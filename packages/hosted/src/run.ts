// The hosted run: one run of a conversation whose model a harness serves, from its inputs to its run_end, as the task
// its adapter names (`claude.run`). It starts or resumes the harness's session where the conversation's position says,
// tells it what the session missed, and lets `converse` commit what it does. A host restart leaves calls without
// results; the next invocation records them as interrupted and goes on from the position. Each job the harness starts
// has a task of its own (`job.ts`), and outlives the run: a job's end that wakes the conversation starts a run that
// sends the harness nothing (D3).
import {
  applyBoundary,
  appendToolResult,
  convertPartial,
  cutOffCount,
  cutOffTooOften,
  endAnswered,
  endFailedRun,
  endRun,
  LiveDoc,
  type ModelRef,
  prepareBoundary,
  prepareFailure,
  renderSections,
  sectionExtension,
  type Agent,
  type Extension,
  INSTRUCTIONS_KEY,
  type RunCtx,
  type RunTasks,
  startRun,
  salvageable,
  type TaskApi,
  TaskServices,
} from "@sigma/harness"
import {
  type ConversationId,
  defineTask,
  type AnyTask,
  type EntryId,
  type EntryRecord,
  idFromNumber,
  type NextTaskState,
  type RunningTask,
  type Task,
  type TaskRuntime,
  type Tx,
} from "@sigma/kernel"
import type { Message } from "@sigma/models"
import { Effect } from "effect"
import { type Adapter, isMember, ownTools, type ProcessConfig, processKey, selectionOf, type Start } from "./adapter.ts"
import { JOB_KIND, JobAnchor, makeCommandTask, makeJobTask } from "./job.ts"
import { continuedOnItsOwn, REPORT_KIND } from "./jobs.ts"
import { JobLinks } from "./links.ts"
import type { HostedProcesses, Openings } from "./processes.ts"
import { history, INTERRUPTED, joining, type Retell, type Said, textOf, unseen } from "./retell.ts"
import type { Ended, HostedRunCheckpoint, RunContext } from "./serving.ts"
import { HostedSessionDoc } from "./session.ts"
import { expireApprovals, type Hosting } from "./transcript.ts"

/** What a resumed session is sent when nothing happened since its position, as after a restart that lost nothing. */
export const CONTINUE = "Continue."

export type HostedRunResult = { entryId?: EntryId }
type Runtime = TaskRuntime<Record<string, never>, HostedRunCheckpoint, HostedRunResult>
type Next = NextTaskState<HostedRunCheckpoint, HostedRunResult>
type Running = RunningTask<Record<string, never>, HostedRunCheckpoint, HostedRunResult>

export interface HostedRunOptions {
  /** The harnesses conversations can run on; a conversation runs on the first that serves its provider. */
  readonly adapters: ReadonlyArray<Adapter>
  /** The conversation's title, which names a fresh session so the harness does not ask a model for one. */
  readonly title?: (conversation: ConversationId) => Effect.Effect<string | undefined>
  /** The live processes the runs lease, from `makeHostedProcesses`. */
  readonly processes: HostedProcesses
  /**
   * The selected extensions whose tools the harness is offered as its own (F65): their prompt sections go to its
   * system prompt, before the agent's instructions. Default none.
   */
  readonly offered?: (agent: Agent) => ReadonlyArray<Extension>
  /** How a remote conversation's runs reach sigma in member mode (D9). */
  readonly member: MemberOptions
}

export interface MemberOptions {
  /** The harness's config folder and working folder for a target's processes, made if missing (D10). */
  readonly folder: (target: string) => Effect.Effect<{ readonly config: string; readonly cwd: string }>
  /**
   * What the model must read now of its target, such as an instance that changed since it was last told (D6), or
   * `undefined`. Asked before each run and after each of sigma's tool calls.
   */
  readonly notice: (
    conversation: ConversationId,
    target: string,
    after: "run" | "call",
  ) => Effect.Effect<string | undefined>
  /**
   * What a session is told of an entry sigma recorded with no model content, such as a change behind its target: told
   * among what the session missed, so a run that ended before the harness read the notice leaves it to the next (D6).
   */
  readonly retell: Retell
}

const failed = (message: string, reason: string): Next => ({
  status: "terminal",
  outcome: { status: "failed", error: { message, detail: { reason } } },
})

/** The calls of the run that have no result: the process that ran them is gone, so each gets `INTERRUPTED`. */
const interruptCalls = (tx: Tx, runtime: Runtime) =>
  Effect.gen(function* () {
    const live = yield* tx.doc(LiveDoc, runtime.conversationId)
    yield* convertPartial(tx, live, runtime.conversationId)
    delete live.generation
    for (const slot of live.tools ?? []) {
      if (slot.entry !== undefined) continue
      const call = { type: "toolCall" as const, id: slot.callId, name: slot.name, arguments: {} }
      const entry = yield* appendToolResult(
        tx,
        runtime.conversationId,
        call,
        { output: [{ type: "text", text: INTERRUPTED }], isError: true },
        { timestamp: runtime.now() },
      )
      slot.entry = entry.id
      slot.status = "done"
    }
    yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
    return live
  })

/**
 * Ends the calls of sigma's own tools whose tool tasks still run though no harness waits for them, as after its
 * process exited or the server restarted, so each call has its one result, from its task, before the run goes on.
 */
const endOwnCalls = (runtime: Runtime) =>
  Effect.gen(function* () {
    const slots = (yield* runtime.snapshot(LiveDoc, runtime.conversationId))?.tools ?? []
    for (const slot of slots) {
      if (slot.taskId !== undefined && slot.entry === undefined) yield* runtime.abortOwned(slot.taskId)
    }
  })

/** The entries after `seen` in the task's conversation, oldest first. */
const entriesAfter = (runtime: Runtime, seen: number) =>
  Effect.gen(function* () {
    const found: EntryRecord[] = []
    let cursor: Parameters<Runtime["entries"]>[2]
    do {
      const page = yield* runtime.entries(
        { minEntryId: idFromNumber<EntryId>(seen + 1), order: "ascending" },
        256,
        cursor,
      )
      found.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return found
  })

/**
 * Whether a session can go on past `entries`: nothing in them changed the context before them, as a reset, a
 * compaction or an edit does, and nothing came from another model.
 */
const continuable = (entries: readonly EntryRecord[], provider: string) =>
  entries.every((entry) => {
    if (entry.head !== undefined || (entry.edits?.length ?? 0) > 0) return false
    return (entry.model ?? []).every((message) => {
      const said = message as { role?: string; provider?: string }
      return said.role !== "assistant" || said.provider === provider
    })
  })

/**
 * Whether `entry` is what a stop recorded of the turn it cut off: the text the model was writing, or a call's result. A live
 * process kept through a stop ended that turn itself, and its session holds both (F14).
 */
const stopped = (entry: EntryRecord) =>
  (entry.model ?? []).every((message) => {
    const said = message as { role?: string; stopReason?: string; content?: unknown }
    if (said.role === "assistant") return said.stopReason === "aborted"
    return said.role === "toolResult" && textOf(said.content) === INTERRUPTED
  }) && (entry.model?.length ?? 0) > 0

/**
 * What a live process that has seen the entries through `seen` is told: what came after them, or `undefined` when
 * they changed the context it holds, as for a resume (F12). What a stop recorded is not told: only a stop the process
 * itself went through leaves it after `seen`, since any other cut-off ends the process. Nor is a job's report, which
 * the process read itself (D4): a run of reports alone is told nothing.
 */
const afterSeen = (runtime: Runtime, provider: string, seen: number, retell: Retell) =>
  Effect.map(entriesAfter(runtime, seen), (missed) => {
    if (!continuable(missed, provider)) return undefined
    const told = missedText(
      missed.filter((entry) => !stopped(entry) && entry.kind !== REPORT_KIND),
      retell,
    )
    if (told.length > 0) return told
    return missed.some((entry) => entry.kind === REPORT_KIND) ? [] : [CONTINUE]
  })

/**
 * What a session is told of the entries it missed, which may be nothing. A compaction's `/compact` stays the whole
 * prompt, since the harness reads only that as its command, so what `retell` names waits for a later run.
 */
const missedText = (missed: readonly EntryRecord[], retell: Retell): ReadonlyArray<Said> => {
  const all = unseen(missed, retell)
  return isCompaction(all) ? unseen(missed) : all
}

/** The id of the conversation's newest entry. */
const newest = (runtime: Runtime) => Effect.map(runtime.entries({}, 1), (page) => Number(page.items[0]?.id ?? 0))

/** Where the harness's session starts for this run, and what it is told first. */
const opening = (runtime: Runtime, api: TaskApi, harness: string, provider: string, title: Title, retell: Retell) =>
  Effect.gen(function* () {
    const current = (yield* runtime.snapshot(HostedSessionDoc, runtime.conversationId))?.current
    if (current !== undefined && current.provider === provider) {
      const missed = yield* entriesAfter(runtime, current.seen)
      if (continuable(missed, provider)) {
        const said = missedText(missed, retell)
        const texts = said.length === 0 ? [CONTINUE] : said
        const start: Start =
          current.conversation === Number(runtime.conversationId)
            ? { _tag: "resume", session: current.session, at: current.at }
            : { _tag: "fork", from: current.session, at: current.at, session: crypto.randomUUID() }
        return { start, texts }
      }
    }
    return yield* fresh(runtime, api, harness, title, retell, current?.seen)
  })

/**
 * A new session, told the conversation's context; one that already has answers is told it joins it. What `retell`
 * names after `since`, the position of the session it replaces, that session never read, so it is told first.
 */
const fresh = (
  runtime: Runtime,
  api: TaskApi,
  harness: string,
  title: Title,
  retell: Retell,
  since: number | undefined,
) =>
  Effect.gen(function* () {
    const { messages } = yield* api.context(runtime.conversationId)
    const named = yield* title(runtime.conversationId)
    const missed = since === undefined ? [] : yield* entriesAfter(runtime, since)
    const told = history(messages as Message[])
    // A compaction's `/compact` stays the whole prompt.
    const retold = isCompaction(told) ? [] : missed.flatMap((entry) => retell(entry) ?? [])
    const joins = messages.some((message) => message.role !== "user")
    const start: Start = {
      _tag: "fresh",
      session: crypto.randomUUID(),
      ...(named === undefined || named === "" ? {} : { title: named }),
    }
    return { start, texts: [...retold, ...(joins ? [joining(harness)] : []), ...told] }
  })

/** What a run tells its process before `texts`, the opening it was given. */
type Told = (texts: ReadonlyArray<Said>) => Effect.Effect<ReadonlyArray<Said>>

/** Whether an opening is a compaction's: the harness reads a `/compact` prompt as its command. */
const isCompaction = (texts: ReadonlyArray<Said>) => {
  const last = texts.findLast((part) => typeof part === "string")
  return last !== undefined && /^\/compact(\s|$)/.test(last)
}

/**
 * Serves the run with the conversation's live process, or a new one `openings` starts. A run that answers leaves the
 * process live, having seen every entry before the run's end, with any jobs still working (D5). A stopped run leaves it
 * live too, once the harness ended the turn it cut off (D5 of s-evw1pn). A live process told nothing serves the turn
 * the harness began by itself (F8); one with no such turn has nothing to answer, as for reports a turn already read.
 */
const converse = <E>(shared: Shared, config: ProcessConfig, run: RunContext, openings: Openings<E>, told: Told) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime } = run
      const lease = yield* shared.options.processes.lease(
        runtime.conversationId,
        processKey(config),
        selectionOf(config.agent),
        openings,
        (start, wake) =>
          run.adapter.open(config, start, (reports) =>
            wake(reports.length > 0 ? reports : [continuedOnItsOwn(run.adapter.name)]),
          ),
      )
      if (lease.texts.length === 0 && !lease.process.waking) {
        const answer = yield* newest(runtime)
        lease.keep(answer)
        return {
          ended: { _tag: "answered", answer: idFromNumber<EntryId>(answer), turnLimit: false } as Ended,
          live: lease.live,
        }
      }
      const ended = yield* lease.process.serve(run, [...(yield* told(lease.texts)), ...lease.texts]).pipe(
        // The run's commits are refused from here, but it still reads.
        Effect.onInterrupt(() =>
          Effect.ignore(
            Effect.gen(function* () {
              if (yield* lease.process.stop(shared.options.processes.stopWithin)) lease.keep(yield* newest(runtime))
            }),
          ),
        ),
      )
      yield* endOwnCalls(runtime)
      // Read before the run's end commits, which may start the next run with inputs the process has not seen.
      if (ended._tag === "answered" && !ended.turnLimit) lease.keep(yield* newest(runtime))
      return { ended, live: lease.live }
    }),
  )

/** Ends the run as `ended` says. */
const finish = (ctx: RunCtx & { readonly runtime: Runtime }, harness: string, ended: Ended) =>
  ctx.runtime.commit((tx) =>
    Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
      const { runtime, api } = ctx
      const answer = ended._tag === "answered" && !ended.turnLimit ? ended.answer : undefined
      const reset = ended._tag === "reset"
      const ends = answer !== undefined || reset
      const boundary = ends ? yield* prepareBoundary(tx, runtime.conversationId, api.settings()) : undefined
      const failure = ends ? undefined : yield* prepareFailure(tx, ctx)
      const live = yield* tx.doc(LiveDoc, runtime.conversationId)
      yield* convertPartial(tx, live, runtime.conversationId)
      yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
      if (answer !== undefined) {
        yield* endAnswered(tx, ctx, live, boundary!, answer)
        return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } }
      }
      if (reset) {
        // The queued reset cuts the run's context before an answer. The run ends before the boundary places it.
        yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" }, api.runOwner)
        const { users, first } = yield* applyBoundary(tx, boundary!, "postTools", runtime.now())
        if (users.length > 0) {
          yield* startRun(tx, runtime.conversationId, live, { inputs: users, first }, api.runTasks, {
            keepFailure: true,
          })
        }
        return { status: "terminal", outcome: { status: "completed", result: {} } }
      }
      const [reason, detail] =
        ended._tag === "failed" || ended._tag === "exited"
          ? (["model_error", ended.message] as const)
          : ended._tag === "gone"
            ? (["model_error", `${harness} lost its session twice`] as const)
            : ended.turnLimit
              ? (["turn_limit", `${harness} reached the conversation's turn limit`] as const)
              : (["nothing_to_answer", `${harness} ended without an answer`] as const)
      yield* endFailedRun(tx, ctx, live, failure!, { status: "unanswered", reason, detail })
      return failed(detail, reason)
    }),
  )

/** Ends a run whose invocations were cut off `restartLimit` times in a row (spec 5.4). */
const endCutOff = (ctx: RunCtx & { readonly runtime: Runtime }, harness: string, task: Running) =>
  ctx.runtime.commit((tx) =>
    Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
      const { runtime, api } = ctx
      const text = `The ${harness} run was interrupted ${cutOffCount(task)}`
      const failure = yield* prepareFailure(tx, ctx)
      const live = salvageable(task, api.settings().restartLimit)
        ? yield* interruptCalls(tx, runtime)
        : yield* tx.doc(LiveDoc, runtime.conversationId)
      yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "restart_limit", detail: text })
      return failed(text, "restart_limit")
    }),
  )

type Title = NonNullable<HostedRunOptions["title"]>

type Shared = { readonly options: HostedRunOptions; readonly hosting: Hosting }

/**
 * The system prompt's `append` of a member-mode process: the conversation's sections, rendered through its env as
 * sigma's own loop renders them for the tools it offers, so the model reads the target's instructions (D11).
 */
const appendOf = (runtime: Runtime, api: TaskApi, served: Agent) =>
  Effect.gen(function* () {
    const conversationId = runtime.conversationId
    const agent = { ...served, tools: ownTools(served) }
    const env = yield* Effect.orElseSucceed(api.env, () => undefined)
    const input = { conversationId, agent, env, shown: {}, read: { snapshot: runtime.snapshot } }
    const rendered = yield* renderSections(agent.sections, input as never, new Map(), (error) =>
      api.report(error, { kind: "host", callback: "section" }),
    )
    return rendered.size === 0 ? undefined : [...rendered.values()].join("\n\n")
  })

/**
 * What the harness adds to its own system prompt: the sections of the extensions it is offered, then the agent's
 * instructions as they are.
 */
const instructionsOf = (runtime: Runtime, api: TaskApi, agent: Agent, offered: ReadonlyArray<Extension>) =>
  Effect.gen(function* () {
    const keys = new Set(offered.flatMap((extension) => (extension.sections ?? []).map((section) => section.key)))
    const sections = agent.sections.filter((section) => section.key !== INSTRUCTIONS_KEY && keys.has(section.key))
    const rendered = yield* renderSections(
      sections,
      {
        conversationId: runtime.conversationId,
        agent,
        env: undefined,
        shown: {},
        read: { snapshot: (token, ...address) => runtime.snapshot(token, ...address) },
      },
      new Map(),
      (error, section) => {
        const extension = sectionExtension(agent, section.key)
        api.report(error, { kind: "extension", ...(extension === undefined ? {} : { extension }) })
      },
    )
    const parts = [...rendered.values(), ...(agent.instructions === undefined ? [] : [agent.instructions])]
    return parts.length === 0 ? undefined : parts.join("\n\n")
  })

const makeRunTask = (
  shared: Shared,
  adapter: Adapter,
): Task<Record<string, never>, HostedRunCheckpoint, HostedRunResult, TaskServices> =>
  defineTask<Record<string, never>, HostedRunCheckpoint, HostedRunResult, TaskServices>({
    name: adapter.kind,
    version: 1,
    initial: () => ({ phase: "converse" }),
    phases: {
      converse: (task, runtime) =>
        Effect.gen(function* () {
          const api = yield* TaskServices
          const ctx = { runtime, api }
          if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, adapter.name, task)
          // A call the last invocation left without a result was cut off, whether by a crash or by a stop, which the
          // kernel does not count as a restart; either ended its process. A call of sigma's own tools gets its result
          // from its tool task.
          yield* endOwnCalls(runtime)
          const slots = yield* runtime.snapshot(LiveDoc, runtime.conversationId)
          if (slots?.generation !== undefined || slots?.tools?.some((slot) => slot.entry === undefined)) {
            yield* runtime.commit((tx) => Effect.as(interruptCalls(tx, runtime), undefined as never))
          }
          const agent = yield* api.agent
          const provider = agent.model?.provider ?? ""
          const settings = adapter.settings(provider)
          if (settings === undefined) {
            const message = `${adapter.name} does not serve provider ${provider}`
            return yield* finish(ctx, adapter.name, { _tag: "failed", message })
          }
          const { member } = shared.options
          const target = isMember(agent) ? agent.target! : undefined
          const folder = target === undefined ? undefined : yield* member.folder(target)
          const instructions = yield* instructionsOf(runtime, api, agent, shared.options.offered?.(agent) ?? [])
          const config: ProcessConfig = {
            agent,
            settings,
            rootConversation: String(runtime.conversationId),
            ...(instructions === undefined ? {} : { instructions }),
            ...(folder === undefined ? {} : { member: { folder, append: appendOf(runtime, api, agent) } }),
          }
          const notice = target === undefined ? undefined : member.notice(runtime.conversationId, target, "run")
          const run: RunContext = {
            runtime,
            api,
            agent,
            adapter,
            hosting: shared.hosting,
            ...(target === undefined
              ? {}
              : { member: { notice: member.notice(runtime.conversationId, target, "call") } }),
          }
          const title: Title = shared.options.title ?? (() => Effect.succeed(undefined))
          const cold = () => opening(runtime, api, adapter.name, provider, title, member.retell)
          // The computer behind a remote conversation may have changed since its last run: it is told first, once for
          // the run however many processes serve it. A compaction is not told, and reaches no target, so its
          // `/compact` stays the whole prompt the harness reads as its command; the run after it is told. The change's
          // entry is retold to a session that has not seen it, so a process started after the change was recorded
          // already holds it in its opening.
          const changed = notice === undefined ? undefined : yield* Effect.cached(notice)
          const told: Told = (texts) =>
            changed === undefined || isCompaction(texts)
              ? Effect.succeed([])
              : Effect.map(changed, (text) => (text === undefined || texts.includes(text) ? [] : [text]))
          let { ended, live } = yield* converse(
            shared,
            config,
            run,
            { live: (seen) => afterSeen(runtime, provider, seen, member.retell), cold },
            told,
          )
          // A live process lost while it waited costs a cold start and nothing else (D1).
          if (ended._tag === "exited" && live) {
            ended = (yield* converse(shared, config, run, { cold }, told)).ended
          }
          if (ended._tag === "gone") {
            // The session is gone, or no longer holds the position (F12): start over, told the conversation.
            const since = (yield* runtime.snapshot(HostedSessionDoc, runtime.conversationId))?.current?.seen
            yield* runtime.commit((tx) =>
              Effect.map(tx.doc(HostedSessionDoc, runtime.conversationId), (doc) => {
                delete doc.current
                return undefined as never
              }),
            )
            ended = (yield* converse(
              shared,
              config,
              run,
              { cold: () => fresh(runtime, api, adapter.name, title, member.retell, since) },
              told,
            )).ended
          }
          // A target's own folder may hold no sign-in, where the harness keeps it there, as Claude Code does on Linux (C45).
          const signIn = folder !== undefined && ended._tag === "failed" ? adapter.signIn?.(ended.message) : undefined
          if (ended._tag === "failed" && signIn !== undefined) {
            ended = { ...ended, message: `${ended.message}. ${signIn}` }
          }
          return yield* finish(ctx, adapter.name, ended)
        }),
    },
    abort: (_task, runtime) =>
      Effect.gen(function* () {
        const api = yield* TaskServices
        const ctx = { runtime, api }
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
            // An input submitted after the abort withdrew the queue, before this commit, is queued behind the run.
            const failure = yield* prepareFailure(tx, ctx)
            const live = yield* interruptCalls(tx, runtime)
            yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "aborted" })
            return { status: "terminal", outcome: { status: "aborted" } }
          }),
        )
      }),
  })

/**
 * The run tasks of conversations whose model a harness serves: each adapter's run task, and `hosted.job` for the
 * conversations of the subagents a harness starts, each owned by a background `hosted.job-anchor`. `runTasks` is what
 * the harness is opened with; `tasks` are what the registry installs.
 */
export function hostedRunTasks(options: HostedRunOptions): {
  readonly tasks: ReadonlyArray<AnyTask<TaskServices>>
  readonly runTasks: RunTasks
} {
  const links = new JobLinks()
  const job = makeJobTask(links)
  const command = makeCommandTask(links)
  const shared: Shared = { options, hosting: { job, command, anchor: JobAnchor, links } }
  const runs = options.adapters.map((adapter) => [adapter, makeRunTask(shared, adapter)] as const)
  return {
    tasks: [...runs.map(([, run]) => run), job, JobAnchor, command],
    runTasks: {
      kinds: new Set([...options.adapters.map((adapter) => adapter.kind), JOB_KIND]),
      choose: (model: ModelRef | undefined) =>
        model === undefined ? undefined : runs.find(([adapter]) => adapter.settings(model.provider) !== undefined)?.[1],
    },
  }
}
