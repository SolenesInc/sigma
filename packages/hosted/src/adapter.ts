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
   * Starts the harness at `start`; it is closed with the scope. `host` is what the harness's own calls reach: the run
   * that serves its turn, or a job's task. The hosted process reads the connection's frames and owns every decision
   * that depends on whether a run is served (D3).
   */
  readonly open: (config: ProcessConfig<S>, start: Start, host: Host) => Effect.Effect<Connection, never, Scope.Scope>
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

/**
 * One harness process as its adapter speaks it, in sigma's vocabulary. It never decides when a run ends, where a job's
 * report goes, or whether the process stays live: the hosted process does, from its frames (D3).
 */
export interface Connection {
  /**
   * Every frame the harness says, in order, whether or not a run is served. Ends when the harness exits; fails with the
   * error its end raised, if it raised one.
   */
  readonly frames: AsyncIterable<Frame>
  /** The harness's session, which a reset such as `/clear` may move to a new id. */
  readonly session: string
  /**
   * Whether a frame's `at` is a position a resume can continue from, as far as the harness's own state says: false
   * while a reset's new session id is not known yet. The hosted process adds that the harness took what it was sent.
   */
  readonly holdsPosition: boolean
  /**
   * Sends the harness a message, and returns its id, which the harness's `took` frame names once it took it. `next`
   * places it before the harness's next step, as a steer.
   */
  readonly send: (said: ReadonlyArray<Said>, priority?: "next") => string
  /** Whether `select` can switch the process to `selection`; one that cannot needs a new process. */
  readonly canSelect: (selection: Selection) => boolean
  /** Switches the harness to `selection`, which `canSelect` allows. */
  readonly select: (selection: Selection) => Effect.Effect<void, unknown>
  /** Stops the open turn. The harness then says `idle`. Its jobs keep working (D7). */
  readonly interrupt: () => Promise<void>
  /** Stops the job `job`. The harness then says `job-ended`. */
  readonly stopJob: (job: string) => Promise<void>
  /** The cache facts of the newest main-loop request, for an idle compaction; `undefined` while none is known. */
  readonly lastRequest: LastRequest | undefined
}

/** What the harness's own calls back reach, which the hosted process gives its adapter. */
export interface Host {
  /**
   * The callbacks for a call of the job `job`, or of the main loop when `undefined`. A main-loop call waits for the run
   * that serves its turn, which a turn the harness began by itself is served by only once a run attaches (F10).
   */
  readonly callbacks: (job: string | undefined, signal?: AbortSignal) => Promise<Callbacks>
  /** The harness compacted its context into `summary`, by a person's request (`manual`) or at its threshold. */
  readonly compacted: (summary: string, manual: boolean, signal?: AbortSignal) => Promise<void>
}

/** One live harness process, serving one run at a time: what the hosted process makes of a `Connection`. */
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
 * What an adapter says of its harness, which the hosted process hands the run, a hosted subagent's job, or holds. `at` is the harness's id of the message a
 * frame came in, where a resume continues from: a frame without one moves no position, so a harness whose frames
 * never carry one is always started fresh, told the conversation.
 */
export type Frame =
  /** Partial text of the response the harness is writing. */
  (
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
     * The harness started the job `id` with the call `call`: a subagent (`agent`), whose frames carry its id and whose
     * end, with its final answer as the summary, closes its conversation, or a command. `background`: the turn can end
     * while it works. A job a job started carries its parent's id as `job`; a job's own frames carry its id the same way.
     */
    | {
        readonly type: "job"
        readonly id: string
        readonly call: string
        readonly kind: "agent" | "command"
        readonly title: string
        readonly background: boolean
        readonly agentType?: string
        readonly prompt?: string
      }
    /** The harness said the job `id` ended; a subagent's `summary` is its final answer. */
    | {
        readonly type: "job-ended"
        readonly id: string
        readonly status: "completed" | "failed" | "stopped"
        readonly summary?: string
      }
    /** The harness took the message `send` returned `id` for: it answers it before its turn is over. */
    | { readonly type: "took"; readonly id: string }
    /**
     * The harness began running a turn. One that nothing sigma sent asked for, while no run serves, is a wake (D3): the
     * hosted process decides, from what it sent and what the harness took.
     */
    | { readonly type: "woke" }
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
     * itself, such as for a job's end, is the run's too, since it comes before this. While a message sent to the harness
     * has not been taken, nothing ends here: the harness begins another turn for it.
     */
    | { readonly type: "idle" }
    /** The turn failed. `gone`: the harness no longer has the session, or the position it was resumed at. */
    | { readonly type: "failed"; readonly message: string; readonly gone?: boolean }
  ) & {
    /** The job whose frame it is; none for the main loop's. */
    readonly job?: string
  }

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
