// What one `claude.run` does with the frames of the Claude Code process serving it: the frames of its own
// conversation, turned into commits through the run's task, and the subagents Claude Code starts in it, hosted as
// conversations of their own. A subagent's frames and callbacks go to its `claude.job` task, which writes its
// conversation (D1); `transcript.ts` is what both write a conversation with.
import type { HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
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
import type { Usage } from "@sigma/models"
import { Effect } from "effect"
import type { Job } from "./links.ts"
import { promptOf, type Said } from "./retell.ts"
import { ClaudeSessionDoc } from "./session.ts"
import {
  assistantMessage,
  type Callbacks,
  type Hosting,
  makeTranscript,
  type Member,
  type Position,
} from "./transcript.ts"

/** How a run ended: it answered, the session is gone, Claude Code failed, or its process exited. */
export type Ended =
  | { readonly _tag: "answered"; readonly answer: EntryId | undefined; readonly turnLimit: boolean }
  | { readonly _tag: "gone" }
  | { readonly _tag: "failed"; readonly message: string }
  /** The process exited before Claude Code took the run's opening: a live process lost while idle, or one that never started. */
  | { readonly _tag: "exited"; readonly message: string }
  /** A reset was queued while the run worked: the run ends before it, and the next run starts in its context. */
  | { readonly _tag: "reset" }

export const failure = (message: string): Ended => ({ _tag: "failed", message })

export type ClaudeRunCheckpoint = { phase: "converse"; at?: string }

type Runtime = TaskRuntime<Record<string, never>, ClaudeRunCheckpoint, { entryId?: EntryId }>
type Next = NextTaskState<ClaudeRunCheckpoint, { entryId?: EntryId }>

/** The run a process serves. */
export type RunContext = {
  readonly runtime: Runtime
  readonly api: TaskApi
  readonly agent: Agent
  /** The tasks its subagents are hosted with. */
  readonly hosting: Hosting
  /** A run of a remote conversation, in member mode (D9). */
  readonly member?: Member
}

/** What a run reaches of the process serving it. */
export interface ServingProcess {
  /** Claude Code's session, which `/clear` moves to a new id. */
  readonly session: string
  /** `/clear` started a new context whose session id no frame carried yet. */
  readonly resetting: boolean
  /** A message the process was sent has not come back as a replay yet. */
  readonly awaitingReplay: boolean
  readonly send: (parts: ReadonlyArray<Said>, priority?: "next") => void
  /** Runs `effect` alone among the process's frames and the run's callbacks. */
  readonly serially: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  /** What each model spent since the process's previous result, from its running totals (F11). */
  readonly spent: (modelUsage: ModelUsage) => ReadonlyArray<readonly [model: string, usage: Usage]>
  /** The job the process made for a subagent Claude Code started, by the Agent call that started it; once. */
  readonly started: (call: string) => Job
}

export type ModelUsage = Record<
  string,
  {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
  }
>

/** What a process hands the run it serves: the frames and callbacks of the run's own conversation. */
export interface Serving extends Callbacks {
  /** Commits what a frame says; a frame that ends the run returns how. */
  readonly handle: (message: SDKMessage) => Effect.Effect<Ended | undefined, unknown>
  readonly postCompact: HookCallback
}

/** Claude Code's errors for a session it does not have, or a position its session does not hold (F12). */
const SESSION_GONE = /No conversation found|No message found with message\.uuid/

/** The run `ctx` served by `process`. */
export const makeServing = (ctx: RunContext, process: ServingProcess): Serving => {
  const { runtime, api, agent } = ctx
  const conversationId = runtime.conversationId
  const provider = agent.model?.provider ?? ""
  const modelId = agent.model?.modelId ?? ""
  let saidAnything = false
  let lastEntry: EntryId | undefined
  let partial = ""
  let flushedAt = 0
  let resetQueued = false

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
      if (at === undefined || process.awaitingReplay || process.resetting) return undefined
      const doc = yield* tx.doc(ClaudeSessionDoc, conversationId)
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
    hosting: ctx.hosting,
    started: process.started,
    position,
    ...(ctx.member === undefined ? {} : { member: ctx.member }),
  })

  /** Claude Code's summary of its own compaction, mirrored as a compaction entry that starts a new context. */
  const postCompact: HookCallback = async (input, _toolUseID, { signal }) => {
    if (input.hook_event_name !== "PostCompact") return {}
    await Effect.runPromise(
      process.serially(
        commit((tx) =>
          Effect.gen(function* () {
            const summary = { role: "user", content: input.compact_summary, timestamp: runtime.now() }
            const entry = yield* tx.appendEntry(CompactionEntry, conversationId, {
              head: "self",
              model: [summary as unknown as JsonObject],
              data: { reason: input.trigger === "manual" ? "manual" : "threshold" },
            })
            lastEntry = entry.id
            // The session holds its compaction: only what comes after it is news to a resume.
            const doc = yield* tx.doc(ClaudeSessionDoc, conversationId)
            if (doc.current?.session === process.session) doc.current.seen = Number(entry.id)
            return undefined
          }),
        ),
      ),
      signal === undefined ? undefined : { signal },
    )
    return {}
  }

  /**
   * Places the steers waiting in the inbox after a round of results, and hands them to Claude Code. A queued reset
   * ends the run instead, as in sigma's own loop: the session Claude Code holds is the context the reset cuts.
   */
  const steer = commit((tx) =>
    Effect.gen(function* () {
      const boundary = yield* prepareBoundary(tx, conversationId, api.settings())
      if (hasQueuedReset(boundary.inbox.items)) {
        resetQueued = true
        return undefined
      }
      const prompts = new Map(
        boundary.inbox.items.flatMap((item) =>
          item.mode === "steer" ? [[item.id, promptOf(item.content as unknown)] as const] : [],
        ),
      )
      const { users } = yield* applyBoundary(tx, boundary, "postTools", runtime.now())
      if (users.length === 0) return undefined
      const live = yield* tx.doc(LiveDoc, conversationId)
      if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users)
      process.send(
        users.flatMap((id) => prompts.get(id) ?? []),
        "next",
      )
      return undefined
    }),
  )

  /** Adds what the process spent since its last result to `pi.usage`, keyed by provider and model (F16). */
  const spent = (modelUsage: ModelUsage) =>
    commit((tx) =>
      Effect.gen(function* () {
        for (const [model, added] of process.spent(modelUsage)) {
          if (added.totalTokens > 0 || added.cost.total > 0) {
            yield* recordUsage(tx, conversationId, "models", `${provider}/${model}`, added)
          }
        }
        return undefined
      }),
    )

  /** Commits the partial text of the response Claude Code is writing, at most every `partialIntervalMs`. */
  const say = (text: string) =>
    Effect.suspend(() => {
      partial += text
      const now = runtime.now()
      if (now - flushedAt < api.settings().progress.partialIntervalMs) return Effect.void
      flushedAt = now
      const message = assistantMessage(provider, modelId, now, [{ type: "text", text: partial }], "partial", "stop")
      return Effect.asVoid(
        commit((tx) =>
          Effect.map(tx.doc(LiveDoc, conversationId), (live) => {
            live.generation = { attempt: 1, message: message as never }
            return undefined
          }),
        ),
      )
    })

  const handle = (message: SDKMessage): Effect.Effect<Ended | undefined, unknown> =>
    Effect.gen(function* () {
      switch (message.type) {
        case "stream_event": {
          const event = message.event
          if (
            message.parent_tool_use_id === null &&
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            saidAnything = true
            yield* say(event.delta.text)
          }
          return undefined
        }
        case "assistant": {
          // A subagent the process routed to no job: a run hosts each one it was told of.
          if (message.parent_tool_use_id !== null) return undefined
          const content = message.message.content
          if (message.error) {
            const text = content.map((block) => (block.type === "text" ? block.text : "")).join("")
            return failure(text || `Claude Code failed: ${message.error}`)
          }
          saidAnything = true
          yield* transcript.said(content, message.message.id, message.uuid)
          return undefined
        }
        case "user": {
          if (message.parent_tool_use_id !== null) return undefined
          if (yield* transcript.results(message, message.uuid || undefined)) yield* steer
          return resetQueued ? ({ _tag: "reset" } as const) : undefined
        }
        case "system": {
          if (message.subtype === "task_started" && message.tool_use_id && message.task_type === "local_agent") {
            yield* transcript.host({
              task_id: message.task_id,
              tool_use_id: message.tool_use_id,
              description: message.description,
              ...(message.subagent_type === undefined ? {} : { subagent_type: message.subagent_type }),
              ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
            })
          }
          return undefined
        }
        case "conversation_reset": {
          // `/clear`: the session goes on under the id the next frames carry (F13); a new context starts.
          yield* commit((tx) =>
            Effect.map(tx.appendEntry(conversationId, { kind: "pi.reset", head: "self" }), (entry) => {
              lastEntry = entry.id
              return undefined
            }),
          )
          return undefined
        }
        case "result": {
          if (message.subtype !== "success" || message.is_error) {
            const errors = "errors" in message ? message.errors : []
            if (!saidAnything && errors.some((error) => SESSION_GONE.test(error))) return { _tag: "gone" }
            const text = "result" in message && message.result ? message.result : errors.join("; ")
            return failure(text || `Claude Code stopped: ${message.subtype}`)
          }
          yield* spent(message.modelUsage)
          if (process.awaitingReplay) return undefined
          return {
            _tag: "answered",
            answer: lastEntry,
            turnLimit: (message as { terminal_reason?: string }).terminal_reason === "max_turns",
          }
        }
        default:
          return undefined
      }
    })

  return { handle, postCompact, ...transcript.callbacks }
}
