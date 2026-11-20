// The worker tools for the model: start, message, assign, wait, list and stop. A worker is a child conversation, on
// any provider of the home, owned by a background anchor task in its parent, so it outlives the parent's turns; each
// task given to it goes through a background reporter task in the parent, which delivers it, waits for the answer and
// mails the answer back. Both are durable tasks, so a restart resumes them (spec 7.3, example 22).
import {
  type Agent,
  type AgentLimits,
  type Harness,
  ApprovalsDoc,
  approveAutomatically,
  AssistantEntry,
  ConversationIdle,
  configure,
  DEFAULT_AGENT_LIMITS,
  defineExtension,
  defineTool,
  InboxDoc,
  LiveDoc,
  recordOrigin,
  refusedWork,
  ROOT_TASK,
  type ToolExecutionApi,
  type ToolExecutionResult,
  TaskServices,
} from "@sigma/harness"
import {
  type ConversationId,
  defineDoc,
  defineTask,
  type EntryId,
  idFromNumber,
  type JsonObject,
  type NextTaskState,
  type TaskId,
} from "@sigma/kernel"
import { usesRemoteHands, type JobReport, JobsDoc, REPORT_KIND } from "@sigma/hosted"
import { type AssistantMessage, defaultModelOf, type ProviderInstance } from "@sigma/models"
import { int, obj, oneOf, opt, str } from "@sigma/schema"
import { rootConversation } from "@sigma/tools"
import { Clock, Duration, Effect, Option, Stream } from "effect"
import type { ExecutionEnv } from "@sigma/env"
import { type AgentType, toolNamer } from "./workspace.ts"

/** The agent types a conversation's agent can spawn, from its provider and its working directory through `env`. */
export type AgentTypes = (
  agent: { readonly model?: { readonly provider: string }; readonly cwd?: string; readonly target?: string },
  env: ExecutionEnv | undefined,
) => Effect.Effect<ReadonlyArray<AgentType>>

/** How a worker's last task ended, as `list_workers` reports it. */
export type AgentStatus = "pending_init" | "interrupted" | { completed: string } | { errored: string }

type Child = {
  conversationId: number
  task: string
  status?: AgentStatus
  reported: number[]
  /** Given a task its reporter has not yet seen end: it counts as working before its run starts. */
  assigned?: true
}

/** A conversation's subagents by name, and the reporter each tool call started. */
export const AgentsDoc = defineDoc<{ agents: Record<string, Child>; reporters: Record<string, number> }>({
  kind: "sigma.agents",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork starts without subagents.
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} }),
  checkpointWhen: () => true,
})

/** A subagent's own canonical task path, such as `/root/writer`; the conversation people started has none. */
export const TaskPathDoc = defineDoc<{ task: string }>({
  kind: "sigma.task_path",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ task: ROOT_TASK }),
  checkpointWhen: () => true,
})

export type MailKind = "new_task" | "message" | "final_answer"

/** The entry a message between agents is placed as; the model reads it as a user message. */
export const MAIL_ENTRY_KIND = "sigma.mail"

const PAYLOAD = "\nPayload:\n"

export const mailText = (kind: MailKind, task: string, sender: string, text: string) => {
  const type = { new_task: "NEW_TASK", message: "MESSAGE", final_answer: "FINAL_ANSWER" }[kind]
  return `Message Type: ${type}\nTask name: ${task}\nSender: ${sender}${PAYLOAD}${text}`
}

/** What people read of a message between agents: its payload, without the headers the model reads. */
export const mailPayload = (text: string) => {
  const at = text.indexOf(PAYLOAD)
  return at === -1 ? text : text.slice(at + PAYLOAD.length)
}

const mailEntry = (kind: MailKind, task: string, sender: string) => ({
  kind: MAIL_ENTRY_KIND,
  data: { kind, task, sender },
})

/** The line in a subagent's instructions that names it; the `script` model reads it to pick the agent's steps. */
export const taskNameLine = (task: string) => `Your task name is ${task}.`
const TASK_NAME = /Your task name is (\/[^\s.]+)\./

/** The task a request is for: the last instructions that name one, or the root. */
export const taskOfRequest = (messages: ReadonlyArray<{ readonly role: string }>): string => {
  for (const message of [...messages].reverse()) {
    if (message.role !== "system") continue
    const named = TASK_NAME.exec(JSON.stringify(message))
    if (named !== null) return named[1]!
  }
  return ROOT_TASK
}

const errored = (message: string) =>
  `Agent errored: ${message}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.`

// ─── Tasks ────────────────────────────────────────────────────────────────────

/** Owns a subagent's conversation: completes at once, and holds `completing` while the subagent has work. */
const Anchor = defineTask<null, { readonly phase: "done" }, null, TaskServices>({
  name: "sigma.agent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime) =>
      runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "completed", result: null } })),
  },
  abort: (_task, runtime) =>
    runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "aborted" } })),
})

type ReporterInput = {
  name: string
  task: string
  sender: string
  conversationId: number
  message: string
  /**
   * The reports of the jobs whose end woke the worker, which it is given in place of `message`: the answer of the wake
   * run they start is mailed as a `message`, not a final answer (D8 of s-7bmc8w).
   */
  wake?: ReadonlyArray<JobReport>
}
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string }

/** What a mailed answer adds when the worker's jobs still work, such as a dev server it started: it never waits for them. */
const stillWorking = (titles: ReadonlyArray<string>) =>
  titles.length === 0 ? "" : `\n\nStill working: ${titles.map((title) => JSON.stringify(title)).join(", ")}.`

/**
 * Gives one task to a worker, or the reports that woke it, waits for its answer, records how it ended, and mails the
 * answer to the parent, naming the worker's jobs still working. Request IDs from its own task ID make a rerun find its
 * submissions, so each arrives once.
 */
const Reporter = defineTask<ReporterInput, ReporterState, null, TaskServices>({
  name: "sigma.agent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: (reporter, runtime) =>
      Effect.gen(function* () {
        const services = yield* TaskServices
        const { name, task, sender, message, wake } = reporter.input
        const childId = idFromNumber<ConversationId>(reporter.input.conversationId)
        const child = (yield* services.conversation(childId))!
        // A wake run's input is its reports, which start one run together; each settles with its answer.
        const submissions =
          wake === undefined
            ? [
                yield* child.submit({
                  type: "input",
                  content: mailText("new_task", task, sender, message),
                  // A working worker takes it at its next step, as other mail.
                  whenBusy: "steer",
                  entry: mailEntry("new_task", task, sender),
                  requestId: `agent:${reporter.id}`,
                }),
              ]
            : yield* Effect.forEach(wake, (report, at) =>
                child.submit({
                  type: "input",
                  content: report.text,
                  whenBusy: "steer",
                  entry: { kind: REPORT_KIND, ...(report.data === undefined ? {} : { data: report.data }) },
                  requestId: `agent-wake:${reporter.id}:${at}`,
                }),
              )
        const settled = (yield* Effect.forEach(submissions, (submission) => submission.wait)).at(-1)!
        yield* runtime.commit((tx) =>
          Effect.gen(function* () {
            const agent = (yield* tx.doc(AgentsDoc, runtime.conversationId)).agents[name]!
            // A wake gave the worker no task, so another reporter's task may still be waiting.
            if (wake === undefined) delete agent.assigned
            const next = (report?: string): NextTaskState<ReporterState, null> => ({
              status: "running",
              checkpoint: report === undefined ? { phase: "report" } : { phase: "report", report },
            })
            // A task given while the wake ran steered into the same run: its reporter reports the run as the task's.
            if (wake !== undefined && agent.assigned === true) return next()
            if (settled.status === "unanswered") {
              // Interrupted, or withdrawn while queued: nothing to report.
              if (settled.reason === "aborted") {
                agent.status = "interrupted"
                return next()
              }
              const detail = typeof settled.detail === "string" ? settled.detail : settled.reason
              agent.status = { errored: detail }
              return next(errored(detail))
            }
            if (settled.type !== "input") return next()
            const answer = settled.answer as EntryId
            // Several tasks can end in one answer; it is reported once.
            if (agent.reported.includes(answer)) return next()
            agent.reported.push(answer)
            const said = textOf((yield* tx.entry(AssistantEntry, answer))?.model?.[0] as AssistantMessage | undefined)
            agent.status = { completed: said }
            const jobs = Object.values((yield* tx.doc(JobsDoc, childId)).jobs)
            return next(said + stillWorking(jobs.filter((job) => job.state === "working").map((job) => job.title)))
          }),
        )
      }),
    report: (reporter, runtime) =>
      Effect.gen(function* () {
        const report = reporter.state.checkpoint.report
        if (report !== undefined) {
          const { task, sender, wake } = reporter.input
          const parent = (yield* (yield* TaskServices).conversation(runtime.conversationId))!
          const kind = wake === undefined ? "final_answer" : "message"
          const content = mailText(kind, sender, task, report)
          const entry = mailEntry(kind, sender, task)
          const submission = yield* parent.submit({
            type: "input",
            content,
            // Into the parent's running turn at its next step, as other mail; an idle parent starts a turn.
            whenBusy: "steer",
            entry,
            requestId: `agent-report:${reporter.id}`,
          })
          const settled = yield* submission.wait
          // Withdrawn before it was placed, as when the person stops the parent: the answer still joins its transcript,
          // once the stopped run has ended, so it lands then instead of waiting in the queue for the next prompt. One
          // that wait_worker took was delivered in that call's result.
          if (settled.status === "unanswered" && settled.entry === undefined && settled.reason !== TAKEN) {
            yield* parent.waitForIdle
            const timestamp = yield* Clock.currentTimeMillis
            yield* parent.submit({
              type: "write",
              entry: { ...entry, model: [{ role: "user", content, timestamp }] as unknown as JsonObject[] },
              requestId: `agent-report-kept:${reporter.id}`,
            })
          }
        }
        yield* runtime.commit(() =>
          Effect.succeed({ status: "terminal", outcome: { status: "completed", result: null } }),
        )
      }),
  },
  abort: (reporter, runtime) =>
    runtime.commit((tx) =>
      Effect.gen(function* () {
        const agent = (yield* tx.doc(AgentsDoc, runtime.conversationId)).agents[reporter.input.name]
        if (agent !== undefined && reporter.input.wake === undefined) delete agent.assigned
        return { status: "terminal", outcome: { status: "aborted" } } as const
      }),
    ),
})

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")

// ─── Reading the tree ─────────────────────────────────────────────────────────

type Member = {
  readonly task: string
  readonly conversationId: ConversationId
  readonly child?: Child
  /** The conversation whose registry holds `child`. */
  readonly parent?: ConversationId
}

const taskOf = (api: ToolExecutionApi, conversationId: ConversationId) =>
  Effect.map(api.snapshot(TaskPathDoc, conversationId), (path) => path?.task ?? ROOT_TASK)

/** Every agent of the caller's tree, the root first, each parent before its subagents. */
const membersOf = (api: ToolExecutionApi) =>
  Effect.gen(function* () {
    const root = yield* rootConversation(api)
    const members: Member[] = [{ task: ROOT_TASK, conversationId: root }]
    for (let at = 0; at < members.length; at++) {
      const registry = yield* api.snapshot(AgentsDoc, members[at]!.conversationId)
      for (const child of Object.values(registry?.agents ?? {})) {
        const parent = members[at]!.conversationId
        members.push({ task: child.task, conversationId: idFromNumber(child.conversationId), child, parent })
      }
    }
    return members
  })

/** The agent `target` names, from the caller: a canonical path, or a name relative to the caller's path. */
const resolveTarget = (api: ToolExecutionApi, target: string) =>
  Effect.gen(function* () {
    const own = yield* taskOf(api, api.conversationId)
    const trimmed = target.trim()
    const task = trimmed.startsWith("/") ? trimmed : `${own}/${trimmed}`
    return { own, member: (yield* membersOf(api)).find((member) => member.task === task) }
  })

const busy = (api: ToolExecutionApi, conversationId: ConversationId) =>
  Effect.map(api.snapshot(LiveDoc, conversationId), (live) => live?.run !== undefined)

/**
 * Counts the tree's working subagents for a commit that gives one a task, so tasks given at once see each other: those
 * in `registry` (the doc of `parent`, read in the commit) by their marks and runs, the rest as read before it.
 */
const workingCounter = (api: ToolExecutionApi, members: ReadonlyArray<Member>, parent: ConversationId) =>
  Effect.gen(function* () {
    let elsewhere = 0
    const running = new Set<number>()
    for (const member of members) {
      if (member.child === undefined) continue
      const working = (yield* busy(api, member.conversationId)) || member.child.assigned === true
      if (member.parent === parent) {
        if (working) running.add(member.child.conversationId)
      } else if (working) elsewhere++
    }
    return (registry: { readonly agents: Record<string, Child> }) =>
      elsewhere +
      Object.values(registry.agents).filter((child) => child.assigned === true || running.has(child.conversationId))
        .length
  })

const statusOf = (api: ToolExecutionApi, member: Member) =>
  Effect.map(busy(api, member.conversationId), (running): AgentStatus | "running" =>
    running ? "running" : (member.child?.status ?? "pending_init"),
  )

// ─── Tools ────────────────────────────────────────────────────────────────────

const ok = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] })
const json = (value: unknown) => ok(JSON.stringify(value))
const failed = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true })

const DEFAULT_WAIT_MS = 30_000
const MIN_WAIT_MS = 10_000
const MAX_WAIT_MS = 3_600_000

/** The home's providers, by id: the ones a worker can be started on. */
export type WorkerProviders = ReadonlyMap<string, ProviderInstance>

/** What a model reads a provider kind as. */
const KIND_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  openai: "ChatGPT",
  agy: "Antigravity's agy",
  script: "a scripted model",
}

const providerList = (providers: WorkerProviders) =>
  [...providers.values()].map((each) => `${each.id} (${KIND_NAMES[each.kind] ?? each.kind})`).join(", ")

/** Whether `provider` runs its own loop, as Claude Code does: a harness, which sigma does not run the model of. */
const isHarness = (providers: WorkerProviders, provider: string | undefined) => {
  const instance = providers.get(provider ?? "")
  return instance !== undefined && instance.provider === undefined
}

/** The providers a worker can start on now, by id, in the home's order. */
const readyList = (providers: WorkerProviders) =>
  Effect.map(
    Effect.forEach([...providers.values()], (each) =>
      Effect.map(each.health(false), (health) => (health.status === "ready" ? [each.id] : [])),
    ),
    (ids) => (ids.flat().length === 0 ? "none" : ids.flat().join(", ")),
  )

const startDescription = (providers: WorkerProviders) => {
  const list = providerList(providers)
  return `Starts a worker: an agent in a conversation of its own, which the user can open, watch and talk to, and which keeps working after your turn ends. Returns the worker's task name at once. Its final answer comes back through wait_worker, or as a message when you are not waiting.
If your task is \`/root/task1\` and you name a worker "scout", its task name is \`/root/task1/scout\`. You can call it \`scout\` or \`/root/task1/scout\`; other agents reach it by its full name.
A worker runs on your provider unless you name another. Set \`provider\` and \`model\` only to what the user named, unchanged.${list === "" ? "" : ` The providers are ${list}.`} On your provider the worker has your tools. A worker starts from your message alone, with none of your history or instructions, so write a complete brief, when it runs on another provider or you run in a harness (Claude Code or agy); otherwise it starts with your history, unless \`fork_turns\` is "none". When you name no model, the worker uses the agent type's model if the provider supports it. Otherwise it uses your model on your provider or the destination's default on another provider.
Start workers only when the user, or instructions such as AGENTS.md or a skill, ask for workers, delegation or parallel work.`
}

const startSchema = (providers: WorkerProviders) =>
  obj({
    task_name: str({ description: "Name for the worker. Use lowercase letters, digits, and underscores." }),
    message: str({ description: "The worker's task, in plain text." }),
    provider: opt(
      str({
        description: `The provider to run the worker on, exactly as the user named it${providers.size === 0 ? "" : `: ${[...providers.keys()].join(", ")}`}. Omit to use yours.`,
      }),
    ),
    model: opt(
      str({
        description:
          "The model to run the worker on, exactly as the user named it. Omit to use the agent type's model if supported, otherwise yours or the other provider's default.",
      }),
    ),
    effort: opt(
      oneOf(["minimal", "low", "medium", "high", "xhigh"], {
        description: "Reasoning effort for the worker. Omit to use yours.",
      }),
    ),
    agent_type: opt(
      str({
        description:
          "Agent type for the worker, one your instructions list under Agent types. Omit unless explicitly asked.",
      }),
    ),
    fork_turns: opt(
      oneOf(["all", "none"], {
        description:
          'Your history to give the worker: "all", the default on your provider, or "none". A worker on another provider, or one you start from a harness (Claude Code or agy), always starts with none.',
      }),
    ),
  })

type StartInput = {
  task_name: string
  message: string
  provider?: string
  model?: string
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh"
  agent_type?: string
  fork_turns?: "all" | "none"
}

const background = { ownership: { kind: "conversation" }, background: true } as const

const startWorker = (limits: AgentLimits, agentTypes: AgentTypes, providers: WorkerProviders) =>
  defineTool({
    name: "start_worker",
    description: startDescription(providers),
    parameters: startSchema(providers),
    execute: (input: StartInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        if (input.message.trim() === "") return failed("Empty message can't be sent to a worker")
        const name = input.task_name.trim()
        if (!/^[a-z0-9_]+$/.test(name)) return failed("task_name takes lowercase letters, digits and underscores")
        const agent = yield* api.agent
        const parentModel = agent.model
        const named = input.provider?.trim() || undefined
        // On another provider the worker starts from its brief alone: a provider cannot take another's history (D5).
        const other = named !== undefined && named !== parentModel?.provider
        // A harness holds its own session, which a worker cannot start from: only a worker on sigma's own loop forks.
        const fresh = other || isHarness(providers, parentModel?.provider)
        if (other) {
          const asked = providers.get(named)
          const ready = asked === undefined ? false : (yield* asked.health(false)).status === "ready"
          // The others' health is read only to name them in the refusal.
          if (!ready)
            return failed(
              `${asked === undefined ? `no provider ${named}` : `provider ${named} is not ready`}; the ready providers are ${yield* readyList(providers)}`,
            )
          if (input.fork_turns === "all")
            return failed('a worker on another provider starts from your message alone; set fork_turns to "none"')
        }
        const provider = named ?? parentModel?.provider
        if (input.model !== undefined && provider === undefined) return failed("this agent has no model to vary")
        const instance = provider === undefined ? undefined : providers.get(provider)
        // Explicit model names pass through to a harness, which can accept names outside its model list.
        const acceptsModel = (model: string) =>
          provider !== undefined &&
          (isHarness(providers, provider) || api.models().getModel(provider, model) !== undefined)
        if (input.model !== undefined && !acceptsModel(input.model))
          return failed(
            `no model ${input.model} on ${provider}; leave model out to use ${other ? "its default" : "yours"}`,
          )
        const wanted = input.agent_type?.trim()
        let agentType: AgentType | undefined
        if (wanted) {
          const types = [...(yield* agentTypes(agent, api.env))]
          agentType = types.find((type) => type.name === wanted)
          // Accept types the destination already supported when the caller did not advertise the name.
          if (agentType === undefined && other) {
            const destination = yield* agentTypes({ ...agent, model: { provider: named } }, api.env)
            agentType = destination.find((type) => type.name === wanted)
            types.push(...destination)
          }
          if (agentType === undefined) {
            const known = [...new Set(types.map((type) => type.name))]
            return failed(`no agent type ${wanted}; there are ${known.length === 0 ? "none" : known.join(", ")}`)
          }
        }
        let model = input.model
        const typeModel = agentType?.model
        if (model === undefined && typeModel !== undefined) {
          const available = other
            ? (yield* instance!.models(false)).some(({ id }) => id === typeModel)
            : acceptsModel(typeModel)
          if (available) model = typeModel
        }
        if (model === undefined && other) model = (yield* defaultModelOf(instance!)) ?? ""
        const own = yield* taskOf(api, api.conversationId)
        const members = yield* membersOf(api)
        const working = yield* workingCounter(api, members, api.conversationId)
        const task = `${own}/${name}`
        // A worker on its parent's provider keeps the instructions its parent inherited, so a fork's prompt matches its
        // parent's up to its notice. A worker parent's own notice and type start at the line naming its task, which
        // sigma wrote. A worker on another provider is not given them: they name this provider's tools.
        const notice = `${taskNameLine(task)} You are a worker; your final answer goes to ${own}.`
        const ownStart = own === ROOT_TASK ? -1 : (agent.instructions?.indexOf(taskNameLine(own)) ?? -1)
        const inherited = ownStart === -1 ? agent.instructions : agent.instructions!.slice(0, ownStart).trimEnd()
        const instructions = [
          other ? undefined : inherited,
          notice,
          agentType === undefined ? undefined : `# You are a ${agentType.name} agent\n\n${agentType.instructions}`,
        ]
          .filter((part) => part !== undefined && part !== "")
          .join("\n\n")
        // A worker of a conversation that runs every call without asking does too: nobody watches it to answer.
        const auto = (yield* api.snapshot(ApprovalsDoc, api.conversationId))?.auto === true
        const started = yield* api.commit((tx) =>
          Effect.gen(function* () {
            const registry = yield* tx.doc(AgentsDoc, api.conversationId)
            // A rerun of this call finds the worker it started.
            const already = registry.reporters[String(api.taskId)]
            if (already !== undefined) return registry.agents[name]?.conversationId
            if (Object.hasOwn(registry.agents, name)) return undefined
            const refused = refusedWork(limits, working(registry))
            if (refused !== undefined) return refused
            const forkAt =
              fresh || input.fork_turns === "none" ? undefined : yield* tx.latestEntryId(api.conversationId)
            const anchor = yield* tx.createTask(Anchor, null, background)
            const ownership = { kind: "task", taskId: anchor } as const
            const child =
              forkAt === undefined
                ? yield* tx.createConversation({ ownership })
                : yield* tx.forkConversation(api.conversationId, forkAt, { ownership })
            yield* configure(tx, child.id, {
              instructions,
              ...(model === undefined ? {} : { model: { provider: provider!, modelId: model } }),
              ...(input.effort === undefined ? {} : { thinkingLevel: input.effort }),
            })
            ;(yield* tx.doc(TaskPathDoc, child.id)).task = task
            yield* recordOrigin(tx, child.id, {
              call: api.callId,
              title: name,
              task,
              ...(agentType === undefined ? {} : { agentType: agentType.name }),
            })
            if (auto) yield* approveAutomatically(tx, child.id)
            registry.agents[name] = { conversationId: Number(child.id), task, reported: [], assigned: true }
            const reporter: ReporterInput = {
              name,
              task,
              sender: own,
              conversationId: Number(child.id),
              message: input.message,
            }
            registry.reporters[String(api.taskId)] = Number(yield* tx.createTask(Reporter, reporter, background))
            return Number(child.id)
          }),
        )
        if (started === undefined) return failed(`${task} already exists; use assign_worker or message_worker`)
        if (typeof started === "string") return failed(started)
        // A client that sees the call attaches to the worker's view through its details.
        return { ...json({ task_name: task }), details: { task, conversation: started } }
      }),
  })

const messageSchema = (target: string, message: string) =>
  obj({ target: str({ description: target }), message: str({ description: message }) })

/** A message that starts no turn: steers a busy agent, and is added to an idle one's transcript for its next turn. */
const messageWorker = defineTool({
  name: "message_worker",
  description:
    "Sends a message to a worker, or to any agent of your tree by its task name. A working one reads it at its next step; an idle one reads it with its next task. Starts no new turn.",
  parameters: messageSchema(
    "The worker's task name, as start_worker returned it, or relative to yours.",
    "The message to send.",
  ),
  execute: (input: { target: string; message: string }, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      if (input.message.trim() === "") return failed("Empty message can't be sent to a worker")
      const { own, member } = yield* resolveTarget(api, input.target)
      if (member === undefined) return failed(`no worker ${input.target.trim()}`)
      const to = (yield* api.conversation(member.conversationId))!
      const content = mailText("message", member.task, own, input.message)
      const entry = mailEntry("message", member.task, own)
      const requestId = `agent-message:${api.taskId}`
      yield* to.submit({ type: "input", content, whenBusy: "steer", whenIdle: "reject", entry, requestId }).pipe(
        Effect.catchIf(
          (error) => error instanceof ConversationIdle,
          () =>
            to.submit({
              type: "write",
              entry: { ...entry, model: [{ role: "user", content, timestamp: api.now() }] as unknown as JsonObject[] },
              requestId,
            }),
        ),
      )
      return ok("")
    }),
})

const assignWorker = (limits: AgentLimits) =>
  defineTool({
    name: "assign_worker",
    description:
      "Gives a worker a follow-up task, and starts it working if it is idle. A working worker takes the task at its next step. Its answer comes back through wait_worker.",
    parameters: messageSchema(
      "The worker's task name, as start_worker returned it, or relative to yours.",
      "The follow-up task.",
    ),
    execute: (input: { target: string; message: string }, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        if (input.message.trim() === "") return failed("Empty message can't be sent to a worker")
        const { own, member } = yield* resolveTarget(api, input.target)
        if (member === undefined) return failed(`no worker ${input.target.trim()}`)
        if (member.child === undefined) return failed("assign_worker takes a worker; message_worker reaches the root")
        // The reporter lives in the worker's parent, whose registry records how the task ended.
        const name = member.task.split("/").at(-1)!
        const parentTask = member.task.slice(0, member.task.lastIndexOf("/"))
        const members = yield* membersOf(api)
        const parentConversation = members.find((each) => each.task === parentTask)!.conversationId
        // A task for an idle worker starts a run, so it counts against maxThreads; a working one only queues it.
        const idle = !(yield* busy(api, member.conversationId)) && member.child.assigned !== true
        const working = yield* workingCounter(api, members, parentConversation)
        const reporter: ReporterInput = {
          name,
          task: member.task,
          sender: own,
          conversationId: Number(member.conversationId),
          message: input.message,
        }
        const refused = yield* api.commit((tx) =>
          Effect.gen(function* () {
            const registry = yield* tx.doc(AgentsDoc, parentConversation)
            if (registry.reporters[String(api.taskId)] !== undefined) return undefined
            const refused = idle ? refusedWork(limits, working(registry)) : undefined
            if (refused !== undefined) return refused
            registry.agents[name]!.assigned = true
            const created = yield* tx.createTask(Reporter, reporter, {
              ...background,
              conversationId: parentConversation,
            })
            registry.reporters[String(api.taskId)] = Number(created)
            return undefined
          }),
        )
        return refused === undefined ? ok("") : failed(refused)
      }),
  })

/** What `wait_worker` returns of one mail: who sent it, whether it is a final answer, and its text. */
type Received = { from: string; kind: "final_answer" | "message"; text: string }

/**
 * What a `wait_worker` call took from its caller's inbox, in the commit that took it, so a rerun after a restart
 * returns the same; it goes with the call's task.
 */
const TakenDoc = defineDoc<{ received?: Received[] }>({
  kind: "sigma.wait_taken",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => true,
})

type Queued = { readonly id: unknown; readonly mode: string; readonly content?: unknown; readonly entry?: unknown }

/** A worker's answer or message waiting in the inbox: what `wait_worker` takes. A task given to this agent is not. */
const takeable = (item: Queued) => {
  if (item.mode !== "steer" || !isMail(item)) return false
  const kind = (item.entry as { readonly data?: { readonly kind?: string } }).data?.kind
  return kind === "final_answer" || kind === "message"
}

const receivedOf = (item: Queued): Received => {
  const data = (item.entry as { readonly data: { readonly kind: Received["kind"]; readonly sender: string } }).data
  const content = item.content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: { readonly text?: string }) => part.text ?? "").join("")
        : ""
  return { from: data.sender, kind: data.kind, text: mailPayload(text) }
}

/** The settlement reason of mail `wait_worker` took: its reporter has nothing more to deliver. */
const TAKEN = "taken"

/**
 * Takes the workers' mail queued in the caller's inbox, in one commit, so it is not also steered in after the call
 * (F49) and two waits never take the same mail; a rerun gets what this call took before. Mail taken by a call that is
 * then stopped before its result is stored reaches the parent only through the worker's own transcript and
 * `list_workers`: a window of one commit, accepted.
 */
const takeMail = (api: ToolExecutionApi) =>
  api.commit((tx) =>
    Effect.gen(function* () {
      const taken = yield* tx.doc(TakenDoc, api.taskId)
      if (taken.received !== undefined) return taken.received as Received[]
      const inbox = yield* tx.doc(InboxDoc, api.conversationId)
      const mail = inbox.items.filter((item) => takeable(item as Queued))
      if (mail.length === 0) return []
      const received = mail.map((item) => receivedOf(item as Queued))
      for (const item of mail) {
        yield* tx.settleSubmission(item.id, { status: "unanswered", reason: TAKEN })
        inbox.items.splice(inbox.items.indexOf(item), 1)
      }
      taken.received = received
      return received
    }),
  )

/** What the worker tools need of the server beyond the home's providers. */
export interface WorkerOptions {
  /**
   * The longest one call of a conversation on `provider` may wait, when its harness cuts a call of sigma's tools sooner
   * than `wait_worker` would return (D15); `undefined` when it waits as long as the call does.
   */
  readonly waitLimit?: (provider: string) => Duration.Input | undefined
  /** What a wait keeps time by; default the server's clock. Tests advance one. */
  readonly clock?: Clock.Clock
}

const waitWorker = ({ waitLimit, clock }: WorkerOptions) =>
  defineTool({
    name: "wait_worker",
    description:
      "Waits for your workers and returns what they sent: a finished worker's final answer, or a message from one. What it returns is not delivered to you again. Returns timed_out true when nothing arrives in time; call it again to keep waiting. Returns early, with nothing received, when the user sends new input.",
    parameters: obj({
      timeout_ms: opt(
        int({
          description: `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_MS}, min ${MIN_WAIT_MS}, max ${MAX_WAIT_MS}.`,
        }),
      ),
    }),
    replay: "safe",
    execute: (input: { timeout_ms?: number }, api: ToolExecutionApi) =>
      Effect.scoped(
        Effect.gen(function* () {
          const requested = input.timeout_ms === undefined ? undefined : Math.max(0, input.timeout_ms)
          if (requested !== undefined && requested > MAX_WAIT_MS)
            return failed(`timeout_ms must be at most ${MAX_WAIT_MS} (asked for ${requested})`)
          const wanted = requested === undefined ? DEFAULT_WAIT_MS : Math.max(requested, MIN_WAIT_MS)
          const provider = (yield* api.agent).model?.provider
          const limit = provider === undefined ? undefined : waitLimit?.(provider)
          const most = limit === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(limit))
          // The harness would cut a longer call, so the wait returns first and says to wait again (D15).
          const timeout = most === undefined ? wanted : Math.min(wanted, most)
          const clamped =
            requested !== undefined && requested < wanted
              ? { message: `Requested timeout of ${requested}ms was clamped to the minimum of ${wanted}ms.` }
              : {}
          /** What a wait that ends empty says: cut short by the harness's limit, it says to wait again. */
          const empty =
            timeout < wanted
              ? {
                  message: `Waited ${timeout}ms, the longest one call can wait here; call wait_worker again to keep waiting.`,
                }
              : clamped
          const watch = yield* api.watchDoc(InboxDoc, api.conversationId)
          if (watch === undefined) return json({ timed_out: true, received: [], ...empty })
          // A steered item reaches the model after this turn, so it is news. Workers' mail is taken and returned; other
          // input steered while the turn runs, such as a person's, ends the wait with nothing received. A follow-up
          // waits for the run to end, so it does not. Mail another call or a step took first is waited past.
          const outcome = yield* Stream.concat(
            Stream.make({ inbox: watch.value, first: true }),
            watch.changes.pipe(Stream.map((change) => ({ inbox: change.value, first: false }))),
          ).pipe(
            // The first look also finds what a run of this call before a restart took; after it, only a steered item
            // is worth a commit.
            Stream.filter(
              ({ inbox, first }) =>
                first || (inbox.items as ReadonlyArray<Queued>).some((item) => item.mode === "steer"),
            ),
            Stream.mapEffect(({ inbox }) =>
              Effect.map(takeMail(api), (received) => {
                if (received.length > 0) return json({ timed_out: false, received, ...clamped })
                const steered = (inbox.items as ReadonlyArray<Queued>).some(
                  (item) => item.mode === "steer" && !takeable(item),
                )
                return steered
                  ? json({ timed_out: false, received: [], message: "Wait interrupted by new input." })
                  : undefined
              }),
            ),
            Stream.filter((result) => result !== undefined),
            Stream.runHead,
            Effect.timeoutOption(Duration.millis(timeout)),
            clock === undefined ? (effect) => effect : Effect.provideService(Clock.Clock, clock),
          )
          return Option.getOrUndefined(Option.flatten(outcome)) ?? json({ timed_out: true, received: [], ...empty })
        }),
      ),
  })

const isMail = (item: { readonly entry?: unknown }) =>
  (item.entry as { readonly kind?: string } | undefined)?.kind === MAIL_ENTRY_KIND

const listWorkers = defineTool({
  name: "list_workers",
  description:
    "Lists the agents of your tree, you and the workers under you, each by task name with whether it is running, done, interrupted or failed. Optionally filtered by task-name prefix.",
  parameters: obj({
    path_prefix: opt(str({ description: "Task-name prefix, without a trailing slash. Omit to list them all." })),
  }),
  replay: "safe",
  execute: (input: { path_prefix?: string }, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      const workers = []
      for (const member of yield* membersOf(api)) {
        if (!member.task.startsWith(input.path_prefix ?? "")) continue
        workers.push({ name: member.task, status: yield* statusOf(api, member) })
      }
      return json({ workers })
    }),
})

const stopWorker = defineTool({
  name: "stop_worker",
  description:
    "Stops a worker's current turn, if any, and returns its previous status. The worker stays available for messages and follow-up tasks.",
  parameters: obj({
    target: str({ description: "The worker's task name, as start_worker returned it, or relative to yours." }),
  }),
  execute: (input: { target: string }, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      const { own, member } = yield* resolveTarget(api, input.target)
      if (member === undefined) return failed(`no worker ${input.target.trim()}`)
      if (own === member.task || own.startsWith(`${member.task}/`))
        return failed("an agent can't stop itself or an agent above it")
      const previous = yield* statusOf(api, member)
      yield* (yield* api.conversation(member.conversationId))!.abort()
      return json({ previous_status: previous })
    }),
})

/**
 * A harness's subagent, such as Claude Code's Agent, is a conversation under its parent that is no agent of the tree:
 * it has no task name, and no registry lists it. It reaches the worker tools over sigma's MCP server as its harness
 * does, and is refused, so it neither starts workers the tree cannot see nor answers as `/root`.
 */
const SUBAGENT_REFUSED = "a subagent cannot start or reach workers; leave that to the agent that started you"

const inTree = <T extends { readonly execute: (input: any, api: ToolExecutionApi) => Effect.Effect<any, any, any> }>(
  tool: T,
): T => ({
  ...tool,
  execute: (input: unknown, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      const own = yield* taskOf(api, api.conversationId)
      if (own === ROOT_TASK && (yield* rootConversation(api)) !== api.conversationId) return failed(SUBAGENT_REFUSED)
      return yield* tool.execute(input, api)
    }),
})

/**
 * What a model is told of the worker tools, when it can call them, by the name it calls `start_worker` by. A harness
 * with remote hands has no subagent tool of its own to point to. It names no reason to prefer one provider over another:
 * which model a worker runs on is the person's choice, passed exactly (D11). It does not change during a conversation,
 * whose instructions are fixed at its start (#132), and a harness's live process keeps its system prompt.
 */
const workersSection = (start: string, subagents: boolean, fresh: boolean) =>
  `Workers. This session can start workers with the ${start} tool. A worker is an agent in a conversation of its own, which the user can open, watch and talk to.${fresh ? " Every worker you start, on your provider too, starts from your message alone, with none of your history, so write a complete brief." : ""} Start a worker when the user asks for one, or names a model or a provider for part of the work. Pass the provider and model they named, unchanged, in \`provider\` and \`model\`. When they name several, start one worker for each. With none named, leave \`provider\` out and the worker runs on your own models. For a quick helper inside your own turn, ${subagents ? "use your own subagent tool if you have one, or do the work yourself" : "do the work yourself"}.`

const AGENTS_EXTENSION = "sigma-agents"

/**
 * The selected extensions a local conversation's harness is offered as its own, beside its own tools: the worker
 * tools, and their section (D17).
 */
export const offeredToHarness = (agent: Agent) =>
  agent.extensions.filter((extension) => extension.name === AGENTS_EXTENSION)

/**
 * Gives the reports of the jobs whose end woke a hosted worker to a reporter in its parent, which mails the wake run's
 * answer to the parent as a message (D8 of s-7bmc8w); `false` for a conversation that is not a worker, whose reports
 * go in as any wake's. A run the worker is busy with takes them at its next step: its answer is mailed once, by the
 * reporter of the task it answers when there is one, else by this one.
 */
export const wakeWorker = (harness: Harness, child: ConversationId, reports: ReadonlyArray<JobReport>) =>
  Effect.gen(function* () {
    const handle = yield* harness.conversation(child)
    if (handle === undefined) return false
    const parent = yield* handle.commit((tx) =>
      Effect.map(tx.conversation(child), (found) => found?.owner?.conversationId),
    )
    if (parent === undefined) return false
    const registry = yield* harness.session.snapshot(AgentsDoc, parent)
    const name = Object.keys(registry?.agents ?? {}).find(
      (key) => registry!.agents[key]!.conversationId === Number(child),
    )
    if (name === undefined) return false
    const sender = (yield* harness.session.snapshot(TaskPathDoc, parent))?.task ?? ROOT_TASK
    const owner = (yield* harness.conversation(parent))!
    const reporter: ReporterInput = {
      name,
      task: registry!.agents[name]!.task,
      sender,
      conversationId: Number(child),
      message: "",
      wake: reports,
    }
    yield* owner.commit((tx) => tx.createTask(Reporter, reporter, { ...background, conversationId: parent }))
    return true
  })

/**
 * What `conversation/interrupt` stops (D7 of s-cjk9k6). A conversation with a run stops that run only: its subagents
 * and the jobs Claude Code started keep working. An idle one stops the work under it: the run of every subagent in its
 * tree, and the jobs Claude Code started in any of them, each told to stop. Each conversation of the tree is aborted on
 * its own, all at once, so the reporters that relay answers carry on as they do when one subagent is stopped, and
 * background work such as compaction is left alone. A subagent its parent started before the parent stopped is found
 * by the next pass.
 */
export const interrupt = (harness: Harness, root: ConversationId) =>
  Effect.gen(function* () {
    const abort = (id: ConversationId) =>
      Effect.flatMap(harness.conversation(id), (conversation) => conversation?.abort() ?? Effect.void)
    if ((yield* harness.session.snapshot(LiveDoc, root))?.run !== undefined) return yield* abort(root)
    const stopped = new Set<ConversationId>()
    for (;;) {
      const fresh = (yield* treeOf(harness, root)).filter((id) => !stopped.has(id))
      if (fresh.length === 0) return
      for (const id of fresh) stopped.add(id)
      yield* Effect.forEach(fresh, (id) => Effect.andThen(abort(id), stopJobs(harness, id)), {
        concurrency: "unbounded",
        discard: true,
      })
    }
  })

/** Aborts the tasks of the jobs Claude Code started in the conversation that still work. */
const stopJobs = (harness: Harness, id: ConversationId) =>
  Effect.gen(function* () {
    const jobs = Object.values((yield* harness.session.snapshot(JobsDoc, id))?.jobs ?? {})
    for (const job of jobs) if (job.state === "working") yield* harness.abortTask(idFromNumber<TaskId>(job.taskId))
  })

/** The conversation and its subagents', each parent before its subagents. */
const treeOf = (harness: Harness, root: ConversationId) =>
  Effect.gen(function* () {
    const tree = [root]
    for (let at = 0; at < tree.length; at++) {
      const registry = yield* harness.session.snapshot(AgentsDoc, tree[at]!)
      for (const child of Object.values(registry?.agents ?? {})) tree.push(idFromNumber(child.conversationId))
    }
    return tree
  })

/**
 * The worker tools, under `limits`, starting workers on `providers`, and what a model is told of them; their tasks come
 * with them, so a restart resumes pending reporters.
 */
export const agentTools = (
  limits: AgentLimits = DEFAULT_AGENT_LIMITS,
  agentTypes: AgentTypes = () => Effect.succeed([]),
  providers: WorkerProviders = new Map(),
  options: WorkerOptions = {},
) =>
  defineExtension({
    name: AGENTS_EXTENSION,
    tasks: [Anchor, Reporter],
    tools: [
      // With no worker allowed to work, no conversation is offered start_worker, the root included.
      ...(limits.maxThreads > 0 ? [startWorker(limits, agentTypes, providers)] : []),
      messageWorker,
      assignWorker(limits),
      waitWorker(options),
      listWorkers,
      stopWorker,
    ].map(inTree),
    sections: [
      {
        key: "workers",
        tag: false,
        // A code-mode model is offered only codemode, whose scripts call start_worker, so the callable tools decide. A
        // harness, as Claude Code, reaches the tools by its own names for them.
        render: ({ agent }) =>
          Effect.succeed(
            agent.callable.some((tool) => tool.name === "start_worker")
              ? workersSection(
                  toolNamer(providers, agent)("start_worker"),
                  // Only a harness on a target runs with remote hands, with no subagent tool of its own.
                  !(usesRemoteHands(agent) && isHarness(providers, agent.model?.provider)),
                  isHarness(providers, agent.model?.provider),
                )
              : undefined,
          ),
      },
    ],
  })
