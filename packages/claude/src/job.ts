// The tasks of Claude Code's jobs. `claude.job` is the run of a subagent Claude Code started, in a conversation of its
// own. It takes the frames and callbacks its process routes to the subagent, and commits them through itself, not
// through the run that started it (D1): its messages, its calls and their results, the approvals it waits on, and the
// subagents it starts. A background `claude.job-anchor` in the parent owns the subagent's conversation, so the parent's
// run can end while the job works (F6). `claude.command` is a background command's, in the background of the
// conversation that started it. A job ends when Claude Code says it did; a person's stop or a restart aborts it, and
// one whose process ends first is cut off (D6). A job of its parent's `claude.jobs` ends there too, and a cut-off one
// tells its parent in a report.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { endRun, LiveDoc, type TaskApi, TaskServices } from "@sigma/harness"
import {
  type AnyTask,
  type ConversationId,
  defineTask,
  type EntryId,
  idFromNumber,
  type NextTaskState,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@sigma/kernel"
import { Deferred, Effect, Semaphore } from "effect"
import { appendReport, endJob, type JobState, reportOf, summaryOf } from "./jobs.ts"
import { ENDED_WITH_PROCESS, type Job, type JobEnd, type JobLinks } from "./links.ts"
import { expireApprovals, makeTranscript, type Transcript } from "./transcript.ts"

export const CLAUDE_JOB_KIND = "claude.job"
export const CLAUDE_JOB_ANCHOR_KIND = "claude.job-anchor"
export const CLAUDE_COMMAND_KIND = "claude.command"

/** The tasks of jobs, which live as long as their Claude Code process: a server stop cuts them off, not waits (D5). */
export const JOB_KINDS: ReadonlySet<string> = new Set([CLAUDE_JOB_KIND, CLAUDE_JOB_ANCHOR_KIND, CLAUDE_COMMAND_KIND])

/**
 * `task`: Claude Code's id of the subagent's task. `parent`: the conversation whose `claude.jobs` holds the job, for a
 * background subagent the run started.
 */
type JobInput = { call: string; title: string; task: string; parent?: number }
type JobCheckpoint = { phase: "wait" }
type JobResult = { entryId?: EntryId }
type JobRuntime = TaskRuntime<JobInput, JobCheckpoint, JobResult>
type JobNext = NextTaskState<JobCheckpoint, JobResult>

const endings = { completed: "completed", failed: "failed", stopped: "stopped", killed: "stopped" } as const

/** A job's state in its parent's document, from how it ended. */
const stateOf = (end: JobEnd): Exclude<JobState, "working"> => (end.status === "completed" ? "done" : end.status)

/**
 * Ends the job `task` in `parent`'s document as `end` says. A job cut off tells its parent in a report, which the next
 * run retells to Claude Code (D6, D4); a job Claude Code ended is reported by whoever read its notification (D3).
 */
const endInParent = (tx: Tx, parent: ConversationId, task: string, end: JobEnd, now: number) =>
  Effect.gen(function* () {
    const summary = end.status === "cut off" ? undefined : end.summary
    const ended = yield* endJob(tx, parent, task, stateOf(end), summary)
    if (ended !== undefined && end.status === "cut off") yield* appendReport(tx, parent, reportOf(ended), now)
  })
/** Commits one frame of the subagent; its `task_notification` ends the job. */
const handle = (transcript: Transcript, frame: SDKMessage): Effect.Effect<JobEnd | undefined, unknown> =>
  Effect.gen(function* () {
    switch (frame.type) {
      case "assistant":
        yield* transcript.said(frame.message.content, frame.message.id)
        return undefined
      case "user":
        yield* transcript.results(frame, undefined)
        return undefined
      case "system": {
        if (frame.subtype === "task_started" && frame.tool_use_id && frame.task_type === "local_agent") {
          // A subagent this one started is hosted under it.
          yield* transcript.host({
            task_id: frame.task_id,
            tool_use_id: frame.tool_use_id,
            description: frame.description,
            background: frame.is_backgrounded === true,
            ...(frame.subagent_type === undefined ? {} : { subagent_type: frame.subagent_type }),
            ...(frame.prompt === undefined ? {} : { prompt: frame.prompt }),
          })
          return undefined
        }
        if (frame.subtype !== "task_notification") return undefined
        const status = endings[frame.status as keyof typeof endings] ?? "failed"
        // A subagent that hands back its report through `SubagentHandback` leaves only a placeholder in `summary`.
        const summary = summaryOf(frame)
        // Claude Code reports a subagent's final answer only here, so it becomes the answer in its conversation.
        if (status === "completed" && summary) {
          yield* transcript.recordText(summary, `${frame.task_id}/summary`, undefined)
        }
        return { status, ...(summary === undefined ? {} : { summary }) }
      }
      default:
        return undefined
    }
  })

/** Commits the job's frames, in the order its process read them, until it ends. */
const work = (job: Job, transcript: Transcript, serially: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const items = job.inbox[Symbol.asyncIterator]()
    for (;;) {
      const next = yield* Effect.promise(() => items.next())
      if (next.done) return ENDED_WITH_PROCESS
      if ("end" in next.value) return next.value.end
      const ended = yield* serially(handle(transcript, next.value.frame))
      if (ended !== undefined) return ended
    }
  })

/**
 * Ends the job aborted, as a person's stop or a restart does: its questions are withdrawn and its run ends `aborted`.
 * A job its process still holds is stopped; one a restart left is cut off with the process that ran it (D6).
 */
const endAborted = (links: JobLinks, input: JobInput, runtime: JobRuntime, api: TaskApi, live: boolean) =>
  runtime.commit((tx) =>
    Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, JobNext, never> {
      links.forget(runtime.taskId)
      const doc = yield* tx.doc(LiveDoc, runtime.conversationId)
      yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
      const end: JobEnd = live ? { status: "stopped" } : ENDED_WITH_PROCESS
      if (input.parent !== undefined) yield* endInParent(tx, idFromNumber(input.parent), input.task, end, runtime.now())
      const detail = live ? undefined : CUT_OFF
      yield* endRun(
        tx,
        doc,
        runtime.taskId,
        { status: "unanswered", reason: "aborted", ...(detail === undefined ? {} : { detail }) },
        api.runOwner,
      )
      return { status: "terminal", outcome: { status: "aborted" } }
    }),
  )

/** What a cut-off job's run ends with. */
const CUT_OFF = "Claude Code ended before the job did"

/** The newest entry of the subagent's conversation: what it answered. */
const latest = (runtime: JobRuntime) => Effect.map(runtime.entries({}, 1), (page) => page.items[0]?.id)

/** Whether the job's process still holds it: a restart forgot every link. */
const linked = (links: JobLinks, runtime: { readonly taskId: TaskId<any> }) =>
  Deferred.isDoneUnsafe(links.link(runtime.taskId))

export const makeJobTask = (links: JobLinks) =>
  defineTask<JobInput, JobCheckpoint, JobResult, TaskServices>({
    name: CLAUDE_JOB_KIND,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (task, runtime) =>
        Effect.gen(function* () {
          const api = yield* TaskServices
          const { job, from } = yield* Deferred.await(links.link(runtime.taskId))
          const serial = yield* Semaphore.make(1)
          const serially = <A, E>(effect: Effect.Effect<A, E>) => serial.withPermits(1)(effect)
          const transcript = makeTranscript({
            ...from,
            runtime,
            api,
            commit: (body) => runtime.commit(body as never),
            serially,
          })
          yield* Deferred.succeed(job.callbacks, transcript.callbacks)
          const ended = yield* work(job, transcript, serially)
          const answer = yield* latest(runtime)
          yield* runtime.commit((tx) =>
            Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, JobNext, never> {
              const live = yield* tx.doc(LiveDoc, runtime.conversationId)
              links.forget(runtime.taskId)
              // A subagent Claude Code stopped leaves its question unanswered: its result no longer reaches the job.
              yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
              const parent = task.input.parent
              if (parent !== undefined) yield* endInParent(tx, idFromNumber(parent), job.task, ended, runtime.now())
              if (ended.status === "completed" && answer !== undefined) {
                yield* endRun(tx, live, runtime.taskId, { status: "done", answer }, api.runOwner)
                return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } }
              }
              const detail =
                ended.status === "cut off"
                  ? CUT_OFF
                  : (ended.summary ?? `The subagent ${ended.status === "stopped" ? "was stopped" : "failed"}`)
              const reason = ended.status === "failed" ? "model_error" : "aborted"
              yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason, detail }, api.runOwner)
              return {
                status: "terminal",
                outcome: { status: "failed", error: { message: detail, detail: { reason } } },
              }
            }),
          )
        }),
    },
    abort: (task, runtime) =>
      Effect.gen(function* () {
        const api = yield* TaskServices
        const live = linked(links, runtime)
        if (live) {
          // Claude Code is told to stop the subagent, as a person stopped it.
          const { job } = yield* Deferred.await(links.link(runtime.taskId))
          yield* Effect.ignore(Effect.tryPromise(job.stop))
        }
        yield* endAborted(links, task.input, runtime, api, live)
      }),
  })

/** Owns a subagent's conversation in its parent, in the background: completes at once, and holds `completing` while the job works. */
export const JobAnchor: AnyTask<TaskServices> = defineTask<null, { readonly phase: "done" }, null, TaskServices>({
  name: CLAUDE_JOB_ANCHOR_KIND,
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime) =>
      runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "completed", result: null } })),
  },
  abort: (_task, runtime) =>
    runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "aborted" } })),
})

type CommandNext = NextTaskState<JobCheckpoint, null>

/** A command's end: Claude Code's notification, or its process's end. */
const commandEnd = (job: Job) =>
  Effect.gen(function* () {
    const items = job.inbox[Symbol.asyncIterator]()
    for (;;) {
      const next = yield* Effect.promise(() => items.next())
      if (next.done) return ENDED_WITH_PROCESS
      if ("end" in next.value) return next.value.end
      const frame = next.value.frame
      if (frame.type === "system" && frame.subtype === "task_notification") {
        const status = endings[frame.status as keyof typeof endings] ?? "failed"
        const summary = summaryOf(frame)
        return { status, ...(summary === undefined ? {} : { summary }) } as JobEnd
      }
    }
  })

/** A background command the run's Claude Code started: its job in the conversation's `claude.jobs`, until it ends. */
export const makeCommandTask = (links: JobLinks) =>
  defineTask<{ task: string }, JobCheckpoint, null, TaskServices>({
    name: CLAUDE_COMMAND_KIND,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (_task, runtime) =>
        Effect.gen(function* () {
          const { job } = yield* Deferred.await(links.link(runtime.taskId))
          const ended = yield* commandEnd(job)
          yield* runtime.commit((tx) =>
            Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, CommandNext, never> {
              links.forget(runtime.taskId)
              yield* endInParent(tx, runtime.conversationId, job.task, ended, runtime.now())
              return { status: "terminal", outcome: { status: "completed", result: null } }
            }),
          )
        }),
    },
    abort: (task, runtime) =>
      Effect.gen(function* () {
        const live = linked(links, runtime)
        if (live) {
          // Claude Code is told to stop the command, as a person stopped it.
          const { job } = yield* Deferred.await(links.link(runtime.taskId))
          yield* Effect.ignore(Effect.tryPromise(job.stop))
        }
        const end: JobEnd = live ? { status: "stopped" } : ENDED_WITH_PROCESS
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, CommandNext, never> {
            links.forget(runtime.taskId)
            yield* endInParent(tx, runtime.conversationId, task.input.task, end, runtime.now())
            return { status: "terminal", outcome: { status: "aborted" } }
          }),
        )
      }),
  })
