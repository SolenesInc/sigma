// Amends upstream/test/harness-ownership.test.ts > "ownership > tracks ownership chains deeper than the call stack"
// (spec 5.5, amendments.json): the same 20,000-task chain and checks, waiting on the top task's ending commit and with a limit
// measured on Bun. Upstream polls for the top task's `completing` status 500 times 5 ms apart, about 2.5 s of wall
// clock, and gives the test 60 s. Beside `scripts/under-load.ts`'s 44 spinners on 22 cores (load 102 to 155) the test
// took 33.4-58.1 s over three runs, all of it the chain's own work, so upstream's limit is reached by load alone and
// its poll by any pause past 2.5 s. This waits on the top task's ending commit, which a task makes only once its gate
// opens, then reads its status once; the limit is four times the slowest run.

import { defineTask, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../upstream/test/session-support.ts";
import { aborted, type Deferred, deferred, openTasks } from "../upstream/test/task-support.ts";

/** A tripwire past the slowest run measured under load; see the header. */
const LIMIT_MS = 240_000;
/** The wait's own tripwire, under the test's by more than the slowest run, so a hang names what it waited on. */
const WAIT_MS = 150_000;

type Ending = "completed" | "failed";
const gates = new Map<string, Deferred<Ending>>();

function gate(name: string): Deferred<Ending> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<Ending>();
		gates.set(name, found);
	}
	return found;
}

function open(name: string, ending: Ending): void {
	gate(name).resolve(ending);
}

/** Resolves once the named task's ending commit has returned. */
const committed = new Map<string, Deferred<void>>();

function endedCommit(name: string): Deferred<void> {
	let found = committed.get(name);
	if (found === undefined) {
		found = deferred<void>();
		committed.set(name, found);
	}
	return found;
}

afterEach(() => {
	gates.clear();
	committed.clear();
});

/** A task that holds until its named gate opens or it is aborted. */
const Hold = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "test.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			const ending = await Promise.race([gate(task.input.name).promise, aborted(runtime.signal)]);
			await runtime.commit(
				() =>
					ending === "completed"
						? { status: "terminal", outcome: { status: "completed", result: null } }
						: { status: "terminal", outcome: { status: "failed", error: { message: "gate failed" } } },
				ctx,
			);
			endedCommit(task.input.name).resolve();
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Settles with `promise`, or fails naming `what` once `ms` pass without it. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		// clock: the tripwire on a signal that never arrives
		timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms} ms`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

describe("ownership", () => {
	it(
		"tracks ownership chains deeper than the call stack",
		async () => {
			const { harness } = await openTasks(new MemoryStorage(), [Hold]);
			const root = await harness.root(context);
			harness.resume();
			// 20,000 tasks, each owning the next, created in one commit above a live leaf; they end top-down and hold.
			const depth = 20_000;
			const { top, leaf } = await root.commit(async (tx) => {
				const top = await tx.createTask(Hold, { name: "top" }, { ownership: { kind: "conversation" } });
				let owner: TaskId = top;
				for (let n = 0; n < depth; n++) {
					owner = await tx.createTask(Hold, { name: `link${n}` }, { ownership: { kind: "task", taskId: owner } });
				}
				const leaf = await tx.createTask(Hold, { name: "leaf" }, { ownership: { kind: "task", taskId: owner } });
				return { top, leaf };
			}, context);
			for (let n = 0; n < depth; n++) open(`link${n}`, "completed");
			open("top", "completed");
			// Its ending commit returned while the chain below it lives, so it holds that outcome.
			await within(endedCommit("top").promise, WAIT_MS, "the top task's ending commit");
			expect((await harness.getTask(top, context))!.state.status).toBe("completing");
			open("leaf", "completed");
			expect((await harness.waitForTask(leaf, context)).state.outcome.status).toBe("completed");
			expect((await harness.waitForTask(top, context)).state.outcome.status).toBe("completed");
			await harness.close(context);
		},
		LIMIT_MS,
	);
});
