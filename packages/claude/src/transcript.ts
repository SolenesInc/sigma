// What sigma commits of one conversation a Claude Code process writes to: the run's own, or a hosted subagent's, which
// its `claude.job` task writes (D1). Each commits through its own task: its texts, its calls and their results, the
// questions it asks a person, and the subagents it starts. A call Claude Code runs itself is committed before its
// PreToolUse hook is answered, so the intent is durable before the effect; a question for a person waits on
// `sigma.approvals`, keyed `<task>/<call>`.
import type { HookCallback, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { copyJson } from "@sigma/delta/json"
import type { Draft } from "@sigma/delta"
import {
  type Agent,
  APPROVALS_KIND,
  ApprovalsDoc,
  appendToolResult,
  approveAutomatically,
  AssistantEntry,
  finishSlot,
  LiveDoc,
  type LiveState,
  recordOrigin,
  removeApproval,
  type TaskApi,
  UserEntry,
} from "@sigma/harness"
import type { AnyTask, ConversationId, EntryId, JsonObject, TaskId, TaskRuntime, Tx } from "@sigma/kernel"
import type { AssistantMessage, ToolCall, Usage } from "@sigma/models"
import { Deferred, Effect, Option, Stream } from "effect"
import type { Job, JobLinks } from "./links.ts"
import { textOf } from "./retell.ts"

/** The callbacks Claude Code makes for the calls of one conversation. */
export interface Callbacks {
  readonly preToolUse: HookCallback
  readonly canUseTool: NonNullable<Options["canUseTool"]>
}

/** The entry that places a hosted subagent's conversation in its parent's transcript. */
export const SUBAGENT_ENTRY_KIND = "sigma.subagent"

export type SubagentEntry = { call: string; conversation: number; title: string; agentType?: string }

/** What a call Claude Code asked a person about gets when they deny it. */
export const DENIED = "the person did not allow this call"

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** An assistant message as Claude Code's responses are committed: their usage is the process's, at its result. */
export const assistantMessage = (
  provider: string,
  model: string,
  timestamp: number,
  content: AssistantMessage["content"],
  responseId: string,
  stop: "stop" | "toolUse",
) =>
  copyJson(
    {
      role: "assistant",
      content,
      api: "claude-code",
      provider,
      model,
      responseId,
      usage: ZERO_USAGE,
      stopReason: stop,
      timestamp,
    },
    { omitUndefinedProperties: true },
  ) as unknown as JsonObject

/** A frame that starts a subagent: Claude Code's `task_started` for a `local_agent`. */
export type Started = {
  readonly task_id: string
  readonly tool_use_id: string
  readonly description: string
  readonly subagent_type?: string
  readonly prompt?: string
}

/** The tasks a conversation hosts its subagents with, and where their jobs are handed over. */
export type Hosting = {
  /** `claude.job`: the run of a subagent's conversation. */
  readonly job: AnyTask<any>
  /** The background task that owns a subagent's conversation in its parent (F6). */
  readonly anchor: AnyTask<any>
  readonly links: JobLinks
}

/** A commit that moves the run's position: the run's own conversation records one, a job's none. */
export type Position = (
  tx: Tx,
  live: Draft<LiveState>,
  at: string | undefined,
  entry: EntryId,
  what: "text" | "call" | "result",
) => Effect.Effect<unknown, unknown>

/** The conversation a transcript writes, and the task it writes through. */
export type TranscriptScope = {
  readonly runtime: TaskRuntime<any, any, any>
  readonly api: TaskApi
  readonly agent: Agent
  /** Commits through the task; what `body` returns is the task's next state, if any. */
  readonly commit: (body: (tx: Tx) => Effect.Effect<unknown, unknown>) => Effect.Effect<unknown, unknown>
  /** Runs `effect` alone among this conversation's frames and callbacks. */
  readonly serially: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly provider: string
  readonly modelId: string
  readonly hosting: Hosting
  /** The job the process made for a subagent Claude Code started, by the Agent call that started it; once. */
  readonly started: (call: string) => Job
  /** The run's own conversation: its entries move its position. A job's has none. */
  readonly position?: Position
}

/** Removes every approval request the task `task` keyed in the conversation: `<task>/<call>`. */
export const expireApprovals = (tx: Tx, conversationId: ConversationId, task: TaskId) =>
  Effect.map(tx.doc(ApprovalsDoc, conversationId), (doc) => {
    for (const key of Object.keys(doc.requests)) if (key.startsWith(`${task}/`)) delete doc.requests[key]
  })

/** A call seen in an assistant frame or a hook, before it is committed. */
type Sighting = { readonly call: ToolCall; readonly response: string; readonly at?: string }

/** The transcript of the conversation `scope` writes. */
export const makeTranscript = (scope: TranscriptScope) => {
  const { runtime, api, agent, commit, serially, provider, modelId, position } = scope
  const conversationId = runtime.conversationId
  const task = runtime.taskId
  const main = position !== undefined
  const sightings = new Map<string, Deferred.Deferred<Sighting>>()
  const recorded = new Map<string, ToolCall>()
  const answered = new Set<string>()
  /** The response whose calls the conversation's slots show. */
  let response: string | undefined

  const sighting = (id: string) => {
    let seen = sightings.get(id)
    if (!seen) sightings.set(id, (seen = Deferred.makeUnsafe<Sighting>()))
    return seen
  }
  const sight = (seen: Sighting) => Deferred.succeed(sighting(seen.call.id), seen)

  const assistant = (content: AssistantMessage["content"], responseId: string, stop: "stop" | "toolUse") =>
    assistantMessage(provider, modelId, runtime.now(), content, responseId, stop)

  /** Starts a new response's slots: the calls of the response before it are done, so they go. */
  const respond = (live: Draft<LiveState>, next: string) => {
    if (response === next) return
    response = next
    if (live.tools !== undefined) {
      live.tools = live.tools.filter((slot) => slot.status !== "done")
      if (live.tools.length === 0) delete live.tools
    }
  }

  /** Commits one text block of a response. */
  const recordText = (text: string, responseId: string, at: string | undefined) =>
    commit((tx) =>
      Effect.gen(function* () {
        const live = yield* tx.doc(LiveDoc, conversationId)
        respond(live, responseId)
        const entry = yield* tx.appendEntry(AssistantEntry, conversationId, {
          model: [assistant([{ type: "text", text }], responseId, "stop")],
        })
        return position === undefined ? undefined : yield* position(tx, live, at, entry.id, "text")
      }),
    )

  /** Commits a call once, with the arguments it runs with. */
  const recordNow = (seen: Sighting, input: unknown) =>
    Effect.suspend(() => {
      const known = recorded.get(seen.call.id)
      if (known) return Effect.succeed(known)
      const call: ToolCall = { ...seen.call, arguments: (input ?? {}) as ToolCall["arguments"] }
      return Effect.as(
        commit((tx) =>
          Effect.gen(function* () {
            const live = yield* tx.doc(LiveDoc, conversationId)
            respond(live, seen.response)
            const entry = yield* tx.appendEntry(AssistantEntry, conversationId, {
              model: [assistant([call], seen.response, "toolUse")],
            })
            // Assigned whole: a draft records an array it is given, not what is pushed to it afterwards.
            live.tools = [...(live.tools ?? []), { callId: call.id, name: call.name, status: "running" }]
            if (main && live.run?.taskId === task && response === seen.response) live.run.first ??= entry.id
            return position === undefined ? undefined : yield* position(tx, live, seen.at, entry.id, "call")
          }),
        ),
        undefined,
      ).pipe(
        Effect.map(() => {
          recorded.set(call.id, call)
          return call
        }),
      )
    })
  const record = (seen: Sighting, input: unknown = seen.call.arguments) => serially(recordNow(seen, input))

  /** Commits a call's result as Claude Code reported it. */
  const recordResult = (call: ToolCall, text: string, isError: boolean, at: string | undefined) =>
    commit((tx) =>
      Effect.gen(function* () {
        const entry = yield* appendToolResult(
          tx,
          conversationId,
          call,
          { output: [{ type: "text", text }], isError },
          { timestamp: runtime.now() },
        )
        const live = yield* tx.doc(LiveDoc, conversationId)
        const slot = live.tools?.find((each) => each.callId === call.id)
        if (slot !== undefined) {
          finishSlot(slot)
          slot.entry = entry.id
        }
        yield* removeApproval(tx, conversationId, `${task}/${call.id}`)
        return position === undefined ? undefined : yield* position(tx, live, at, entry.id, "result")
      }),
    )

  /**
   * The call as sighted. A subagent's callback can come before its assistant frame, so in a subagent's conversation
   * the callback sights the call itself; the run's waits for its frame.
   */
  const sighted = (call: ToolCall) =>
    Effect.gen(function* () {
      if (!main) yield* sight({ call, response: response ?? call.id })
      return yield* Deferred.await(sighting(call.id))
    })

  const autoApproved = Effect.map(runtime.snapshot(ApprovalsDoc, conversationId), (doc) => doc?.auto === true)

  /** Asks a person about the call in the conversation's `sigma.approvals`, and waits for the first answer. */
  const approve = (call: ToolCall) =>
    Effect.scoped(
      Effect.gen(function* () {
        const key = `${task}/${call.id}`
        yield* commit((tx) =>
          Effect.map(tx.doc(ApprovalsDoc, conversationId), (doc) => {
            if (!Object.hasOwn(doc.requests, key)) {
              doc.requests[key] = {
                callId: call.id,
                tool: call.name,
                arguments: call.arguments as JsonObject,
                at: runtime.now(),
              }
            }
            return undefined
          }),
        )
        const watch = yield* api.watchDoc(ApprovalsDoc, conversationId)
        if (watch === undefined) return yield* Effect.die(new Error(`${APPROVALS_KIND} is missing`))
        const now = watch.value.requests[key]?.answer
        if (now !== undefined) return now.allow
        const next = yield* watch.changes.pipe(
          Stream.map((change) => change.value.requests[key]?.answer),
          Stream.filter((answer) => answer !== undefined),
          Stream.runHead,
        )
        if (Option.isNone(next)) return yield* Effect.interrupt
        return next.value!.allow
      }),
    )

  const run = <A>(effect: Effect.Effect<A, unknown>, signal: AbortSignal | undefined) =>
    Effect.runPromise(effect, signal === undefined ? undefined : { signal })

  /** Commits each call Claude Code runs itself before it runs, so the intent is durable before the effect. */
  const preToolUse: HookCallback = async (input, _toolUseID, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {}
    const asked: ToolCall = {
      type: "toolCall",
      id: input.tool_use_id,
      name: input.tool_name,
      arguments: input.tool_input as ToolCall["arguments"],
    }
    return run(
      Effect.map(
        // Claude Code runs the call with these arguments, which it may have normalized, such as a path made absolute.
        Effect.flatMap(sighted(asked), (seen) => record(seen, asked.arguments)),
        () => ({}),
      ),
      signal,
    )
  }

  const canUseTool: NonNullable<Options["canUseTool"]> = async (tool, input, { signal, toolUseID }) => {
    const allow = { behavior: "allow" as const, updatedInput: input, toolUseID }
    const asked: ToolCall = {
      type: "toolCall",
      id: toolUseID,
      name: tool,
      arguments: input as ToolCall["arguments"],
    }
    const allowed = await run(
      Effect.gen(function* () {
        const seen = yield* sighted(asked)
        if (yield* autoApproved) return true
        const call = yield* record(seen, input)
        return yield* approve({ ...call, arguments: input as ToolCall["arguments"] })
      }),
      signal,
    )
    if (allowed) return allow
    return { behavior: "deny", message: DENIED, toolUseID }
  }

  /** Commits the texts of an assistant frame and sights its calls, which their hooks or results commit. */
  const said = (content: AssistantMessage["content"] | ReadonlyArray<any>, responseId: string, at?: string) =>
    Effect.gen(function* () {
      for (const block of content) {
        if (block.type === "text") yield* recordText(block.text, responseId, at)
        else if (block.type === "tool_use") {
          yield* sight({
            call: {
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: block.input as ToolCall["arguments"],
            },
            response: responseId,
            ...(at === undefined ? {} : { at }),
          })
        }
      }
    })

  /** Commits the results of a user frame; whether any of them was the result of a call of this conversation. */
  const results = (message: Extract<SDKMessage, { type: "user" }>, at: string | undefined) =>
    Effect.gen(function* () {
      if (!Array.isArray(message.message.content)) return false
      // An Agent call whose subagent handed back its report gets a placeholder as its result; the frame's
      // `tool_use_result` holds the report, which the SDK's types do not declare yet. Keeping the report means
      // a retelling of the conversation, to a new session or another provider, still has it.
      const handback = (message as { tool_use_result?: { handbackReport?: { text?: string } } }).tool_use_result
        ?.handbackReport?.text
      let anyResult = false
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue
        const id = block.tool_use_id
        if (answered.has(id)) {
          anyResult = true
          continue
        }
        if (!Deferred.isDoneUnsafe(sighting(id))) continue
        const seen = yield* Deferred.await(sighting(id))
        const call = yield* recordNow(seen, seen.call.arguments)
        anyResult = true
        answered.add(id)
        yield* recordResult(call, handback || textOf(block.content), block.is_error === true, at)
      }
      return anyResult
    })

  /**
   * Hosts a subagent Claude Code started as a conversation of its own, under this one, which its `claude.job` task
   * writes (D1). A background anchor owns the conversation of a run's subagent; a job owns its subagent's own.
   */
  const host = (frame: Started) =>
    Effect.gen(function* () {
      // The Agent call that started it comes first in this conversation.
      if (Deferred.isDoneUnsafe(sighting(frame.tool_use_id))) {
        yield* recordNow(yield* Deferred.await(sighting(frame.tool_use_id)), undefined)
      }
      const auto = yield* autoApproved
      let hosted: TaskId | undefined
      yield* commit((tx) =>
        Effect.gen(function* () {
          // The run's subagents are background work, so the run can end while they work (F6). A subagent's own
          // subagents are its job's, so stopping it stops them too.
          const owner = main
            ? yield* tx.createTask(scope.hosting.anchor, null, {
                ownership: { kind: "conversation" },
                conversationId,
                background: true,
              })
            : task
          const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: owner } })
          hosted = yield* tx.createTask(
            scope.hosting.job,
            { call: frame.tool_use_id, title: frame.description },
            { ownership: { kind: "conversation" }, conversationId: created.id, abandonOnRestart: true },
          )
          yield* recordOrigin(tx, created.id, {
            call: frame.tool_use_id,
            title: frame.description,
            ...(frame.subagent_type === undefined ? {} : { agentType: frame.subagent_type }),
          })
          const live = yield* tx.doc(LiveDoc, created.id)
          live.run = { taskId: hosted, inputs: [], turns: 0 }
          if (auto) yield* approveAutomatically(tx, created.id)
          const prompt = { role: "user", content: frame.prompt ?? "", timestamp: runtime.now() }
          yield* tx.appendEntry(UserEntry, created.id, { model: [prompt as unknown as JsonObject] })
          const data: SubagentEntry = {
            call: frame.tool_use_id,
            conversation: Number(created.id),
            title: frame.description,
            ...(frame.subagent_type === undefined ? {} : { agentType: frame.subagent_type }),
          }
          yield* tx.appendEntry(conversationId, { kind: SUBAGENT_ENTRY_KIND, data })
          return undefined
        }),
      )
      const { hosting, started } = scope
      yield* Deferred.succeed(hosting.links.link(hosted!), {
        job: started(frame.tool_use_id),
        from: { agent, provider, modelId, hosting, started },
      })
    })

  /** The callbacks for this conversation's calls. */
  const callbacks: Callbacks = { preToolUse, canUseTool }

  return { callbacks, said, results, host, recordText }
}

export type Transcript = ReturnType<typeof makeTranscript>
