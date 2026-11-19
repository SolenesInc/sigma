// The `claude.job` task: the run of a subagent Claude Code started, in a conversation of its own. It takes the frames
// and callbacks its process routes to the subagent, and commits them through itself, not through the run that
// started it (D1): its messages, its calls and their results, the approvals it waits on, and the subagents it starts.
// A background `claude.job-anchor` in the parent owns the subagent's conversation, so the parent's run can end while
// the job works (F6). The job ends when Claude Code says the subagent did, or with its process.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { endRun, LiveDoc, TaskServices } from "@sigma/harness"
import { type AnyTask, defineTask, type EntryId, type NextTaskState, type TaskRuntime } from "@sigma/kernel"
import { Deferred, Effect, Semaphore } from "effect"
import { ENDED_WITH_PROCESS, type Job, type JobEnd, type JobLinks } from "./links.ts"
import { expireApprovals, makeTranscript, type Transcript } from "./transcript.ts"

export const CLAUDE_JOB_KIND = "claude.job"
export const CLAUDE_JOB_ANCHOR_KIND = "claude.job-anchor"

type JobInput = { call: string; title: string }
type JobCheckpoint = { phase: "wait" }
type JobResult = { entryId?: EntryId }
type JobRuntime = TaskRuntime<JobInput, JobCheckpoint, JobResult>
type JobNext = NextTaskState<JobCheckpoint, JobResult>

const endings = { completed: "completed", failed: "failed", stopped: "stopped", killed: "stopped" } as const

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
            ...(frame.subagent_type === undefined ? {} : { subagent_type: frame.subagent_type }),
            ...(frame.prompt === undefined ? {} : { prompt: frame.prompt }),
          })
          return undefined
        }
        if (frame.subtype !== "task_notification") return undefined
        const status = endings[frame.status as keyof typeof endings] ?? "failed"
        // A subagent that hands back its report through `SubagentHandback` leaves only a placeholder in `summary`;
        // the report is `handback_report`, which the SDK's types do not declare yet.
        const handback = (frame as { handback_report?: { text?: string } }).handback_report?.text
        const summary = handback || frame.summary
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

/** The newest entry of the subagent's conversation: what it answered. */
const latest = (runtime: JobRuntime) => Effect.map(runtime.entries({}, 1), (page) => page.items[0]?.id)

export const makeJobTask = (links: JobLinks) =>
  defineTask<JobInput, JobCheckpoint, JobResult, TaskServices>({
    name: CLAUDE_JOB_KIND,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (_task, runtime) =>
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
              if (ended.status === "completed" && answer !== undefined) {
                yield* endRun(tx, live, runtime.taskId, { status: "done", answer }, api.runOwner)
                return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } }
              }
              const detail = ended.summary ?? `The subagent ${ended.status === "stopped" ? "was stopped" : "failed"}`
              const reason = ended.status === "stopped" ? "aborted" : "model_error"
              yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason, detail }, api.runOwner)
              return {
                status: "terminal",
                outcome: { status: "failed", error: { message: detail, detail: { reason } } },
              }
            }),
          )
        }),
    },
    abort: (_task, runtime) =>
      Effect.gen(function* () {
        const api = yield* TaskServices
        const link = links.link(runtime.taskId)
        if (Deferred.isDoneUnsafe(link)) {
          const { job } = yield* Deferred.await(link)
          yield* Effect.ignore(Effect.tryPromise(job.stop))
        }
        links.forget(runtime.taskId)
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, JobNext, never> {
            const live = yield* tx.doc(LiveDoc, runtime.conversationId)
            yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
            yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" }, api.runOwner)
            return { status: "terminal", outcome: { status: "aborted" } }
          }),
        )
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
