// The tasks of a harness's jobs. `hosted.job` is the run of a subagent the harness started, in a conversation of its
// own. It takes the frames and callbacks its process routes to the subagent, and commits them through itself, not
// through the run that started it (D1): its messages, its calls and their results, the approvals it waits on, and the
// subagents it starts. A background `hosted.job-anchor` in the parent owns the subagent's conversation, so the parent's
// run can end while the job works (F6). `hosted.command` is a background command's, in the background of the
// conversation that started it. A job ends when the harness says it did; a person's stop or a restart aborts it, and
// one whose process ends first is cut off (D6). A job of its parent's `claude.jobs` ends there too, and a cut-off one
// tells its parent in a report.
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
import type { Frame } from "./adapter.ts"
import { appendReport, endJob, type JobState, reportOf } from "./jobs.ts"
import { ENDED_WITH_PROCESS, type Job, type JobEnd, type JobLinks } from "./links.ts"
import { expireApprovals, makeTranscript, type Transcript } from "./transcript.ts"

export const JOB_KIND = "hosted.job"
export const JOB_ANCHOR_KIND = "hosted.job-anchor"
export const COMMAND_KIND = "hosted.command"

/** The tasks of jobs, which live as long as their harness process: a server stop cuts them off, not waits (D5). */
export const JOB_KINDS: ReadonlySet<string> = new Set([JOB_KIND, JOB_ANCHOR_KIND, COMMAND_KIND])

/**
 * `task`: the harness's id of the subagent's task. `harness`: the adapter's name, which a cut-off job's texts say.
 * `parent`: the conversation whose `claude.jobs` holds the job, for a background subagent the run started.
 */
type JobInput = { call: string; title: string; task: string; harness: string; parent?: number }
type JobCheckpoint = { phase: "wait" }
type JobResult = { entryId?: EntryId }
type JobRuntime = TaskRuntime<JobInput, JobCheckpoint, JobResult>
type JobNext = NextTaskState<JobCheckpoint, JobResult>

/** A job's state in its parent's document, from how it ended. */
const stateOf = (end: JobEnd): Exclude<JobState, "working"> => (end.status === "completed" ? "done" : end.status)

/**
 * Ends the job `task` in `parent`'s document as `end` says. A job cut off tells its parent in a report, which the next
 * run retells to the harness (D6, D4); a job the harness ended is reported by whoever read its end (D3).
 */
const endInParent = (tx: Tx, harness: string, parent: ConversationId, task: string, end: JobEnd, now: number) =>
  Effect.gen(function* () {
    const summary = end.status === "cut off" ? undefined : end.summary
    const ended = yield* endJob(tx, parent, task, stateOf(end), summary)
    if (ended !== undefined && end.status === "cut off") yield* appendReport(tx, parent, reportOf(harness, ended), now)
  })

/** Commits one frame of the subagent. */
const handle = (transcript: Transcript, frame: Frame) =>
  Effect.gen(function* () {
    switch (frame.type) {
      case "said":
        return yield* transcript.said(frame.content, frame.response, frame.at)
      case "results":
        return yield* Effect.asVoid(transcript.results(frame))
      case "subagent":
        // A subagent this one started is hosted under it.
        return yield* transcript.host(frame)
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
      if ("frame" in next.value) {
        yield* serially(handle(transcript, next.value.frame))
        continue
      }
      const end = next.value.end
      // The harness reports a subagent's final answer only with its end, so it becomes the answer in its conversation.
      if (end.status === "completed" && end.summary) {
        yield* serially(transcript.recordText(end.summary, `${job.task}/summary`, undefined))
      }
      return end
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
      if (input.parent !== undefined) {
        yield* endInParent(tx, input.harness, idFromNumber(input.parent), input.task, end, runtime.now())
      }
      const detail = live ? undefined : cutOff(input.harness)
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
const cutOff = (harness: string) => `${harness} ended before the job did`

/** The newest entry of the subagent's conversation: what it answered. */
const latest = (runtime: JobRuntime) => Effect.map(runtime.entries({}, 1), (page) => page.items[0]?.id)

/** Whether the job's process still holds it: a restart forgot every link. */
const linked = (links: JobLinks, runtime: { readonly taskId: TaskId<any> }) =>
  Deferred.isDoneUnsafe(links.link(runtime.taskId))

export const makeJobTask = (links: JobLinks) =>
  defineTask<JobInput, JobCheckpoint, JobResult, TaskServices>({
    name: JOB_KIND,
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
              // A subagent the harness stopped leaves its question unanswered: its result no longer reaches the job.
              yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
              const parent = task.input.parent
              if (parent !== undefined) {
                yield* endInParent(tx, task.input.harness, idFromNumber(parent), job.task, ended, runtime.now())
              }
              if (ended.status === "completed" && answer !== undefined) {
                yield* endRun(tx, live, runtime.taskId, { status: "done", answer }, api.runOwner)
                return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } }
              }
              const detail =
                ended.status === "cut off"
                  ? cutOff(task.input.harness)
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
          // The harness is told to stop the subagent, as a person stopped it.
          const { job } = yield* Deferred.await(links.link(runtime.taskId))
          yield* Effect.ignore(Effect.tryPromise(job.stop))
        }
        yield* endAborted(links, task.input, runtime, api, live)
      }),
  })

/** Owns a subagent's conversation in its parent, in the background: completes at once, and holds `completing` while the job works. */
export const JobAnchor: AnyTask<TaskServices> = defineTask<null, { readonly phase: "done" }, null, TaskServices>({
  name: JOB_ANCHOR_KIND,
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

/** A command's end: the harness's word for it, or its process's end. */
const commandEnd = (job: Job) =>
  Effect.gen(function* () {
    const items = job.inbox[Symbol.asyncIterator]()
    for (;;) {
      const next = yield* Effect.promise(() => items.next())
      if (next.done) return ENDED_WITH_PROCESS
      if ("end" in next.value) return next.value.end
    }
  })

/** A background command the run's harness started: its job in the conversation's `claude.jobs`, until it ends. */
export const makeCommandTask = (links: JobLinks) =>
  defineTask<{ task: string; harness: string }, JobCheckpoint, null, TaskServices>({
    name: COMMAND_KIND,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (task, runtime) =>
        Effect.gen(function* () {
          const { job } = yield* Deferred.await(links.link(runtime.taskId))
          const ended = yield* commandEnd(job)
          yield* runtime.commit((tx) =>
            Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, CommandNext, never> {
              links.forget(runtime.taskId)
              yield* endInParent(tx, task.input.harness, runtime.conversationId, job.task, ended, runtime.now())
              return { status: "terminal", outcome: { status: "completed", result: null } }
            }),
          )
        }),
    },
    abort: (task, runtime) =>
      Effect.gen(function* () {
        const live = linked(links, runtime)
        if (live) {
          // The harness is told to stop the command, as a person stopped it.
          const { job } = yield* Deferred.await(links.link(runtime.taskId))
          yield* Effect.ignore(Effect.tryPromise(job.stop))
        }
        const end: JobEnd = live ? { status: "stopped" } : ENDED_WITH_PROCESS
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, CommandNext, never> {
            links.forget(runtime.taskId)
            yield* endInParent(tx, task.input.harness, runtime.conversationId, task.input.task, end, runtime.now())
            return { status: "terminal", outcome: { status: "aborted" } }
          }),
        )
      }),
  })
