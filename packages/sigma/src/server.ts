// The server a home runs: one Harness over `kernel.sqlite`, served over the home's socket with the protocol
// (`@sigma/protocol`). Conversations run on the home's providers (`./providers.ts`).
import { join } from "node:path"
import { agyAdapter, clearBridges } from "@sigma/agy"
import { claudeAdapter } from "@sigma/claude"
import {
  appendReport,
  hostedRunTasks,
  JOB_KINDS,
  type JobReport,
  JobsDoc,
  makeHostedProcesses,
  REPORT_KIND,
} from "@sigma/hosted"
import { CodemodeSandbox } from "@sigma/codemode/sandbox"
import type { ExecutionEnv } from "@sigma/env"
import { LocalExecutionEnv } from "@sigma/env/local"
import type { TargetPool } from "@sigma/env/remote"
import { ProcessRegistry } from "@sigma/env/registry"
import {
  answerApproval,
  AgentDoc,
  ApprovalsDoc,
  approveAutomatically,
  configure,
  ConversationBusy as BusyConversation,
  type Conversation,
  type Submission,
  type ConversationView,
  type ConversationWindow,
  createRegistry,
  type EndedRun,
  type WithdrawnInput,
  InboxDoc,
  type Agent,
  openHarness,
  UsageDoc,
  type Harness,
  LiveDoc,
} from "@sigma/harness"
import {
  type ConversationId,
  type Cursor,
  type DocumentObservation,
  type DocumentObserver,
  type EntryId,
  idFromNumber,
  openSqliteStorage,
  type SubmissionId,
  type Tx,
} from "@sigma/kernel"
import type { AgentHello } from "@sigma/env/protocol"
import { fromProviders, type ImageContent, type Models } from "@sigma/models"
import type { ImageProcessor } from "@sigma/tools"
import { createNodePhotonImages } from "@sigma/tools/images/node"
import {
  ReadOnlyServer,
  CONFIGURED_KIND,
  ConversationBusy,
  NothingToContinue,
  FellBehind,
  NoSuchSubmission,
  type TaskGraphItem,
  InvalidConversationId,
  InvalidWindow,
  PROTOCOL_VERSION,
  SigmaRpcs,
  MODEL_KIND,
  NoSuchApproval,
  NoSuchConversation,
  NoSuchEntry,
  TakesNoInput,
  TargetUnavailable,
  UnknownProvider,
  type EntryRecord as WireEntry,
  USER_KIND,
  type Author,
  STARTED_KIND,
  FORKED_KIND,
  INTERRUPTED_KIND,
  CONTINUED_KIND,
  COMPACTION_KIND,
  WITHDRAWN_KIND,
  type View,
  type ViewItem,
  type Window,
} from "@sigma/protocol"
import {
  Cause,
  type Clock,
  Console,
  Context,
  type Duration,
  Effect,
  Exit,
  Layer,
  Queue,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import * as RpcServer from "effect/rpc/RpcServer"
import type { ModelAsk } from "./config.ts"
import type { ProviderOptions } from "./providers.ts"
import type { Home } from "./home.ts"
import { Lifetime } from "./lifetime.ts"
import { homeSocketServer } from "./socket.ts"
import { Setup } from "./setup.ts"
import { VERSION } from "./version.ts"
import { chosenNumber, ConversationIdsDoc, kernelNumber, refusedChoice } from "./ids.ts"
import { agentModel, Providers, LastModelDoc, selectionOf } from "./providers.ts"
import { countStops, restartLimitMessage } from "./restarts.ts"
import { endRun, LastRunEndDoc, switchModel, writeRunEnd } from "./run-end.ts"
import { committedSignIns } from "./sign-ins.ts"
import { codeModeTools, sigmaTools } from "./tools/index.ts"
import { attachedImages } from "./images.ts"
import { agentTools, type AgentTypes, interrupt, offeredToHarness, wakeWorker } from "./agents.ts"
import { followTreeStatus, type TreeStatuses } from "./status.ts"
import {
  attachedSkills,
  skillNames,
  toldOfWorkspace,
  userInput,
  type Workspace,
  workspaceInstructions,
} from "./workspace.ts"
import { projectDefaultModel } from "./config.ts"
import {
  envOn,
  forgetReaching,
  isLocal,
  openTargets,
  ReachingDoc,
  reachingIn,
  recordTarget,
  retellTarget,
  targetLoop,
  targetNotice,
  targetSection,
} from "./targets.ts"
import { lineageOf, listConversations, titleOf, wireId } from "./conversations.ts"
import { readableNdJsonRpc } from "./wire-errors.ts"

/**
 * The changes one watch may hold unread before it ends with `FellBehind` (D10); the connection stays open. Receipt: 1,500
 * prompts submitted 100 at a time to one conversation, a client that reads peaked at 34 queued changes; 300 at a time,
 * at 64. Past this the client is told it fell behind at its next read, and watches again from the position it holds.
 */
export const CONNECTION_QUEUE = 4096

/** The server's watch limit: CONNECTION_QUEUE unless a test needs a client to fall behind sooner. */
const ConnectionQueue = Context.Reference<number>("sigma/ConnectionQueue", { defaultValue: () => CONNECTION_QUEUE })

/**
 * The home's Harness, and the runs the server stopped too often in a row (D12): counted as it opens, before anything
 * runs, and ended `restart_limit` once scheduling resumes.
 */
export type KernelHarnessService = {
  readonly home: Home
  readonly harness: Harness
  readonly stoppedTooOften: Map<ConversationId, number>
  readonly status: TreeStatuses
  /** Prepares the images `read` returns and people attach. */
  readonly images: ImageProcessor
  readonly models: Models
  /** Opened read-only: it shows the home and changes nothing. */
  readonly readOnly: boolean
  /** The channel to each target its conversations act on. */
  readonly targets: TargetPool
  /** The environment of a conversation with this agent state, on its target. */
  readonly envOf: (agent: { readonly cwd?: string; readonly target?: string }) => ExecutionEnv
  /** Where a conversation with this agent state works, read through `env`. */
  readonly workspaceOf: (
    agent: { readonly cwd?: string; readonly target?: string },
    env: ExecutionEnv,
    conversation?: ConversationId,
  ) => Workspace
}

export class KernelHarness extends Context.Service<KernelHarness, KernelHarnessService>()("sigma/KernelHarness") {
  static readonly layer = (
    home: Home,
    readOnly: boolean,
    live: ClaudeLiveOptions,
    connector: ReadonlyArray<string> | undefined,
    bashTimeout?: number,
  ) =>
    Layer.effect(
      KernelHarness,
      Effect.gen(function* () {
        const { instances, agents, claude, agy, agentTypes, skills } = yield* Providers
        const lifetime = yield* Lifetime
        // An idle conversation compacts as a person's compact does, by its `/compact` input; one that is busy again by
        // then refuses it and goes on.
        let compactIdle = (_conversation: ConversationId): Effect.Effect<void, unknown> => Effect.void
        let recordReports = (
          _conversation: ConversationId,
          _reports: ReadonlyArray<JobReport>,
        ): Effect.Effect<void, unknown> => Effect.void
        let wakeHosted = (
          _conversation: ConversationId,
          _reports: ReadonlyArray<JobReport>,
        ): Effect.Effect<void, unknown> => Effect.void
        // Opened before the harness, so a server stop closes the live Claude Code processes after the runs (D3).
        const processes = yield* makeHostedProcesses({
          ...(live.idle === undefined ? {} : { idle: live.idle }),
          ...(live.clock === undefined ? {} : { clock: live.clock }),
          ...(live.idleCompaction ? { compact: (conversation) => compactIdle(conversation) } : {}),
          ...(live.stop === undefined ? {} : { stop: live.stop }),
          hold: lifetime.hold,
          wake: (conversation, reports) => wakeHosted(conversation, reports),
          record: (conversation, reports) => recordReports(conversation, reports),
        })
        const stoppedTooOften = new Map<ConversationId, number>()
        const registry = createRegistry()
        // Closed after the harness, which stops the scripts first. Closing asks a stuck worker to stop and does not wait
        // for it (F19).
        const sandbox = yield* Effect.acquireRelease(
          Effect.sync(() => new CodemodeSandbox()),
          (sandbox) => Effect.promise(() => sandbox.close()),
        )
        // One processor prepares the images `read` returns and the images people attach, in a worker that exits when idle.
        const images = createNodePhotonImages()
        const models = fromProviders(
          [...instances.values()].flatMap((instance) => (instance.provider ? [instance.provider] : [])),
        )
        // A crash leaves the local commands it ran running. They are killed before any run resumes, which would start them
        // again beside the old copies (D15). The home's lock is held, so none of them is another server's.
        const commands = new ProcessRegistry(home.processes)
        if (!readOnly) commands.sweep()
        // A killed server leaves its agy processes' bridge sockets; none of them is another server's either (D14).
        if (!readOnly) clearBridges(home.bridges)
        // Closed after the harness, so the runs stop before their targets' channels end; ending a channel stops the
        // target's commands (D7).
        const targets = yield* Effect.acquireRelease(
          // A read-only server changes nothing, and a hello on a target sweeps what an earlier server left running there.
          Effect.sync(() => openTargets(home, readOnly ? undefined : connector)),
          (targets) => targets.close(),
        )
        const local = (cwd: string) => new LocalExecutionEnv({ cwd, processes: commands })
        const homeEnv = local(home.dir)
        const envOf = (agent: { readonly cwd?: string; readonly target?: string }) => envOn(targets, local, home, agent)
        const workspaceOf = (
          agent: { readonly cwd?: string; readonly target?: string },
          env: ExecutionEnv,
          conversation?: ConversationId,
        ): Workspace => {
          const target = agent.target
          const reaching = conversation === undefined ? undefined : reachingIn(() => harness, conversation)
          return {
            env,
            cwd: agent.cwd ?? home.dir,
            home: { dir: home.dir, env: homeEnv },
            local: isLocal(target),
            reachable: isLocal(target) ? Effect.void : Effect.asVoid(targets.connect(target, reaching)),
          }
        }
        const typesOf: AgentTypes = (agent, env) =>
          env === undefined ? Effect.succeed([]) : agentTypes(agent.model?.provider, workspaceOf(agent, env))
        const adapters = [
          claudeAdapter((provider) => claude.get(provider)),
          agyAdapter((provider) => agy.get(provider), { dir: home.bridges, command: bridgeCommand }),
        ]
        // A harness that cuts a call of sigma's tools sooner than a wait returns, as agy does, limits each wait (D15).
        const waitLimit = (provider: string) =>
          adapters.find((adapter) => adapter.settings(provider) !== undefined)?.ownToolLimit
        const workers = agentTools(agents, typesOf, instances, {
          waitLimit,
          ...(live.clock === undefined ? {} : { clock: live.clock }),
        })
        const base = [sigmaTools(images, bashTimeout), workers, codeModeTools(sandbox)]
        for (const extension of base) registry.install(extension)
        registry.install(
          workspaceInstructions(
            instances,
            (agent, env, conversation) => (env === undefined ? undefined : workspaceOf(agent, env, conversation)),
            typesOf,
            skills,
          ),
        )
        registry.install(
          targetSection(
            targets,
            () => harness,
            (provider) => claude.has(provider),
          ),
        )
        // A local conversation's harness, Claude Code or agy, has its own tools and subagents, and is offered sigma's
        // worker tools beside them (D17), agy's over the bridge (D14). A remote one's Claude Code runs with remote hands,
        // with only sigma's (D9); agy runs only locally.
        const hosted = hostedRunTasks({
          adapters,
          offered: offeredToHarness,
          title: (conversation) => titleOf(harness, conversation),
          processes,
          remoteHands: {
            cwd: (target) => targetLoop(home, target),
            notice: targetNotice(targets, () => harness),
            retell: retellTarget,
          },
        })
        registry.install({ name: "hosted", tasks: hosted.tasks })
        // A run ended for the limit was aborted; its run_end says why.
        const runEnded = (tx: Tx, run: EndedRun) => {
          // The first run to end after the abort is the one the limit stopped, however it ended.
          const stops = stoppedTooOften.get(run.conversationId)
          stoppedTooOften.delete(run.conversationId)
          if (stops === undefined || run.answered || run.end.status === "done") return writeRunEnd(tx, run)
          return endRun(tx, run.conversationId, { outcome: "restart_limit", message: restartLimitMessage(stops) })
        }
        // A person's input withdrawn while it waited says so in the transcript, under the requestId it was submitted
        // with, so a client that lost its watch learns the input's fate from entries alone.
        // Withdrawn by submission/withdraw, it names who withdrew it.
        const inputWithdrawn = (tx: Tx, { conversationId, entry, data }: WithdrawnInput) =>
          entry?.kind === USER_KIND
            ? Effect.asVoid(
                tx.appendEntry(conversationId, {
                  kind: WITHDRAWN_KIND,
                  data: { requestId: (entry.data as { requestId: string }).requestId, ...data },
                }),
              )
            : Effect.void
        const harness: Harness = yield* Effect.acquireRelease(
          Effect.flatMap(openSqliteStorage(home.database), (storage) =>
            openHarness(storage, {
              registry,
              models,
              // A run's tool calls tell its clients while they wait for the target's hello.
              env: (agent) =>
                Effect.succeed(
                  envOn(
                    targets,
                    local,
                    home,
                    agent,
                    reachingIn(() => harness, agent.conversationId),
                  ),
                ),
              runEnded,
              inputWithdrawn,
              runTasks: hosted.runTasks,
              viewDocs: [ReachingDoc, JobsDoc],
              // A prompt queued behind a run that fails runs next, as one queued behind an answer does.
              settings: { afterFailedRun: "continue" },
              readOnly,
            }),
          ),
          (harness) => Effect.ignore(harness.close),
        )
        compactIdle = (conversation) =>
          Effect.flatMap(harness.conversation(conversation), (handle) => {
            if (handle === undefined) return Effect.fail(new Error(`conversation ${conversation} is gone`))
            return compactInRun(handle, { author: SIGMA, whenBusy: "reject" })
          })
        // A harness woke by itself: its reports reach the conversation as input, which an idle one runs (D3). A busy one
        // places them at its next step, and they are never sent to the harness, which read them itself (D4).
        // A worker's wake goes through a reporter in its parent, which mails the wake run's answer (D8 of s-7bmc8w).
        wakeHosted = (conversation, reports) =>
          Effect.flatMap(wakeWorker(harness, conversation, reports), (mailed) =>
            mailed ? Effect.void : wakeOn(conversation, reports),
          )
        const wakeOn = (conversation: ConversationId, reports: ReadonlyArray<JobReport>) =>
          Effect.flatMap(harness.conversation(conversation), (handle) =>
            Effect.forEach(
              reports,
              (report) =>
                handle === undefined
                  ? Effect.void
                  : handle.submit({
                      type: "input",
                      content: report.text,
                      whenBusy: "steer",
                      // No requestId: the harness's task id names a resumed subagent's every end, and nothing retries a wake.
                      entry: { kind: REPORT_KIND, ...(report.data === undefined ? {} : { data: report.data }) },
                    }),
              { discard: true },
            ),
          )
        // A process closed holding reports no run took: they join the transcript without a run, and a new process is
        // told them as anything else its session missed.
        recordReports = (conversation, reports) =>
          Effect.flatMap(harness.conversation(conversation), (handle) =>
            handle === undefined
              ? Effect.void
              : handle.commit((tx) =>
                  Effect.forEach(reports, (report) => appendReport(tx, conversation, report, Date.now()), {
                    discard: true,
                  }),
                ),
          )
        // Read-only, nothing runs, so no run counts a stop.
        if (!readOnly) for (const [id, stops] of yield* countStops(harness)) stoppedTooOften.set(id, stops)
        if (!readOnly) yield* forgetReaching(harness)
        const status = yield* followTreeStatus(harness)
        return { home, harness, stoppedTooOften, status, images, models, readOnly, targets, envOf, workspaceOf }
      }).pipe(Effect.orDie),
    )
}

/** Sigma as the author of what it does on its own, such as compacting an idle conversation. */
const SIGMA: Author = { id: "sigma", name: "sigma" }

/**
 * Compacts a conversation whose provider runs its own loop, such as Claude Code: its `/compact` input starts a run in
 * which the provider summarizes its context, committed as a pi.compaction entry. `whenBusy` defaults to queueing.
 */
const compactInRun = (
  conversation: Conversation,
  request: { readonly author: Author; readonly instructions?: string; readonly whenBusy?: "reject" },
) => {
  const requestId = crypto.randomUUID()
  const text = request.instructions === undefined ? "/compact" : `/compact ${request.instructions}`
  return conversation.submit({
    type: "input",
    content: [{ type: "text", text }],
    requestId,
    entry: { kind: USER_KIND, data: { author: request.author, requestId } },
    ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
  })
}

/** How the run of a `/compact` input ended, as `conversation/compact` answers. */
const compactionOfRun = (conversation: Conversation, submission: Submission) =>
  Effect.gen(function* () {
    const settled = yield* submission.wait
    if (settled.type !== "input") return yield* Effect.die(new Error(`a /compact input settled as a ${settled.type}`))
    if (settled.status === "unanswered") {
      // Withdrawn while queued, or its run stopped.
      if (settled.reason === "aborted") return { outcome: "stopped" as const }
      const message = typeof settled.detail === "string" ? settled.detail : settled.reason
      return { outcome: "failed" as const, message }
    }
    // The run's entries run from its input to its answer; the provider's summary is among them when it compacted.
    const span = Number(settled.answer) - Number(settled.entry) + 1
    const entries = yield* conversation.entries(
      { minEntryId: settled.entry, maxEntryId: settled.answer, order: "ascending" },
      span,
    )
    return entries.items.some((entry) => entry.kind === COMPACTION_KIND)
      ? { outcome: "compacted" as const }
      : { outcome: "nothing_to_compact" as const }
  })

const toWindow = (window: Window | undefined): ConversationWindow | undefined =>
  window === undefined
    ? undefined
    : {
        ...(window.from === undefined ? {} : { from: idFromNumber<EntryId>(window.from) }),
        ...(window.min === undefined ? {} : { min: window.min }),
        ...(window.max === undefined ? {} : { max: window.max }),
      }

const Handlers = SigmaRpcs.toLayer(
  Effect.gen(function* () {
    const { home, harness, stoppedTooOften, status, images, models, readOnly, targets, envOf, workspaceOf } =
      yield* KernelHarness
    const connectionQueue = yield* ConnectionQueue
    const providers = yield* Providers
    const setup = yield* Setup.make(providers.instances, yield* committedSignIns(harness, readOnly))
    const lifetime = yield* Lifetime
    // Keeps the server up while the harness has work, such as a run a submission started or a crash left.
    const scope = yield* Effect.scope
    // The hold is taken before `admit` and handed to an idle wait that starts after it, so the work `admit` admits
    // is never unheld: an idle wait started earlier can return before the work exists.
    // The harness's idle leaves out work under background tasks, such as a subagent and its reporter, so the hold also
    // waits for every task left; a blocked task waits for a person, not for the server. A Claude Code job lives as long
    // as its process, whose own hold keeps the server up, and which a stop closes, cutting the job off (D5).
    const quiet = Effect.gen(function* () {
      for (;;) {
        yield* harness.waitForIdle
        const live = (yield* harness.inspect).tasks.filter(
          (task) => task.state.kind !== "blocked" && !JOB_KINDS.has(task.record.kind),
        )
        if (live.length === 0) return
        yield* Effect.forEach(live, (task) => harness.waitForTask(task.record.id), {
          concurrency: "unbounded",
          discard: true,
        })
      }
    })
    const heldUntilIdle = <A, E>(admit: Effect.Effect<A, E>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const held = yield* Scope.make()
          yield* Scope.provide(lifetime.hold, held)
          const admitted = yield* Effect.exit(restore(admit))
          yield* Effect.forkIn(Effect.ensuring(Effect.ignore(quiet), Scope.close(held, Exit.void)), scope)
          return yield* admitted
        }),
      )
    /** Refuses a call that would change the home when the server opened it read-only. */
    const writable = readOnly
      ? Effect.fail(
          new ReadOnlyServer({
            message: `the server opened ${home.dir} read-only, so it changes nothing; stop it and run sigma serve to make changes`,
          }),
        )
      : Effect.void
    const writing =
      <P, A, E, R>(handler: (payload: P) => Effect.Effect<A, E, R>) =>
      (payload: P) =>
        Effect.andThen(writable, handler(payload))
    if (!readOnly) yield* heldUntilIdle(Effect.orDie(harness.resume))
    // Ends each run the server stopped during too often; its run_end says restart_limit.
    for (const id of stoppedTooOften.keys()) {
      yield* heldUntilIdle(
        Effect.orDie(Effect.flatMap(harness.conversation(id), (conversation) => conversation?.abort() ?? Effect.void)),
      )
    }

    /** The kernel number of a wire id: a chosen id's mapping, or the number it is. */
    const resolve = (id: string) =>
      Effect.map(Effect.orDie(harness.session.snapshot(ConversationIdsDoc)), (chosen) => {
        const mapped = chosenNumber(chosen, id)
        return mapped === undefined ? kernelNumber(id) : idFromNumber<ConversationId>(mapped)
      })

    const find = (id: string) =>
      Effect.flatMap(
        Effect.flatMap(resolve(id), (kernelId) =>
          kernelId === undefined ? Effect.succeed(undefined) : Effect.orDie(harness.conversation(kernelId)),
        ),
        (conversation) =>
          conversation === undefined
            ? Effect.fail(new NoSuchConversation({ conversation: id }))
            : Effect.succeed(conversation),
      )

    const agentOf = (conversation: Conversation) => Effect.orDie(conversation.agent)

    /** A conversation that takes input: not one its parent's provider runs inside its parent's run. */
    const takingInput = (id: string) =>
      Effect.gen(function* () {
        const conversation = yield* find(id)
        const lineage = yield* lineageOf(harness, conversation.id)
        if (lineage !== undefined && lineage.task === undefined) return yield* new TakesNoInput({ conversation: id })
        return conversation
      })

    /**
     * The skills `text` names, read now. A skill named while its target is unreachable could not be read, and the
     * input would go without it, as if it named none: it is refused instead, so the person knows.
     */
    const skillsNamed = (agent: Agent, text: string) =>
      Effect.gen(function* () {
        const env = envOf(agent)
        if (skillNames(text).length > 0 && toldOfWorkspace(providers.instances, agent)) yield* reach(agent.target)
        return yield* attachedSkills(env, text, providers.skills(agent.model?.provider, workspaceOf(agent, env)))
      })

    // Starts with a chosen id one at a time, so two starts with one new id make one conversation.
    const choosing = yield* Semaphore.make(1)

    // A remote target is reached before a start: one that cannot be reached starts nothing (D4).
    const reach = (target: string | undefined) =>
      isLocal(target)
        ? Effect.succeed(undefined)
        : targets.connect(target).pipe(
            Effect.map((hello) => ({ target, hello })),
            Effect.mapError((error) => new TargetUnavailable({ target, reason: error.reason })),
          )
    const startConversation = (
      cwd: string,
      reached: { readonly target: string; readonly hello: AgentHello } | undefined,
      id: string | undefined,
      approvals: "ask" | "auto" | undefined,
      instructions: string | undefined,
      ask: ModelAsk,
      author: Author,
    ) =>
      Effect.gen(function* () {
        yield* writable
        const remote = reached?.target
        const last = yield* Effect.orDie(harness.session.snapshot(LastModelDoc))
        const project = yield* projectDefaultModel(
          envOf({ cwd, ...(remote === undefined ? {} : { target: remote }) }),
          cwd,
        )
        const { selection, instance } = yield* providers.choose(project, ask, last?.selection)
        const model = yield* agentModel(selection, instance)
        // One commit: a second start with the same id finds the first one's mapping.
        let started: ConversationId | undefined
        const conversation = yield* Effect.orDie(
          harness.createConversation({
            ownership: { kind: "ownerless" },
            agent: { ...model, cwd, ...(instructions === undefined ? {} : { instructions }) },
            ...(remote === undefined ? {} : { target: remote }),
            init: (tx, created) =>
              Effect.gen(function* () {
                started = created
                if (reached !== undefined) yield* recordTarget(tx, created, reached.target, reached.hello)
                if (approvals === "auto") yield* approveAutomatically(tx, created)
                if (id !== undefined) (yield* tx.doc(ConversationIdsDoc)).ids[id] = Number(created)
                ;(yield* tx.doc(LastModelDoc)).selection = { ...selection }
                yield* tx.appendEntry(created, { kind: STARTED_KIND, data: { author } })
              }),
          }),
        )
        return { conversation: id ?? String(started ?? conversation.id), model: selectionOf(model) }
      })

    /**
     * A watch's items: `first` of the value `attach` observes, then each commit's operations on it. A full queue ends
     * the watch instead of holding the Session line; what it held is dropped so the client hears FellBehind at its next
     * read.
     */
    const follow = <V, I, E>(
      attach: (observer: DocumentObserver<V>) => Effect.Effect<DocumentObservation<V>, E>,
      first: (value: V) => I,
    ) =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<
          I | { readonly _tag: "change"; readonly ops: ReadonlyArray<unknown> },
          FellBehind | Cause.Done
        >(connectionQueue)
        let behind = false
        const observation = yield* Effect.acquireRelease(
          attach({
            // On the Session line: only capture.
            advance: (change) => {
              if (behind || Queue.offerUnsafe(queue, { _tag: "change" as const, ops: change.ops })) return
              behind = true
              Effect.runSync(Queue.clear(queue))
              Queue.failCauseUnsafe(queue, Cause.fail(new FellBehind({ limit: connectionQueue })))
            },
            end: (end) => {
              if (end.kind === "ended") Queue.endUnsafe(queue)
              else Queue.failCauseUnsafe(queue, Cause.die(end.error))
            },
          }),
          (attached) => Effect.sync(() => attached.detach()),
        )
        return Stream.concat(Stream.make(first(observation.value)), Stream.fromQueue(queue))
      })

    /** Refuses an id a client chose that cannot name a new conversation, or names one already. */
    const freshChoice = (id: string) =>
      Effect.gen(function* () {
        const refused = refusedChoice(id)
        if (refused !== undefined) return yield* new InvalidConversationId({ message: refused })
        // refusedChoice refuses every all-digit id, so only a chosen id can be taken.
        if (chosenNumber(yield* Effect.orDie(harness.session.snapshot(ConversationIdsDoc)), id) !== undefined)
          return yield* new InvalidConversationId({ message: `${id} already names a conversation` })
      })

    const fork = (id: string, at: number, chosen: string | undefined, author: Author) =>
      Effect.gen(function* () {
        const conversation = yield* takingInput(id)
        const entry = idFromNumber<EntryId>(at)
        const visible = yield* Effect.orDie(harness.session.read((storage) => storage.entry(conversation.id, entry)))
        if (visible === undefined) return yield* new NoSuchEntry({ entry: at })
        const auto = (yield* Effect.orDie(harness.session.snapshot(ApprovalsDoc, conversation.id)))?.auto === true
        // The fork goes on with the settings as they are now, not as they were at `at`.
        const settings = yield* Effect.orDie(harness.session.snapshot(AgentDoc, conversation.id))
        const forked = yield* Effect.orDie(
          conversation.fork(entry, {
            ownership: { kind: "ownerless" },
            init: (tx, created) =>
              Effect.gen(function* () {
                if (settings !== undefined) {
                  const agent = yield* tx.doc(AgentDoc, created)
                  for (const key of Object.keys(agent)) delete agent[key as keyof typeof agent]
                  Object.assign(agent, structuredClone(settings))
                }
                if (auto) yield* approveAutomatically(tx, created)
                if (chosen !== undefined) (yield* tx.doc(ConversationIdsDoc)).ids[chosen] = Number(created)
                yield* tx.appendEntry(created, { kind: FORKED_KIND, data: { author } })
              }),
          }),
        )
        return { conversation: chosen ?? String(forked.id) }
      })

    const watchTasks = Stream.unwrap(
      Effect.gen(function* () {
        yield* lifetime.hold
        return yield* follow(
          (observer) => Effect.orDie(harness.observeTaskGraph(observer)),
          (graph): TaskGraphItem => ({ _tag: "graph", graph: graph as unknown as { tasks: Record<string, unknown> } }),
        )
      }),
    )

    const watch = (id: string, window: Window | undefined) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* lifetime.hold
          const conversation = yield* find(id)
          return yield* follow(
            (observer) =>
              harness.observeConversation(conversation.id, observer, toWindow(window)).pipe(
                Effect.orDie,
                // The harness checks the window's bounds and names the one that is wrong.
                Effect.catchDefect((defect) =>
                  defect instanceof RangeError
                    ? Effect.fail(new InvalidWindow({ message: defect.message }))
                    : Effect.die(defect),
                ),
              ),
            (view: ConversationView): ViewItem => ({ _tag: "view", view: toView(view) }),
          )
        }),
      )

    return SigmaRpcs.of({
      initialize: () => Effect.succeed({ version: VERSION, protocol: PROTOCOL_VERSION, readOnly }),
      "conversation/start": ({ cwd, target, id, approvals, instructions, author, ...ask }) =>
        Effect.gen(function* () {
          if (id === undefined)
            return yield* startConversation(cwd, yield* reach(target), undefined, approvals, instructions, ask, author)
          // A conversation's number opens it, as its chosen id does, and answers with the id every other call names it
          // by; a number that names none is refused below.
          const numbered = kernelNumber(id)
          if (numbered !== undefined && (yield* Effect.orDie(harness.conversation(numbered))) !== undefined) {
            return {
              conversation: yield* wireId(harness, numbered),
              model: selectionOf(yield* Effect.orDie(harness.resolveAgent(numbered))),
            }
          }
          const refused = refusedChoice(id)
          if (refused !== undefined) return yield* Effect.fail(new InvalidConversationId({ message: refused }))
          const chosen = Effect.gen(function* () {
            const existing = chosenNumber(yield* Effect.orDie(harness.session.snapshot(ConversationIdsDoc)), id)
            if (existing === undefined) return undefined
            const agent = yield* Effect.orDie(harness.resolveAgent(idFromNumber<ConversationId>(existing)))
            return { conversation: id, model: selectionOf(agent) }
          })
          // An id that names a conversation keeps it, whatever its target's state. A new one's target is reached
          // outside the permit, so a target slow to answer holds up no other start.
          const found = yield* chosen
          if (found !== undefined) return found
          const reached = yield* reach(target)
          return yield* choosing.withPermits(1)(
            Effect.gen(function* () {
              return (
                (yield* chosen) ?? (yield* startConversation(cwd, reached, id, approvals, instructions, ask, author))
              )
            }),
          )
        }),
      "conversation/submit": writing(({ conversation: id, requestId, author, text, images: attaching = [], steer }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          const agent = yield* agentOf(conversation)
          const { content, attached } = userInput(
            text,
            yield* skillsNamed(agent, text),
            yield* attachedImages(attaching, images, models, agent),
          )
          const entry = {
            kind: USER_KIND,
            data: {
              author,
              requestId,
              ...(attached.length === 0 ? {} : { skills: attached }),
              ...(attaching.length === 0 ? {} : { images: attaching.map((image) => image.name) }),
            },
          }
          const submission = yield* heldUntilIdle(
            Effect.orDie(
              conversation.submit({
                type: "input",
                content,
                requestId,
                entry,
                ...(steer ? { whenBusy: "steer" as const } : {}),
              }),
            ),
          )
          return { submission: submission.id }
        }),
      ),
      "conversation/list": () => listConversations(harness),
      "conversation/select_model": writing(({ conversation: id, author, selection }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          const instance = providers.instances.get(selection.provider)
          if (instance === undefined) return yield* new UnknownProvider({ provider: selection.provider })
          const model = yield* agentModel(selection, instance)
          const subagent = (yield* lineageOf(harness, conversation.id)) !== undefined
          yield* Effect.orDie(
            conversation.commit((tx) =>
              Effect.gen(function* () {
                yield* switchModel(tx, conversation.id, {
                  model: model.model,
                  thinkingLevel: model.thinkingLevel ?? null,
                })
                yield* tx.appendEntry(conversation.id, { kind: MODEL_KIND, data: { author, selection } })
                // The model chosen last is one a person chose for a conversation they started.
                if (!subagent) (yield* tx.doc(LastModelDoc)).selection = { ...selection }
              }),
            ),
          )
        }),
      ),
      "skills/list": ({ conversation: id }) =>
        Effect.gen(function* () {
          const agent = yield* agentOf(yield* find(id))
          return [...(yield* providers.skills(agent.model?.provider, workspaceOf(agent, envOf(agent))))]
        }),
      "conversation/entries": ({ conversation: id, from, to, order, limit, cursor }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const page = yield* Effect.orDie(
            conversation.entries(
              {
                ...(from === undefined ? {} : { minEntryId: idFromNumber<EntryId>(from) }),
                ...(to === undefined ? {} : { maxEntryId: idFromNumber<EntryId>(to) }),
                ...(order === undefined ? {} : { order }),
              },
              limit,
              cursor as Cursor | undefined,
            ),
          )
          return {
            entries: page.items as unknown as ReadonlyArray<WireEntry>,
            ...(page.next === undefined ? {} : { next: page.next }),
          }
        }),
      "conversation/context": ({ conversation: id, at }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const entry = at === undefined ? undefined : idFromNumber<EntryId>(at)
          if (entry !== undefined) {
            const visible = yield* Effect.orDie(
              harness.session.read((storage) => storage.entry(conversation.id, entry)),
            )
            if (visible === undefined) return yield* new NoSuchEntry({ entry: at! })
          }
          const context = yield* Effect.orDie(conversation.context(entry === undefined ? {} : { at: entry }))
          return { messages: context.messages, entries: context.entries.map((record) => Number(record.id)) }
        }),
      "conversation/watch": ({ conversation, window }) => watch(conversation, window),
      "conversation/fork": writing(({ conversation, at, id, author }) =>
        id === undefined
          ? fork(conversation, at, undefined, author)
          : choosing.withPermits(1)(Effect.andThen(freshChoice(id), fork(conversation, at, id, author))),
      ),
      "conversation/reset": writing(({ conversation: id, author, handoff }) =>
        Effect.flatMap(takingInput(id), (conversation) =>
          heldUntilIdle(Effect.orDie(conversation.reset(handoff, { author }))),
        ),
      ),
      "conversation/compact": writing(({ conversation: id, author, instructions }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          if (harness.runTasks.choose((yield* agentOf(conversation)).model) !== undefined) {
            // A person's compact queues behind a run in flight, as the same text typed would.
            const submission = yield* heldUntilIdle(
              Effect.orDie(
                compactInRun(conversation, { author, ...(instructions === undefined ? {} : { instructions }) }),
              ),
            )
            return yield* Effect.orDie(compactionOfRun(conversation, submission))
          }
          const task = yield* heldUntilIdle(Effect.orDie(conversation.compact(instructions, { author })))
          const outcome = (yield* Effect.orDie(harness.waitForTask(task))).state.outcome
          if (outcome.status === "completed") {
            // The summary is placed as a write; a compaction that found nothing to summarize places none.
            const { entryId, submissionId } = outcome.result
            return { outcome: entryId === undefined && submissionId === undefined ? "nothing_to_compact" : "compacted" }
          }
          if (outcome.status === "aborted") return { outcome: "stopped" as const }
          return { outcome: "failed" as const, message: outcome.error?.message ?? outcome.reason ?? outcome.status }
        }),
      ),
      "conversation/continue": writing(({ conversation: id, author }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          // A working run is the reason to refuse first: how the run before it ended says nothing about this one.
          if ((yield* Effect.orDie(harness.session.snapshot(LiveDoc, conversation.id)))?.run !== undefined)
            return yield* new ConversationBusy({ conversation: id })
          const last = (yield* Effect.orDie(harness.session.snapshot(LastRunEndDoc, conversation.id)))?.end?.data
          if (last === undefined)
            return yield* new NothingToContinue({ message: "no run has ended here yet; send a message to start one" })
          if (last.outcome === "answered")
            return yield* new NothingToContinue({ message: "the last run answered; send a message to go on" })
          // The continue and the entry naming who continued commit together, before the run's first entry.
          const submission = yield* heldUntilIdle(
            conversation
              .commit((tx) =>
                Effect.gen(function* () {
                  const submission = yield* conversation.submit(tx, { type: "continue" })
                  yield* tx.appendEntry(conversation.id, { kind: CONTINUED_KIND, data: { author } })
                  return submission
                }),
              )
              .pipe(
                Effect.catchIf(
                  (error) => error instanceof BusyConversation,
                  () => Effect.fail(new ConversationBusy({ conversation: id })),
                ),
                Effect.catchIf(
                  (error) => !(error instanceof ConversationBusy),
                  (error) => Effect.die(error),
                ),
              ),
          )
          return { submission: Number(submission) }
        }),
      ),
      "submission/withdraw": writing(({ conversation: id, submission, author }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const result = yield* Effect.orDie(
            harness.abortSubmission(idFromNumber<SubmissionId>(submission), conversation.id, { author }),
          )
          if (result === "not_found") return yield* new NoSuchSubmission({ submission })
          return { result: result === "aborted" ? ("withdrawn" as const) : result }
        }),
      ),
      "submission/update": writing(({ conversation: id, submission, author, text, steer }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const sid = idFromNumber<SubmissionId>(submission)
          const attached = text === undefined ? undefined : yield* skillsNamed(yield* agentOf(conversation), text)
          const result = yield* Effect.orDie(
            conversation.commit((tx) =>
              Effect.gen(function* () {
                const record = yield* tx.submission(sid)
                if (record === undefined || record.conversationId !== conversation.id) return "not_found" as const
                if (record.status !== "queued") return record.status === "placed" ? "already_placed" : "settled"
                const item = (yield* tx.doc(InboxDoc, conversation.id)).items.find((queued) => queued.id === sid)
                // Only a person's input says what a person wrote; the rest of the queue is Sigma's own.
                if (item === undefined || item.mode === "write" || item.entry?.kind !== USER_KIND) {
                  return "not_found" as const
                }
                const { entry } = item
                const data = { ...(entry.data as object), editedBy: author } as Record<string, unknown>
                if (text !== undefined && attached !== undefined) {
                  const queued: unknown = item.content
                  const kept = Array.isArray(queued) ? queued.filter((part) => part.type === "image") : []
                  item.content = userInput(text, attached, kept as Array<ImageContent>).content as typeof item.content
                  delete data.skills
                  if (attached.length > 0) data.skills = attached
                }
                entry.data = data as NonNullable<typeof entry.data>
                if (steer !== undefined) item.mode = steer ? "steer" : "followUp"
                return "updated" as const
              }),
            ),
          )
          if (result === "not_found") return yield* new NoSuchSubmission({ submission })
          return { result }
        }),
      ),
      "conversation/configure": writing(({ conversation: id, author, maxTurns }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          yield* Effect.orDie(
            conversation.commit((tx) =>
              Effect.gen(function* () {
                yield* configure(tx, conversation.id, { maxTurns })
                yield* tx.appendEntry(conversation.id, { kind: CONFIGURED_KIND, data: { author, maxTurns } })
              }),
            ),
          )
        }),
      ),
      "usage/get": ({ conversation: id }) =>
        id === undefined
          ? Effect.orDie(harness.usage)
          : Effect.gen(function* () {
              const conversation = yield* find(id)
              const usage = yield* Effect.orDie(harness.session.snapshot(UsageDoc, conversation.id))
              return usage ?? { models: {}, tools: {} }
            }),
      "tasks/watch": () => watchTasks,
      "conversation/interrupt": writing(({ conversation: id, author }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          yield* Effect.orDie(
            conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: INTERRUPTED_KIND, data: { author } })),
          )
          yield* Effect.orDie(interrupt(harness, conversation.id))
        }),
      ),
      "approval/resolve": writing(({ conversation: id, approval, author, allow }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const answered = yield* Effect.orDie(
            conversation.commit((tx) =>
              answerApproval(tx, conversation.id, approval, { allow, author, at: Date.now() }),
            ),
          )
          if (answered === "unknown") return yield* Effect.fail(new NoSuchApproval({ approval }))
          return { accepted: answered === "accepted" }
        }),
      ),
      "status/watch": () => Stream.unwrap(Effect.as(lifetime.hold, status.watch(connectionQueue))),
      // Stops once the runs in flight settle; a run is never cut off by a stop.
      "server/stop": () => Effect.andThen(Effect.ignore(quiet), afterReply(lifetime.stop)),
      "providers/list": ({ refresh }) => setup.providers(refresh ?? false),
      "models/list": ({ refresh }) => setup.models(refresh ?? false),
      "auth/start": writing(({ provider, method }) => setup.start(provider, method)),
      "auth/respond": ({ provider, flow, response }) =>
        Effect.map(setup.respond(provider, flow, response), (accepted) => ({ accepted })),
      "auth/cancel": ({ provider, flow }) => Effect.map(setup.cancel(provider, flow), (accepted) => ({ accepted })),
      "auth/logout": writing(({ provider }) => setup.logout(provider)),
      "auth/watch": () => Stream.unwrap(Effect.as(lifetime.hold, setup.watch)),
    })
  }),
)

/** The view as the wire carries it: kernel ids are plain numbers already. */
const toView = (view: ConversationView): View => view as unknown as View

const afterReply = (effect: Effect.Effect<void>) =>
  Effect.withFiber((handler) =>
    Effect.sync(() => {
      handler.addObserver(() => Effect.runFork(effect))
    }),
  )

/** The command `agy` runs to reach a bridge socket: this sigma's `mcp-bridge` (D14). */
const bridgeCommand = (socket: string) => {
  const main = join(import.meta.dir, "main.ts")
  return main.startsWith("/$bunfs")
    ? { command: process.execPath, args: ["mcp-bridge", socket] }
    : { command: process.execPath, args: [main, "mcp-bridge", socket] }
}

/** How the server's live Claude Code processes wait for their conversation's next run. */
export interface ClaudeLiveOptions {
  /** How long a Claude Code process stays live for its conversation's next run; default `IDLE_RELEASE`. */
  readonly idle?: Duration.Input
  /** How long a stopped run waits for Claude Code to end its turn before closing its process; default `STOP_TIMEOUT`. */
  readonly stop?: Duration.Input
  /** What the live processes keep time by; default the server's clock. Tests advance one. */
  readonly clock?: Clock.Clock
  /** An idle conversation with a long context compacts before its prompt cache expires: `claude_idle_compaction`. */
  readonly idleCompaction: boolean
}

export interface ServerOptions {
  /** How long the server outlives its last watch, run and live Claude Code process. */
  readonly idleGrace: Duration.Input
  /** How long a Claude Code process stays live for its conversation's next run; default `IDLE_RELEASE`. */
  readonly claudeIdle?: Duration.Input
  /** How long a stopped run waits for Claude Code to end its turn before closing its process; default `STOP_TIMEOUT`. */
  readonly claudeStop?: Duration.Input
  /** What the live Claude Code processes and `wait_worker` keep time by; default the server's clock. Tests advance one. */
  readonly clock?: Clock.Clock
  /** Show the home and change nothing: no run resumes, and calls that would change it are refused. */
  readonly readOnly?: boolean
  readonly providers: ProviderOptions
  readonly connectionQueue?: number
  /** Seconds `bash` lets a command run when its call gives no `timeout`; default the tool's. Tests shorten it. */
  readonly bashTimeout?: number
}

export const serverLayer = (home: Home, options: ServerOptions) =>
  RpcServer.layer(SigmaRpcs).pipe(
    Layer.provide(Handlers),
    Layer.provide(Layer.succeed(ConnectionQueue, options.connectionQueue ?? CONNECTION_QUEUE)),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(readableNdJsonRpc),
    Layer.provide(homeSocketServer(home.socket)),
    Layer.provideMerge(
      KernelHarness.layer(
        home,
        options.readOnly === true,
        {
          ...(options.claudeIdle === undefined ? {} : { idle: options.claudeIdle }),
          ...(options.claudeStop === undefined ? {} : { stop: options.claudeStop }),
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          idleCompaction: options.providers.config.claude_idle_compaction !== false,
        },
        options.providers.config.target_connector,
        options.bashTimeout,
      ),
    ),
    Layer.provideMerge(
      Providers.layer(
        options.readOnly === true
          ? { ...options.providers, openai: (id) => ({ ...options.providers.openai(id), readOnly: true }) }
          : options.providers,
      ),
    ),
    Layer.provideMerge(Lifetime.layer(options.idleGrace)),
  )

/** Serves the home until its lifetime ends: stopped, or idle past the grace. */
export const serve = (home: Home, options: ServerOptions) =>
  Effect.gen(function* () {
    const lifetime = yield* Lifetime
    yield* Console.error(`sigma ${VERSION} serving ${home.dir}`)
    yield* lifetime.ended
  }).pipe(Effect.provide(serverLayer(home, options)), Effect.scoped)
