// One Claude Code process, started through the Claude Agent SDK: its query, the inbox it reads its messages from, the
// reader that observes each frame it sends as it arrives and routes it, and the callbacks Claude Code makes. A
// subagent's frames and callbacks go to its job (D1, F7); the rest go to the run it serves, or wait for the next run
// while it serves none. What a run does with its frames is `serving.ts`, what a job does is `job.ts`.
import {
  createSdkMcpServer,
  type EffortLevel,
  type HookCallbackMatcher,
  type HookEvent,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk"
import type { Agent } from "@sigma/harness"
import type { Usage } from "@sigma/models"
import { Cause, Clock, Deferred, type Duration, Effect, Exit, Option, Semaphore } from "effect"
import { z } from "zod"
import { claudeEnvironment, toolSearchSettings } from "./environment.ts"
import { Inbox } from "./inbox.ts"
import { ENDED_WITH_PROCESS, Job, type JobEnd, STOPPED_WITH_RUN } from "./links.ts"
import type { Said } from "./retell.ts"
import {
  type Ended,
  failure,
  makeServing,
  type ModelUsage,
  type RunContext,
  type Serving,
  type ServingProcess,
} from "./serving.ts"
import type { Callbacks } from "./transcript.ts"

/** How a Claude Code instance is started: its executable, environment and extra arguments. */
export interface ClaudeProcessSettings {
  /** Default: the SDK's bundled Claude Code. */
  readonly executable?: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
}

/** Where a process starts in Claude Code's session. */
export type Start =
  /** A new session, named `title` so Claude Code does not ask a model for a name. */
  | { readonly _tag: "fresh"; readonly session: string; readonly title?: string }
  | { readonly _tag: "resume"; readonly session: string; readonly at: string }
  /** A fork of a conversation whose parent held the session: a new session continuing the parent's at `at`. */
  | { readonly _tag: "fork"; readonly from: string; readonly at: string; readonly session: string }

/** What a process is started with. */
export type ProcessConfig = {
  readonly agent: Agent
  readonly settings: ClaudeProcessSettings
  /** The id of the conversation people started, for the `SIGMA_ROOT_CONVERSATION` its commands see. */
  readonly rootConversation: string
  /** A remote conversation's process, in member mode (D9); absent for a local conversation's. */
  readonly member?: MemberProcess
}

/**
 * What a process in member mode starts with: the target's Claude Code folders (D10), and the system prompt's `append`,
 * the conversation's sections as sigma renders them (D11).
 */
export type MemberProcess = {
  readonly folder: { readonly config: string; readonly cwd: string }
  /** Rendered when a process starts, so a live process costs no render. */
  readonly append: Effect.Effect<string | undefined>
}

/**
 * Whether a conversation with this agent runs in member mode: its tools act on a target that is not the server's
 * machine, so Claude Code must not use its own tools, which act on the machine it runs on (D9).
 */
export const isMember = (agent: Agent) => agent.target !== undefined && agent.target !== "local"

/**
 * How long Claude Code waits for a call of sigma's tools in member mode: as long as sigma's bash may run (its largest
 * `timeout`, `MAX_TIMEOUT_SECONDS` in packages/tools' bash.ts), so each tool's own limit, such as bash's 1800 s
 * default, is the one the model sees. Claude Code 2.1.312 waits `MCP_TOOL_TIMEOUT` ms when set, which a person's
 * environment may set lower, and otherwise 1e8 ms (read from its bundle); measured, `MCP_TOOL_TIMEOUT=3000` aborted an
 * 8 s call and the model read `MCP server "sigma" tool "sleep" timed out after 3s`.
 */
const MEMBER_TOOL_TIMEOUT_MS = 2_147_483_647

/** The tools sigma offers Claude Code in member mode: the conversation's, but code mode, which Claude takes no part in. */
export const ownTools = (agent: Agent) => agent.tools.filter((tool) => tool.codeMode !== true)

/** The model and effort a process answers with; `""` and `undefined` leave them to the person's Claude Code settings. */
export type Selection = { readonly modelId: string; readonly effort: EffortLevel | undefined }

export const selectionOf = (agent: Agent): Selection => ({
  modelId: agent.model?.modelId ?? "",
  effort:
    agent.thinkingLevel === "off" || agent.thinkingLevel === undefined
      ? undefined
      : (agent.thinkingLevel as EffortLevel),
})

export interface ClaudeProcess {
  /**
   * Serves the run `run`: switches to the run's model and effort, sends it `opening`, then hands every frame to it
   * until the run ends. A process that exits before Claude Code took the opening ends the run `exited`.
   */
  readonly serve: (run: RunContext, opening: ReadonlyArray<Said>) => Effect.Effect<Ended, unknown>
  /**
   * Whether `serve` can switch the process to `selection`. Claude Code clears a model or effort to its own default,
   * not to the person's settings, so a run that clears either needs a new process (D4).
   */
  readonly canSelect: (selection: Selection) => boolean
  /**
   * Stops the turn of the run it served (D5): interrupts Claude Code and takes the run's frames, handing them to no run,
   * until the turn's result. Succeeds with whether the process can serve another run: it ended the turn within
   * `within`, with nothing left queued and no background work. A stopped run's subagents end with the turn.
   */
  readonly stop: (within: Duration.Input) => Effect.Effect<boolean>
  /** Background work Claude Code started and has not said ended: a background command or subagent (D6). */
  readonly busy: boolean
  /** Completes once the process has exited. */
  readonly exited: Effect.Effect<void>
  /** The cache facts of the newest main-loop request, once one was made (F13). */
  readonly lastRequest: LastRequest | undefined
}

/** What the newest main-loop request left in the prompt cache: when it was made, its context and the cache's TTL. */
export interface LastRequest {
  /** When its response started, by the clock the process was opened with, in milliseconds. */
  readonly at: number
  /** Its whole context in tokens: uncached input, cache reads and cache writes. */
  readonly context: number
  /** How long the cache it wrote lives, from the newest request that wrote one; `undefined` while none has. */
  readonly ttl: "5m" | "1h" | undefined
}

/** What takes the frames that are not a job's: whether a frame was its last, and what the process's end does to it. */
type Taker = {
  readonly frame: (message: SDKMessage) => Effect.Effect<boolean>
  readonly exit: (error: unknown) => void
}

/** One model's running totals in one Claude Code process, as it reports them (`modelUsage`). */
type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

export const bundledExecutable = () => {
  for (const variant of ["", "-musl"]) {
    try {
      return Bun.resolveSync(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${variant}/claude`,
        import.meta.dir,
      )
    } catch {}
  }
  return "claude"
}

/** `--flag value`, `--flag=value` and bare `--flag` arguments as the SDK's `extraArgs`. */
const extraArgs = (args: ReadonlyArray<string>) => {
  const extra: Record<string, string | null> = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (!flag.startsWith("--")) continue
    const [name, joined] = flag.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    const next = args[i + 1]
    if (joined !== undefined) extra[name] = joined
    else if (next !== undefined && !next.startsWith("--")) extra[name] = args[++i]!
    else extra[name] = null
  }
  return extra
}

const userMessage = (parts: ReadonlyArray<Said>, priority?: "next"): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content: parts.map((part) =>
      typeof part === "string"
        ? { type: "text" as const, text: part }
        : {
            type: "image" as const,
            source: { type: "base64" as const, media_type: part.mimeType as "image/png", data: part.data },
          },
    ),
  },
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: "",
  ...(priority ? { priority } : {}),
})

/**
 * The process key: what a process of `config` is spawned with, which a live one cannot change. A run whose key
 * differs from its live process's gets a new process. The model and effort are not in it: `serve` switches them.
 */
export const processKey = (config: ProcessConfig) => {
  const { agent } = config
  return JSON.stringify({
    provider: agent.model?.provider,
    settings: config.settings,
    cwd: agent.cwd,
    target: agent.target,
    maxTurns: agent.maxTurns,
    rootConversation: config.rootConversation,
    ...(isMember(agent)
      ? { own: ownTools(agent).map(({ name, description, parameters }) => ({ name, description, parameters })) }
      : {}),
  })
}

/** Starts a Claude Code process at `start`; it is closed with the scope. */
export const openProcess = (config: ProcessConfig, start: Start) =>
  Effect.gen(function* () {
    const { agent, settings } = config
    const { modelId, effort } = selectionOf(agent)
    const serial = yield* Semaphore.make(1)
    const clock = yield* Clock.Clock
    let lastRequest: LastRequest | undefined
    const inbox = new Inbox<SDKUserMessage>()
    const awaitingReplay = new Set<string>()
    let session = start.session
    /** What Claude Code answers with now: what it was spawned with, then what the last run switched it to. */
    let selected: Selection = { modelId, effort }
    let resetting = false
    // `modelUsage` at this process's previous result: a process reports its own running totals, which a resumed
    // session does not carry over (died_while_idle's second process reports a first turn's cache read again).
    let totals: Record<string, UsageTotals> | undefined
    /** The run the process serves now, which the callbacks of its own conversation reach. */
    let serving: Serving | undefined
    /** The tasks Claude Code started and has not said ended. */
    const tasks = new Set<string>()
    /** The subagents Claude Code started and has not said ended, by task id, and by the Agent call that started each. */
    const jobs = new Map<string, Job>()
    const jobsByCall = new Map<string, Job>()
    /**
     * The job each subagent's start made, by the Agent call that started it, until the conversation that hosts it
     * takes it: a subagent can end before it is hosted, as one a subagent started, or one started while no run served.
     */
    const starts = new Map<string, Job>()
    /** What takes the frames that are not a job's: the run served, or a stop. While none does, they wait in `held`. */
    let taker: Taker | undefined
    const held: SDKMessage[] = []
    /** How the process ended, once the reader read its end: the error its end raised, if it raised one. */
    let ended: { readonly error: unknown } | undefined
    const exit = Deferred.makeUnsafe<void>()

    /** Ends the jobs left working: a subagent lives in its process, and ends with it (D6 of s-evw1pn). */
    const endJobs = (end: JobEnd) => {
      for (const job of jobs.values()) job.inbox.push({ end })
      jobs.clear()
      jobsByCall.clear()
    }

    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.sync(() => {
          inbox.close()
          controller.abort()
          endJobs(ENDED_WITH_PROCESS)
        }),
    )

    const current = () => {
      if (serving === undefined) throw new Error("Claude Code called back while the process served no run")
      return serving
    }

    const jobOf = (task: string) => {
      let job = jobs.get(task)
      if (job === undefined) jobs.set(task, (job = new Job(task, () => messages.stopTask(task))))
      return job
    }
    const until = <A>(effect: Effect.Effect<A>, signal: AbortSignal | undefined) =>
      Effect.runPromise(effect, signal === undefined ? undefined : { signal })
    /** The callbacks of a job's task, once it runs. */
    const jobCallbacks = (job: Job, signal: AbortSignal | undefined): Promise<Callbacks> =>
      until(Deferred.await(job.callbacks), signal)
    /** The callbacks for a call the agent `agentId` makes: a subagent's go to its job, the main loop's to the run. */
    const callbacksOf = async (agentId: string | undefined, signal: AbortSignal | undefined): Promise<Callbacks> =>
      agentId === undefined ? current() : jobCallbacks(jobOf(agentId), signal)

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreToolUse: [
        {
          hooks: [
            async (input, id, options) =>
              (await callbacksOf(input.agent_id, options.signal)).preToolUse(input, id, options),
          ],
        },
      ],
      PostCompact: [{ hooks: [async (...args) => current().postCompact(...args)] }],
    }
    const canUseTool: NonNullable<Options["canUseTool"]> = async (tool, input, options) =>
      (await callbacksOf(options.agentID, options.signal)).canUseTool(tool, input, options)
    const { member } = config
    // In member mode nothing comes from the person's Claude Code settings, and Claude Code's own tools, connectors and
    // folders are off: it acts only through sigma's tools, on the target (D9, D10, Q3).
    const settingSources: SettingSource[] = member === undefined ? ["user", "project", "local"] : []
    const env = {
      ...claudeEnvironment(settings.env),
      SIGMA_ROOT_CONVERSATION: config.rootConversation,
      CLAUDE_AGENT_SDK_CLIENT_APP: "sigma",
      ...(member === undefined
        ? {}
        : {
            CLAUDE_CONFIG_DIR: member.folder.config,
            ENABLE_TOOL_SEARCH: "true",
            ENABLE_CLAUDEAI_MCP_SERVERS: "false",
            MCP_TOOL_TIMEOUT: String(MEMBER_TOOL_TIMEOUT_MS),
          }),
    }
    const toolSearch = member === undefined ? yield* toolSearchSettings(agent.cwd, settingSources, env) : undefined
    const cwd = member === undefined ? agent.cwd : member.folder.cwd
    const append = member === undefined ? agent.instructions : yield* member.append
    const messages = query({
      prompt: inbox,
      options: {
        ...(cwd === undefined ? {} : { cwd }),
        abortController: controller,
        includePartialMessages: true,
        canUseTool,
        hooks,
        settingSources,
        ...(member === undefined
          ? {}
          : {
              // ToolSearch stays so Claude Code can load a deferred tool; alwaysLoad keeps sigma's out of its search.
              tools: ["ToolSearch"],
              strictMcpConfig: true,
              mcpServers: {
                sigma: createSdkMcpServer({
                  name: "sigma",
                  alwaysLoad: true,
                  tools: ownTools(agent).map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: z.fromJSONSchema(tool.parameters as z.core.JSONSchema.JSONSchema),
                    handler: (input: unknown, extra: unknown) => current().runOwn(tool.name)(input, extra),
                  })),
                }),
              },
            }),
        // Claude Code's own idle compaction would compact with no run to commit its summary; sigma's does it (D7).
        settings: { ...toolSearch, idleCompaction: false },
        extraArgs: { ...extraArgs(settings.args ?? []), "replay-user-messages": null },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(append === undefined ? {} : { append }),
        },
        env,
        ...(modelId === "" ? {} : { model: modelId }),
        ...(effort === undefined ? {} : { effort: effort as EffortLevel }),
        ...(agent.maxTurns === undefined ? {} : { maxTurns: agent.maxTurns }),
        ...(start._tag === "fresh"
          ? { sessionId: start.session, ...(start.title === undefined ? {} : { title: start.title }) }
          : {}),
        ...(start._tag === "resume" ? { resume: start.session, resumeSessionAt: start.at } : {}),
        ...(start._tag === "fork"
          ? { resume: start.from, resumeSessionAt: start.at, forkSession: true, sessionId: start.session }
          : {}),
        pathToClaudeCodeExecutable: settings.executable ?? bundledExecutable(),
      },
    })

    const send = (parts: ReadonlyArray<Said>, priority?: "next") => {
      const message = userMessage(parts, priority)
      awaitingReplay.add(message.uuid!)
      inbox.push(message)
      return message.uuid!
    }

    /** What each model spent since the previous result; a total that went down started over, as after `/clear`. */
    const spent = (modelUsage: ModelUsage) => {
      const before = totals ?? {}
      const now: Record<string, UsageTotals> = {}
      for (const [model, usage] of Object.entries(modelUsage)) {
        now[model] = {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cacheReadInputTokens,
          cacheWrite: usage.cacheCreationInputTokens,
          cost: usage.costUSD,
        }
      }
      const added: Array<readonly [string, Usage]> = []
      for (const [model, total] of Object.entries(now)) {
        const previous = before[model]
        const continues =
          previous !== undefined &&
          (["input", "output", "cacheRead", "cacheWrite", "cost"] as const).every((key) => total[key] >= previous[key])
        const base = continues ? previous : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
        added.push([
          model,
          {
            input: total.input - base.input,
            output: total.output - base.output,
            cacheRead: total.cacheRead - base.cacheRead,
            cacheWrite: total.cacheWrite - base.cacheWrite,
            totalTokens:
              total.input +
              total.output +
              total.cacheRead +
              total.cacheWrite -
              (base.input + base.output + base.cacheRead + base.cacheWrite),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total.cost - base.cost },
          },
        ])
      }
      totals = now
      return added
    }

    const view: ServingProcess = {
      get session() {
        return session
      },
      get resetting() {
        return resetting
      },
      get awaitingReplay() {
        return awaitingReplay.size > 0
      },
      send,
      serially: (effect) => serial.withPermits(1)(effect),
      spent,
      started: (call) => {
        const job = starts.get(call)!
        starts.delete(call)
        return job
      },
    }

    const iterator = messages[Symbol.asyncIterator]()
    /** The next frame, or how the process ended: `done`, with the error its end raised if it raised one. */
    const read = () =>
      iterator.next().then(
        (result) => result,
        (error: unknown) => ({ done: true as const, value: error }),
      )
    /** Tracks Claude Code's tasks, which end the process when its run ends with one still working (D6). */
    const track = (message: SDKMessage) => {
      if (message.type === "stream_event") return observeRequest(message)
      if (message.type !== "system") return
      if (message.subtype === "task_started") tasks.add(message.task_id)
      else if (message.subtype === "task_notification") tasks.delete(message.task_id)
      else if (
        message.subtype === "task_updated" &&
        ["completed", "failed", "killed"].includes(message.patch.status!)
      ) {
        tasks.delete(message.task_id)
      }
    }

    const canSelect = (wanted: Selection) =>
      (wanted.modelId !== "" || selected.modelId === "") &&
      (wanted.effort !== undefined || selected.effort === undefined)

    /** Switches Claude Code to `wanted`, which `canSelect` allows; the model first, as an effort may depend on it. */
    const select = (wanted: Selection) =>
      Effect.tryPromise(async () => {
        if (wanted.modelId !== selected.modelId) {
          await messages.setModel(wanted.modelId)
          selected = { ...selected, modelId: wanted.modelId }
        }
        if (wanted.effort !== selected.effort) {
          await messages.applyFlagSettings({ effortLevel: wanted.effort! })
          selected = { ...selected, effort: wanted.effort }
        }
      })

    /**
     * What every frame tells the process, whether or not a run is served: its session, its tasks and its replays.
     * Returns whether the frame is for the run: a replay of a message sigma sent is not.
     */
    const observe = (message: SDKMessage) => {
      track(message)
      if (resetting && "session_id" in message && message.session_id && message.session_id !== session) {
        session = message.session_id
        resetting = false
      }
      if (message.type === "user" && "isReplay" in message && message.isReplay) {
        awaitingReplay.delete(message.uuid)
        return false
      }
      // `/clear`: the session goes on under the id the next frames carry (F13).
      if (message.type === "conversation_reset") resetting = true
      return true
    }

    /** Keeps the cache facts of each main-loop request from the usage its response starts with (F13). */
    const observeRequest = (message: Extract<SDKMessage, { type: "stream_event" }>) => {
      if (message.parent_tool_use_id !== null || message.event.type !== "message_start") return
      const usage = message.event.message.usage
      const written = usage.cache_creation
      const ttl =
        (written?.ephemeral_1h_input_tokens ?? 0) > 0
          ? "1h"
          : (written?.ephemeral_5m_input_tokens ?? 0) > 0
            ? "5m"
            : lastRequest?.ttl
      lastRequest = {
        at: clock.currentTimeMillisUnsafe(),
        context: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        ttl,
      }
    }

    /**
     * The job a frame is for: a subagent's own frames and its end go to its job, and a subagent a subagent started is
     * hosted by its parent's. Every other frame, and every `task_started` of a subagent, is the run's: a subagent's
     * job is made as its start is read, so none of its frames arrive before it.
     */
    const route = (message: SDKMessage): Job | undefined => {
      if (message.type === "system") {
        if (message.subtype === "task_started" && message.task_type === "local_agent" && message.tool_use_id) {
          const job = jobOf(message.task_id)
          jobsByCall.set(message.tool_use_id, job)
          starts.set(message.tool_use_id, job)
          return message.parent_task_id === undefined ? undefined : jobs.get(message.parent_task_id)
        }
        if (message.subtype === "task_notification" && message.tool_use_id) {
          const job = jobsByCall.get(message.tool_use_id)
          if (job !== undefined) {
            jobsByCall.delete(message.tool_use_id)
            jobs.delete(job.task)
          }
          return job
        }
        return undefined
      }
      if (!("parent_tool_use_id" in message) || message.parent_tool_use_id === null) return undefined
      return jobsByCall.get(message.parent_tool_use_id)
    }

    /** Hands a frame to the taker, or holds it for the next one. */
    const take = (message: SDKMessage) => {
      const now = taker
      if (now === undefined) {
        held.push(message)
        return Effect.void
      }
      return Effect.map(now.frame(message), (done) => {
        if (done && taker === now) taker = undefined
      })
    }

    /** Makes `next` the taker: it takes the held frames first, then the end, if the process has ended. */
    const attach = (next: Taker) =>
      serial.withPermits(1)(
        Effect.gen(function* () {
          taker = next
          while (taker === next && held.length > 0) yield* take(held.shift()!)
          if (taker === next && ended !== undefined) {
            taker = undefined
            next.exit(ended.error)
          }
        }),
      )
    const detach = (gone: Taker) =>
      Effect.sync(() => {
        if (taker === gone) taker = undefined
      })

    /** Reads every frame as it arrives, observes it, and routes it (F7), until the process ends. */
    const reader = Effect.gen(function* () {
      for (;;) {
        const next = yield* Effect.promise(read)
        yield* serial.withPermits(1)(
          Effect.suspend(() => {
            if (next.done) {
              ended = { error: next.value }
              const now = taker
              taker = undefined
              now?.exit(next.value)
              return Effect.void
            }
            const message = next.value
            if (!observe(message)) return Effect.void
            const job = route(message)
            if (job === undefined) return take(message)
            job.inbox.push({ frame: message })
            return Effect.void
          }),
        )
        if (next.done) return yield* Deferred.succeed(exit, undefined)
      }
    })
    /** However the reader ends, the process has: a reader that died ends the run it served instead of stalling it. */
    const readerEnded = (done: Exit.Exit<void>) =>
      Effect.andThen(
        Effect.sync(() => {
          if (ended !== undefined) return
          ended = { error: Exit.isFailure(done) ? Cause.squash(done.cause) : undefined }
          const now = taker
          taker = undefined
          now?.exit(ended.error)
        }),
        Deferred.succeed(exit, undefined),
      )
    yield* Effect.forkScoped(Effect.onExit(reader, readerEnded))

    const serve = (run: RunContext, opening: ReadonlyArray<Said>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const now = makeServing(run, view)
          const done = Deferred.makeUnsafe<Ended, unknown>()
          let opened: string | undefined
          const served: Taker = {
            frame: (message) =>
              Effect.map(Effect.exit(now.handle(message)), (handled) => {
                if (Exit.isSuccess(handled) && handled.value === undefined) return false
                Deferred.doneUnsafe(done, handled as Exit.Exit<Ended, unknown>)
                return true
              }),
            exit: (error) => {
              const message =
                error === undefined
                  ? "Claude Code exited before the turn finished"
                  : `Claude Code stopped: ${error instanceof Error ? error.message : String(error)}`
              // Claude Code never took the opening, so nothing of the run reached it.
              const lost = opened !== undefined && awaitingReplay.has(opened)
              Deferred.doneUnsafe(done, Exit.succeed(lost ? ({ _tag: "exited", message } as const) : failure(message)))
            },
          }
          serving = now
          yield* Effect.addFinalizer(() =>
            Effect.andThen(
              detach(served),
              Effect.sync(() => {
                serving = undefined
              }),
            ),
          )
          const switched = yield* Effect.result(select(selectionOf(run.agent)))
          // Nothing of the run reached Claude Code yet, so a process that cannot switch costs a cold start.
          if (switched._tag === "Failure") {
            return {
              _tag: "exited",
              message: `Claude Code did not switch its model or effort: ${String(switched.failure)}`,
            } as const
          }
          opened = send(opening)
          yield* attach(served)
          return yield* Deferred.await(done)
        }),
      )

    const stop = (within: Duration.Input) =>
      Effect.gen(function* () {
        // A person stopped the run: its subagents are stopped with it, as an abort of each would, before Claude Code
        // reports how its interrupt ended them.
        yield* serial.withPermits(1)(Effect.sync(() => endJobs(STOPPED_WITH_RUN)))
        yield* Effect.promise(() => messages.interrupt().catch(() => undefined))
        const done = Deferred.makeUnsafe<boolean>()
        const stopping: Taker = {
          frame: (message) =>
            Effect.sync(() => {
              if (message.type !== "result") return false
              Deferred.doneUnsafe(done, Exit.succeed(awaitingReplay.size === 0 && tasks.size === 0))
              return true
            }),
          exit: () => Deferred.doneUnsafe(done, Exit.succeed(false)),
        }
        return yield* Effect.andThen(attach(stopping), Deferred.await(done)).pipe(Effect.ensuring(detach(stopping)))
      }).pipe(Effect.timeoutOption(within), Effect.map(Option.getOrElse(() => false)))

    return {
      serve,
      canSelect,
      stop,
      get busy() {
        return tasks.size > 0
      },
      exited: Deferred.await(exit),
      get lastRequest() {
        return lastRequest
      },
    } satisfies ClaudeProcess
  })
