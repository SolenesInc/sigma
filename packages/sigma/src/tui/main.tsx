// The TUI: it watches the conversation's view, keeps every entry it saw in a
// `ConversationTranscript`, and draws the transcript's items with the view's documents: partial text and running
// output from `pi.live`, the queue from `pi.inbox`, waiting calls from `sigma.approvals`, the model from `pi.agent`.
// The marker above the oldest entry held, and one where entries are missing, load more once scrolled into view.
import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { applyImmutable, type Op } from "@sigma/delta"
import {
  ConversationTranscript,
  type ConversationView,
  type TranscriptGap,
  type TranscriptItem,
  type TranscriptView,
} from "@sigma/harness"
import { type JobReport, JobsDoc, REPORT_KIND } from "@sigma/hosted"
import type { EntryRecord } from "@sigma/kernel"
import {
  type Author,
  COMPACTION_KIND,
  CONFIGURED_KIND,
  CONTINUED_KIND,
  FORKED_KIND,
  INTERRUPTED_KIND,
  STARTED_KIND,
  WITHDRAWN_KIND,
  type ConversationInfo,
  type ModelSelection,
  type Outcome,
  LOCAL_TARGET,
  TARGET_CHANGED_KIND,
  PROTOCOL_VERSION,
  RESET_KIND,
  RUN_END_KIND,
  type RunEnd,
  USER_KIND,
  MODEL_KIND,
  type View,
} from "@sigma/protocol"
import { Cause, Deferred, Effect, Fiber, Schedule, type Scope, Stream } from "effect"
import {
  type Accessor,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { launchAuthor } from "../author.ts"
import { VERSION } from "../version.ts"
import { mailPayload } from "../agents.ts"
import { Client, serverRefusal, type StartOptions } from "../client.ts"
import { attachmentsIn, imagesIn } from "../attach.ts"
import { describeCall, describeTargetChange, receivedOf } from "./calls.ts"
import {
  type Ask,
  clip,
  COMMANDS,
  type ConversationActions,
  type Notice,
  type Panel,
  type Pending,
  type Screen,
  setupOf,
  Shell,
  showUntilDone,
  Tag,
  TITLE_WIDTH,
  tokens,
} from "./chrome.tsx"
import { modelLabel } from "./setup.tsx"
import { color } from "./theme.tsx"

const RESULT_LINES = 6
/** The running output a call shows: its last lines. */
const OUTPUT_LINES = 6
const REWATCH_DELAY = "50 millis"

const MAIL_KIND = "sigma.mail"
const SUBAGENT_KIND = "sigma.subagent"
const APPROVAL_KIND = "sigma.approval"

type Block = { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string }
type Message = {
  readonly role?: string
  readonly content?: string | ReadonlyArray<Block>
  readonly toolCallId?: string
  readonly isError?: boolean
  readonly details?: { readonly conversation?: number; readonly task?: string }
}
type ToolCallBlock = { readonly id: string; readonly name: string; readonly arguments?: unknown }

type LiveTool = { readonly callId: string; readonly status: string; readonly output?: string }
/** A call a running tool made, such as a code-mode script's `tools.bash(...)`: its id is `<parentCallId>/<key>`. */
type NestedTool = LiveTool & { readonly parentCallId: string; readonly name: string; readonly arguments?: unknown }
type Live = {
  readonly run?: unknown
  readonly generation?: {
    readonly message?: Message
    readonly retry?: { readonly at: number; readonly error: string }
  }
  readonly compactions?: ReadonlyArray<unknown>
  readonly compactionFailure?: { readonly error: string }
  readonly tools?: ReadonlyArray<LiveTool>
  readonly nestedTools?: ReadonlyArray<NestedTool>
}
type Approval = {
  readonly callId: string
  readonly tool?: string
  readonly arguments?: unknown
  /** When the call asked. */
  readonly at?: number
  readonly answer?: unknown
}
type Approvals = { readonly requests?: Readonly<Record<string, Approval>> }
type InboxItem = {
  readonly id: number
  readonly mode: string
  readonly content?: Message["content"]
  /** The entry it is placed as: a person's input names its author. */
  readonly entry?: EntryRecord
}
type Usage = {
  readonly totalTokens: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}
type UsageLedger = {
  readonly models?: Readonly<Record<string, Usage>>
  readonly tools?: Readonly<Record<string, Usage>>
}
type Agent = { readonly model?: { readonly provider: string; readonly modelId?: string }; readonly cwd?: string }
type Docs = {
  readonly "pi.live"?: Live
  readonly "pi.inbox"?: { readonly items?: ReadonlyArray<InboxItem> }
  readonly "pi.agent"?: Agent & { readonly thinkingLevel?: string }
  readonly "sigma.approvals"?: Approvals
  readonly "pi.usage"?: UsageLedger
  readonly "sigma.reaching"?: { readonly wait?: { readonly target: string; readonly since: number } }
}

/** What a report entry holds besides its text. */
type ReportData = NonNullable<JobReport["data"]>
/** A background job as the TUI draws it, from its parent's jobs document. */
type JobRecord = {
  readonly call: string
  readonly kind: ReportData["kind"]
  readonly state: ReportData["status"] | "working"
}

const messageOf = (entry: EntryRecord): Message | undefined => entry.model?.[0] as Message | undefined
const dataOf = <A,>(entry: EntryRecord) => (entry.data ?? {}) as A

const textOf = (content: Message["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("")

/**
 * A call's result as a person reads it: its output, then the harness's diagnostics one per line. The harness tells the
 * model its diagnostics in a tagged text block it appends last to the content, and keeps them in the entry's data;
 * the screen draws them from the data, without the tags.
 */
const resultTextOf = (message: Message, entry: EntryRecord) => {
  const diagnostics = dataOf<{ diagnostics?: ReadonlyArray<{ readonly message: string }> }>(entry).diagnostics ?? []
  const content =
    typeof message.content === "string" || diagnostics.length === 0 ? message.content : message.content?.slice(0, -1)
  const output = textOf(content)
  const notes = diagnostics.map((diagnostic) => diagnostic.message).join("\n")
  return output === "" || notes === "" ? output + notes : `${output.replace(/\n$/, "")}\n${notes}`
}

/** What a person wrote: their input's first text, before the skills it named, which follow it as text of their own. */
const typedOf = (content: Message["content"]) =>
  typeof content === "string" ? content : (content?.find((block) => block.type === "text")?.text ?? "")

const callsOf = (message: Message | undefined): ReadonlyArray<ToolCallBlock> =>
  typeof message?.content === "string"
    ? []
    : (message?.content ?? []).filter((block): block is Block & ToolCallBlock => block.type === "toolCall")

/** The model a conversation answers with, as its `pi.agent` document says. */
const selectionOf = (agent: Docs["pi.agent"]): ModelSelection | undefined =>
  agent?.model === undefined
    ? undefined
    : {
        provider: agent.model.provider,
        ...(agent.model.modelId ? { model: agent.model.modelId } : {}),
        ...(agent.thinkingLevel === undefined || agent.thinkingLevel === "off" ? {} : { effort: agent.thinkingLevel }),
      }

/** One conversation as the TUI follows it. */
interface Followed {
  readonly id: string
  readonly items: Accessor<ReadonlyArray<TranscriptItem>>
  readonly docs: Accessor<Docs>
  readonly loaded: Accessor<boolean>
  /** Loads the page before the oldest entry held; `inserting` runs just before a page that adds entries shows. */
  readonly loadEarlier: (inserting: () => void) => void
  readonly fillGap: (gap: TranscriptGap, inserting: () => void) => void
}

/** What a conversation's entries say about its calls, rebuilt when its items change. */
interface Index {
  readonly results: ReadonlyMap<string, EntryRecord>
  readonly answers: ReadonlyMap<string, EntryRecord>
  /** The subagent each call that started one started, by the call's id. */
  readonly subagents: ReadonlyMap<string, Subagent>
}

/**
 * A subagent's conversation, and the title and type a hosted one (Claude's) was given, which its call does not carry.
 * `task` is the name agents address one of Sigma's own subagents by; a subagent Claude Code runs has none.
 */
type Subagent = {
  readonly conversation: string
  readonly title?: string | undefined
  readonly agentType?: string | undefined
  readonly task?: string | undefined
}

const indexOf = (items: ReadonlyArray<TranscriptItem>): Index => {
  const results = new Map<string, EntryRecord>()
  const answers = new Map<string, EntryRecord>()
  const subagents = new Map<string, Subagent>()
  for (const item of items) {
    if (item.kind !== "entry") continue
    const entry = item.entry
    if (entry.kind === "pi.tool-result") {
      const message = messageOf(entry)
      if (message?.toolCallId === undefined) continue
      results.set(message.toolCallId, entry)
      if (message.details?.conversation !== undefined)
        subagents.set(message.toolCallId, { conversation: String(message.details.conversation) })
    } else if (entry.kind === APPROVAL_KIND) answers.set(dataOf<{ callId: string }>(entry).callId, entry)
    else if (entry.kind === SUBAGENT_KIND) {
      const data = dataOf<{ call: string; conversation: number; title: string; agentType?: string }>(entry)
      subagents.set(data.call, {
        conversation: String(data.conversation),
        title: data.title,
        agentType: data.agentType,
      })
    }
  }
  return { results, answers, subagents }
}

const pendingCalls = (docs: Docs) =>
  Object.entries(docs["sigma.approvals"]?.requests ?? {}).filter(([, request]) => request.answer === undefined)

const statusOf = (docs: Docs) =>
  pendingCalls(docs).length > 0 ? "waiting" : docs["pi.live"]?.run !== undefined ? "working" : "idle"

/**
 * Follows `id` for as long as `scope` is open: watches its view and, when the watch drops (the client fell behind, or
 * the server went away), watches again from where the transcript reaches. Fails `done` when there is no such conversation.
 */
const follow = (client: Client["Service"], id: string, scope: Scope.Scope, done: Deferred.Deferred<void, string>) =>
  Effect.gen(function* () {
    const transcript = new ConversationTranscript((query, limit) =>
      client["conversation/entries"]({
        conversation: id,
        ...(query.minEntryId === undefined ? {} : { from: query.minEntryId }),
        ...(query.maxEntryId === undefined ? {} : { to: query.maxEntryId }),
        ...(query.order === undefined ? {} : { order: query.order }),
        limit,
      }).pipe(
        Effect.map((page) => ({
          items: page.entries as unknown as ReadonlyArray<EntryRecord>,
          ...(page.next === undefined ? {} : { next: page.next as Record<string, never> }),
        })),
      ),
    )
    const [view, setView] = createSignal<TranscriptView | undefined>(undefined)
    const show = (next: TranscriptView) => setView(() => next)
    const watch = Effect.suspend(() => {
      let value: View | undefined
      const window = transcript.resume
      return client["conversation/watch"]({ conversation: id, ...(window ? { window } : {}) }).pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            value = item._tag === "view" ? item.view : applyImmutable(value, item.ops as ReadonlyArray<Op>)
            show(transcript.merge(value as unknown as ConversationView))
          }),
        ),
      )
    })
    // A watch that ends or drops is watched again; only a conversation that is not there ends the following.
    const rewatch: Effect.Effect<void> = watch.pipe(
      Effect.catchIf(
        (error) => error._tag !== "NoSuchConversation",
        () => Effect.void,
      ),
      Effect.andThen(Effect.sleep(REWATCH_DELAY)),
      Effect.andThen(Effect.suspend(() => rewatch)),
      Effect.catchTag("NoSuchConversation", () => Effect.asVoid(Deferred.fail(done, `no conversation ${id}`))),
    )
    yield* Effect.forkIn(rewatch, scope)
    // A load that fails leaves its marker, and scrolling to it again loads again.
    const load = (effect: Effect.Effect<TranscriptView, unknown>, inserting: () => void) =>
      Effect.runFork(
        effect.pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              if (next === untrack(view)) return
              inserting()
              show(next)
            }),
          ),
          Effect.ignore,
        ),
      )
    // Memos, so what reads only the items does not run again for a change to the documents, such as a streamed word.
    const { items, docs } = createRoot(() => ({
      items: createMemo(() => view()?.items ?? []),
      docs: createMemo(() => (view()?.docs ?? {}) as Docs),
    }))
    const followed: Followed = {
      id,
      items,
      docs,
      loaded: () => view() !== undefined,
      loadEarlier: (inserting) => load(transcript.loadEarlier, inserting),
      fillGap: (gap, inserting) => load(transcript.fillGap(gap), inserting),
    }
    return followed
  })

const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? ""
const tail = (text: string, lines: number) => text.trimEnd().split("\n").slice(-lines).join("\n")
const head = (text: string, lines: number) => {
  const all = text.trimEnd().split("\n")
  return all.length <= lines ? all.join("\n") : `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines`
}

/**
 * The kinds the transcript draws a row for; the rest it skips: the context's system entries, and results, answers and
 * hosted subagents, which the call they belong to draws.
 */
const DRAWN = new Set([
  "pi.user",
  USER_KIND,
  MAIL_KIND,
  REPORT_KIND,
  "pi.assistant",
  RUN_END_KIND,
  MODEL_KIND,
  RESET_KIND,
  COMPACTION_KIND,
  CONFIGURED_KIND,
  STARTED_KIND,
  FORKED_KIND,
  INTERRUPTED_KIND,
  CONTINUED_KIND,
  WITHDRAWN_KIND,
  TARGET_CHANGED_KIND,
])

/** What the entry of each act that has no other row says its author did. */
const ACTS: Readonly<Record<string, string>> = {
  [STARTED_KIND]: "started the conversation",
  [FORKED_KIND]: "forked the conversation here",
  [INTERRUPTED_KIND]: "interrupted",
  [CONTINUED_KIND]: "continued",
}

const drawn = (item: TranscriptItem) => item.kind !== "entry" || DRAWN.has(item.entry.kind)

/** Whether the model's words after `previous` start a new turn, under their own SIGMA tag. */
const startsTurn = (previous: TranscriptItem | undefined) =>
  previous?.kind !== "entry" ||
  previous.entry.kind === "pi.user" ||
  previous.entry.kind === USER_KIND ||
  previous.entry.kind === MAIL_KIND ||
  previous.entry.kind === REPORT_KIND ||
  previous.entry.kind === RUN_END_KIND ||
  previous.entry.kind === CONTINUED_KIND

/** The conversations the TUI follows: the one it opened and every subagent under it, keyed by id. */
interface Tree {
  readonly root: Followed
  readonly children: Readonly<Record<string, Followed>>
  /** Each subagent's parent. */
  readonly parents: Readonly<Record<string, string>>
  /**
   * The subagents the server lists under the tree, by the call that started each. A call a script made, such as a
   * code-mode `tools.start_worker(...)`, is `<script's call>/<key>`, and leaves no entry that names its subagent.
   */
  readonly started: Readonly<Record<string, Subagent>>
}

const isUnder = (tree: Tree, id: string, ancestor: string) => {
  let parent = tree.parents[id]
  while (parent !== undefined) {
    if (parent === ancestor) return true
    parent = tree.parents[parent]
  }
  return false
}

/** The subagent, or one under it, whose call waits on a person. */
const askingIn = (tree: Tree, subagent: string) =>
  [tree.children[subagent], ...Object.values(tree.children).filter((each) => isUnder(tree, each.id, subagent))].find(
    (each) => each !== undefined && pendingCalls(each.docs()).length > 0,
  )

/** What a subagent's card calls it: the title it was started with, or else the name its parent's call gave it. */
const titleOf = (tree: Tree, id: string) => {
  const parent = tree.parents[id] === tree.root.id ? tree.root : tree.children[tree.parents[id] ?? ""]
  const started = [...(parent === undefined ? [] : indexOf(parent.items()).subagents)].find(
    ([, subagent]) => subagent.conversation === id,
  )
  return (
    started?.[1].title ??
    nameOf(parent, started?.[0]) ??
    Object.values(tree.started).find((listed) => listed.conversation === id)?.title ??
    `conversation ${id}`
  )
}

/** The `task_name` the call `callId` of `followed` gave the subagent it started. */
const nameOf = (followed: Followed | undefined, callId: string | undefined) => {
  if (followed === undefined || callId === undefined) return undefined
  for (const item of followed.items()) {
    if (item.kind !== "entry" || item.entry.kind !== "pi.assistant") continue
    const call = callsOf(messageOf(item.entry)).find((each) => each.id === callId)
    if (call) return (call.arguments as { task_name?: string } | undefined)?.task_name
  }
  return undefined
}

/** A call of the tree waiting on a person, as the asks panel lists it, with the request that answers it. */
type Waiting = Ask & { readonly conversation: string; readonly approval: string }

const waitingIn = (followed: Followed, by: string | undefined) =>
  pendingCalls(followed.docs()).map(([approval, request]) => ({
    conversation: followed.id,
    approval,
    at: request.at ?? 0,
    ...(by === undefined ? {} : { by }),
    call: describeCall(request.tool ?? "", request.arguments),
  }))

/**
 * Every call of the tree waiting on a person, in the order `^Y` and `^N` answer them (D9 of s-cjk9k6): the shown
 * conversation's own first, then its subagents', oldest first.
 */
const asksOf = (tree: Tree): ReadonlyArray<Waiting> => {
  const byAge = (a: { at: number }, b: { at: number }) => a.at - b.at
  const own = waitingIn(tree.root, undefined).toSorted(byAge)
  const theirs = Object.values(tree.children)
    .flatMap((child) => waitingIn(child, titleOf(tree, child.id)))
    .toSorted(byAge)
  return [...own, ...theirs]
}

/** The background jobs a harness started in `followed`, by the harness's task id. */
const jobsOf = (followed: Followed) => {
  const doc = (followed.docs() as Readonly<Record<string, unknown>>)[JobsDoc.definition.kind] as
    | { readonly jobs?: Readonly<Record<string, JobRecord>> }
    | undefined
  return Object.values(doc?.jobs ?? {})
}

/**
 * The work going on under the tree beside its runs, which `Esc` on an idle conversation stops: Sigma's own subagents
 * that work, and the jobs Claude Code runs in the background. A subagent Claude Code runs counts as its job.
 */
const backgroundOf = (tree: Tree) => {
  const own = new Set(
    Object.values(tree.started).flatMap((started) => (started.task === undefined ? [] : [started.conversation])),
  )
  const subagents = Object.values(tree.children).filter(
    (child) => own.has(child.id) && child.loaded() && statusOf(child.docs()) !== "idle",
  ).length
  const jobs = [tree.root, ...Object.values(tree.children)].flatMap(jobsOf).filter((job) => job.state === "working")
  return subagents + jobs.length
}

/** What a job's card says of it. */
const JOB_STATES: Readonly<Record<JobRecord["state"], { label: string; tone: string }>> = {
  working: { label: "running", tone: color.cyan },
  done: { label: "done", tone: color.dim },
  failed: { label: "failed", tone: color.yellow },
  stopped: { label: "stopped", tone: color.yellow },
  "cut off": { label: "cut off", tone: color.yellow },
}

/** The line under a call that waits on a person: the asks panel below the transcript answers it. */
const AskedLine = (props: { call: string }) => (
  <box flexDirection="row" marginLeft={2} gap={1}>
    <text fg={color.yellow}>{`allow ${props.call}?`}</text>
    <text fg={color.dim}>· answer below</text>
  </box>
)

const lastActivity = (child: Followed) => {
  const live = textOf(child.docs()["pi.live"]?.generation?.message?.content)
  if (live !== "") return lastLine(live)
  for (const item of child.items().toReversed()) {
    if (item.kind !== "entry") continue
    const entry = item.entry
    if (entry.kind === "pi.assistant") {
      const message = messageOf(entry)
      const call = callsOf(message).at(-1)
      if (call) return describeCall(call.name, call.arguments)
      const text = textOf(message?.content)
      if (text !== "") return lastLine(text)
    }
    if (entry.kind === "pi.user" || entry.kind === USER_KIND) return lastLine(typedOf(messageOf(entry)?.content))
  }
  return ""
}

const childState = (child: Followed | undefined): { label: string; tone: string } => {
  if (!child || !child.loaded()) return { label: "working", tone: color.cyan }
  const status = statusOf(child.docs())
  if (status === "working") return { label: "working", tone: color.cyan }
  if (status === "waiting") return { label: "waiting on you", tone: color.yellow }
  const end = child.items().findLast((item) => item.kind === "entry" && item.entry.kind === RUN_END_KIND)
  const outcome = end?.kind === "entry" ? dataOf<RunEnd>(end.entry).outcome : "answered"
  if (outcome === "answered") return { label: "done", tone: color.dim }
  return { label: outcome === "interrupted" ? "interrupted" : "failed", tone: color.yellow }
}

const SubagentCard = (props: {
  tree: Tree
  conversation: string
  title: string
  agentType: string | undefined
  /** The job Claude Code runs it as, when it runs in the background. */
  job?: JobRecord | undefined
}) => {
  const child = () => props.tree.children[props.conversation]
  const asker = () => askingIn(props.tree, props.conversation)
  // A job that ended other than done says how, which its conversation's last run may not: stopped, or cut off.
  const ended = () => {
    const state = props.job?.state
    return state === undefined || state === "working" || state === "done" ? undefined : JOB_STATES[state]
  }
  const state = () => (asker() ? { label: "waiting on you", tone: color.yellow } : (ended() ?? childState(child())))
  const asking = () => {
    const pending = asker() && pendingCalls(asker()!.docs())[0]
    if (!pending) return undefined
    const [, request] = pending as [string, Approval & { tool?: string; arguments?: unknown }]
    return describeCall(request.tool ?? "", request.arguments)
  }
  return (
    <box flexDirection="column" marginTop={1} marginLeft={2}>
      <box flexDirection="row" gap={1}>
        <text fg={color.violet}>{`⧉ ${props.title}${props.agentType ? ` (${props.agentType})` : ""}`}</text>
        <text fg={state().tone}>{state().label}</text>
      </box>
      <Show when={child() && lastActivity(child()!)}>
        {(activity) => (
          <text fg={color.dim} marginLeft={2}>
            {activity()}
          </text>
        )}
      </Show>
      <Show when={asking()}>{(call) => <AskedLine call={call()} />}</Show>
    </box>
  )
}

/** The calls a running tool made, under it, each with the approval it waits for: what ctrl+y would allow. */
const NestedCalls = (props: { followed: Followed; index: Index; parent: string }) => {
  const calls = () =>
    props.followed.docs()["pi.live"]?.nestedTools?.filter((call) => call.parentCallId === props.parent) ?? []
  return (
    <For each={calls()}>
      {(call) => {
        const asking = () => pendingCalls(props.followed.docs()).some(([, request]) => request.callId === call.callId)
        const answer = () => {
          const entry = props.index.answers.get(call.callId)
          return entry && dataOf<{ allow: boolean; author: Author }>(entry)
        }
        return (
          <box flexDirection="column" marginLeft={2}>
            <text fg={color.violet}>{`▸ ${describeCall(call.name, call.arguments)}`}</text>
            <Show when={asking()}>
              <AskedLine call="this call" />
            </Show>
            <Show when={answer()}>
              {(given) => (
                <text fg={color.dim} marginLeft={2}>
                  {`${given().allow ? "✓ allowed" : "✗ denied"} by ${given().author.name.toLowerCase()}`}
                </text>
              )}
            </Show>
            <Show when={(call.output ?? "") !== ""}>
              <text fg={color.dim} marginLeft={2}>
                {tail(call.output ?? "", OUTPUT_LINES)}
              </text>
            </Show>
            <NestedCalls followed={props.followed} index={props.index} parent={call.callId} />
          </box>
        )
      }}
    </For>
  )
}

const ToolCallView = (props: { followed: Followed; index: Index; tree: Tree; call: ToolCallBlock }) => {
  const result = () => {
    const entry = props.index.results.get(props.call.id)
    const message = entry && messageOf(entry)
    return message && { text: resultTextOf(message, entry), error: message.isError === true }
  }
  // What a worker sent reads as what it said under its name, as its mail does.
  const received = () => {
    const shown = result()
    const mail = shown && !shown.error ? receivedOf(props.call.name, shown.text) : undefined
    return mail === undefined || mail.length === 0 ? undefined : mail
  }
  const output = () =>
    props.followed.docs()["pi.live"]?.tools?.find((tool) => tool.callId === props.call.id)?.output ?? ""
  const asking = () => pendingCalls(props.followed.docs()).some(([, request]) => request.callId === props.call.id)
  const answer = () => {
    const entry = props.index.answers.get(props.call.id)
    return entry && dataOf<{ allow: boolean; author: Author }>(entry)
  }
  const subagent = () => props.index.subagents.get(props.call.id) ?? props.tree.started[props.call.id]
  const nested = () =>
    Object.entries(props.tree.started).flatMap(([call, started]) =>
      call.startsWith(`${props.call.id}/`) ? [started] : [],
    )
  const input = () => props.call.arguments as { task_name?: string; agent_type?: string } | undefined
  /** The background job Claude Code runs for this call. */
  const job = () => jobsOf(props.followed).find((each) => each.call === props.call.id)
  const command = () => {
    const started = job()
    return started?.kind === "command" ? JOB_STATES[started.state] : undefined
  }
  return (
    <Show
      when={subagent()}
      fallback={
        <box flexDirection="column" marginLeft={2}>
          <box flexDirection="row" gap={1}>
            <text fg={color.violet}>{`▸ ${describeCall(props.call.name, props.call.arguments)}`}</text>
            <Show when={command()}>
              {(state) => (
                <>
                  <text fg={color.dim}>in background ·</text>
                  <text fg={state().tone}>{state().label}</text>
                </>
              )}
            </Show>
          </box>
          <Show when={asking()}>
            <AskedLine call="this call" />
          </Show>
          <Show when={answer()}>
            {(given) => (
              <text fg={color.dim} marginLeft={2}>
                {`${given().allow ? "✓ allowed" : "✗ denied"} by ${given().author.name.toLowerCase()}`}
              </text>
            )}
          </Show>
          <Show when={result() === undefined}>
            <NestedCalls followed={props.followed} index={props.index} parent={props.call.id} />
          </Show>
          <Show when={result() === undefined && output() !== ""}>
            <text fg={color.dim} marginLeft={2}>
              {tail(output(), OUTPUT_LINES)}
            </text>
          </Show>
          <Show when={command() === undefined && result()}>
            {(shown) => (
              <Show
                when={received()}
                fallback={
                  <Show when={shown().text.trim() !== ""}>
                    <text fg={shown().error ? color.yellow : color.dim} marginLeft={2}>
                      {head(shown().text, RESULT_LINES)}
                    </text>
                  </Show>
                }
              >
                {(mail) => (
                  <For each={mail()}>
                    {(each) => <UserView label={each.from} tone={color.violet} text={each.text} attached={[]} />}
                  </For>
                )}
              </Show>
            )}
          </Show>
          <For each={nested()}>
            {(started) => (
              <SubagentCard
                tree={props.tree}
                conversation={started.conversation}
                title={started.title ?? started.conversation}
                agentType={started.agentType}
              />
            )}
          </For>
        </box>
      }
    >
      {(started) => (
        <SubagentCard
          tree={props.tree}
          conversation={started().conversation}
          title={started().title ?? input()?.task_name ?? props.call.name}
          agentType={started().agentType ?? input()?.agent_type}
          job={job()}
        />
      )}
    </Show>
  )
}

const RunEndView = (props: { outcome: Outcome; message: string | undefined }) => (
  <Switch>
    <Match when={props.outcome === "interrupted"}>
      <text fg={color.dim} marginLeft={2}>
        ◆ interrupted
      </text>
    </Match>
    <Match when={props.outcome !== "answered"}>
      <text fg={color.yellow} marginLeft={2}>
        {`✗ ${props.message ?? props.outcome}`}
      </text>
    </Match>
  </Switch>
)

/** What a person sent, with the skills and images it carried. */
const UserView = (props: { label: string; tone: string; text: string; attached: ReadonlyArray<string> }) => (
  <box flexDirection="column" marginTop={1}>
    <Tag label={props.label} color={props.tone} />
    <text fg={color.ink} marginLeft={2}>
      {props.text}
    </text>
    <Show when={props.attached.length > 0}>
      <text fg={color.dim} marginLeft={2}>
        {`with ${props.attached.join(", ")}`}
      </text>
    </Show>
  </box>
)

const EntryView = (props: {
  followed: Followed
  index: Index
  tree: Tree
  entry: EntryRecord
  previous: TranscriptItem | undefined
}) => {
  const entry = props.entry
  switch (entry.kind) {
    case USER_KIND:
    case "pi.user": {
      const data = dataOf<{
        author?: Author
        skills?: ReadonlyArray<{ name: string }>
        images?: ReadonlyArray<string>
      }>(entry)
      return (
        <UserView
          label={(data.author?.name ?? "you").toUpperCase()}
          tone={color.magenta}
          text={typedOf(messageOf(entry)?.content)}
          attached={[...(data.skills ?? []).map((skill) => skill.name), ...(data.images ?? [])]}
        />
      )
    }
    case MAIL_KIND:
      return (
        <UserView
          label={dataOf<{ sender: string }>(entry).sender}
          tone={color.violet}
          text={mailPayload(textOf(messageOf(entry)?.content))}
          attached={[]}
        />
      )
    case REPORT_KIND: {
      // A wake with no job's end before it says the harness went on by itself, in its text.
      const job = entry.data === undefined ? undefined : dataOf<ReportData>(entry)
      return (
        <UserView
          label={job?.title ?? "background"}
          tone={color.violet}
          text={textOf(messageOf(entry)?.content)}
          attached={[]}
        />
      )
    }
    case "pi.assistant": {
      const message = messageOf(entry)
      const text = textOf(message?.content)
      const calls = callsOf(message)
      if (text === "" && calls.length === 0) return null
      return (
        <box flexDirection="column" marginTop={1}>
          <Show when={startsTurn(props.previous)}>
            <Tag label="SIGMA" color={color.cyan} />
          </Show>
          <Show when={text !== ""}>
            <text fg={color.ink} marginLeft={2}>
              {text}
            </text>
          </Show>
          <For each={calls}>
            {(call) => <ToolCallView followed={props.followed} index={props.index} tree={props.tree} call={call} />}
          </For>
        </box>
      )
    }
    case RUN_END_KIND: {
      const end = dataOf<RunEnd>(entry)
      return <RunEndView outcome={end.outcome} message={end.message} />
    }
    case TARGET_CHANGED_KIND: {
      return (
        <text fg={color.yellow} marginTop={1} marginLeft={2}>
          {describeTargetChange(dataOf<Parameters<typeof describeTargetChange>[0]>(entry))}
        </text>
      )
    }
    case MODEL_KIND: {
      const data = dataOf<{ author: Author; selection: ModelSelection }>(entry)
      return (
        <text fg={color.dim} marginTop={1} marginLeft={2}>
          {`◆ ${data.author.name.toLowerCase()} switched to ${modelLabel(data.selection)}`}
        </text>
      )
    }
    case RESET_KIND: {
      const author = dataOf<{ author?: Author }>(entry).author?.name
      const handoff = textOf(messageOf(entry)?.content)
      return (
        <box flexDirection="column" marginTop={1} marginLeft={2}>
          <text fg={color.dim}>{`◆ ${author ? `${author.toLowerCase()} started` : "started"} a new context`}</text>
          <Show when={handoff !== ""}>
            <text fg={color.dim} marginLeft={2}>
              {handoff}
            </text>
          </Show>
        </box>
      )
    }
    case COMPACTION_KIND: {
      const data = dataOf<{ reason?: string; author?: Author }>(entry)
      const who = data.author === undefined ? "" : `${data.author.name.toLowerCase()} `
      return (
        <text fg={color.dim} marginTop={1} marginLeft={2}>
          {`◆ ${who}compacted the context${data.reason === "manual" ? "" : " to make room"}`}
        </text>
      )
    }
    case STARTED_KIND:
    case FORKED_KIND:
    case INTERRUPTED_KIND:
    case CONTINUED_KIND: {
      const did = ACTS[entry.kind]
      return (
        <text fg={color.dim} marginTop={1} marginLeft={2}>
          {`◆ ${dataOf<{ author: Author }>(entry).author.name.toLowerCase()} ${did}`}
        </text>
      )
    }
    case WITHDRAWN_KIND: {
      // Withdrawn by an interrupt or a failed run, it names no one; the interrupt or the run's end says what happened.
      const author = dataOf<{ author?: Author }>(entry).author
      if (author === undefined) return null
      return (
        <text fg={color.dim} marginTop={1} marginLeft={2}>
          {`◆ ${author.name.toLowerCase()} withdrew a queued prompt`}
        </text>
      )
    }
    case CONFIGURED_KIND: {
      const { author, maxTurns } = dataOf<{ author: Author; maxTurns: number | null }>(entry)
      const change =
        maxTurns === null
          ? "removed the turn limit"
          : `set the turn limit to ${maxTurns} ${maxTurns === 1 ? "turn" : "turns"}`
      return (
        <text fg={color.dim} marginTop={1} marginLeft={2}>
          {`◆ ${author.name.toLowerCase()} ${change}`}
        </text>
      )
    }
    default:
      return null
  }
}

/** A row that loads more once it is scrolled into view. */
const Marker = (props: { text: string; register: (renderable: Renderable | undefined) => void }) => {
  onCleanup(() => props.register(undefined))
  return (
    <box ref={(element: Renderable) => props.register(element)} marginTop={1} marginLeft={2} height={1}>
      <text fg={color.dim}>{props.text}</text>
    </box>
  )
}

const Transcript = (props: { followed: Followed; tree: Tree }) => {
  let box: ScrollBoxRenderable | undefined
  const markers = new Map<TranscriptItem, { renderable: Renderable; load: (inserting: () => void) => void }>()
  /** The distance from the bottom to keep while a load inserts entries above the rows in view. */
  let anchor: number | undefined
  // Measured inside the content, which a scroll moves as a whole, against where the scroll has it now.
  const visible = (renderable: Renderable) => {
    if (!box) return false
    const at = renderable.y - box.content.y
    return at + renderable.height > box.scrollTop && at < box.scrollTop + box.viewport.height
  }
  const check = () => {
    for (const marker of markers.values()) {
      if (!visible(marker.renderable)) continue
      marker.load(() => {
        if (box) anchor = box.scrollHeight - box.scrollTop
      })
    }
  }
  const resized = () => {
    if (box && anchor !== undefined) {
      box.scrollTop = box.scrollHeight - anchor
      anchor = undefined
    }
    check()
  }
  const attach = (element: ScrollBoxRenderable) => {
    box = element
    const own = element.content.onSizeChange
    element.content.onSizeChange = () => {
      own?.call(element.content)
      resized()
    }
  }
  const register =
    (item: TranscriptItem, load: (inserting: () => void) => void) => (renderable: Renderable | undefined) => {
      if (renderable) markers.set(item, { renderable, load })
      else markers.delete(item)
    }
  const rows = createMemo(() => props.followed.items().filter(drawn))
  const index = createMemo(() => indexOf(props.followed.items()))
  const live = () => textOf(props.followed.docs()["pi.live"]?.generation?.message?.content)
  const queued = () =>
    (props.followed.docs()["pi.inbox"]?.items ?? []).filter((item) => item.mode === "steer" || item.mode === "followUp")
  return (
    <scrollbox
      ref={attach}
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={() => queueMicrotask(check)}
    >
      <For each={rows()}>
        {(item, at) => (
          <Switch>
            <Match when={item.kind === "earlier"}>
              <Marker text="↑ earlier messages" register={register(item, props.followed.loadEarlier)} />
            </Match>
            <Match when={item.kind === "gap" && item}>
              {(gap) => (
                <Marker
                  text="… missing messages"
                  register={register(item, (inserting) => props.followed.fillGap(gap(), inserting))}
                />
              )}
            </Match>
            <Match when={item.kind === "entry" && item.entry}>
              {(entry) => (
                <EntryView
                  followed={props.followed}
                  index={index()}
                  tree={props.tree}
                  entry={entry()}
                  previous={rows()[at() - 1]}
                />
              )}
            </Match>
          </Switch>
        )}
      </For>
      <Show when={live() !== ""}>
        <box flexDirection="column" marginTop={1}>
          <Show when={startsTurn(rows().at(-1))}>
            <Tag label="SIGMA" color={color.cyan} />
          </Show>
          <text fg={color.ink} marginLeft={2}>
            {live()}
          </text>
        </box>
      </Show>
      <For each={queued()}>
        {(item) => (
          <text fg={color.dim} marginLeft={2}>
            {`${item.mode === "steer" ? "steering" : "queued"} · ${typedOf(item.content)}`}
          </text>
        )}
      </For>
    </scrollbox>
  )
}

type TaskGraph = {
  readonly tasks: Readonly<
    Record<
      string,
      {
        readonly kind: string
        readonly conversationId: number
        readonly state: { readonly status: string; readonly phase?: string }
        readonly blocked?: unknown
      }
    >
  >
}

/** A conversation as a person knows it: its id, and its title when it has one. */
const conversationLabel = (info: ConversationInfo | undefined, number: number) =>
  info === undefined
    ? `conversation ${number}`
    : `conversation ${info.id}${info.title === undefined ? "" : ` · ${clip(info.title, TITLE_WIDTH)}`}`

/** The tasks under the conversation each works in, with `current`'s marked; `known` names conversations by number. */
const taskLines = (graph: TaskGraph, known: ReadonlyMap<number, ConversationInfo>, current: string) => {
  const tasks = Object.entries(graph.tasks)
  if (tasks.length === 0) return ["nothing is running"]
  const byConversation = new Map<number, Array<string>>()
  for (const [id, task] of tasks) {
    const lines = byConversation.get(task.conversationId) ?? []
    lines.push(
      `  ${id}  ${task.kind}  ${task.state.status}${task.state.phase ? ` · ${task.state.phase}` : ""}${task.blocked === undefined ? "" : "  blocked"}`,
    )
    byConversation.set(task.conversationId, lines)
  }
  return [...byConversation].flatMap(([number, lines]) => {
    const info = known.get(number)
    return [`${conversationLabel(info, number)}${info?.id === current ? "  (this one)" : ""}`, ...lines]
  })
}

/**
 * The tokens of the context at the newest answer: its request and what it wrote. Unknown once a reset or summary
 * came after it, or before an answer that reports usage.
 */
const contextUsed = (items: ReadonlyArray<TranscriptItem>) => {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.kind !== "entry") continue
    if (item.entry.kind === RESET_KIND || item.entry.kind === COMPACTION_KIND) return undefined
    if (item.entry.kind !== "pi.assistant") continue
    // A provider that does not count, such as Claude Code, reports zero.
    const total = (messageOf(item.entry) as { usage?: Usage } | undefined)?.usage?.totalTokens ?? 0
    return total > 0 ? total : undefined
  }
  return undefined
}

/** Commands that take nothing after their name: given more, the text goes to the model as typed. */
const TAKES_NOTHING = new Set(["help", "fork", "continue", "withdraw", "usage", "tasks"])

/** The subagents `followed`'s entries started. */
const subagentsOf = (followed: Followed) =>
  [...indexOf(followed.items()).subagents.values()].map((subagent) => subagent.conversation)

/** Opens `id`, or a new conversation, and then each fork the person moves on to, until they quit. */
export const tui = Effect.fnUntraced(function* (
  id: string | undefined,
  options: StartOptions,
  prompt: string | undefined,
) {
  let next = yield* Effect.scoped(conversationScreen(id, options, prompt))
  while (next !== undefined) next = yield* Effect.scoped(conversationScreen(next, options, undefined))
})

const READ_ONLY_NOTICE = {
  text: "this server is read-only and sends nothing; stop it and run sigma serve to send",
  warning: true,
}

/** Shows one conversation until the person quits it, or moves on to a fork of it: then the fork's id. */
const conversationScreen = Effect.fnUntraced(function* (
  id: string | undefined,
  options: StartOptions,
  prompt: string | undefined,
) {
  const client = yield* Client
  const author = launchAuthor()
  const initialize = client.initialize({ client: "sigma", version: VERSION, protocol: PROTOCOL_VERSION })
  const [readOnly, setReadOnly] = createSignal((yield* initialize).readOnly)
  // A number names a conversation the server numbered; any other id is one a client chose, and starting with it
  // opens that conversation or starts it.
  const numbered = id !== undefined && /^\d+$/.test(id)
  const started = numbered
    ? undefined
    : yield* client["conversation/start"]({
        cwd: process.cwd(),
        author,
        ...options,
        ...(id === undefined ? {} : { id }),
      })
  const conversation = started?.conversation ?? id!
  const conversations = yield* client["conversation/list"]()
  const info = conversations.find((each) => each.id === conversation)
  const forkOf = info?.fork && conversations.find((each) => each.id === info.fork!.of)
  const done = yield* Deferred.make<void, string>()
  const scope = yield* Effect.scope

  const root = yield* follow(client, conversation, scope, done)
  const [children, setChildren] = createSignal<Readonly<Record<string, Followed>>>({})
  const [spawned, setSpawned] = createSignal<Readonly<Record<string, Subagent>>>({})
  const parents: Record<string, string> = {}
  const tree: Tree = {
    root,
    get children() {
      return children()
    },
    parents,
    get started() {
      return spawned()
    },
  }
  const adopt = (child: string, parent: string) => {
    if (child in untrack(children)) return
    parents[child] = parent
    const followed = Effect.runSync(follow(client, child, scope, done))
    setChildren((all) => ({ ...all, [child]: followed }))
  }
  // Follows each subagent once some conversation the TUI follows shows it started.
  const followSubagents = () =>
    createEffect(() => {
      for (const parent of [root, ...Object.values(children())]) {
        for (const child of subagentsOf(parent)) adopt(child, parent.id)
      }
    })
  // A subagent no entry names, one a script started, is found in the server's list: once at the start, and again each
  // time the status of a tree changes, as it does when such a subagent waits on a person.
  const listed = client["conversation/list"]().pipe(
    Effect.tap((all) =>
      Effect.sync(() => {
        // Oldest first, so a subagent's parent is followed before it.
        for (const each of all) {
          const lineage = each.lineage
          if (lineage === undefined || (lineage.parent !== conversation && !(lineage.parent in untrack(children))))
            continue
          if (!(lineage.call in untrack(spawned)))
            setSpawned((all) => ({
              ...all,
              [lineage.call]: {
                conversation: each.id,
                title: lineage.title,
                agentType: lineage.agentType,
                task: lineage.task,
              },
            }))
          adopt(each.id, lineage.parent)
        }
      }),
    ),
  )
  // Watched again whenever the server goes away, and the server that answers may be another one: a `serve --restart`
  // can replace a read-only server with one that writes, or the other way, so each watch asks what this server is.
  // While the server refuses to start, the person sees what it said, until a server answers again.
  let refusal: Notice | undefined
  const relist: Effect.Effect<void> = Effect.suspend(() => {
    // A refusal answers a call made before the person's latest action, such as a prompt typed while the call waited,
    // so it is not put back over what that action showed: the next attempt, a second later, shows it again.
    const before = untrack(notice)
    return initialize.pipe(
      Effect.tap(({ readOnly }) =>
        Effect.sync(() => {
          setReadOnly(readOnly)
          const shown = untrack(notice)
          if (shown === refusal || (!readOnly && shown === READ_ONLY_NOTICE)) setNotice(undefined)
          refusal = undefined
        }),
      ),
      Effect.andThen(Stream.runForEach(client["status/watch"](), () => listed)),
      Effect.catchTag("RpcClientError", (error) =>
        Effect.sync(() => {
          const said = serverRefusal(error)
          if (said === undefined) return
          const text = `sigma's server cannot start: ${said}`
          // Shown again after the person's next action replaced it, while the server still refuses.
          if (untrack(notice) !== before || untrack(notice)?.text === text) return
          refusal = { text, warning: true }
          setNotice(refusal)
        }),
      ),
    )
  }).pipe(Effect.ignore, Effect.andThen(Effect.sleep(REWATCH_DELAY)), Effect.andThen(Effect.suspend(() => relist)))

  // Images are the person's, read on this machine: from the conversation's folder when it is here too.
  const remote = info !== undefined && info.target !== LOCAL_TARGET
  const imageDir = (cwd: string | undefined) => (remote ? process.cwd() : (cwd ?? process.cwd()))
  if (prompt !== undefined) {
    const images = imagesIn(prompt, imageDir(info?.cwd))
    yield* client["conversation/submit"]({
      conversation,
      requestId: crypto.randomUUID(),
      author,
      text: prompt,
      ...(images.length === 0 ? {} : { images }),
    })
  }

  let renderer: CliRenderer | undefined
  const setup = yield* setupOf(client, scope, () => renderer)
  const [workingSince, setWorkingSince] = createSignal<number | undefined>(undefined)
  const [notice, setNotice] = createSignal<Notice | undefined>(undefined)
  const [panel, setPanel] = createSignal<Panel | undefined>(undefined)
  const [contextWindows, setContextWindows] = createSignal<ReadonlyMap<string, number>>(new Map())
  Effect.runFork(
    client["models/list"]({}).pipe(
      Effect.tap((lists) =>
        Effect.sync(() =>
          setContextWindows(
            new Map(
              lists.flatMap((list) =>
                list.models.flatMap((model) =>
                  model.contextWindow === undefined ? [] : [[`${list.provider}/${model.id}`, model.contextWindow]],
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.ignore,
    ),
  )
  /** A task, its notice once it ends: what it came to, or why it failed, a defect the server sent included. */
  const report = <A, E>(effect: Effect.Effect<A, E>, said: (value: A) => string | undefined) =>
    Effect.runPromise(
      effect.pipe(
        Effect.matchCause({
          onSuccess: (value): A | undefined => {
            const text = said(value)
            setNotice(text === undefined ? undefined : { text, warning: false })
            return value
          },
          onFailure: (cause) => {
            const why: unknown = Cause.squash(cause)
            const text =
              typeof why === "object" && why !== null && "message" in why && typeof why.message === "string"
                ? why.message
                : String(why)
            setNotice({ text, warning: true })
            return undefined
          },
        }),
      ),
      // A notice that throws while it is drawn fails the promise; nothing waits on most, and a rejection nothing
      // handles would end the TUI.
    ).catch(() => undefined)
  /** Your own prompts waiting in the queue, oldest first: the ones you may edit. */
  const yours = (): ReadonlyArray<Pending> =>
    (root.docs()["pi.inbox"]?.items ?? []).flatMap((item) =>
      (item.mode === "steer" || item.mode === "followUp") &&
      item.entry?.kind === USER_KIND &&
      dataOf<{ author?: Author }>(item.entry).author?.id === author.id
        ? [{ id: item.id, text: typedOf(item.content), steer: item.mode === "steer" }]
        : [],
    )
  // A read-only server runs nothing, so a run it shows in flight is not working.
  const status = () => (readOnly() ? "idle" : statusOf(root.docs()))
  const { asks, background } = createRoot(() => ({
    asks: createMemo(() => asksOf(tree), [], {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((ask, at) => {
          const other = b[at]!
          return (
            ask.conversation === other.conversation &&
            ask.approval === other.approval &&
            ask.by === other.by &&
            ask.call === other.call
          )
        }),
    }),
    background: createMemo(() => backgroundOf(tree)),
  }))
  const screen: Screen = {
    id: conversation,
    fork: info?.fork && {
      of: info.fork.of,
      ...(forkOf?.title === undefined ? {} : { title: clip(forkOf.title, TITLE_WIDTH) }),
    },
    get cwd() {
      return root.docs()["pi.agent"]?.cwd ?? info?.cwd
    },
    target: remote ? info.target : undefined,
    get model() {
      return selectionOf(root.docs()["pi.agent"]) ?? info?.model
    },
    get status() {
      return status()
    },
    get workingSince() {
      return workingSince()
    },
    hosted: info?.lineage !== undefined && info.lineage.task === undefined,
    get readOnly() {
      return readOnly()
    },
    // A conversation that holds only who started it shows the splash until something happens in it.
    get empty() {
      return (
        !root
          .items()
          .some((item) => item.kind !== "entry" || (DRAWN.has(item.entry.kind) && item.entry.kind !== STARTED_KIND)) &&
        textOf(root.docs()["pi.live"]?.generation?.message?.content) === ""
      )
    },
    get asks() {
      return asks()
    },
    get background() {
      return readOnly() ? 0 : background()
    },
    get notice() {
      return notice()
    },
    get live() {
      const live = root.docs()["pi.live"]
      // A read-only server works on nothing, so it is neither compacting nor retrying.
      return {
        compacting: !readOnly() && (live?.compactions?.length ?? 0) > 0,
        compactionFailure: live?.compactionFailure?.error,
        retry: readOnly() ? undefined : live?.generation?.retry,
        reaching: readOnly() ? undefined : root.docs()["sigma.reaching"]?.wait,
      }
    },
    get usage() {
      const ledger = root.docs()["pi.usage"]
      const spent = [...Object.values(ledger?.models ?? {}), ...Object.values(ledger?.tools ?? {})]
      const model = screen.model
      return {
        tokens: spent.reduce((sum, usage) => sum + usage.totalTokens, 0),
        context: contextUsed(root.items()),
        contextWindow:
          model?.model === undefined ? undefined : contextWindows().get(`${model.provider}/${model.model}`),
      }
    },
    get panel() {
      return panel()
    },
  }
  const actions: ConversationActions = {
    // While the server is away the prompt is sent again under the same request id, which the server answers once.
    submit: (text, steer) => {
      if (readOnly()) return setNotice(READ_ONLY_NOTICE)
      setNotice(undefined)
      const images = imagesIn(text, imageDir(screen.cwd))
      const payload = {
        conversation,
        requestId: crypto.randomUUID(),
        author,
        text,
        ...(images.length === 0 ? {} : { images }),
        steer,
      }
      Effect.runFork(
        client["conversation/submit"](payload).pipe(
          Effect.retry({ while: (error) => error._tag === "RpcClientError", schedule: Schedule.spaced(REWATCH_DELAY) }),
          Effect.catchTag(["UnreadableImage", "TargetUnavailable"], (error) =>
            Effect.sync(() => setNotice({ text: error.message, warning: true })),
          ),
          // The server that answered is another, read-only one, which a restart put in place after the prompt was typed.
          Effect.catchTag("ReadOnlyServer", () =>
            Effect.sync(() => {
              setReadOnly(true)
              setNotice(READ_ONLY_NOTICE)
            }),
          ),
        ),
      )
    },
    attachments: (text) => attachmentsIn(text, imageDir(screen.cwd)).map((attachment) => attachment.name),
    answer: (allow) => {
      const head = untrack(asks)[0]
      if (head)
        Effect.runFork(
          client["approval/resolve"]({ conversation: head.conversation, approval: head.approval, author, allow }),
        )
    },
    pending: yours,
    edit: async (pending, text) => {
      if (readOnly()) {
        setNotice(READ_ONLY_NOTICE)
        return "failed"
      }
      const went = (result: string) => (result === "settled" ? "already ran" : "already reached sigma")
      if (text.trim() === "") {
        const withdrawn = await report(
          client["submission/withdraw"]({ conversation, submission: pending.id, author }),
          (withdrawn) =>
            withdrawn.result === "withdrawn"
              ? `withdrew: ${pending.text}`
              : `too late to withdraw: ${pending.text} ${went(withdrawn.result)}`,
        )
        return withdrawn === undefined ? "failed" : withdrawn.result === "withdrawn" ? "saved" : "went"
      }
      const updated = await report(
        client["submission/update"]({ conversation, submission: pending.id, author, text, steer: pending.steer }),
        (updated) =>
          updated.result === "updated"
            ? undefined
            : `too late to edit: ${pending.text} ${went(updated.result)}; enter sends your edit as a new prompt`,
      )
      return updated === undefined ? "failed" : updated.result === "updated" ? "saved" : "went"
    },
    // The server says which prompts the interrupt withdrew; yours are the ones to give back.
    interrupt: () =>
      Effect.runPromise(
        client["conversation/interrupt"]({ conversation, author }).pipe(
          Effect.map(({ withdrawn }) =>
            withdrawn.filter((prompt) => prompt.author.id === author.id).map((prompt) => prompt.text),
          ),
          Effect.catchCause(() => Effect.succeed([])),
        ),
      ),
    selectModel: (selection) =>
      Effect.runFork(client["conversation/select_model"]({ conversation, author, selection })),
    command: (name, argument) => {
      const run = commands[name]
      if (run === undefined || (argument !== "" && TAKES_NOTHING.has(name))) return false
      setNotice(undefined)
      run(argument)
      return true
    },
    closePanel: () => setPanel(undefined),
    quit: () => Effect.runFork(Deferred.succeed(done, undefined)),
  }

  /** The conversation to open once this one closes: a fork it made. */
  let next: string | undefined
  const usageLines = (title: string, ledger: UsageLedger) => {
    const rows = [
      ...Object.entries(ledger.models ?? {}).map(([model, usage]) => ({ name: model, usage })),
      ...Object.entries(ledger.tools ?? {}).map(([tool, usage]) => ({ name: `tool ${tool}`, usage })),
    ]
    const total = rows.reduce((sum, row) => sum + row.usage.totalTokens, 0)
    return [
      "",
      `${title}: ${tokens(total)} tokens`,
      ...rows.map(({ name, usage }) => {
        // `in` is what the provider did not read from its prompt cache; Claude also bills what it writes to it.
        const parts = [
          `${tokens(usage.input)} in`,
          `${tokens(usage.cacheRead)} cached`,
          ...(usage.cacheWrite > 0 ? [`${tokens(usage.cacheWrite)} cache write`] : []),
          `${tokens(usage.output)} out`,
        ]
        return `  ${name}  ${tokens(usage.totalTokens)} (${parts.join(", ")})`
      }),
    ]
  }
  const commands: Readonly<Record<string, (argument: string) => void>> = {
    help: () => setPanel({ title: "COMMANDS", lines: COMMANDS.map(([command, what]) => `${command}  ${what}`) }),
    fork: () => {
      // Just before the last prompt a person typed, so they can try it another way.
      const items = root.items()
      const last = items.findLastIndex(
        (item) => item.kind === "entry" && (item.entry.kind === USER_KIND || item.entry.kind === "pi.user"),
      )
      const before = last > 0 ? items[last - 1] : undefined
      if (before?.kind !== "entry") {
        const text =
          last === -1
            ? items[0]?.kind === "earlier"
              ? "the last prompt is not loaded; scroll up to it and fork again"
              : "nothing to fork yet: no prompt has been sent"
            : before === undefined
              ? "nothing comes before the first prompt to fork from"
              : "the entry before the last prompt is not loaded; scroll up to it and fork again"
        return setNotice({ text, warning: true })
      }
      report(client["conversation/fork"]({ conversation, at: Number(before.entry.id), author }), (forked) => {
        next = forked.conversation
        Effect.runFork(Deferred.succeed(done, undefined))
        return undefined
      })
    },
    reset: (handoff) =>
      report(
        client["conversation/reset"]({ conversation, author, ...(handoff === "" ? {} : { handoff }) }),
        () => undefined,
      ),
    compact: (instructions) => {
      setNotice({ text: "compacting", warning: false })
      report(
        client["conversation/compact"]({
          conversation,
          author,
          ...(instructions === "" ? {} : { instructions }),
        }),
        (ended) =>
          // A failure shows from the live state, which every client sees.
          ended.outcome === "nothing_to_compact"
            ? "nothing to compact: the context is short enough already"
            : ended.outcome === "stopped"
              ? "compaction stopped"
              : undefined,
      )
    },
    continue: () => report(client["conversation/continue"]({ conversation, author }), () => undefined),
    withdraw: () => {
      const queued = (root.docs()["pi.inbox"]?.items ?? []).filter(
        (item) => item.mode === "steer" || item.mode === "followUp",
      )
      const newest = queued.at(-1)
      if (newest === undefined) return setNotice({ text: "nothing queued to withdraw", warning: true })
      report(client["submission/withdraw"]({ conversation, submission: newest.id, author }), (withdrawn) =>
        withdrawn.result === "withdrawn"
          ? `withdrew: ${typedOf(newest.content)}`
          : `too late to withdraw: ${typedOf(newest.content)} already ${withdrawn.result === "settled" ? "ran" : "reached sigma"}`,
      )
    },
    "max-turns": (count) => {
      const turns = count === "" ? null : Number(count)
      if (turns !== null && !(Number.isInteger(turns) && turns >= 1))
        return setNotice({ text: `max turns takes a whole number 1 or more, got ${count}`, warning: true })
      report(client["conversation/configure"]({ conversation, author, maxTurns: turns }), () => undefined)
    },
    usage: () =>
      report(client["usage/get"]({}), (home) => {
        setPanel({
          title: "USAGE",
          lines: [
            ...usageLines("this conversation", root.docs()["pi.usage"] ?? {}),
            ...usageLines("every conversation", home),
          ],
        })
        return undefined
      }),
    tasks: () => {
      let graph: TaskGraph | undefined
      // The graph names conversations by number; the list says what a person knows each by.
      let known = new Map<number, ConversationInfo>()
      const draw = () => {
        if (graph !== undefined && untrack(panel)?.title === "TASKS")
          setPanel({ title: "TASKS", lines: taskLines(graph, known, conversation) })
      }
      const listAgain = client["conversation/list"]().pipe(
        Effect.tap((all) =>
          Effect.sync(() => {
            known = new Map(all.map((each) => [each.number, each]))
            draw()
          }),
        ),
        Effect.ignore,
      )
      // Each watch starts from the whole graph, so one that fell behind or lost the server is simply watched again.
      const shown = Effect.runSync(
        Effect.forkIn(
          client["tasks/watch"]().pipe(
            Stream.runForEach((item) =>
              Effect.suspend(() => {
                graph =
                  item._tag === "graph"
                    ? (item.graph as unknown as TaskGraph)
                    : (applyImmutable(graph, item.ops as ReadonlyArray<Op>) as TaskGraph)
                // A conversation started since the list was read, such as a new subagent, is listed again before
                // the graph is drawn, so the panel never shows it by number while its name is on the way.
                return Object.values(graph.tasks).every((task) => known.has(task.conversationId))
                  ? Effect.sync(draw)
                  : listAgain
              }),
            ),
            Effect.retry({ schedule: Schedule.spaced(REWATCH_DELAY) }),
            Effect.ignore,
          ),
          scope,
        ),
      )
      setPanel({ title: "TASKS", lines: ["loading"] })
      createRoot((dispose) =>
        createEffect(() => {
          if (panel()?.title === "TASKS") return
          Effect.runFork(Fiber.interrupt(shown))
          dispose()
        }),
      )
    },
  }

  yield* showUntilDone(
    () => {
      followSubagents()
      Effect.runFork(Effect.forkIn(relist, scope))
      createMemo((was: string) => {
        const now = status()
        if (now === "idle") setWorkingSince(undefined)
        else if (was === "idle") setWorkingSince(Date.now())
        return now
      }, "idle")
      return (
        <Shell
          screen={screen}
          setup={setup}
          actions={actions}
          transcript={() => <Transcript followed={root} tree={tree} />}
        />
      )
    },
    done,
    conversation,
    (opened) => (renderer = opened),
    () => next === undefined,
  )
  return next
})
