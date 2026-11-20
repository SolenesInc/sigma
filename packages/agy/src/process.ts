// One `agy acp` process as the hosted run's connection: Antigravity's CLI serving one session over the Agent Client
// Protocol, translated into the hosted run's frames in the order `agy` says things. What the frames mean for a run, a
// job or a wake is `@sigma/hosted`'s; this file only says what `agy` did (s-7bmc8w D3, D4).
//
// What each ACP event becomes (plot s-5r0qqa, Design):
//   agent_message_chunk           text; the text so far is said at the next call or at the turn's end
//   tool_call                     said, with the call's arguments (F45), and `beforeRun`, so the call is committed
//   request_permission            `approve`: allow_once, or reject_once and the call's result is DENIED (D9)
//   tool_call_update completed    results; for a call still in_progress at a turn's end, that job's end (D12)
//   a prompt's result             what the turn spent; with no prompt left outstanding, the turn is over
//   Stop hook for the session     the end of a turn `agy` began by itself, which no prompt's result ends (D12)
//   the first update outside a turn that is not a job's end    woke
// A turn ended by a denial or by `session/cancel` fires no Stop (measured on 1.5.13), so a prompt's result is a
// turn-over too; the Stop hook is what ends a wake.
import {
  type Adapter,
  type Connection,
  DENIED,
  type Frame,
  type Host,
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
import { openStopHook } from "./hook.ts"

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
}

type Event =
  | { readonly type: "acp"; readonly item: Incoming }
  | { readonly type: "stop"; readonly session: string }
  | { readonly type: "exit"; readonly why: string }
  | { readonly type: "prompt"; readonly id: string; readonly said: ReadonlyArray<Said> }
  | { readonly type: "decided"; readonly request: number | string; readonly allow: boolean | undefined }
  | { readonly type: "interrupt" }
  | { readonly type: "stop-job"; readonly job: string }

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
export const openConnection = (config: ProcessConfig<AgySettings>, start: Start, host: Host) =>
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

    void (async () => {
      for await (const item of acp.incoming) events.push({ type: "acp", item })
      events.push({ type: "exit", why: await acp.exited })
    })()
    void (async () => {
      for await (const stopped of hook.stops) events.push({ type: "stop", session: stopped })
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
        const loading = acp.request("session/load", { sessionId: start.session, cwd, mcpServers: [], ...directories })
        const loaded = await loading.answer
        if (loaded.error) return { failure: failedOpen(loaded, true) }
        return { replayEnds: loading.id }
      }
      const made = await acp.call("session/new", {
        cwd,
        mcpServers: [],
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
      let text = ""
      let responses = 0
      let positions = 0
      let spent = { ...ZERO }
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

      /** Shows the run a call `agy` announced, once, and commits it before it runs. */
      const sight = (update: Json): Frame[] => {
        const id = String(update.toolCallId)
        if (calls.has(id)) return []
        const name = String(update.name ?? update.title ?? "tool")
        const call: ToolCall = {
          type: "toolCall",
          id,
          name,
          arguments: (update.rawInput ?? update.args ?? {}) as ToolCall["arguments"],
        }
        calls.set(id, { call, title: String(update.title ?? name) })
        const said = [...flush(), { type: "said", response: responseId(), at: at(), content: [call as Part] } as Frame]
        responses++
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
          if (known.job) continue
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
        const out: Frame[] = []
        for (const [id, known] of calls) {
          if (known.job) continue
          if (known.refused)
            out.push({ type: "results", at: at(), results: [{ call: id, text: DENIED, isError: true }] })
          calls.delete(id)
        }
        return out
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
            // A job's progress is not a turn of agy's own (not seen from 1.5.13, whose commands report only their end).
            if (known?.job && status !== "completed" && status !== "failed") return []
            if (status !== "completed" && status !== "failed") return [...wake(), ...sight(change)]
            if (known?.job) {
              // A job's end: news from outside the turn, which the hosted process reports (D2).
              calls.delete(id)
              hushed = false
              const ended = known.stopped ? "stopped" : status === "completed" ? "completed" : "failed"
              const summary = outputOf(change)
              return [{ type: "job-ended", id, status: ended, ...(summary === "" ? {} : { summary }) }]
            }
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
        const out = [...wake(), ...sight(change)]
        const aborted = new AbortController()
        asking.set(id, { params, aborted })
        const call = calls.get(String(change.toolCallId))!.call
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
            // The end of a turn agy began by itself. One sigma prompted ends at its result, which follows.
            if (event.session === session && turn && prompts.size === 0) yield* turnOver(false)
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

/** `agy` as a harness of the hosted run; `settings` says how the `agy` of a provider instance starts. */
export const agyAdapter = (settings: (provider: string) => AgySettings | undefined): Adapter<AgySettings> => ({
  kind: AGY_RUN_KIND,
  name: NAME,
  api: "agy",
  settings,
  open: openConnection,
})
