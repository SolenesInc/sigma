// What a Claude Code process and the tasks of its jobs share in memory: each job's frames, in the order the process
// read them, and the callbacks Claude Code makes for it. Neither survives a restart, which abandons
// the job tasks with the process.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TaskId } from "@sigma/kernel"
import { Deferred } from "effect"
import { Inbox } from "./inbox.ts"
import type { Callbacks, TranscriptScope } from "./transcript.ts"

/** How a job ended: as Claude Code said, or cut off with its process before it said (D6). */
export type JobEnd =
  | { readonly status: "completed" | "failed" | "stopped"; readonly summary?: string }
  | { readonly status: "cut off" }

/** What a job's task takes in turn: a frame of its subagent, or its end when the process ends first. */
export type JobItem = { readonly frame: SDKMessage } | { readonly end: JobEnd }

/** What a job ends with when its process ends before Claude Code said the job did (D6). */
export const ENDED_WITH_PROCESS: JobEnd = { status: "cut off" }

/** What Claude Code said of a job as it started it. */
export type JobStart = {
  readonly kind: "agent" | "command"
  readonly title: string
  /** The call that started it. */
  readonly call: string
  /** Background work the main loop started: its parent's jobs document holds it, and its end is reported (D3). */
  readonly reported: boolean
}

/** One subagent or background command Claude Code started, as its process routes to it. */
export class Job {
  /** Its frames, then its end; its task reads them once it runs. */
  readonly inbox = new Inbox<JobItem>()
  /** The callbacks of its task, which Claude Code's callbacks for the subagent wait for. */
  readonly callbacks = Deferred.makeUnsafe<Callbacks>()
  /** What its `task_started` said, once the process read it. */
  start: JobStart | undefined
  /** A subagent's conversation, once a conversation hosts it. */
  conversation: number | undefined

  constructor(
    /** Claude Code's id of the job's task, which a subagent's callbacks name as their agent. */
    readonly task: string,
    /** Asks Claude Code to stop the job. */
    readonly stop: () => Promise<void>,
  ) {}
}

/** What the conversation that hosts a job hands its task: the job, and what its subagent works with (the host's). */
export type Hosted = {
  readonly job: Job
  readonly from: Pick<TranscriptScope, "agent" | "provider" | "modelId" | "hosting" | "started">
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
