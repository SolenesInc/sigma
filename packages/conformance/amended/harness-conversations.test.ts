// Amends two tests of upstream/test/harness-conversations.test.ts (spec 2.2, amendments.json). Sigma's amendment "A
// fork keeps its parent's provider session" (D3 of "Sigma keeps the ChatGPT prompt cache across forks and instruction
// changes") forks `pi.provider` as `current`, so a fork sends its parent's prompt cache key and reads its parent's
// cache. Upstream asserts each fork's session differs from its fork parent's; these assert they are equal. Everything
// else is upstream's, and a new conversation, task-owned or not, still gets a session of its own: what #10424 needs,
// each conversation's requests reading its own document, holds either way.
// - "keeps root and conversation identity and state across reopen": the ownerless fork of the root.
// - "gives conversations created through Tx their documents: empty, an owner copy, or the fork's as-of copy": the
//   task-owned fork of an ownerless conversation.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	configure,
	defineTask,
	type EntryRecord,
	LiveDoc,
	MemoryStorage,
	ProviderDoc,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../upstream/src/storage/sqlite/node.ts";
import { openHarness, user } from "../upstream/test/harness-support.ts";
import { context } from "../upstream/test/session-support.ts";

const directories = new Set<string>();
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-harness-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function append(conversation: Conversation, text: string): Promise<EntryRecord> {
	return conversation.commit(
		(tx) => tx.appendEntry(conversation.id, { kind: "message", model: [user(text)] }),
		context,
	);
}

async function allEntries(conversation: Conversation): Promise<string[]> {
	const texts: string[] = [];
	let cursor: Parameters<Conversation["entries"]>[2];
	do {
		const page = await conversation.entries({}, 2, cursor, context);
		for (const entry of page.items) texts.push((entry.model?.[0] as { content: string }).content);
		cursor = page.next;
	} while (cursor !== undefined);
	return texts;
}

describe("Harness root and conversations", () => {
	it("keeps root and conversation identity and state across reopen", async () => {
		const path = await sqlitePath();
		let first = await openHarness(await openNodeSqliteStorage(path), ["read"]);
		const root = await first.harness.root(context);
		await root.configure({ model: { provider: "anthropic", modelId: "claude" }, cwd: "/repo" }, context);
		const entry = await append(root, "hello");
		const child = await first.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const fork = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		const providerSessionIds = await Promise.all(
			[root, child, fork].map(
				async (conversation) => (await first.harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId,
			),
		);
		// A new conversation gets its own provider identity (#10424); a fork keeps its parent's.
		for (const sessionId of providerSessionIds) expect(sessionId).toMatch(UUID_V7);
		const [rootSession, childSession, forkSession] = providerSessionIds;
		expect(childSession).not.toBe(rootSession);
		expect(forkSession).toBe(rootSession);
		await first.harness.close(context);
		await expect(root.agent(context)).rejects.toThrow();

		// The new process installs nothing: the stored choices survive, the tools do not resolve.
		first = await openHarness(await openNodeSqliteStorage(path), []);
		const reopened = await first.harness.root(context, { init: () => expect.unreachable() });
		expect(reopened.id).toBe(ROOT_CONVERSATION_ID);
		expect(await reopened.agent(context)).toMatchObject({
			model: { provider: "anthropic", modelId: "claude" },
			cwd: "/repo",
			tools: [],
		});
		expect(await allEntries(reopened)).toEqual(["hello"]);
		expect((await first.harness.conversation(child.id, context))?.id).toBe(child.id);
		await expect(
			Promise.all(
				[root.id, child.id, fork.id].map(
					async (id) => (await first.harness.snapshot(ProviderDoc, id, context))?.sessionId,
				),
			),
		).resolves.toEqual(providerSessionIds);
		const reopenedFork = await first.harness.conversation(fork.id, context);
		expect(await allEntries(reopenedFork!)).toEqual(["hello"]);
		expect((await reopenedFork!.agent(context)).model).toEqual({ provider: "anthropic", modelId: "claude" });
		expect(await first.harness.conversation(999 as ConversationId, context)).toBeUndefined();
		await first.harness.close(context);
	});
});

describe("Harness agent", () => {
	it("gives conversations created through Tx their documents: empty, an owner copy, or the fork's as-of copy", async () => {
		const { harness } = await openHarness(new MemoryStorage(), ["read"]);
		const root = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: "m" }, instructions: "Main role.", cwd: "/repo" },
		});
		const owner = defineTask<Record<string, never>, { phase: "never" }, null>({
			name: "test.owner",
			version: 1,
			initial: () => ({ phase: "never" }),
			phases: { never: async () => {} },
			abort: async () => {},
		});
		const ids = await root.commit(async (tx) => {
			const taskId = await tx.createTask(owner, {}, { ownership: { kind: "conversation" } });
			const plain = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const owned = await tx.createConversation({ ownership: { kind: "task", taskId } });
			// The copy exists when createConversation() returns, so a configure() in the same callback overrides it.
			expect((await tx.doc(AgentDoc, owned.id)).cwd).toBe("/repo");
			await configure(tx, owned.id, { cwd: "/worktree" });
			return { taskId, plain: plain.id, owned: owned.id };
		}, context);
		expect(await harness.snapshot(AgentDoc, ids.plain, context)).toEqual({});
		expect(await harness.snapshot(LiveDoc, ids.plain, context)).toEqual({});
		expect(await harness.snapshot(ProviderDoc, ids.plain, context)).toEqual({
			sessionId: expect.stringMatching(UUID_V7),
		});
		expect((await harness.snapshot(ProviderDoc, ids.owned, context))?.sessionId).not.toBe(
			(await harness.snapshot(ProviderDoc, root.id, context))?.sessionId,
		);
		expect(await harness.snapshot(AgentDoc, ids.owned, context)).toEqual({
			model: { provider: "faux", modelId: "m" },
			instructions: "Main role.",
			cwd: "/worktree",
		});

		// A later owner change does not reach the child.
		await root.configure({ thinkingLevel: "high" }, context);
		expect((await harness.snapshot(AgentDoc, ids.owned, context))?.thinkingLevel).toBeUndefined();

		// A task-owned fork keeps its as-of copy of its fork parent, not its owner's agent.
		const at = await root.commit(async (tx) => (await tx.appendEntry(ids.plain, { kind: "note" })).id, context);
		const fork = await root.commit(
			async (tx) =>
				(await tx.forkConversation(ids.plain, at, { ownership: { kind: "task", taskId: ids.taskId } })).id,
			context,
		);
		expect(await harness.snapshot(AgentDoc, fork, context)).toEqual({});
		expect(await harness.snapshot(LiveDoc, fork, context)).toEqual({});
		// The fork keeps its fork parent's provider session, not its owner's, and not a fresh one.
		expect((await harness.snapshot(ProviderDoc, fork, context))?.sessionId).toBe(
			(await harness.snapshot(ProviderDoc, ids.plain, context))?.sessionId,
		);
		await harness.close(context);
	});
});
