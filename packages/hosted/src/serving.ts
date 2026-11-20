// What one hosted run does with the frames of the harness process serving it: the frames of its own conversation,
// turned into commits through the run's task, the jobs the harness starts in it, and the reports of the jobs that end
// while it serves. A subagent is hosted as a conversation of its own, whose `hosted.job` task takes its frames and
// callbacks (D1); a background command is a `hosted.command` task. `transcript.ts` is what a run and a job write a
// conversation with. A run ends when the harness goes idle, not at its answer (D2).
import {
  type Agent,
  applyBoundary,
  CompactionEntry,
  hasQueuedReset,
  LiveDoc,
  prepareBoundary,
  recordUsage,
  type TaskApi,
} from "@sigma/harness"
import type { EntryId, JsonObject, NextTaskState, TaskRuntime, Tx } from "@sigma/kernel"
import { Effect } from "effect"
import type { Adapter, Callbacks, Frame } from "./adapter.ts"
import { appendReport, type JobReport, REPORT_KIND } from "./jobs.ts"
import type { Job } from "./links.ts"
import { promptOf, type Said } from "./retell.ts"
import { HostedSessionDoc } from "./session.ts"
import { assistantMessage, type Hosting, makeTranscript, type Member, type Position } from "./transcript.ts"

/** How a run ended: it answered, the session is gone, the harness failed, or its process exited. */
export type Ended =
  | { readonly _tag: "answered"; readonly answer: EntryId | undefined; readonly turnLimit: boolean }
  | { readonly _tag: "gone" }
  | { readonly _tag: "failed"; readonly message: string }
  /** The process exited before the harness took the run's opening: a live process lost while idle, or one that never started. */
  | { readonly _tag: "exited"; readonly message: string }
  /** A reset was queued while the run worked: the run ends before it, and the next run starts in its context. */
  | { readonly _tag: "reset" }

export const failure = (message: string): Ended => ({ _tag: "failed", message })

export type HostedRunCheckpoint = { phase: "converse"; at?: string }

type Runtime = TaskRuntime<Record<string, never>, HostedRunCheckpoint, { entryId?: EntryId }>
type Next = NextTaskState<HostedRunCheckpoint, { entryId?: EntryId }>

/** The run a process serves. */
export type RunContext = {
  readonly runtime: Runtime
  readonly api: TaskApi
  readonly agent: Agent
  /** The harness serving it. */
  readonly adapter: Adapter
  /** The tasks its subagents are hosted with. */
  readonly hosting: Hosting
  /** A run of a remote conversation, in member mode (D9). */
  readonly member?: Member
}

/** What a run reaches of the process serving it. */
export interface ServingProcess {
  /** The harness's session, which a reset such as `/clear` may move to a new id. */
  readonly session: string
  /**
   * Whether a frame's `at` is a position a resume can continue from now: false while a message the process was sent
   * has not come back from the harness, or while a reset's new session id is not known yet.
   */
  readonly holdsPosition: boolean
  readonly send: (parts: ReadonlyArray<Said>, priority?: "next") => void
  /** Runs `effect` alone among the process's frames and the run's callbacks. */
  readonly serially: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  /** The job the process made for a subagent the harness started, by the call that started it; once. */
  readonly started: (call: string) => Job
}

/** What a process hands the run it serves: the frames and callbacks of the run's own conversation. */
export interface Serving extends Callbacks {
  /** Commits what a frame says; a frame that ends the run returns how. */
  readonly handle: (frame: Frame) => Effect.Effect<Ended | undefined, unknown>
  /** Commits a job's end, read while the run serves or held for it (D3). */
  readonly report: (report: JobReport) => Effect.Effect<void, unknown>
  /** How the run ends if the harness goes idle now: as its newest `answered` said. */
  readonly ended: Ended | undefined
  /** The harness compacted its context into `summary`, by a person's request (`manual`) or at its threshold. */
  readonly compacted: (summary: string, manual: boolean, signal?: AbortSignal) => Promise<void>
}

/** The run `ctx` served by `process`. */
export const makeServing = (ctx: RunContext, process: ServingProcess): Serving => {
  const { runtime, api, agent, adapter } = ctx
  const conversationId = runtime.conversationId
  const provider = agent.model?.provider ?? ""
  const modelId = agent.model?.modelId ?? ""
  let saidAnything = false
  let lastEntry: EntryId | undefined
  let partial = ""
  let flushedAt = 0
  let resetQueued = false
  /** How the newest `answered` ended the turn, which ends the run once the harness goes idle. */
  let ended: Ended | undefined

  /** A commit returning nothing, or the checkpoint a moved position records as progress. */
  const commit = (body: (tx: Tx) => Effect.Effect<unknown, unknown>) =>
    runtime.commit((tx) => body(tx) as Effect.Effect<Next | undefined, never>)

  /** Moves the position to `at`, through the entry `seen`, unless a sent message has not come back yet. */
  const position: Position = (tx, live, at, seen, what) =>
    Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next | undefined, never> {
      if (what === "text") {
        partial = ""
        delete live.generation
      }
      lastEntry = seen
      if (at === undefined || !process.holdsPosition) return undefined
      const doc = yield* tx.doc(HostedSessionDoc, conversationId)
      doc.current = {
        conversation: Number(conversationId),
        provider,
        session: process.session,
        at,
        seen: Number(seen),
      }
      return { status: "running", checkpoint: { phase: "converse", at } }
    })

  const transcript = makeTranscript({
    runtime,
    api,
    agent,
    commit,
    serially: process.serially,
    provider,
    modelId,
    adapter,
    hosting: ctx.hosting,
    started: process.started,
    position,
    ...(ctx.member === undefined ? {} : { member: ctx.member }),
  })

  /** The harness's summary of its own compaction, mirrored as a compaction entry that starts a new context. */
  const compacted: Serving["compacted"] = (summary, manual, signal) =>
    Effect.runPromise(
      process.serially(
        commit((tx) =>
          Effect.gen(function* () {
            const message = { role: "user", content: summary, timestamp: runtime.now() }
            const entry = yield* tx.appendEntry(CompactionEntry, conversationId, {
              head: "self",
              model: [message as unknown as JsonObject],
              data: { reason: manual ? "manual" : "threshold" },
            })
            lastEntry = entry.id
            // The session holds its compaction: only what comes after it is news to a resume.
            const doc = yield* tx.doc(HostedSessionDoc, conversationId)
            if (doc.current?.session === process.session) doc.current.seen = Number(entry.id)
            return undefined
          }),
        ),
      ),
      signal === undefined ? undefined : { signal },
    ).then(() => undefined)

  /**
   * Places the steers waiting in the inbox after a round of results, and hands them to the harness. A queued reset
   * ends the run instead, as in sigma's own loop: the session the harness holds is the context the reset cuts.
   */
  const steer = commit((tx) =>
    Effect.gen(function* () {
      const boundary = yield* prepareBoundary(tx, conversationId, api.settings())
      if (hasQueuedReset(boundary.inbox.items)) {
        resetQueued = true
        return undefined
      }
      // A job's report is placed, not sent: the harness read the job's end itself (D4).
      const prompts = new Map(
        boundary.inbox.items.flatMap((item) =>
          item.mode === "steer" && item.entry?.kind !== REPORT_KIND
            ? [[item.id, promptOf(item.content as unknown)] as const]
            : [],
        ),
      )
      const { users } = yield* applyBoundary(tx, boundary, "postTools", runtime.now())
      if (users.length === 0) return undefined
      const live = yield* tx.doc(LiveDoc, conversationId)
      if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users)
      const said = users.flatMap((id) => prompts.get(id) ?? [])
      if (said.length > 0) process.send(said, "next")
      return undefined
    }),
  )

  /** Adds what the process spent since its last report to `pi.usage`, keyed by provider and model (F16). */
  const spent = (usage: Extract<Frame, { type: "spent" }>["usage"]) =>
    commit((tx) =>
      Effect.gen(function* () {
        for (const [model, added] of usage) {
          if (added.totalTokens > 0 || added.cost.total > 0) {
            yield* recordUsage(tx, conversationId, "models", `${provider}/${model}`, added)
          }
        }
        return undefined
      }),
    )

  /** Commits the partial text of the response the harness is writing, at most every `partialIntervalMs`. */
  const say = (text: string) =>
    Effect.suspend(() => {
      partial += text
      const now = runtime.now()
      if (now - flushedAt < api.settings().progress.partialIntervalMs) return Effect.void
      flushedAt = now
      const message = assistantMessage(
        adapter.api,
        provider,
        modelId,
        now,
        [{ type: "text", text: partial }],
        "partial",
        "stop",
      )
      return Effect.asVoid(
        commit((tx) =>
          Effect.map(tx.doc(LiveDoc, conversationId), (live) => {
            live.generation = { attempt: 1, message: message as never }
            return undefined
          }),
        ),
      )
    })

  const handle = (frame: Frame): Effect.Effect<Ended | undefined, unknown> =>
    Effect.gen(function* () {
      switch (frame.type) {
        case "text":
          saidAnything = true
          yield* say(frame.delta)
          return undefined
        case "said":
          saidAnything = true
          yield* transcript.said(frame.content, frame.response, frame.at)
          return undefined
        case "results":
          if (yield* transcript.results(frame)) yield* steer
          return resetQueued ? ({ _tag: "reset" } as const) : undefined
        case "subagent":
          yield* transcript.host(frame)
          return undefined
        case "command":
          yield* transcript.hostCommand(frame)
          return undefined
        case "reset":
          // The session goes on under the id the next frames carry (F13); a new context starts.
          yield* commit((tx) =>
            Effect.map(tx.appendEntry(conversationId, { kind: "pi.reset", head: "self" }), (entry) => {
              lastEntry = entry.id
              return undefined
            }),
          )
          return undefined
        case "spent":
          yield* spent(frame.usage)
          return undefined
        case "answered":
          ended = { _tag: "answered", answer: lastEntry, turnLimit: frame.turnLimit }
          return undefined
        case "began":
          // Until its own `answered`, a process that exits ended the run, not the turn before it.
          ended = undefined
          return undefined
        case "idle":
          return ended
        case "failed":
          return frame.gone && !saidAnything ? { _tag: "gone" } : failure(frame.message)
      }
    })

  const report = (made: JobReport) =>
    Effect.asVoid(commit((tx) => Effect.as(appendReport(tx, conversationId, made, runtime.now()), undefined)))

  return {
    handle,
    report,
    get ended() {
      return ended
    },
    compacted,
    ...transcript.callbacks,
  }
}
