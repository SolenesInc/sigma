// One `agy acp` process as the hosted run's connection: Antigravity's CLI serving one session over the Agent Client
// Protocol, translated into the hosted run's frames in the order `agy` says things. What the frames mean for a run, a
// job or a wake is `@sigma/hosted`'s; this file only says what `agy` did (s-7bmc8w D3, D4).
//
// What each ACP event becomes (plot s-5r0qqa, Design):
//   agent_message_chunk           text; the text so far is said at the next call or at the turn's end
//   tool_call                     said, with the call's arguments (F45), and `beforeRun`, so the call is committed
//   request_permission            `approve`: allow_once, or reject_once and the call's result is DENIED (D9); an own
//                                 tool's is allowed at once, since its tool task asks (F18)
//   tool_call_update completed    results; for a call still in_progress at a turn's end, that job's end (D12)
//   a prompt's result             what the turn spent; with no prompt left outstanding, the turn is over
//   Stop hook for the session     the end of a turn `agy` began by itself, which no prompt's result ends (D12), at
//                                 the answer to a request sent once the Stop is read, which follows all `agy` said
//                                 before it (`hook.ts`)
//   the first update outside a turn that is not a job's end    woke
// A turn ended by a denial or by `session/cancel` fires no Stop (measured on 1.5.13), so a prompt's result is a
// turn-over too; the Stop hook is what ends a wake.
//
// Sigma's own tools (`ProcessConfig.own`) reach agy over MCP through the bridge (D14), as `mcp_sigma_<name>`. A
// `tools/call` carries no call id, so it is paired with the ACP call agy announced first with the same name and
// arguments (F43), less the `toolSummary` agy adds to every call it announces (measured on 1.5.13).
import {
  type Adapter,
  type Connection,
  DENIED,
  type Frame,
  type Host,
  type OwnResult,
  Inbox,
  isMember,
  type Part,
  type ProcessConfig,
  type Said,
  type Selection,
  type Start,
} from "@sigma/hosted"
import type { ToolCall, Usage } from "@sigma/models"
import { Effect } from "effect"
import { type Acp, type Answer, type Incoming, INITIALIZE, type Json, SIGN_IN, signedOut, startAcp } from "./acp.ts"
import { type BridgeCall, type BridgeOptions, openBridge } from "./bridge.ts"
import { openStopHook, type Stop } from "./hook.ts"

/** How an `agy` instance is started: its executable, environment and extra arguments to `agy acp`. */
export interface AgySettings {
  /** Default: `agy` on the server's PATH. */
  readonly executable?: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
}

/** How long a closing process waits for `session/close`: a tripwire. agy 1.5.13 answered it in 1 ms, three of three. */
const CLOSE_PATIENCE_MS = 5_000

/** The name `agy` is shown by. */
const NAME = "agy"

/**
 * What a read Stop asks `agy`, to learn where the Stop falls in what it says: a method `agy` does not know, which it
 * answers at once with -32601, also while it waits for its Stop hook (measured on 1.5.13).
 */
const PLACE_STOP = "sigma/place_stop"

/** The prefix `agy` gives the tools of sigma's MCP server, which it names `sigma` (F17). */
const OWN_TOOL = "mcp_sigma_"

/** What `agy` adds to the arguments of every call it announces, and does not pass to an MCP tool (1.5.13). */
const SUMMARY = "toolSummary"

/** Why an `agy` subagent's call of sigma's tools is refused: it has no conversation of its own in sigma. */
const SUBAGENT_REFUSAL = "sigma's tools serve the agent the person talks to, not a subagent it started"

/** The longest `agy` lets an MCP call take is 180 s (F28); an own tool returns within this, as `wait_worker` does (D15). */
const OWN_TOOL_LIMIT = "150 seconds"

/** What a job's call says until its end: `agy` runs it on after its turn ended (F40). */
export const IN_BACKGROUND = "still running in the background; its end comes as a report"

/** Why a remote conversation cannot run on `agy` (D18). */
export const remoteRefusal = (target: string) =>
  `agy runs only on the server's machine: its tools act where agy runs, so a conversation on the target ${target} cannot use it`

/** The command and environment a process of `settings` starts with. */
export const commandOf = (settings: AgySettings, cwd: string, extra: Readonly<Record<string, string>> = {}) => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value
  return {
    executable: settings.executable ?? "agy",
    args: settings.args ?? [],
    env: { ...env, ...settings.env, ...extra },
    cwd,
  }
}

/** A call `agy` announced, until its end. */
type Call = {
  readonly call: ToolCall
  readonly title: string
  /** Sigma answered its permission request with a denial. */
  refused?: boolean
  /** It was still running when its turn ended: a job, whose end is its completed or failed update (D12). */
  job?: boolean
  /** A person stopped the job. */
  stopped?: boolean
  /** One of sigma's own tools, which its `tools/call` runs, unless the bridge has paired it with one already. */
  own?: "waiting" | "paired"
}

type Event =
  | { readonly type: "acp"; readonly item: Incoming }
  | { readonly type: "stop"; readonly stop: Stop }
  | { readonly type: "exit"; readonly why: string }
  | { readonly type: "prompt"; readonly id: string; readonly said: ReadonlyArray<Said> }
  | { readonly type: "decided"; readonly request: number | string; readonly allow: boolean | undefined }
  | { readonly type: "interrupt" }
  | { readonly type: "stop-job"; readonly job: string }
  | { readonly type: "own"; readonly request: BridgeCall; readonly done: (result: OwnResult) => void }

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** The text of a finished call's output, as `agy` reports it. */
const outputOf = (update: Json) => {
  const content = Array.isArray(update.content) ? update.content : []
  const text = content.map((part: Json) => String(part?.content?.text ?? "")).join("")
  return text || String(update.rawOutput?.output ?? "")
}

/** The ACP prompt of what sigma says: its texts and images. */
const promptOf = (said: ReadonlyArray<Said>) =>
  said.map((part) =>
    typeof part === "string"
      ? { type: "text", text: part }
      : { type: "image", data: part.data, mimeType: part.mimeType },
  )

/**
 * Starts `agy acp` at `start`, as a connection; it is closed with the scope, after `session/close`, which ends the
 * daemon commands `agy` would otherwise leave running (s-7bmc8w F7).
 */
export const openConnection = (config: ProcessConfig<AgySettings>, start: Start, host: Host, bridge: BridgeOptions) =>
  Effect.gen(function* () {
    const { agent, settings } = config
    const output = new Inbox<Frame>()
    if (isMember(agent)) {
      output.push({ type: "failed", message: remoteRefusal(agent.target!) })
      output.close()
      return inert(output)
    }
    const hook = yield* openStopHook
    const events = new Inbox<Event>()
    const own = new Set(config.own.map((tool) => tool.name))
    /** Sigma's name of a tool agy calls: one of sigma's own loses its MCP prefix. */
    const named = (tool: string) =>
      tool.startsWith(OWN_TOOL) && own.has(tool.slice(OWN_TOOL.length)) ? tool.slice(OWN_TOOL.length) : undefined
    const mcpServers =
      config.own.length === 0
        ? []
        : [
            {
              ...(yield* openBridge(
                bridge,
                config.own.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.parameters,
                })),
                (request) => new Promise((done) => events.push({ type: "own", request, done })),
              )).server,
              env: [],
            },
          ]
    const cwd = agent.cwd ?? process.cwd()
    const acp: Acp = yield* Effect.acquireRelease(
      Effect.sync(() => startAcp(commandOf(settings, cwd, { SIGMA_ROOT_CONVERSATION: config.rootConversation }))),
      (acp) => Effect.promise(() => close(acp)),
    )
    let session = start._tag === "resume" ? start.session : ""
    let selected: { modelId?: string; effort?: string } = {}
    /** Resolves once the session is open, with why it is not when it failed. */
    let opened: (failure: Frame | undefined) => void = () => undefined
    const ready = new Promise<Frame | undefined>((done) => (opened = done))

    const close = async (process: Acp) => {
      closing = true
      // The tripwire covers the open too: an agy that never finishes loading must not hold the server's stop.
      let timer: ReturnType<typeof setTimeout> | undefined
      const patience = new Promise<"late">((done) => (timer = setTimeout(() => done("late"), CLOSE_PATIENCE_MS)))
      const opened = await Promise.race([ready, patience])
      if (session !== "" && opened === undefined)
        await Promise.race([process.call("session/close", { sessionId: session }), patience])
      clearTimeout(timer)
      process.kill()
      events.close()
    }
    let closing = false
    /** Whether the session opened: undefined while it opens. */
    let isOpen: boolean | undefined

    void (async () => {
      for await (const item of acp.incoming) events.push({ type: "acp", item })
      events.push({ type: "exit", why: await acp.exited })
    })()
    void (async () => {
      for await (const stop of hook.stops) {
        // A Stop while the session opens ends no turn sigma knows of, and agy may wait on it to answer the open.
        if (isOpen === undefined) stop.done()
        else events.push({ type: "stop", stop })
      }
    })()

    /** Opens the session; the id of the request whose answer ends `agy`'s replay of a loaded session (F22). */
    const open = async (): Promise<{ failure?: Frame; replayEnds?: number }> => {
      const initialized = await acp.call("initialize", INITIALIZE)
      if (initialized.error)
        return { failure: { type: "failed", message: `agy did not start: ${initialized.error.message}` } }
      if (start._tag === "fork") {
        // agy cannot fork a session (F4): the conversation starts a session of its own, told what came before.
        return { failure: { type: "failed", message: "agy cannot fork a session", gone: true } }
      }
      const directories = { additionalDirectories: [hook.dir] }
      if (start._tag === "resume") {
        const loading = acp.request("session/load", { sessionId: start.session, cwd, mcpServers, ...directories })
        const loaded = await loading.answer
        if (loaded.error) return { failure: failedOpen(loaded, true) }
        return { replayEnds: loading.id }
      }
      const made = await acp.call("session/new", {
        cwd,
        mcpServers,
        ...directories,
        // Measured on 1.5.13: this key reaches the model, and `_meta.systemPrompt.append` does not (F25).
        ...(config.instructions === undefined
          ? {}
          : { _meta: { antigravity: { systemPrompt: { append: config.instructions } } } }),
      })
      if (made.error) return { failure: failedOpen(made, false) }
      session = String(made.result?.sessionId ?? "")
      return {}
    }

    async function* frames(): AsyncGenerator<Frame> {
      const { failure, replayEnds } = await open()
      opened(failure)
      isOpen = failure === undefined
      if (failure !== undefined) {
        yield failure
        acp.kill()
        return
      }
      /** The updates of a loaded session's replay, which sigma already holds, are dropped until this answer (F22). */
      let replaying = replayEnds
      const calls = new Map<string, Call>()
      /** The prompts sent and not answered, by their request ids. */
      const prompts = new Set<number>()
      /** `agy` is in a turn: one sigma prompted, or one it began by itself (`waking`). */
      let turn = false
      let waking = false
      /**
       * A wake a person stopped: agy fires no Stop for a cancel, so what it had in flight is dropped instead of
       * waking the conversation again, until it is next prompted or a job ends.
       */
      let hushed = false
      /** Calls from a stopped wake can report their end after a job or a prompt lets agy speak again. */
      const cancelledWakeCalls = new Set<string>()
      let text = ""
      let responses = 0
      let positions = 0
      let spent = { ...ZERO }
      /** The Stops of the session read and not yet placed, by the id of the request that places each. */
      const placing = new Map<number, Stop>()
      /** The permission requests not answered yet, by their ids. */
      const asking = new Map<number | string, { readonly params: Json; readonly aborted: AbortController }>()

      const at = () => `${session}/${++positions}`
      const responseId = () => `${session}/r${responses}`

      /** The turn's text so far, said as one message. */
      const flush = (): Frame[] => {
        if (text === "") return []
        const said: Frame = { type: "said", response: responseId(), at: at(), content: [{ type: "text", text }] }
        text = ""
        return [said]
      }

      /** An update outside a turn that is not a job's end: `agy` began a turn by itself (s-7bmc8w D4). */
      const wake = (): Frame[] => {
        if (turn) return []
        hushed = false
        turn = true
        waking = true
        return [{ type: "woke" }]
      }

      /** The `tools/call`s the bridge took that no announced call matched yet, oldest first. */
      const unpaired: Array<Extract<Event, { type: "own" }>> = []

      /** Runs a `tools/call` as the announced call `id`, through the tool task `runOwn` gives it (F18). */
      const runOwn = (id: string, { request, done }: Extract<Event, { type: "own" }>) => {
        calls.get(id)!.own = "paired"
        void host
          .callbacks(undefined, request.signal)
          .then((callbacks) => callbacks.runOwn(id, calls.get(id)!.call.name, request.arguments, request.signal))
          .then(done, (error) => done({ content: [{ type: "text", text: String(error) }], isError: true }))
      }

      /**
       * The announced own call a `tools/call` is: the first waiting one with its name and arguments (F43), else the
       * first with its name, so arguments agy passes in another form do not leave the call unanswered.
       */
      const pair = (request: BridgeCall) => {
        const wanted = JSON.stringify(request.arguments)
        let named: string | undefined
        for (const [id, known] of calls) {
          if (known.own !== "waiting" || known.call.name !== request.name) continue
          const { [SUMMARY]: _, ...args } = known.call.arguments as Json
          if (JSON.stringify(args) === wanted) return id
          named ??= id
        }
        return named
      }

      /** A `tools/call` the bridge took: run it as the call it pairs with, or hold it until agy announces that call. */
      const ownCall = (event: Extract<Event, { type: "own" }>) => {
        if (event.request.conversation !== undefined && event.request.conversation !== session) {
          event.done({ content: [{ type: "text", text: SUBAGENT_REFUSAL }], isError: true })
          return
        }
        const id = pair(event.request)
        if (id === undefined) unpaired.push(event)
        else runOwn(id, event)
      }

      /** Shows the run a call `agy` announced, once, and commits it before it runs; an own call commits as it runs. */
      const sight = (update: Json): Frame[] => {
        const id = String(update.toolCallId)
        if (calls.has(id)) return []
        const name = String(update.name ?? update.title ?? "tool")
        const ownName = named(name)
        const call: ToolCall = {
          type: "toolCall",
          id,
          name: ownName ?? name,
          arguments: (update.rawInput ?? update.args ?? {}) as ToolCall["arguments"],
        }
        calls.set(id, {
          call,
          title: String(update.title ?? name),
          ...(ownName === undefined ? {} : { own: "waiting" }),
        })
        const said = [...flush(), { type: "said", response: responseId(), at: at(), content: [call as Part] } as Frame]
        responses++
        if (ownName !== undefined) {
          const held = unpaired.findIndex((event) => !event.request.signal.aborted && pair(event.request) === id)
          if (held !== -1) runOwn(id, unpaired.splice(held, 1)[0]!)
          return said
        }
        void host
          .callbacks(undefined)
          .then((callbacks) => callbacks.beforeRun(call))
          .catch(() => undefined)
        return said
      }

      /**
       * The calls `agy` left running to go on with its turn are jobs (D12): it does so once a command outlasts its
       * `WaitMsBeforeAsync`, and says so only by speaking past the call or ending the turn. A refused call's result is
       * the denial.
       */
      const background = (): Frame[] => {
        const out: Frame[] = []
        for (const [id, known] of calls) {
          // An own call is answered within its turn: agy waits for its MCP call, which its tool task ends.
          if (known.job || known.own !== undefined) continue
          if (known.refused) {
            out.push({ type: "results", at: at(), results: [{ call: id, text: DENIED, isError: true }] })
            calls.delete(id)
            continue
          }
          known.job = true
          out.push(
            { type: "job", id, call: id, kind: "command", title: known.title, background: true },
            { type: "results", at: at(), results: [{ call: id, text: IN_BACKGROUND, isError: false }] },
          )
        }
        return out
      }

      /** The calls a cancel or a failure ended: they get no result, so the run records them as interrupted. */
      const cutOff = (): Frame[] => {
        // A held `tools/call` belongs to the turn that ended: agy no longer waits for it.
        for (const held of unpaired.splice(0))
          held.done({ content: [{ type: "text", text: "the turn ended before this call ran" }], isError: true })
        const out: Frame[] = []
        for (const [id, known] of calls) {
          if (known.job) continue
          if (known.refused)
            out.push({ type: "results", at: at(), results: [{ call: id, text: DENIED, isError: true }] })
          if (waking) cancelledWakeCalls.add(id)
          calls.delete(id)
        }
        return out
      }

      /** Keeps late tool events from starting a wake or being committed to the next prompted run. */
      const dropWakeCall = (id: string, ended = false) => {
        if (!hushed && !cancelledWakeCalls.has(id)) return false
        if (ended) cancelledWakeCalls.delete(id)
        else cancelledWakeCalls.add(id)
        return true
      }

      /**
       * The turn is over: its calls still running are jobs, then what it spent and its answer (D12). In a cancelled
       * turn they were cut off instead.
       */
      const turnOver = (turnLimit: boolean, cancelled = false): Frame[] => {
        const out: Frame[] = [...flush(), ...(cancelled ? cutOff() : background())]
        const used = spent
        spent = { ...ZERO }
        if (used.input + used.output + used.cacheRead + used.cacheWrite > 0) {
          const usage: Usage = {
            input: used.input,
            output: used.output,
            cacheRead: used.cacheRead,
            cacheWrite: used.cacheWrite,
            totalTokens: used.total || used.input + used.output + used.cacheRead + used.cacheWrite,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }
          out.push({ type: "spent", usage: [[selected.modelId || NAME, usage]] })
        }
        out.push({ type: "answered", turnLimit }, { type: "idle" })
        turn = false
        waking = false
        return out
      }

      /** What one update says. */
      const update = (params: Json): Frame[] => {
        if (params.sessionId !== session) return []
        const change = params.update as Json
        switch (change?.sessionUpdate) {
          case "agent_message_chunk": {
            const delta = String(change.content?.text ?? "")
            if (hushed && !turn) return []
            const moved = [...wake(), ...background()]
            text += delta
            return [...moved, { type: "text", delta }]
          }
          case "agent_thought_chunk":
            return hushed && !turn ? [] : wake()
          case "tool_call":
          case "tool_call_update": {
            const id = String(change.toolCallId)
            const known = calls.get(id)
            const status = change.status
            const endedCall = status === "completed" || status === "failed"
            if (known?.job) {
              // A job's progress is not a turn of agy's own.
              if (!endedCall) return []
              // A job's end: news from outside the turn, which the hosted process reports (D2).
              calls.delete(id)
              hushed = false
              const ended = known.stopped ? "stopped" : status === "completed" ? "completed" : "failed"
              const summary = outputOf(change)
              return [{ type: "job-ended", id, status: ended, ...(summary === "" ? {} : { summary }) }]
            }
            if (dropWakeCall(id, endedCall)) return []
            if (!endedCall) return [...wake(), ...sight(change)]
            const out = [...wake(), ...sight(change)]
            const refused = calls.get(id)?.refused === true
            calls.delete(id)
            const shown = refused ? DENIED : outputOf(change) || (status === "failed" ? "the call failed" : "")
            out.push({
              type: "results",
              at: at(),
              results: [{ call: id, text: shown, isError: status === "failed" || refused }],
            })
            // A denial ends agy's turn, and fires no Stop: in a turn it began by itself, nothing else would end it.
            if (refused && prompts.size === 0 && waking) out.push(...turnOver(false))
            return out
          }
          default:
            // usage_update follows every model response and says only the context's size (s-7bmc8w F2); the rest
            // are agy's own bookkeeping.
            return []
        }
      }

      const ask = (id: number | string, params: Json): Frame[] => {
        const change = params.toolCall as Json
        const callId = String(change.toolCallId)
        if (dropWakeCall(callId)) {
          acp.reply(id, { outcome: { outcome: "cancelled" } })
          return []
        }
        const out = [...wake(), ...sight(change)]
        if (calls.get(callId)?.own !== undefined) {
          // An own tool's tool task asks a person when the tool asks, so agy's ask is allowed at once (F18).
          const options = (params.options ?? []) as Array<{ optionId: string; kind: string }>
          const allow = options.find((each) => each.kind === "allow_once")?.optionId ?? "allow"
          acp.reply(id, { outcome: { outcome: "selected", optionId: allow } })
          return out
        }
        const aborted = new AbortController()
        asking.set(id, { params, aborted })
        const call = calls.get(callId)!.call
        void host
          .callbacks(undefined)
          .then((callbacks) => callbacks.approve(call, aborted.signal))
          .then(
            (allow) => events.push({ type: "decided", request: id, allow }),
            () => events.push({ type: "decided", request: id, allow: undefined }),
          )
        return out
      }

      /** Answers a permission request: once only, so whatever is remembered is sigma's (D9). */
      const answer = (id: number | string, allow: boolean | undefined) => {
        const waiting = asking.get(id)
        if (waiting === undefined) return
        asking.delete(id)
        const params = waiting.params
        if (allow === undefined) {
          // A cancel answered it: the person's question is withdrawn.
          waiting.aborted.abort()
          return acp.reply(id, { outcome: { outcome: "cancelled" } })
        }
        const options = (params.options ?? []) as Array<{ optionId: string; kind: string }>
        const option = options.find((each) => each.kind === (allow ? "allow_once" : "reject_once"))
        const known = calls.get(String(params.toolCall?.toolCallId))
        if (!allow && known !== undefined) known.refused = true
        acp.reply(id, { outcome: { outcome: "selected", optionId: option?.optionId ?? (allow ? "allow" : "deny") } })
      }

      const cancel = () => {
        acp.notify("session/cancel", { sessionId: session })
        for (const id of [...asking.keys()]) answer(id, undefined)
      }

      for await (const event of events) {
        switch (event.type) {
          case "acp": {
            const item = event.item
            const placed = item.type === "answer" ? placing.get(item.id) : undefined
            if (item.type === "answer" && placed !== undefined) {
              // All `agy` said before the Stop is read: the end of a turn it began by itself. One sigma prompted
              // ends at its result, which `agy` sends once the hook lets it go on.
              placing.delete(item.id)
              if (turn && prompts.size === 0) yield* turnOver(false)
              placed.done()
              continue
            }
            if (replaying !== undefined) {
              if (item.type === "answer" && item.id === replaying) replaying = undefined
              continue
            }
            if (item.type === "notification") {
              if (item.method === "session/update") yield* update(item.params)
            } else if (item.type === "request") {
              if (item.method === "session/request_permission" && item.params.sessionId === session) {
                yield* ask(item.id, item.params)
              } else acp.refuse(item.id, `sigma does not serve ${item.method}`)
            } else if (prompts.delete(item.id)) {
              const result = item.answer
              if (result.error) {
                if (prompts.size === 0) {
                  // What the turn said stays; its calls are cut off, and nothing of it reaches the next run.
                  yield* flush()
                  yield* cutOff()
                  spent = { ...ZERO }
                  turn = false
                  waking = false
                }
                yield { type: "failed", message: `agy failed: ${result.error.message}` }
                continue
              }
              const usage = result.result?.usage as Json | undefined
              spent = {
                input: spent.input + Number(usage?.inputTokens ?? 0),
                output: spent.output + Number(usage?.outputTokens ?? 0),
                cacheRead: spent.cacheRead + Number(usage?.cachedReadTokens ?? 0),
                cacheWrite: spent.cacheWrite + Number(usage?.cachedWriteTokens ?? 0),
                total: spent.total + Number(usage?.totalTokens ?? 0),
              }
              // A prompt a later one steered returns at once; the turn goes on to the newest one's result (F24).
              const stopReason = result.result?.stopReason
              if (prompts.size === 0) yield* turnOver(stopReason === "max_turn_requests", stopReason === "cancelled")
            }
            break
          }
          case "stop":
            // agy waits in the hook until the Stop is placed. A subagent's Stop ends nothing of the session's.
            if (event.stop.session === session)
              placing.set(acp.request(PLACE_STOP, { sessionId: session }).id, event.stop)
            else event.stop.done()
            break
          case "prompt": {
            const sent = acp.request("session/prompt", { sessionId: session, prompt: promptOf(event.said) })
            prompts.add(sent.id)
            turn = true
            waking = false
            hushed = false
            yield { type: "took", id: event.id }
            break
          }
          case "decided":
            answer(event.request, event.allow)
            break
          case "interrupt":
            if (!turn) {
              // Nothing to stop: the turn is already over.
              yield { type: "idle" }
              break
            }
            cancel()
            // A turn agy began by itself has no result to end it, and a cancel fires no Stop.
            if (prompts.size === 0) {
              yield* turnOver(false, true)
              hushed = true
            }
            break
          case "own":
            ownCall(event)
            break
          case "stop-job": {
            const known = calls.get(event.job)
            if (known === undefined) break
            known.stopped = true
            // A job is stopped only while its conversation has no run (interrupt-idle), so no turn is open: a cancel
            // ends agy's background command (s-7bmc8w F7).
            cancel()
            break
          }
          case "exit":
            if (closing) return
            throw new Error(event.why)
        }
      }
    }

    const send = (said: ReadonlyArray<Said>) => {
      const id = crypto.randomUUID()
      void ready.then((failure) => {
        if (failure === undefined) events.push({ type: "prompt", id, said })
      })
      return id
    }

    /** Sets the model and thinking level, after every open: a loaded session answers with agy's default again (F20). */
    const select = (wanted: Selection) =>
      Effect.tryPromise(async () => {
        // A session that did not open says why in its frames.
        if ((await ready) !== undefined) return
        const set = async (configId: string, value: string) => {
          const answered = await acp.call("session/set_config_option", { sessionId: session, configId, value })
          if (answered.error) throw new Error(`agy refused ${configId} ${value}: ${answered.error.message}`)
        }
        if (wanted.modelId !== "" && wanted.modelId !== selected.modelId) {
          await set("model", wanted.modelId)
          // Each model has its own levels, so the level is set again after a switch.
          selected = { modelId: wanted.modelId }
        }
        if (wanted.effort !== undefined && wanted.effort !== selected.effort) {
          await set("thought_level", wanted.effort)
          selected = { ...selected, effort: wanted.effort }
        }
      })

    return {
      frames: frames(),
      get session() {
        return session
      },
      holdsPosition: true,
      send,
      canSelect: () => true,
      select,
      interrupt: async () => events.push({ type: "interrupt" }),
      stopJob: async (job) => events.push({ type: "stop-job", job }),
      lastRequest: undefined,
    } satisfies Connection
  })

/** Why a session did not open: `agy` is signed out, or it no longer has the session it was asked to load. */
const failedOpen = (answer: Answer, loading: boolean): Frame =>
  signedOut(answer)
    ? { type: "failed", message: `agy is not signed in: ${SIGN_IN}` }
    : { type: "failed", message: `agy did not open its session: ${answer.error?.message}`, gone: loading }

/** A connection that only says why it cannot serve. */
const inert = (frames: Inbox<Frame>): Connection => ({
  frames,
  session: "",
  holdsPosition: true,
  send: () => crypto.randomUUID(),
  canSelect: () => true,
  select: () => Effect.void,
  interrupt: async () => undefined,
  stopJob: async () => undefined,
  lastRequest: undefined,
})

/** The task kind of an `agy` conversation's runs. */
export const AGY_RUN_KIND = "agy.run"

/**
 * `agy` as a harness of the hosted run; `settings` says how the `agy` of a provider instance starts, and `bridge` where
 * sigma's own tools are served to it from (D14).
 */
export const agyAdapter = (
  settings: (provider: string) => AgySettings | undefined,
  bridge: BridgeOptions,
): Adapter<AgySettings> => ({
  kind: AGY_RUN_KIND,
  name: NAME,
  api: "agy",
  settings,
  open: (config, start, host) => openConnection(config, start, host, bridge),
  ownToolLimit: OWN_TOOL_LIMIT,
})
