// What a Claude Code process and the `claude.job` tasks of its subagents share in memory: each job's frames, in the
// order the process read them, and the callbacks Claude Code makes for it. Neither survives a restart, which abandons
// the job tasks with the process.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TaskId } from "@sigma/kernel"
import { Deferred } from "effect"
import { Inbox } from "./inbox.ts"
import type { Callbacks, TranscriptScope } from "./transcript.ts"

/** How a job ended: as Claude Code said, cut off with its process, or aborted with the run a person stopped. */
export type JobEnd =
  | { readonly status: "completed" | "failed" | "stopped"; readonly summary?: string }
  | { readonly status: "aborted" }

/** What a job's task takes in turn: a frame of its subagent, or its end when the process ends first. */
export type JobItem = { readonly frame: SDKMessage } | { readonly end: JobEnd }

/** What a job ends with when its process ends before Claude Code said the subagent did (D6 of s-evw1pn). */
export const ENDED_WITH_PROCESS: JobEnd = { status: "stopped", summary: "Claude Code ended before the subagent did" }

/** What a job ends with when a person stops the run its process served: as if they had stopped the job itself. */
export const STOPPED_WITH_RUN: JobEnd = { status: "aborted" }

/** One subagent Claude Code started, as its process routes to it. */
export class Job {
  /** Its frames, then its end; its task reads them once it runs. */
  readonly inbox = new Inbox<JobItem>()
  /** The callbacks of its task, which Claude Code's callbacks for the subagent wait for. */
  readonly callbacks = Deferred.makeUnsafe<Callbacks>()

  constructor(
    /** Claude Code's id of the subagent's task, which its callbacks name as their agent. */
    readonly task: string,
    /** Asks Claude Code to stop the subagent. */
    readonly stop: () => Promise<void>,
  ) {}
}

/** What the conversation that hosts a job hands its task: the job, and what its subagent works with (the host's). */
export type Hosted = {
  readonly job: Job
  readonly from: Pick<TranscriptScope, "agent" | "own" | "provider" | "modelId" | "hosting" | "jobOf">
}

/** The job each `claude.job` task holds, by the task's id. */
export class JobLinks {
  readonly #links = new Map<TaskId, Deferred.Deferred<Hosted>>()

  /** The job of the task `id`, given by whichever side comes first: the conversation that hosts it, or the task. */
  link(id: TaskId): Deferred.Deferred<Hosted> {
    let link = this.#links.get(id)
    if (link === undefined) this.#links.set(id, (link = Deferred.makeUnsafe<Hosted>()))
    return link
  }

  forget(id: TaskId): void {
    this.#links.delete(id)
  }
}
