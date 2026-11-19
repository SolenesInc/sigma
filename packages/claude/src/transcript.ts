// What sigma commits of one conversation a Claude Code process writes to: the run's own, or a hosted subagent's, which
// its `claude.job` task writes (D1). Each commits through its own task: its texts, its calls and their results, the
// questions it asks a person, the extensions' hooks on its calls, and the subagents it starts. A call Claude Code runs
// itself is committed before its PreToolUse hook is answered, so the intent is durable before the effect; an
// extension's tool reached through sigma's MCP server runs as a `pi.tool` task; a question for a person waits on
// `sigma.approvals`, keyed `<task>/<call>`.
import type { HookCallback, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { copyJson } from "@sigma/delta/json"
import type { Draft } from "@sigma/delta"
import {
  type Agent,
  agentHooks,
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
  ToolTask,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolHooks,
  type ToolTaskResult,
  UserEntry,
} from "@sigma/harness"
import type { AnyTask, ConversationId, EntryId, EntryRecord, JsonObject, TaskId, TaskRuntime, Tx } from "@sigma/kernel"
import type { AssistantMessage, ToolCall, Usage } from "@sigma/models"
import { Cause, Deferred, Effect, Option, Stream } from "effect"
import type { Job, JobLinks } from "./links.ts"
import { textOf } from "./retell.ts"

/** The callbacks Claude Code makes for the calls of one conversation. */
export interface Callbacks {
  readonly preToolUse: HookCallback
  readonly postToolUse: HookCallback
  readonly canUseTool: NonNullable<Options["canUseTool"]>
  readonly runOwn: (name: string) => (input: unknown, extra: unknown) => Promise<McpResult>
}

type McpPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
export type McpResult = { content: McpPart[]; isError: boolean }

export type OwnTool = Agent["tools"][number]

/** The entry that places a hosted subagent's conversation in its parent's transcript. */
export const SUBAGENT_ENTRY_KIND = "sigma.subagent"

export type SubagentEntry = { call: string; conversation: number; title: string; agentType?: string }

/** What a call Claude Code asked a person about gets when they deny it. */
export const DENIED = "the person did not allow this call"

export const OWN_TOOL = "mcp__sigma__"

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export const toolName = (name: string) => (name.startsWith(OWN_TOOL) ? name.slice(OWN_TOOL.length) : name)

/** The extensions' tool hooks: `beforeTool` ones and `afterTool` ones. */
export const toolHooksOf = (agent: Agent) => {
  const all = agentHooks(agent, ToolTask.definition.name).map(({ extension, handlers }) => ({
    extension,
    handlers: handlers as Partial<ToolHooks>,
  }))
  return {
    before: all.filter(({ handlers }) => typeof handlers.beforeTool === "function"),
    after: all.filter(({ handlers }) => typeof handlers.afterTool === "function"),
  }
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

/** A tool result as MCP carries it: its text and its images, whose shape MCP shares with sigma's. */
const mcpContent = (content: unknown): McpPart[] => {
  if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? "") }]
  return (content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>).flatMap(
    (part): McpPart[] =>
      part.type === "text"
        ? [{ type: "text", text: part.text ?? "" }]
        : part.type === "image"
          ? [{ type: "image", data: part.data!, mimeType: part.mimeType! }]
          : [],
  )
}

const toolUseOf = (extra: unknown) => {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta
  return meta?.["claudecode/toolUseId"] as string | undefined
}

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
  /** Tools offered to Claude Code over sigma's MCP server, by name. */
  readonly own: ReadonlyMap<string, OwnTool>
  readonly provider: string
  readonly modelId: string
  readonly hosting: Hosting
  /** The process's job for a subagent Claude Code started, by its task id. */
  readonly jobOf: (task: string) => Job
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
  const { runtime, api, agent, commit, serially, own, provider, modelId, position } = scope
  const conversationId = runtime.conversationId
  const task = runtime.taskId
  const main = position !== undefined
  const sightings = new Map<string, Deferred.Deferred<Sighting>>()
  const recorded = new Map<string, ToolCall>()
  const answered = new Set<string>()
  /** The response whose calls the conversation's slots show. */
  let response: string | undefined
  const { before: toolHooks, after: afterHooks } = toolHooksOf(agent)

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

  /** Commits a call once, with the arguments it runs with; an own tool's call also gets its tool task. */
  const recordNow = (seen: Sighting, input: unknown) =>
    Effect.suspend(() => {
      const known = recorded.get(seen.call.id)
      if (known) return Effect.succeed({ call: known, task: undefined as TaskId<ToolTaskResult> | undefined })
      const call: ToolCall = { ...seen.call, arguments: (input ?? {}) as ToolCall["arguments"] }
      let tool: TaskId<ToolTaskResult> | undefined
      return Effect.as(
        commit((tx) =>
          Effect.gen(function* () {
            const live = yield* tx.doc(LiveDoc, conversationId)
            respond(live, seen.response)
            const entry = yield* tx.appendEntry(AssistantEntry, conversationId, {
              model: [assistant([call], seen.response, "toolUse")],
            })
            if (own.has(call.name)) {
              tool = yield* tx.createTask(
                ToolTask,
                { kind: "model", assistant: entry.id, callId: call.id },
                // Owned in the conversation the call is in, where the tool task finds it and adds its result.
                { ownership: { kind: "task", taskId: task }, abandonOnRestart: true },
              )
              answered.add(call.id)
            }
            // Assigned whole: a draft records an array it is given, not what is pushed to it afterwards.
            live.tools = [
              ...(live.tools ?? []),
              { callId: call.id, name: call.name, status: "running", ...(tool === undefined ? {} : { taskId: tool }) },
            ]
            if (main && live.run?.taskId === task && response === seen.response) live.run.first ??= entry.id
            return position === undefined ? undefined : yield* position(tx, live, seen.at, entry.id, "call")
          }),
        ),
        undefined,
      ).pipe(
        Effect.map(() => {
          recorded.set(call.id, call)
          return { call, task: tool }
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

  /** The `beforeTool` chain of the conversation's extensions: the first block wins, otherwise arguments chain. */
  const beforeTool = (call: ToolHookCall) =>
    Effect.gen(function* () {
      let args = call.arguments as JsonObject
      for (const { extension, handlers } of toolHooks) {
        const decided = yield* Effect.exit(handlers.beforeTool!({ ...call, arguments: args }, api.hookApi))
        if (decided._tag === "Failure") {
          if (runtime.signal.aborted || Cause.hasInterruptsOnly(decided.cause)) {
            return yield* Effect.failCause(decided.cause)
          }
          const error = Cause.squash(decided.cause)
          api.report(error, { kind: "extension", extension })
          // A failing hook blocks the call, as in sigma's own tool task.
          return { block: error instanceof Error ? error.message : String(error) }
        }
        if (decided.value?.block !== undefined) return { block: decided.value.block }
        if (decided.value?.arguments !== undefined) args = decided.value.arguments
      }
      return { arguments: args }
    })

  const run = <A>(effect: Effect.Effect<A, unknown>, signal: AbortSignal | undefined) =>
    Effect.runPromise(effect, signal === undefined ? undefined : { signal })

  const preToolUse: HookCallback = async (input, _toolUseID, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {}
    // An own tool's task runs the hooks and asks, as in sigma's own loop.
    if (own.has(toolName(input.tool_name)) && input.tool_name.startsWith(OWN_TOOL)) return {}
    const asked: ToolCall = {
      type: "toolCall",
      id: input.tool_use_id,
      name: toolName(input.tool_name),
      arguments: input.tool_input as ToolCall["arguments"],
    }
    return run(
      Effect.gen(function* () {
        const seen = yield* sighted(asked)
        const checked = yield* beforeTool({ ...seen.call, arguments: asked.arguments })
        if ("block" in checked) {
          const { call } = yield* record(seen, asked.arguments)
          answered.add(asked.id)
          const refused = `Tool call blocked: ${checked.block}`
          yield* serially(recordResult(call, refused, true, undefined))
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: refused,
            },
          }
        }
        yield* record(seen, checked.arguments)
        return JSON.stringify(checked.arguments) === JSON.stringify(asked.arguments)
          ? {}
          : {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                updatedInput: checked.arguments as Record<string, unknown>,
              },
            }
      }),
      signal,
    )
  }

  /**
   * The `afterTool` chain over what one of Claude Code's own tools returned, each hook given the result before it. A
   * failing hook is reported and leaves the result as it was.
   */
  const afterTool = (call: ToolHookCall, result: ToolExecutionResult) =>
    Effect.gen(function* () {
      let current = result
      for (const { extension, handlers } of afterHooks) {
        const changed = yield* Effect.exit(handlers.afterTool!(call, current, api.hookApi))
        if (changed._tag === "Failure") {
          if (runtime.signal.aborted || Cause.hasInterruptsOnly(changed.cause)) {
            return yield* Effect.failCause(changed.cause)
          }
          api.report(Cause.squash(changed.cause), { kind: "extension", extension })
        } else if (changed.value !== undefined) current = changed.value
      }
      return current
    })

  /**
   * Hands what Claude Code's own tool returned to the extensions' `afterTool`. Claude Code takes a changed output
   * only as the tool's own result object; for `Read`, whose object carries the file's text, sigma swaps that text
   * (F15). Another tool's result is given to the hooks as `final`: their change cannot reach Claude.
   */
  const postToolUse: HookCallback = async (input, _toolUseID, { signal }) => {
    if (input.hook_event_name !== "PostToolUse" || input.tool_name.startsWith(OWN_TOOL)) return {}
    const response = input.tool_response as { type?: string; file?: { content?: unknown } } | string | undefined
    const read = typeof response === "object" && typeof response?.file?.content === "string"
    const text =
      typeof response === "string" ? response : read ? (response!.file!.content as string) : JSON.stringify(response)
    const call: ToolHookCall = {
      type: "toolCall",
      id: input.tool_use_id,
      name: input.tool_name,
      arguments: input.tool_input as ToolCall["arguments"],
    }
    // Only a Read's text can be swapped; the hooks are told when what they change cannot reach Claude.
    const given = { output: [{ type: "text" as const, text }], ...(read ? {} : { final: true as const }) }
    const after = await run(afterTool(call, given), signal)
    const changed = textOf(after.output ?? [])
    if (changed === text) return {}
    if (!read) {
      api.report(new Error(`afterTool changed ${input.tool_name}'s result, but Claude Code keeps its own result`), {
        kind: "extension",
      })
      return {}
    }
    const updated = { ...(response as object), file: { ...(response as { file: object }).file, content: changed } }
    return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: updated } }
  }

  const canUseTool: NonNullable<Options["canUseTool"]> = async (tool, input, { signal, toolUseID }) => {
    const allow = { behavior: "allow" as const, updatedInput: input, toolUseID }
    if (tool.startsWith(OWN_TOOL)) return allow
    const asked: ToolCall = {
      type: "toolCall",
      id: toolUseID,
      name: toolName(tool),
      arguments: input as ToolCall["arguments"],
    }
    const allowed = await run(
      Effect.gen(function* () {
        const seen = yield* sighted(asked)
        if (yield* autoApproved) return true
        const { call } = yield* record(seen, input)
        return yield* approve({ ...call, arguments: input as ToolCall["arguments"] })
      }),
      signal,
    )
    if (allowed) return allow
    return { behavior: "deny", message: DENIED, toolUseID }
  }

  const runOwn = (name: string) => async (input: unknown, extra: unknown) =>
    run(
      Effect.gen(function* () {
        const id = toolUseOf(extra)
        if (id === undefined) {
          return {
            content: [{ type: "text" as const, text: `Claude Code called ${name} without a call id` }],
            isError: true,
          }
        }
        const seen = yield* Deferred.await(sighting(id))
        const { task: tool } = yield* record(seen, input)
        if (tool === undefined) {
          return { content: [{ type: "text" as const, text: `${name} is already running` }], isError: true }
        }
        const settled = yield* runtime.waitForTask(tool)
        const outcome = settled.state.outcome
        // A subagent's result is in its own conversation, which only a commit reads; one that writes nothing is not stored.
        let entry: EntryRecord | undefined
        if (outcome.status === "completed" && outcome.result.kind === "model") {
          const id = outcome.result.entryId
          yield* commit((tx) => Effect.map(tx.entry(id), (found) => void (entry = found)))
        }
        const message = entry?.model?.[0] as { content?: unknown; isError?: boolean } | undefined
        if (message === undefined) {
          return { content: [{ type: "text" as const, text: `${name} ended ${outcome.status}` }], isError: true }
        }
        return { content: mcpContent(message.content), isError: message.isError ?? true }
      }),
      (extra as { signal?: AbortSignal } | undefined)?.signal,
    )

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
              name: toolName(block.name),
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
        const { call } = yield* recordNow(seen, seen.call.arguments)
        anyResult = true
        answered.add(id)
        yield* recordResult(call, handback || textOf(block.content), block.is_error === true, at)
      }
      return anyResult
    })

  /**
   * Hosts a subagent Claude Code started as a conversation of its own, under this one: a background anchor here owns
   * it, so this conversation's run can end while it works (F6), and its `claude.job` task writes it (D1).
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
          const anchor = yield* tx.createTask(scope.hosting.anchor, null, {
            ownership: { kind: "conversation" },
            conversationId,
            background: true,
          })
          const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: anchor } })
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
      const { hosting, jobOf } = scope
      yield* Deferred.succeed(hosting.links.link(hosted!), {
        job: jobOf(frame.task_id),
        from: { agent, own, provider, modelId, hosting, jobOf },
      })
    })

  /** The callbacks for this conversation's calls. */
  const callbacks: Callbacks = { preToolUse, postToolUse, canUseTool, runOwn }

  return { callbacks, said, results, host, recordText }
}

export type Transcript = ReturnType<typeof makeTranscript>
