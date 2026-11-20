// Amends two tests of upstream/test/codemode.test.ts that raced the wall clock; each keeps upstream's script, tools and
// checks.
// - "times a script out across a restart, without admitting new calls" gave the script 300 ms and restarted after a
//   400 ms sleep, so the deadline passed while the Harness was closed only when the close took under 300 ms. Under
//   load the live sandbox timed the script out first ("Script timed out" without "deadline passed", 3 of 10 runs at
//   load 60 to 130). Here the script has an hour, which the live run never reaches, and the Harness clock steps past
//   that hour while the Harness is closed.
// - "delivers a result only after its journal commit" polled with `eventually` for the first call, which under load
//   gave up before it came, then waited 100 ms for a second call that must never come. Here the run's own end is the
//   signal: the lost commit fails the Session, and with it the run's wait, after which nothing of the script can start.
//   Neither version catches a result delivered before its commit: the lost commit fails the Session before such a
//   result reaches the second call (measured: with delivery moved ahead of the commit, the second call did not run
//   within 3 s). What both check is that nothing runs past a lost commit.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineTool, type ToolRegistration, ToolResultEntry } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import { type CodemodeGlobal, createCodemodeTool } from "../upstream/src/codemode/codemode.ts";
import { openNodeSqliteStorage } from "../upstream/src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat } from "../upstream/test/chat-support.ts";
import { addTool } from "../upstream/test/harness-support.ts";
import { ControlledStorage, context } from "../upstream/test/session-support.ts";
import { aborted, deferred } from "../upstream/test/task-support.ts";

const Parameters = obj({ text: opt(str()), id: opt(num()) });

function tool(name: string, execute: ToolRegistration<typeof Parameters>["execute"], replay: "safe" | "unsafe") {
	return defineTool({ name, description: name, parameters: Parameters, execute, replay });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function script(code: string): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" });
}

const directories = new Set<string>();
afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-codemode-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** A chat with code mode, `echo` counting its runs by text, and `hold`, which waits for an abort while `holds.block`. */
function codemodeChat(globals: CodemodeGlobal[] = []) {
	const setup = chatSetup();
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
	const vm = { starts: 0 };
	const start = sandbox.start.bind(sandbox);
	sandbox.start = (code, options) => {
		vm.starts++;
		return start(code, options);
	};
	addTool(setup.registry, createCodemodeTool({ sandbox, globals }));
	const echo = new Map<string, number>();
	addTool(
		setup.registry,
		tool(
			"echo",
			async (args) => {
				echo.set(args.text ?? "", (echo.get(args.text ?? "") ?? 0) + 1);
				return { output: [{ type: "text", text: `echo ${args.text ?? ""}` }] };
			},
			"unsafe",
		),
	);
	const holds = { block: true, reached: deferred() };
	addTool(
		setup.registry,
		tool(
			"hold",
			async (args, _api, callContext) => {
				if (holds.block) {
					holds.reached.resolve();
					await aborted(callContext.abortSignal!);
				}
				return { output: [{ type: "text", text: `held ${args.id ?? ""}` }] };
			},
			"safe",
		),
	);
	return { setup, vm, echo, holds };
}

/** The code mode call's result text, without the "Script completed" header and its wall time. */
async function resultText(root: Awaited<ReturnType<typeof openChat>>["root"]) {
	const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
	const message = entry.model![0]!;
	return {
		text:
			message.role === "toolResult"
				? message.content
						.map((item) => (item.type === "text" ? item.text : ""))
						.join("")
						.replace(/^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/, "")
				: "",
		isError: message.role === "toolResult" && message.isError,
	};
}

const HOUR = 3_600_000;

describe("durable code mode", () => {
	it("times a script out across a restart, without admitting new calls", async () => {
		const chat = codemodeChat();
		const path = await sqlitePath();
		let clock = Date.now();
		chat.setup.now = () => clock;
		chat.setup.faux.setResponses([
			script(`// @options: {"timeout_ms": ${HOUR}}
			await tools.hold({}); await tools.echo({ text: "late" });`),
			DONE,
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), chat.setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await chat.holds.reached.promise;
		await opened.harness.close(context);
		chat.holds.block = false;
		// The hour passes while the Harness is closed.
		clock += 2 * HOUR;
		opened = await openChat(await openNodeSqliteStorage(path), chat.setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		const result = await resultText(opened.root);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("deadline passed");
		expect(chat.echo.size).toBe(0);
		expect(chat.vm.starts).toBe(1);
		await opened.harness.close(context);
	});

	it("delivers a result only after its journal commit", async () => {
		const storage = new ControlledStorage();
		const seen: string[] = [];
		const lost = new Error("lost");
		const chat = codemodeChat([
			{
				name: "first",
				execute: async () => {
					seen.push("first");
					// The next commit is this result's journal commit: it never lands.
					storage.failNextCommit(lost);
					return 1;
				},
			},
			{
				name: "second",
				execute: async () => {
					seen.push("second");
					return 2;
				},
			},
		]);
		chat.holds.block = false;
		chat.setup.faux.setResponses([script(`await first(); await second();`), DONE]);
		const { harness, root } = await openChat(storage, chat.setup);
		const submitted = await root.submit({ type: "input", content: "go" }, context);
		// The lost commit fails the Session, and with it the run waiting on it: once the run has ended, nothing more of
		// the script can start.
		await expect(submitted.wait(context)).rejects.toMatchObject({ name: "SessionFailed", cause: lost });
		expect(chat.setup.reports).toEqual([lost]);
		expect(seen).toEqual(["first"]);
		await harness.close(context).catch(() => {});
	});
});
