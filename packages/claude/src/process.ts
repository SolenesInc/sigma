// One Claude Code process, started through the Claude Agent SDK, as the hosted run's connection: its query, the inbox
// it reads its messages from, and the translation of each message it sends into the hosted run's frames, in the order
// it sends them. A subagent's messages carry its job's id, and Claude Code's task and session-state messages say when a
// job starts and ends, when Claude Code begins a turn by itself, and when its turn is over (D4). Its calls back reach
// the host the hosted process gives it. What the frames mean for a run, a job or a wake is `@sigma/hosted`'s.
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
import {
  type Adapter,
  type Connection,
  DENIED,
  type Frame,
  type Host,
  Inbox,
  type LastRequest,
  type OwnResult,
  type Part,
  type ProcessConfig,
  type Said,
  type Selection,
  selectionOf,
  type Start,
  textOf,
} from "@sigma/hosted"
import type { ToolCall, Usage } from "@sigma/models"
import { Clock, Effect } from "effect"
import { z } from "zod"
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

/**
 * How long Claude Code waits for a call of sigma's tools with remote hands: as long as sigma's bash may run (its largest
 * `timeout`, `MAX_TIMEOUT_SECONDS` in packages/tools' bash.ts), so each tool's own limit, such as bash's 1800 s
 * default, is the one the model sees. Claude Code 2.1.312 waits `MCP_TOOL_TIMEOUT` ms when set, which a person's
 * environment may set lower, and otherwise 1e8 ms (read from its bundle). Measured against a fake Anthropic API: a
 * 1830 s call of an in-process MCP tool reached the model whole, unset and with this value; `MCP_TOOL_TIMEOUT=3000`
 * aborted an 8 s call and the model read `MCP server "sigma" tool "sleep" timed out after 3s`.
 */
const REMOTE_HANDS_TOOL_TIMEOUT_MS = 2_147_483_647

/** The prefix Claude Code gives the tools of sigma's MCP server. */
const OWN_TOOL = "mcp__sigma__"

type McpPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

/** An own tool's result as MCP carries it: its texts and its images, whose shape MCP shares with sigma's. */
const mcpResult = (result: OwnResult): { content: McpPart[]; isError: boolean } => ({
  content: result.content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.data, mimeType: part.mimeType },
  ),
  isError: result.isError,
})

/** The call id Claude Code gives an MCP tool's handler. */
const toolUseOf = (extra: unknown) => {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta
  return meta?.["claudecode/toolUseId"] as string | undefined
}

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

/** Sigma's name of a tool Claude Code calls: one of sigma's own loses its MCP prefix. */
type Naming = (name: string) => string

/** The texts and calls of a message's content; its other blocks, such as thinking, are Claude Code's own. */
const partsOf = (content: ReadonlyArray<any>, named: Naming): Part[] =>
  content.flatMap((block): Part[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }]
    if (block.type !== "tool_use") return []
    return [
      { type: "toolCall", id: block.id, name: named(block.name), arguments: block.input as ToolCall["arguments"] },
    ]
  })

/** How a job's `task_notification` ends it, with a subagent's final answer or a command's summary. */
const endOf = (message: Extract<SDKMessage, { type: "system"; subtype: "task_notification" }>) => {
  const status = endings[message.status as keyof typeof endings] ?? "failed"
  // A subagent that hands back its report through `SubagentHandback` leaves only a placeholder in `summary`;
  // the report is `handback_report`, which the SDK's types do not declare yet.
  const handback = (message as { handback_report?: { text?: string } }).handback_report?.text
  const summary = handback || message.summary
  return { status, ...(summary === undefined ? {} : { summary }) }
}

/**
 * The frames of a message of Claude Code's main loop (`main`) or of a subagent's, as the hosted run reads them. What
 * the process's state decides, a turn's end and a job's start and end, is the caller's. Claude Code names sigma's own
 * tools with their MCP prefix, which `named` takes off.
 */
const framesOf = (message: SDKMessage, main: boolean, named: Naming): Frame[] => {
  const own = !("parent_tool_use_id" in message) || (message.parent_tool_use_id === null) === main
  switch (message.type) {
    case "stream_event": {
      const event = message.event
      if (!main || !own || event.type !== "content_block_delta" || event.delta.type !== "text_delta") return []
      return [{ type: "text", delta: event.delta.text }]
    }
    case "assistant": {
      // A subagent's message with no job: Claude Code named no start for it.
      if (!own) return []
      const content = message.message.content
      if (main && message.error) {
        const text = content.map((block) => (block.type === "text" ? block.text : "")).join("")
        return [{ type: "failed", message: text || `Claude Code failed: ${message.error}` }]
      }
      return [{ type: "said", response: message.message.id, at: message.uuid, content: partsOf(content, named) }]
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
    case "conversation_reset":
      // `/clear`: the session goes on under the id the next frames carry (F13); a new context starts.
      return main ? [{ type: "reset" }] : []
    default:
      return []
  }
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
 * Starts a Claude Code process at `start`, as a connection; it is closed with the scope. Its calls back reach `host`:
 * a subagent's, by `agent_id`, its job's task, and the main loop's the run that serves its turn.
 */
export const openConnection = (config: ProcessConfig<ClaudeProcessSettings>, start: Start, host: Host) =>
  Effect.gen(function* () {
    const { agent, settings, remoteHands } = config
    const own = new Set(config.own.map((tool) => tool.name))
    /** Whether Claude Code's `tool` is one of sigma's own, which it calls over sigma's MCP server. */
    const isOwn = (tool: string) => tool.startsWith(OWN_TOOL) && own.has(tool.slice(OWN_TOOL.length))
    const named: Naming = (tool) => (isOwn(tool) ? tool.slice(OWN_TOOL.length) : tool)
    /**
     * The subagent that made each call of sigma's own tools, by call, from its `PreToolUse`, which comes before the
     * call reaches sigma's MCP server; a main-loop call has none.
     */
    const ownCallers = new Map<string, string | undefined>()
    const { modelId, effort } = selectionOf(agent)
    const clock = yield* Clock.Clock
    let lastRequest: LastRequest | undefined
    const inbox = new Inbox<SDKUserMessage>()
    let session = start.session
    /** What Claude Code answers with now: what it was spawned with, then what the last run switched it to. */
    let selected: Selection = { modelId, effort }
    let resetting = false
    // `modelUsage` at this process's previous result: a process reports its own running totals, which a resumed
    // session does not carry over (died_while_idle's second process reports a first turn's cache read again).
    let totals: Record<string, UsageTotals> | undefined
    /**
     * Claude Code's task id of each job it started and has not said ended, by the call that started it: a subagent's
     * messages and a job's end name the call.
     */
    const jobs = new Map<string, string>()

    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.sync(() => {
          inbox.close()
          controller.abort()
        }),
    )

    /** Each call Claude Code runs itself is committed before it runs, with the arguments it runs with. */
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreToolUse: [
        {
          hooks: [
            async (input, _id, { signal }) => {
              if (input.hook_event_name !== "PreToolUse") return {}
              // An own tool's call is committed as it runs, by `runOwn` of the conversation that made it.
              if (isOwn(input.tool_name)) {
                ownCallers.set(input.tool_use_id, input.agent_id)
                return {}
              }
              const call: ToolCall = {
                type: "toolCall",
                id: input.tool_use_id,
                name: input.tool_name,
                arguments: input.tool_input as ToolCall["arguments"],
              }
              await (await host.callbacks(input.agent_id, signal)).beforeRun(call, signal)
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
              await host.compacted(input.compact_summary, input.trigger === "manual", signal)
              return {}
            },
          ],
        },
      ],
    }
    const canUseTool: NonNullable<Options["canUseTool"]> = async (tool, input, { agentID, signal, toolUseID }) => {
      // An own tool's call asks a person through its tool task, as in sigma's own loop, so Claude Code's ask is allowed (F18).
      if (isOwn(tool)) return { behavior: "allow", updatedInput: input, toolUseID }
      const call: ToolCall = { type: "toolCall", id: toolUseID, name: tool, arguments: input as ToolCall["arguments"] }
      if (await (await host.callbacks(agentID, signal)).approve(call, signal)) {
        return { behavior: "allow", updatedInput: input, toolUseID }
      }
      return { behavior: "deny", message: DENIED, toolUseID }
    }
    // With remote hands nothing comes from the person's Claude Code settings, and Claude Code's own tools and connectors
    // are off: it acts only through sigma's tools, on the target (D9, Q3). It keeps the server's own Claude folder, so it
    // signs in as the machine's Claude Code does; its working folder is its target's (D10).
    const settingSources: SettingSource[] = remoteHands === undefined ? ["user", "project", "local"] : []
    const env = {
      ...claudeEnvironment(settings.env),
      SIGMA_ROOT_CONVERSATION: config.rootConversation,
      CLAUDE_AGENT_SDK_CLIENT_APP: "sigma",
      // Claude Code's turn-over signal reaches sigma: without it, Claude Code marks the signal for the SDK alone, and
      // the SDK keeps it to itself (F1).
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      ...(remoteHands === undefined
        ? {}
        : {
            ENABLE_TOOL_SEARCH: "true",
            ENABLE_CLAUDEAI_MCP_SERVERS: "false",
            MCP_TOOL_TIMEOUT: String(REMOTE_HANDS_TOOL_TIMEOUT_MS),
          }),
    }
    const toolSearch = remoteHands === undefined ? yield* toolSearchSettings(agent.cwd, settingSources, env) : undefined
    const cwd = remoteHands === undefined ? agent.cwd : remoteHands.cwd
    const append = remoteHands === undefined ? config.instructions : yield* remoteHands.append
    const messages = query({
      prompt: inbox,
      options: {
        ...(cwd === undefined ? {} : { cwd }),
        abortController: controller,
        includePartialMessages: true,
        canUseTool,
        hooks,
        settingSources,
        // With remote hands Claude Code has sigma's tools alone; ToolSearch stays so it can load a deferred tool.
        ...(remoteHands === undefined ? {} : { tools: ["ToolSearch"], strictMcpConfig: true }),
        ...(config.own.length === 0
          ? {}
          : {
              mcpServers: {
                sigma: createSdkMcpServer({
                  name: "sigma",
                  // Kept out of Claude Code's tool search, which would hide them until it searched (F55).
                  alwaysLoad: true,
                  tools: config.own.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: z.fromJSONSchema(tool.parameters as z.core.JSONSchema.JSONSchema),
                    handler: async (input: unknown, extra: unknown) => {
                      const call = toolUseOf(extra)
                      if (call === undefined) {
                        const text = `Claude Code called ${tool.name} without a call id`
                        return { content: [{ type: "text" as const, text }], isError: true }
                      }
                      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal
                      // A subagent's call is its job's, which writes the subagent's conversation.
                      const job = ownCallers.get(call)
                      ownCallers.delete(call)
                      return mcpResult(await host.runOwn(job, call, tool.name, input, signal))
                    },
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
      inbox.push(message)
      return message.uuid!
    }

    /**
     * What each model spent since the previous result; a total that went down started over, as after `/clear`. The
     * totals move to these.
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
      totals = now
      return added
    }

    /** How a turn's `result` ended it: what it spent and how it answered, or its failure. */
    const resultFrames = (message: Extract<SDKMessage, { type: "result" }>): Frame[] => {
      if (message.subtype !== "success" || message.is_error) {
        const errors = "errors" in message ? message.errors : []
        const text = "result" in message && message.result ? message.result : errors.join("; ")
        const gone = errors.some((error) => SESSION_GONE.test(error))
        return [{ type: "failed", message: text || `Claude Code stopped: ${message.subtype}`, gone }]
      }
      const turnLimit = (message as { terminal_reason?: string }).terminal_reason === "max_turns"
      return [
        { type: "spent", usage: spent(message.modelUsage) },
        { type: "answered", turnLimit },
      ]
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
     * What one message says, in the hosted run's frames. Every message moves the process's own state first: its
     * session and its cache facts. A replay of a message sigma sent says Claude Code took it. Claude Code's session state is its turn's start (`running`) and its turn-over (`idle`).
     */
    const translate = (message: SDKMessage): Frame[] => {
      if (message.type === "stream_event") observeRequest(message)
      if (resetting && "session_id" in message && message.session_id && message.session_id !== session) {
        session = message.session_id
        resetting = false
      }
      // `--replay-user-messages`: Claude Code took a message sigma sent.
      if (message.type === "user" && "isReplay" in message && message.isReplay)
        return [{ type: "took", id: message.uuid }]
      // `/clear`: the session goes on under the id the next frames carry (F13).
      if (message.type === "conversation_reset") resetting = true
      if (message.type === "result") return resultFrames(message)
      if (message.type === "system") {
        switch (message.subtype) {
          // A turn begins after a result, as Claude Code's follow-up for a job's end or a steer.
          case "init":
            return [{ type: "began" }]
          case "session_state_changed":
            if (message.state === "running") return [{ type: "woke" }]
            return message.state === "idle" ? [{ type: "idle" }] : []
          case "task_started": {
            if (!message.tool_use_id) return []
            jobs.set(message.tool_use_id, message.task_id)
            return [
              {
                type: "job",
                id: message.task_id,
                call: message.tool_use_id,
                kind: message.task_type === "local_agent" ? "agent" : "command",
                title: message.description,
                background: message.is_backgrounded === true,
                ...(message.subagent_type === undefined ? {} : { agentType: message.subagent_type }),
                ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
                // A job a subagent started is that subagent's.
                ...(message.parent_task_id === undefined ? {} : { job: message.parent_task_id }),
              },
            ]
          }
          case "task_notification": {
            const id = message.tool_use_id === undefined ? undefined : jobs.get(message.tool_use_id)
            if (id === undefined) return []
            jobs.delete(message.tool_use_id!)
            return [{ type: "job-ended", id, ...endOf(message) }]
          }
          default:
            return []
        }
      }
      if (!("parent_tool_use_id" in message) || message.parent_tool_use_id === null) {
        return framesOf(message, true, named)
      }
      // A subagent's message is its job's.
      const job = jobs.get(message.parent_tool_use_id)
      return job === undefined ? [] : framesOf(message, false, named).map((frame) => ({ ...frame, job }))
    }

    async function* frames(): AsyncGenerator<Frame> {
      for await (const message of messages) yield* translate(message)
    }

    return {
      frames: frames(),
      get session() {
        return session
      },
      get holdsPosition() {
        return !resetting
      },
      send,
      canSelect,
      select,
      interrupt: () => messages.interrupt().then(() => undefined),
      stopJob: (id) => messages.stopTask(id),
      get lastRequest() {
        return lastRequest
      },
    } satisfies Connection
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
  open: openConnection,
})
