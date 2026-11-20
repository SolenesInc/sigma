// One Claude Code process, started through the Claude Agent SDK: its query, the inbox it reads its messages from, the
// reader that observes each message it sends as it arrives, routes it and turns it into the hosted run's frames, and
// the callbacks Claude Code makes. A job's frames and callbacks go to the job (D1, F7); the rest go to the run it
// serves, or wait for the next run while it serves none. A job's end it reads while no run serves waits as a report,
// and a turn Claude Code starts by itself wakes the conversation (D3). What a run and a job do with their frames is
// `@sigma/hosted`.
import {
  type EffortLevel,
  type HookCallbackMatcher,
  type HookEvent,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk"
import {
  type Adapter,
  type Callbacks,
  DENIED,
  type Ended,
  ENDED_WITH_PROCESS,
  failure,
  type Frame,
  type HostedProcess,
  Inbox,
  Job,
  type JobEnd,
  type JobReport,
  type LastRequest,
  makeServing,
  type Part,
  endReport,
  type ProcessConfig,
  type RunContext,
  type Said,
  type Selection,
  selectionOf,
  type Serving,
  type ServingProcess,
  type Start,
  textOf,
} from "@sigma/hosted"
import type { ToolCall, Usage } from "@sigma/models"
import { Cause, Clock, Deferred, type Duration, Effect, Exit, Option, Semaphore } from "effect"
import { claudeEnvironment, toolSearchSettings } from "./environment.ts"

/** How a Claude Code instance is started: its executable, environment and extra arguments. */
export interface ClaudeProcessSettings {
  /** Default: the SDK's bundled Claude Code. */
  readonly executable?: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
}

/** The name Claude Code is told and shown by. */
const NAME = "Claude Code"

/** Claude Code's errors for a session it does not have, or a position its session does not hold (F12). */
const SESSION_GONE = /No conversation found|No message found with message\.uuid/

/** One model's running totals since a Claude Code process's previous result, as it reports them (`modelUsage`). */
type ModelUsage = Record<
  string,
  {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
  }
>

/** How a job's `task_notification` statuses end it. */
const endings = { completed: "completed", failed: "failed", stopped: "stopped", killed: "stopped" } as const

/** The texts and calls of a message's content; its other blocks, such as thinking, are Claude Code's own. */
const partsOf = (content: ReadonlyArray<any>): Part[] =>
  content.flatMap((block): Part[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }]
    if (block.type !== "tool_use") return []
    return [{ type: "toolCall", id: block.id, name: block.name, arguments: block.input as ToolCall["arguments"] }]
  })

/** How a job's `task_notification` ends it, with a subagent's final answer or a command's summary. */
const endOf = (message: SDKMessage): Exclude<JobEnd, { status: "cut off" }> | undefined => {
  if (message.type !== "system" || message.subtype !== "task_notification") return undefined
  const status = endings[message.status as keyof typeof endings] ?? "failed"
  // A subagent that hands back its report through `SubagentHandback` leaves only a placeholder in `summary`;
  // the report is `handback_report`, which the SDK's types do not declare yet.
  const handback = (message as { handback_report?: { text?: string } }).handback_report?.text
  const summary = handback || message.summary
  return { status, ...(summary === undefined ? {} : { summary }) }
}

/**
 * The frames of a message of Claude Code's main loop (`main`) or of a subagent's, as the hosted run reads them. What
 * ends a run, its `result`, is the caller's: it depends on the process.
 */
const framesOf = (message: SDKMessage, main: boolean): Frame[] => {
  const own = !("parent_tool_use_id" in message) || (message.parent_tool_use_id === null) === main
  switch (message.type) {
    case "stream_event": {
      const event = message.event
      if (!main || !own || event.type !== "content_block_delta" || event.delta.type !== "text_delta") return []
      return [{ type: "text", delta: event.delta.text }]
    }
    case "assistant": {
      // A subagent the process routed to no job: a run hosts each one it was told of.
      if (!own) return []
      const content = message.message.content
      if (main && message.error) {
        const text = content.map((block) => (block.type === "text" ? block.text : "")).join("")
        return [{ type: "failed", message: text || `Claude Code failed: ${message.error}` }]
      }
      return [{ type: "said", response: message.message.id, at: message.uuid, content: partsOf(content) }]
    }
    case "user": {
      if (!own) return []
      const content = Array.isArray(message.message.content) ? message.message.content : []
      // An Agent call whose subagent handed back its report gets a placeholder as its result; the frame's
      // `tool_use_result` holds the report, which the SDK's types do not declare yet. Keeping the report means
      // a retelling of the conversation, to a new session or another provider, still has it.
      const handback = (message as { tool_use_result?: { handbackReport?: { text?: string } } }).tool_use_result
        ?.handbackReport?.text
      const results = content.flatMap((block) =>
        block.type === "tool_result"
          ? [{ call: block.tool_use_id, text: handback || textOf(block.content), isError: block.is_error === true }]
          : [],
      )
      return [{ type: "results", ...(message.uuid ? { at: message.uuid } : {}), results }]
    }
    case "system": {
      if (message.subtype === "task_started" && message.tool_use_id) {
        const background = message.is_backgrounded === true
        if (message.task_type === "local_agent") {
          return [
            {
              type: "subagent",
              call: message.tool_use_id,
              task: message.task_id,
              description: message.description,
              background,
              ...(message.subagent_type === undefined ? {} : { agentType: message.subagent_type }),
              ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
            },
          ]
        }
        // A command is the conversation's job when its own Claude Code started it; one a subagent started is the
        // subagent's, which the process does not track as a job.
        if (main && background && message.parent_task_id === undefined) {
          return [
            { type: "command", call: message.tool_use_id, task: message.task_id, description: message.description },
          ]
        }
        return []
      }
      return []
    }
    case "conversation_reset":
      // `/clear`: the session goes on under the id the next frames carry (F13); a new context starts.
      return main ? [{ type: "reset" }] : []
    default:
      return []
  }
}

/**
 * What takes the frames that are not a job's: whether a frame was its last, what the process's end does to it, and,
 * for a run, the reports of the jobs that end while it serves.
 */
type Taker = {
  readonly frame: (message: SDKMessage) => Effect.Effect<boolean>
  readonly exit: (error: unknown) => void
  readonly report?: (report: JobReport) => Effect.Effect<void>
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
 * Starts a Claude Code process at `start`; it is closed with the scope. `wake` is called when Claude Code begins a turn
 * by itself while the process serves no run (D3).
 */
export const openProcess = (
  config: ProcessConfig<ClaudeProcessSettings>,
  start: Start,
  wake: (reports: ReadonlyArray<JobReport>) => void,
) =>
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
    /** The run the process serves now, which the callbacks of its own conversation wait for. */
    let serving = Deferred.makeUnsafe<Serving>()
    /** The tasks Claude Code started and has not said ended. */
    const tasks = new Set<string>()
    /** Completes when `tasks` empties, and is made anew when one starts. */
    let quiet = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(quiet, Exit.void)
    /** Claude Code began a turn by itself, and no run took it yet. */
    let waking = false
    /** The jobs that ended while no run served. */
    let reports: JobReport[] = []
    /** The jobs Claude Code started and has not said ended, by task id, and by the call that started each. */
    const jobs = new Map<string, Job>()
    const jobsByCall = new Map<string, Job>()
    /**
     * The job each start made, by the call that started it, until the conversation that hosts it takes it: a job can
     * end before it is hosted, as a subagent a subagent started, or one started while no run served.
     */
    const starts = new Map<string, Job>()
    /** What takes the frames that are not a job's: the run served, or a stop. While none does, they wait in `held`. */
    let taker: Taker | undefined
    const held: SDKMessage[] = []
    /** How the process ended, once the reader read its end: the error its end raised, if it raised one. */
    let ended: { readonly error: unknown } | undefined
    const exit = Deferred.makeUnsafe<void>()

    /** Ends the jobs left working: a job lives in its process, and is cut off with it (D6). */
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

    /** The run served: a main-loop callback comes only in a turn, which a run serves once it attaches (D3). */
    const current = (signal: AbortSignal | undefined) => until(Deferred.await(serving), signal)

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
      agentId === undefined ? current(signal) : jobCallbacks(jobOf(agentId), signal)

    /** Each call Claude Code runs itself is committed before it runs, with the arguments it runs with. */
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreToolUse: [
        {
          hooks: [
            async (input, _id, { signal }) => {
              if (input.hook_event_name !== "PreToolUse") return {}
              const call: ToolCall = {
                type: "toolCall",
                id: input.tool_use_id,
                name: input.tool_name,
                arguments: input.tool_input as ToolCall["arguments"],
              }
              await (await callbacksOf(input.agent_id, signal)).beforeRun(call, signal)
              return {}
            },
          ],
        },
      ],
      // Claude Code's summary of its own compaction.
      PostCompact: [
        {
          hooks: [
            async (input, _id, { signal }) => {
              if (input.hook_event_name !== "PostCompact") return {}
              await (await current(signal)).compacted(input.compact_summary, input.trigger === "manual", signal)
              return {}
            },
          ],
        },
      ],
    }
    const canUseTool: NonNullable<Options["canUseTool"]> = async (tool, input, { agentID, signal, toolUseID }) => {
      const call: ToolCall = { type: "toolCall", id: toolUseID, name: tool, arguments: input as ToolCall["arguments"] }
      if (await (await callbacksOf(agentID, signal)).approve(call, signal)) {
        return { behavior: "allow", updatedInput: input, toolUseID }
      }
      return { behavior: "deny", message: DENIED, toolUseID }
    }
    const settingSources: SettingSource[] = ["user", "project", "local"]
    const env = {
      ...claudeEnvironment(settings.env),
      SIGMA_ROOT_CONVERSATION: config.rootConversation,
      CLAUDE_AGENT_SDK_CLIENT_APP: "sigma",
      // Claude Code's turn-over signal reaches sigma: without it, Claude Code marks the signal for the SDK alone, and
      // the SDK keeps it to itself (F1).
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    }
    const toolSearch = yield* toolSearchSettings(agent.cwd, settingSources, env)
    const messages = query({
      prompt: inbox,
      options: {
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
        abortController: controller,
        includePartialMessages: true,
        canUseTool,
        hooks,
        settingSources,
        // Claude Code's own idle compaction would compact with no run to commit its summary; sigma's does it (D7).
        settings: { ...toolSearch, idleCompaction: false },
        extraArgs: { ...extraArgs(settings.args ?? []), "replay-user-messages": null },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(config.instructions === undefined ? {} : { append: config.instructions }),
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

    /**
     * What each model spent since the previous result, and the totals it was measured to; a total that went down
     * started over, as after `/clear`. The totals move once the run has committed what was spent (`handle`).
     */
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
      return { added, now }
    }

    /** The totals a `spent` frame was measured to, which become the process's once its run committed the frame. */
    let measured: Record<string, UsageTotals> | undefined

    /**
     * The frames of a main-loop message for the run served: its `result` reports what was spent and how the turn ended,
     * and Claude Code going idle ends the run (D2), unless a message the process was sent, such as a steer, has not come
     * back yet, which Claude Code answers next. A failed turn ends the run at once: a failed resume sends no idle before
     * its process exits (F4).
     */
    const runFrames = (message: SDKMessage): Frame[] => {
      // A turn begins after a result, as Claude Code's follow-up for a job's end or a steer: its own result ends the run.
      if (message.type === "system" && message.subtype === "init") return [{ type: "began" }]
      if (message.type === "system" && message.subtype === "session_state_changed") {
        return message.state === "idle" && awaitingReplay.size === 0 ? [{ type: "idle" }] : []
      }
      if (message.type !== "result") return framesOf(message, true)
      if (message.subtype !== "success" || message.is_error) {
        const errors = "errors" in message ? message.errors : []
        const text = "result" in message && message.result ? message.result : errors.join("; ")
        const gone = errors.some((error) => SESSION_GONE.test(error))
        return [{ type: "failed", message: text || `Claude Code stopped: ${message.subtype}`, gone }]
      }
      const { added, now } = spent(message.modelUsage)
      measured = now
      const turnLimit = (message as { terminal_reason?: string }).terminal_reason === "max_turns"
      return [
        { type: "spent", usage: added },
        { type: "answered", turnLimit },
      ]
    }

    const view: ServingProcess = {
      get session() {
        return session
      },
      get holdsPosition() {
        return awaitingReplay.size === 0 && !resetting
      },
      send,
      serially: (effect) => serial.withPermits(1)(effect),
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
    /** Tracks Claude Code's tasks, which keep the process live while any works (D5). */
    const track = (message: SDKMessage) => {
      if (message.type === "stream_event") return observeRequest(message)
      if (message.type !== "system") return
      if (message.subtype === "task_started") {
        if (tasks.size === 0) quiet = Deferred.makeUnsafe<void>()
        tasks.add(message.task_id)
      } else if (
        message.subtype === "task_notification" ||
        (message.subtype === "task_updated" && ["completed", "failed", "killed"].includes(message.patch.status!))
      ) {
        if (tasks.delete(message.task_id) && tasks.size === 0) Deferred.doneUnsafe(quiet, Exit.void)
      }
    }

    // Claude Code clears a model or effort to its own default, not to the person's settings, so a run that clears
    // either needs a new process (D4).
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
          await messages.applyFlagSettings({ effortLevel: wanted.effort as EffortLevel })
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
     * The job a frame is for: a job's own frames and its end go to it, and a subagent a subagent started is hosted by its
     * parent's. Every other frame, and the `task_started` of a job the main loop started, is the run's: a job is made as
     * its start is read, so none of its frames arrive before it. A job is every subagent, and each background command
     * the main loop starts.
     */
    const route = (message: SDKMessage): Job | undefined => {
      if (message.type === "system") {
        if (message.subtype === "task_started" && message.tool_use_id) {
          const top = message.parent_task_id === undefined
          const background = message.is_backgrounded === true
          const kind = message.task_type === "local_agent" ? "agent" : top && background ? "command" : undefined
          if (kind === undefined) return undefined
          const job = jobOf(message.task_id)
          job.start = { kind, title: message.description, call: message.tool_use_id, reported: top && background }
          jobsByCall.set(message.tool_use_id, job)
          starts.set(message.tool_use_id, job)
          return top ? undefined : jobs.get(message.parent_task_id!)
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

    const takeReports = () => {
      const taken = reports
      reports = []
      return taken
    }

    /** Hands a report to the run served, or holds it for a wake or the next run (D3). */
    const report = (job: Job, end: JobEnd) => {
      if (end.status === "cut off") return Effect.void
      const made = endReport(NAME, job, end)
      if (taker?.report !== undefined) return taker.report(made)
      reports.push(made)
      return Effect.void
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

    /** Makes `next` the taker: it takes the held reports and frames first, then the end, if the process has ended. */
    const attach = (next: Taker) =>
      serial.withPermits(1)(
        Effect.gen(function* () {
          taker = next
          waking = false
          if (next.report !== undefined) for (const held of takeReports()) yield* next.report(held)
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
            // A turn nobody sent: Claude Code woke by itself, for a job's end or its own wakeup (F2).
            if (
              message.type === "system" &&
              message.subtype === "session_state_changed" &&
              message.state === "running" &&
              taker === undefined &&
              awaitingReplay.size === 0
            ) {
              // The reports held so far are the ones this turn is for: taken here, under the reader's lock, so a run that
              // attaches before the wake is handed over cannot take them, and none means no job's end came before it.
              waking = true
              wake(takeReports())
            }
            if (job === undefined) return take(message)
            const end = endOf(message)
            if (end === undefined) {
              for (const frame of framesOf(message, false)) job.inbox.push({ frame })
              return Effect.void
            }
            job.inbox.push({ end })
            if (job.start?.reported) return report(job, end)
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
          /** Hands the run the frames of a message, until one ends it. */
          const handle = (frames: ReadonlyArray<Frame>) =>
            Effect.gen(function* () {
              for (const frame of frames) {
                const ended = yield* now.handle(frame)
                if (frame.type === "spent") totals = measured
                if (ended !== undefined) return ended
              }
              return undefined
            })
          const served: Taker = {
            frame: (message) =>
              Effect.map(Effect.exit(handle(runFrames(message))), (handled) => {
                if (Exit.isSuccess(handled) && handled.value === undefined) return false
                Deferred.doneUnsafe(done, handled as Exit.Exit<Ended, unknown>)
                return true
              }),
            // A report the run cannot commit fails it, as a frame it cannot does.
            report: (made) =>
              Effect.catchCause(now.report(made), (cause) =>
                Effect.sync(() => Deferred.doneUnsafe(done, Exit.failCause(cause))),
              ),
            exit: (error) => {
              const message =
                error === undefined
                  ? "Claude Code exited before the turn finished"
                  : `Claude Code stopped: ${error instanceof Error ? error.message : String(error)}`
              // Claude Code never took the opening, so nothing of the run reached it.
              const lost = opened !== undefined && awaitingReplay.has(opened)
              // A turn that ended before the process did ended the run as its result said.
              const ended = now.ended ?? (lost ? ({ _tag: "exited", message } as const) : failure(message))
              Deferred.doneUnsafe(done, Exit.succeed(ended))
            },
          }
          Deferred.doneUnsafe(serving, Exit.succeed(now))
          yield* Effect.addFinalizer(() =>
            Effect.andThen(
              detach(served),
              Effect.sync(() => {
                serving = Deferred.makeUnsafe<Serving>()
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
          if (opening.length > 0) opened = send(opening)
          yield* attach(served)
          return yield* Deferred.await(done)
        }),
      )

    const stop = (within: Duration.Input) =>
      Effect.gen(function* () {
        // A person stopped the run, not its jobs, which keep working (D7).
        yield* Effect.promise(() => messages.interrupt().catch(() => undefined))
        const done = Deferred.makeUnsafe<boolean>()
        const stopping: Taker = {
          frame: (message) =>
            Effect.sync(() => {
              if (
                message.type !== "system" ||
                message.subtype !== "session_state_changed" ||
                message.state !== "idle"
              ) {
                return false
              }
              Deferred.doneUnsafe(done, Exit.succeed(awaitingReplay.size === 0))
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
      quiet: Effect.suspend(() => Deferred.await(quiet)),
      get waking() {
        return waking
      },
      takeReports,
      exited: Deferred.await(exit),
      get lastRequest() {
        return lastRequest
      },
    } satisfies HostedProcess
  })

/** The task kind of a Claude Code conversation's runs. */
export const CLAUDE_RUN_KIND = "claude.run"

/** Claude Code as a harness of the hosted run; `settings` says how the Claude Code of a provider instance starts. */
export const claudeAdapter = (
  settings: (provider: string) => ClaudeProcessSettings | undefined,
): Adapter<ClaudeProcessSettings> => ({
  kind: CLAUDE_RUN_KIND,
  name: NAME,
  api: "claude-code",
  settings,
  open: openProcess,
})
