// What sigma commits of one conversation a harness process writes to: the run's own, or a hosted subagent's, which
// its `hosted.job` task writes (D1). Each commits through its own task: its texts, its calls and their results, the
// questions it asks a person, and the jobs it starts. A call the harness runs itself is committed before its
// `beforeRun` callback returns, so the intent is durable before the effect; a question for a person waits on
// `sigma.approvals`, keyed `<task>/<call>`. In member mode a call of sigma's own tools, which the harness makes through
// sigma (`runOwn`), runs as a `pi.tool` task of the run, as in sigma's own loop.
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
  ToolTask,
  type ToolTaskResult,
  UserEntry,
} from "@sigma/harness"
import type { AnyTask, ConversationId, EntryId, EntryRecord, JsonObject, TaskId, TaskRuntime, Tx } from "@sigma/kernel"
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage, Usage } from "@sigma/models"
import { Deferred, Effect, Option, Stream } from "effect"
import type { Adapter, Callbacks, Frame, Part } from "./adapter.ts"
import { recordJob } from "./jobs.ts"
import type { Job, JobLinks } from "./links.ts"

/**
 * What a run in member mode has of sigma (D9): what the model must read after each call of sigma's tools, such as a
 * computer behind the conversation that changed (D6).
 */
export type Member = {
  readonly notice: Effect.Effect<string | undefined>
}

/** The entry that places a hosted subagent's conversation in its parent's transcript. */
export const SUBAGENT_ENTRY_KIND = "sigma.subagent"

export type SubagentEntry = { call: string; conversation: number; title: string; agentType?: string }

/** What a call the harness asked a person about gets when they deny it. */
export const DENIED = "the person did not allow this call"

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** An assistant message as a harness's responses are committed: their usage is the process's, at its result. */
export const assistantMessage = (
  api: string,
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
      api,
      provider,
      model,
      responseId,
      usage: ZERO_USAGE,
      stopReason: stop,
      timestamp,
    },
    { omitUndefinedProperties: true },
  ) as unknown as JsonObject

/** The tasks a conversation hosts its jobs with, and where their jobs are handed over. */
export type Hosting = {
  /** `hosted.job`: the run of a subagent's conversation. */
  readonly job: AnyTask<any>
  /** `hosted.command`: a background command, in the background of the conversation that started it. */
  readonly command: AnyTask<any>
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
  /** The harness writing it. */
  readonly adapter: Adapter
  readonly provider: string
  readonly modelId: string
  readonly hosting: Hosting
  /** The job the process made for a subagent the harness started, by the call that started it; once. */
  readonly started: (call: string) => Job
  /** The run's own conversation: its entries move its position. A job's has none. */
  readonly position?: Position
  /** A run in member mode; a job has none, since member mode offers no Agent tool. */
  readonly member?: Member
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
  const { runtime, api, agent, commit, serially, adapter, provider, modelId, position } = scope
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
    assistantMessage(adapter.api, provider, modelId, runtime.now(), content, responseId, stop)

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

  /** The tool tasks of own tools' calls, by call. */
  const tools = new Map<string, TaskId<ToolTaskResult>>()

  /**
   * Commits a call once, with the arguments it runs with. `runs` gives an own tool's call the tool task that runs it:
   * only Claude Code's MCP call does, so a call Claude Code failed before making it is committed with its result alone.
   */
  const recordNow = (seen: Sighting, input: unknown, runs = false) =>
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
            let tool: TaskId<ToolTaskResult> | undefined
            if (runs) {
              tool = yield* tx.createTask(
                ToolTask,
                { kind: "model", assistant: entry.id, callId: call.id },
                // Owned by the run, in whose conversation the tool task finds the call and adds its result.
                { ownership: { kind: "task", taskId: task }, abandonOnRestart: true },
              )
              tools.set(call.id, tool)
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
          return call
        }),
      )
    })
  const record = (seen: Sighting, input: unknown = seen.call.arguments, runs = false) =>
    serially(recordNow(seen, input, runs))

  /** Commits a call's result as the harness reported it. */
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
  const ask = (call: ToolCall) =>
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

  /**
   * Commits each call the harness runs itself before it runs, so the intent is durable before the effect. The harness
   * runs it with `asked.arguments`, which it may have normalized, such as a path made absolute.
   */
  const beforeRun: Callbacks["beforeRun"] = (asked, signal) =>
    run(Effect.asVoid(Effect.flatMap(sighted(asked), (seen) => record(seen, asked.arguments))), signal)

  const approve: Callbacks["approve"] = (asked, signal) =>
    run(
      Effect.gen(function* () {
        const seen = yield* sighted(asked)
        if (yield* autoApproved) return true
        const call = yield* record(seen, asked.arguments)
        return yield* ask({ ...call, arguments: asked.arguments })
      }),
      signal,
    )

  /** Commits the texts of a message and sights its calls, which their callbacks or results commit. */
  const said = (content: ReadonlyArray<Part>, responseId: string, at?: string) =>
    Effect.gen(function* () {
      for (const part of content) {
        if (part.type === "text") yield* recordText(part.text, responseId, at)
        else yield* sight({ call: part, response: responseId, ...(at === undefined ? {} : { at }) })
      }
    })

  /**
   * Moves the position to `at`, through the newest result the tool tasks of own calls `ids` committed. Tasks running in
   * parallel commit in any order, so the newest, not the last named, is the one the session holds through.
   */
  const ownResults = (ids: ReadonlyArray<string>, at: string) =>
    commit((tx) =>
      Effect.gen(function* () {
        const live = yield* tx.doc(LiveDoc, conversationId)
        const entries = (live.tools ?? []).flatMap((slot) =>
          ids.includes(slot.callId) && slot.entry !== undefined ? [slot.entry] : [],
        )
        if (entries.length === 0 || position === undefined) return undefined
        const newest = entries.reduce((a, b) => (Number(b) > Number(a) ? b : a))
        return yield* position(tx, live, at, newest, "result")
      }),
    )

  /** Commits the results of a frame; whether any of them was the result of a call of this conversation. */
  const results = (frame: Extract<Frame, { type: "results" }>) =>
    Effect.gen(function* () {
      let anyResult = false
      // An own call's result is committed by its tool task. The session holds it once the harness writes it here, so
      // the position moves past it, and a resume does not retell it as cut off.
      const own: string[] = []
      for (const result of frame.results) {
        const id = result.call
        if (answered.has(id)) {
          anyResult = true
          own.push(id)
          continue
        }
        if (!Deferred.isDoneUnsafe(sighting(id))) continue
        const seen = yield* Deferred.await(sighting(id))
        const call = yield* recordNow(seen, seen.call.arguments)
        anyResult = true
        answered.add(id)
        yield* recordResult(call, result.text, result.isError, frame.at)
      }
      if (own.length > 0 && position !== undefined && frame.at !== undefined) yield* ownResults(own, frame.at)
      return anyResult
    })

  /**
   * Hosts a subagent the harness started as a conversation of its own, under this one, which its `hosted.job` task
   * writes (D1). A background anchor owns the conversation of a run's subagent; a job owns its subagent's own.
   */
  const host = (frame: Extract<Frame, { type: "subagent" }>) =>
    Effect.gen(function* () {
      // The call that started it comes first in this conversation.
      if (Deferred.isDoneUnsafe(sighting(frame.call))) {
        yield* recordNow(yield* Deferred.await(sighting(frame.call)), undefined)
      }
      const auto = yield* autoApproved
      const job = scope.started(frame.call)
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
          // A background subagent of the run is one of its conversation's jobs (D3).
          const reported = main && frame.background
          hosted = yield* tx.createTask(
            scope.hosting.job,
            {
              call: frame.call,
              title: frame.description,
              task: frame.task,
              harness: adapter.name,
              ...(reported ? { parent: Number(conversationId) } : {}),
            },
            { ownership: { kind: "conversation" }, conversationId: created.id, abandonOnRestart: true },
          )
          job.conversation = Number(created.id)
          if (reported) {
            yield* recordJob(tx, conversationId, {
              task: frame.task,
              kind: "agent",
              title: frame.description,
              call: frame.call,
              conversation: Number(created.id),
              taskId: Number(hosted),
              state: "working",
            })
          }
          yield* recordOrigin(tx, created.id, {
            call: frame.call,
            title: frame.description,
            ...(frame.agentType === undefined ? {} : { agentType: frame.agentType }),
          })
          const live = yield* tx.doc(LiveDoc, created.id)
          live.run = { taskId: hosted, inputs: [], turns: 0 }
          if (auto) yield* approveAutomatically(tx, created.id)
          const prompt = { role: "user", content: frame.prompt ?? "", timestamp: runtime.now() }
          yield* tx.appendEntry(UserEntry, created.id, { model: [prompt as unknown as JsonObject] })
          const data: SubagentEntry = {
            call: frame.call,
            conversation: Number(created.id),
            title: frame.description,
            ...(frame.agentType === undefined ? {} : { agentType: frame.agentType }),
          }
          yield* tx.appendEntry(conversationId, { kind: SUBAGENT_ENTRY_KIND, data })
          return undefined
        }),
      )
      const { hosting, started } = scope
      yield* Deferred.succeed(hosting.links.link(hosted!), {
        job,
        from: { agent, adapter, provider, modelId, hosting, started },
      })
    })

  /**
   * Hosts a background command the run's harness started as a `hosted.command` task in the background of this
   * conversation, which ends the command's job when the harness says it ended, or cuts it off (D6).
   */
  const hostCommand = (frame: Extract<Frame, { type: "command" }>) =>
    Effect.gen(function* () {
      const job = scope.started(frame.call)
      let hosted: TaskId | undefined
      yield* commit((tx) =>
        Effect.gen(function* () {
          hosted = yield* tx.createTask(
            scope.hosting.command,
            { task: frame.task, harness: adapter.name },
            {
              ownership: { kind: "conversation" },
              conversationId,
              background: true,
              abandonOnRestart: true,
            },
          )
          yield* recordJob(tx, conversationId, {
            task: frame.task,
            kind: "command",
            title: frame.description,
            call: frame.call,
            taskId: Number(hosted),
            state: "working",
          })
          return undefined
        }),
      )
      const { hosting, started } = scope
      yield* Deferred.succeed(hosting.links.link(hosted!), {
        job,
        from: { agent, adapter, provider, modelId, hosting, started },
      })
    })

  /**
   * Runs an own tool's call: commits it with its tool task, waits for the task, and answers with the result it
   * committed, followed by what the model must read now (`Member.notice`).
   */
  const runOwn: Callbacks["runOwn"] = (id, name, input, signal) =>
    run(
      Effect.gen(function* () {
        const seen = yield* Deferred.await(sighting(id))
        yield* record(seen, input, true)
        const tool = tools.get(id)
        tools.delete(id)
        if (tool === undefined) {
          return { content: [{ type: "text" as const, text: `${name} is already running` }], isError: true }
        }
        const settled = yield* runtime.waitForTask(tool)
        const outcome = settled.state.outcome
        let entry: EntryRecord | undefined
        // A failed or aborted call has the result it committed too, which says why, as a completed one does.
        const result = "result" in outcome ? outcome.result : undefined
        if (result?.kind === "model") {
          const id = result.entryId
          yield* commit((tx) => Effect.map(tx.entry(id), (found) => void (entry = found)))
        }
        const message = entry?.model?.[0] as ToolResultMessage | undefined
        const notice = yield* scope.member?.notice ?? Effect.succeed(undefined)
        const told: TextContent[] = notice === undefined ? [] : [{ type: "text", text: notice }]
        if (message === undefined) {
          return {
            content: [{ type: "text" as const, text: `${name} ended ${outcome.status}` }, ...told],
            isError: true,
          }
        }
        return { content: [...message.content, ...told], isError: message.isError ?? true }
      }),
      signal,
    )

  /** The callbacks for this conversation's calls. */
  const callbacks: Callbacks = { beforeRun, approve, runOwn }

  return { callbacks, said, results, host, hostCommand, recordText }
}

export type Transcript = ReturnType<typeof makeTranscript>
