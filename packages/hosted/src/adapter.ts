// The seam between the hosted run and a harness: what an adapter is, the process it opens, the frames it hands the run
// it serves and the callbacks it reaches the run through. The vocabulary is sigma's own, so an adapter is the only code
// that knows its harness's protocol, and the hosted run the only code that commits.
import type { Agent } from "@sigma/harness"
import type { ImageContent, TextContent, ToolCall, Usage } from "@sigma/models"
import type { Duration, Effect, Scope } from "effect"
import type { JobReport } from "./jobs.ts"
import type { Said } from "./retell.ts"
import type { Ended, RunContext } from "./serving.ts"

/** One harness the hosted run can drive, such as Claude Code. */
export interface Adapter<S = any> {
  /** The task kind of its runs, as `claude.run`. */
  readonly kind: string
  /** The harness as people and the harness itself are told of it, as "Claude Code". */
  readonly name: string
  /** The `api` its responses are committed with, as `claude-code`. */
  readonly api: string
  /** How the harness of a provider instance is started; `undefined` for a provider it does not serve. */
  readonly settings: (provider: string) => S | undefined
  /**
   * Starts a process at `start`; it is closed with the scope. It calls `wake` with the reports it holds when the
   * harness begins a turn by itself while the process serves no run (D3), taking them so no run that attaches
   * meanwhile takes them too.
   */
  readonly open: (
    config: ProcessConfig<S>,
    start: Start,
    wake: (reports: ReadonlyArray<JobReport>) => void,
  ) => Effect.Effect<HostedProcess, never, Scope.Scope>
  /**
   * What a member-mode run's failure `message` adds when it says the harness is signed out, as a target's own folder
   * holds no sign-in; `undefined` when it does not say so.
   */
  readonly signIn?: (message: string) => string | undefined
}

/** What a process is started with. */
export type ProcessConfig<S = unknown> = {
  readonly agent: Agent
  readonly settings: S
  /** The id of the conversation people started, for the `SIGMA_ROOT_CONVERSATION` its commands see. */
  readonly rootConversation: string
  /** What the harness adds to its own system prompt: the sections of the extensions it is offered, then the agent's instructions. */
  readonly instructions?: string
  /** A remote conversation's process, in member mode (D9); absent for a local conversation's. */
  readonly member?: MemberProcess
}

/**
 * What a process in member mode starts with: the target's folders for the harness's config and work (D10), and what
 * it adds to its system prompt in place of `instructions`: the conversation's sections as sigma renders them (D11).
 */
export type MemberProcess = {
  readonly folder: { readonly config: string; readonly cwd: string }
  /** Rendered when a process starts, so a live process costs no render. */
  readonly append: Effect.Effect<string | undefined>
}

/**
 * Whether a conversation with this agent runs in member mode: its tools act on a target that is not the server's
 * machine, so the harness must not use its own tools, which act on the machine it runs on (D9).
 */
export const isMember = (agent: Agent) => agent.target !== undefined && agent.target !== "local"

/** The tools sigma offers a harness in member mode: the conversation's, but code mode, which a harness takes no part in. */
export const ownTools = (agent: Agent) => agent.tools.filter((tool) => tool.codeMode !== true)

/** Where a process starts in its harness's session. */
export type Start =
  /** A new session, named `title` so the harness does not ask a model for a name. */
  | { readonly _tag: "fresh"; readonly session: string; readonly title?: string }
  | { readonly _tag: "resume"; readonly session: string; readonly at: string }
  /** A fork of a conversation whose parent held the session: a new session continuing the parent's at `at`. */
  | { readonly _tag: "fork"; readonly from: string; readonly at: string; readonly session: string }

/** The model and effort a process answers with; `""` and `undefined` leave them to the harness's own settings. */
export type Selection = { readonly modelId: string; readonly effort: string | undefined }

export const selectionOf = (agent: Agent): Selection => ({
  modelId: agent.model?.modelId ?? "",
  effort: agent.thinkingLevel === "off" ? undefined : agent.thinkingLevel,
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

/** One live harness process, serving one run at a time. */
export interface HostedProcess {
  /**
   * Serves the run `run`: switches to the run's model and effort, commits the reports the process holds, sends it
   * `opening`, then hands every frame to it until the harness goes idle (D2). An empty opening sends nothing: the run
   * serves the turn the harness began by itself (F8). A process that exits before the harness took the opening ends the
   * run `exited`.
   */
  readonly serve: (run: RunContext, opening: ReadonlyArray<Said>) => Effect.Effect<Ended, unknown>
  /** Whether `serve` can switch the process to `selection`; one that cannot needs a new process. */
  readonly canSelect: (selection: Selection) => boolean
  /**
   * Stops the turn of the run it served (D5): interrupts the harness and takes the run's frames, handing them to no run,
   * until the harness goes idle. Succeeds with whether the process can serve another run: it ended the turn within
   * `within`, with nothing left queued. Its jobs keep working (D7).
   */
  readonly stop: (within: Duration.Input) => Effect.Effect<boolean>
  /** Work the harness started and has not said ended, such as a background command or subagent: its jobs (D5). */
  readonly busy: boolean
  /** Completes once the process has no job. */
  readonly quiet: Effect.Effect<void>
  /** The harness began a turn by itself, which waits for a run to serve it (D3). */
  readonly waking: boolean
  /** The reports of the jobs that ended while no run served, oldest first; taken once. */
  readonly takeReports: () => ReadonlyArray<JobReport>
  /** Completes once the process has exited. */
  readonly exited: Effect.Effect<void>
  /** The cache facts of the newest main-loop request, for an idle compaction; `undefined` while none is known. */
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

/** A text or a call of one response. */
export type Part = { readonly type: "text"; readonly text: string } | ToolCall

/**
 * What an adapter tells the run, or a hosted subagent's job, of its harness. `at` is the harness's id of the message a
 * frame came in, where a resume continues from: a frame without one moves no position, so a harness whose frames
 * never carry one is always started fresh, told the conversation.
 */
export type Frame =
  /** Partial text of the response the harness is writing. */
  | { readonly type: "text"; readonly delta: string }
  /** One message of a response: its texts are committed, its calls sighted for their callbacks or results to commit. */
  | { readonly type: "said"; readonly response: string; readonly at?: string; readonly content: ReadonlyArray<Part> }
  /** The results of calls, as the harness reports them. */
  | {
      readonly type: "results"
      readonly at?: string
      readonly results: ReadonlyArray<{ readonly call: string; readonly text: string; readonly isError: boolean }>
    }
  /**
   * The harness started a subagent with the call `call`, which it knows as `task`; its frames go to the job
   * `ServingProcess.started` gives, and its end, with its final answer as the summary, as that job's `end`.
   * `background`: the turn can end while it works, so the run's conversation holds it as a job (D3).
   */
  | {
      readonly type: "subagent"
      readonly call: string
      readonly task: string
      readonly description: string
      readonly background: boolean
      readonly agentType?: string
      readonly prompt?: string
    }
  /**
   * The run's harness started a background command with the call `call`, which it knows as `task`: a job of the run's
   * conversation, whose end goes to the job `ServingProcess.started` gives.
   */
  | { readonly type: "command"; readonly call: string; readonly task: string; readonly description: string }
  /** The harness started a new context, as `/clear` does. */
  | { readonly type: "reset" }
  /** What each model spent since the process's previous report, keyed by the harness's model id. */
  | { readonly type: "spent"; readonly usage: ReadonlyArray<readonly [model: string, usage: Usage]> }
  /** The harness began a turn, such as its follow-up for a job's end or a steer: the one before it no longer ends the run. */
  | { readonly type: "began" }
  /** The turn ended with an answer, or at the conversation's turn limit; the run ends with it at the next `idle`. */
  | { readonly type: "answered"; readonly turnLimit: boolean }
  /**
   * The harness's turn is over, and with it the run, as its newest `answered` said (D2). A turn the harness began by
   * itself, such as for a job's end, is the run's too, since it comes before this.
   */
  | { readonly type: "idle" }
  /** The turn failed. `gone`: the harness no longer has the session, or the position it was resumed at. */
  | { readonly type: "failed"; readonly message: string; readonly gone?: boolean }

/** What the harness calls back for the calls of one conversation. */
export interface Callbacks {
  /** The call is about to run with `call.arguments`: it is committed first, so the intent is durable before the effect. */
  readonly beforeRun: (call: ToolCall, signal?: AbortSignal) => Promise<void>
  /** Whether the call may run: at once in a conversation that runs without asking, otherwise once a person answers. */
  readonly approve: (call: ToolCall, signal?: AbortSignal) => Promise<boolean>
  /**
   * Runs the call `call` of one of sigma's own tools, `name`, which a harness in member mode made through sigma: it is
   * committed with its tool task, as in sigma's own loop, and answered with the result that task committed, followed by
   * what the model must read now (`Member.notice`). An own tool's call takes neither `beforeRun` nor `approve`.
   */
  readonly runOwn: (call: string, name: string, input: unknown, signal?: AbortSignal) => Promise<OwnResult>
}

/** What a call of sigma's own tools answers the harness with. */
export type OwnResult = { readonly content: ReadonlyArray<TextContent | ImageContent>; readonly isError: boolean }
