// The hosted process's rule for a harness's work outside a run, with no harness: a scripted adapter whose connection
// the test speaks for, over a Harness on real SQLite. No wire test can reach a second adapter yet, so these hold the
// rule every adapter shares, as Claude Code's provider tests hold its translation.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Scope } from "effect"
import { type EntryRecord, openSqliteStorage } from "@sigma/kernel"
import { fromProviders } from "@sigma/models"
import {
  approveAutomatically,
  type Conversation,
  createRegistry,
  defineExtension,
  type Harness,
  openHarness,
} from "@sigma/harness"
import {
  type Adapter,
  type Connection,
  type Frame,
  type Host,
  hostedRunTasks,
  Inbox,
  JobsDoc,
  makeHostedProcesses,
  REPORT_KIND,
  type Said,
} from "../src/index.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One scripted harness process: the test says its frames and reads what it was sent. */
type Scripted = {
  readonly host: Host
  /**
   * Says frames, in order, as the harness would. The harness takes what it was sent before it says them, as Claude Code
   * replays a message it took.
   */
  readonly say: (...frames: Frame[]) => void
  /** Says frames before the harness took what it was sent: what it says of an earlier turn. */
  readonly sayBefore: (...frames: Frame[]) => void
  /** Everything the process was sent, in order. */
  readonly sent: Array<ReadonlyArray<Said>>
  /** Completes once the process was sent `count` messages. */
  readonly untilSent: (count: number) => Promise<void>
}

/** An adapter whose every process is scripted; `opened` lists them in the order they started. */
const scriptedAdapter = () => {
  const opened: Scripted[] = []
  let first: (scripted: Scripted) => void = () => {}
  const firstOpened = new Promise<Scripted>((resolve) => (first = resolve))
  const adapter: Adapter<{}> = {
    kind: "scripted.run",
    name: "Scripted",
    api: "scripted",
    settings: (provider) => (provider === "scripted" ? {} : undefined),
    open: (_config, start, host) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const said = new Inbox<Frame>()
          const sent: Array<ReadonlyArray<Said>> = []
          /** How many of the messages sent the harness took. */
          let took = 0
          const sends: Array<{ readonly count: number; readonly resolve: () => void }> = []
          const scripted: Scripted = {
            host,
            say: (...frames) => {
              for (; took < sent.length; took++) said.push({ type: "took", id: String(took) })
              frames.forEach((frame) => said.push(frame))
            },
            sayBefore: (...frames) => frames.forEach((frame) => said.push(frame)),
            sent,
            untilSent: (count) =>
              sent.length >= count ? Promise.resolve() : new Promise((resolve) => sends.push({ count, resolve })),
          }
          opened.push(scripted)
          first(scripted)
          const connection: Connection = {
            frames: said,
            session: start.session,
            holdsPosition: true,
            send: (message) => {
              sent.push(message)
              for (const waiting of sends.filter(({ count }) => sent.length >= count)) {
                sends.splice(sends.indexOf(waiting), 1)
                waiting.resolve()
              }
              return String(sent.length - 1)
            },
            canSelect: () => true,
            select: () => Effect.void,
            interrupt: async () => said.push({ type: "idle" }),
            stopJob: async (job) => said.push({ type: "job-ended", id: job, status: "stopped" }),
            lastRequest: undefined,
          }
          return { connection, said }
        }),
        ({ said }) => Effect.sync(() => said.close()),
      ).pipe(Effect.map(({ connection }) => connection)),
  }
  return { adapter, opened, firstOpened }
}

/** A Harness running conversations on a scripted adapter, whose wakes submit reports as sigma's server does. */
const open = () =>
  Effect.gen(function* () {
    const dir = mkdtempSync("/tmp/sigma-hosted-")
    dirs.push(dir)
    const scripted = scriptedAdapter()
    const registry = createRegistry()
    let harness: Harness | undefined
    const processes = yield* makeHostedProcesses({
      wake: (conversation, reports) =>
        Effect.flatMap(harness!.conversation(conversation), (handle) =>
          Effect.forEach(
            reports,
            (report) =>
              handle === undefined
                ? Effect.void
                : handle.submit({
                    type: "input",
                    content: report.text,
                    whenBusy: "steer",
                    entry: { kind: REPORT_KIND, ...(report.data === undefined ? {} : { data: report.data }) },
                  }),
            { discard: true },
          ),
        ),
    })
    const tasks = hostedRunTasks({
      adapters: [scripted.adapter],
      processes,
      remoteHands: {
        folder: () => Effect.die("no target"),
        notice: () => Effect.succeed(undefined),
        retell: () => undefined,
      },
    })
    registry.install(defineExtension({ name: "scripted", tasks: tasks.tasks }))
    harness = yield* Effect.acquireRelease(
      Effect.flatMap(openSqliteStorage(join(dir, "kernel.sqlite")), (storage) =>
        openHarness(storage, {
          registry,
          models: fromProviders([]),
          runTasks: tasks.runTasks,
          // Each run's end as an entry, where sigma's server records its own, so a transcript shows where runs end.
          runEnded: (tx, ended) =>
            Effect.asVoid(tx.appendEntry(ended.conversationId, { kind: RUN_END, data: { status: ended.end.status } })),
        }),
      ),
      (harness) => Effect.ignore(harness.close),
    )
    const conversation = yield* harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "scripted", modelId: "" }, cwd: dir },
      init: (tx, created) => approveAutomatically(tx, created),
    })
    return { harness, conversation, opened: scripted.opened, firstOpened: scripted.firstOpened }
  })

const RUN_END = "test.run_end"

const entries = (conversation: Conversation) =>
  Effect.map(conversation.entries({ order: "ascending" }, 1000), (page) => page.items)

/** The transcript as lines: who said what, each report with its job, and each run's end. */
const lines = (all: ReadonlyArray<EntryRecord>) =>
  all.flatMap((entry): string[] => {
    const message = entry.model?.[0] as any
    if (entry.kind === REPORT_KIND) {
      const job = (entry.data as { job?: string } | undefined)?.job
      return [`report${job === undefined ? "" : ` ${job}`}: ${message.content}`]
    }
    if (entry.kind === RUN_END) return ["run_end"]
    if (message?.role === "toolResult") return [`result: ${message.content.map((part: any) => part.text).join("")}`]
    if (message?.role === "user") return [`user: ${typeof message.content === "string" ? message.content : ""}`]
    if (message?.role === "assistant") {
      return message.content.map((part: any) =>
        part.type === "toolCall" ? `call ${part.name}` : `assistant: ${part.text}`,
      )
    }
    return []
  })

const said = (text: string, response: string): Frame => ({
  type: "said",
  response,
  content: [{ type: "text", text }],
})
const answered: Frame = { type: "answered", turnLimit: false }
const idle: Frame = { type: "idle" }
const command = (id: string): Frame => ({
  type: "job",
  id,
  call: `call-${id}`,
  kind: "command",
  title: `sleep ${id}`,
  background: true,
})

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

type Opened = { readonly opened: Scripted[]; readonly firstOpened: Promise<Scripted> }

/** A run on `prompt` that the harness answers with `frames`, as the process it got sends them. */
const ask = (scripted: Opened, conversation: Conversation, prompt: string, ...frames: Frame[]) =>
  Effect.gen(function* () {
    const before = scripted.opened.at(-1)?.sent.length ?? 0
    yield* conversation.submit({ type: "input", content: prompt })
    const process = yield* Effect.promise(() => scripted.firstOpened)
    yield* Effect.promise(() => process.untilSent(before + 1))
    process.say(...frames)
    yield* conversation.waitForIdle
    return process
  })

/** Completes once a run serves the process's turn: the main loop's callbacks wait for that run (F10). */
const served = (process: Scripted) => Effect.promise(() => process.host.callbacks(undefined))

test("hosted-outside-a-run: a job that outlives its run reports in a wake run, which sends the harness nothing", async () => {
  await run(
    Effect.gen(function* () {
      const scripted = yield* open()
      const { harness, conversation, opened } = scripted
      const process = yield* ask(
        scripted,
        conversation,
        "start it",
        said("started", "r1"),
        command("j1"),
        answered,
        idle,
      )
      const jobs = Object.values((yield* harness.session.snapshot(JobsDoc, conversation.id))?.jobs ?? {})
      expect(jobs.map((job) => [job.task, job.state])).toEqual([["j1", "working"]])

      process.say({ type: "job-ended", id: "j1", status: "completed", summary: "slept" }, { type: "woke" })
      yield* served(process)
      process.say(said("it slept", "r2"), answered, idle)
      yield* conversation.waitForIdle

      expect(lines(yield* entries(conversation))).toEqual([
        "user: start it",
        "assistant: started",
        "run_end",
        "report j1: slept",
        "assistant: it slept",
        "run_end",
      ])
      expect(process.sent.length).toBe(1)
      expect(opened.length).toBe(1)
      const ended = Object.values((yield* harness.session.snapshot(JobsDoc, conversation.id))?.jobs ?? {})
      expect(ended.map((job) => [job.task, job.state])).toEqual([["j1", "done"]])
    }),
  )
})

test("hosted-outside-a-run: a job that ends while its run serves reports in that run, before its answer", async () => {
  await run(
    Effect.gen(function* () {
      const scripted = yield* open()
      const { conversation } = scripted
      yield* ask(
        scripted,
        conversation,
        "start it",
        command("j1"),
        { type: "job-ended", id: "j1", status: "completed", summary: "slept" },
        said("it slept", "r1"),
        answered,
        idle,
      )
      expect(lines(yield* entries(conversation))).toEqual([
        "user: start it",
        "report j1: slept",
        "assistant: it slept",
        "run_end",
      ])
    }),
  )
})

test("hosted-outside-a-run: a wake with no job's end before it is committed as the harness continuing on its own", async () => {
  await run(
    Effect.gen(function* () {
      const scripted = yield* open()
      const { conversation } = scripted
      const process = yield* ask(scripted, conversation, "hello", said("hi", "r1"), answered, idle)
      process.say({ type: "woke" })
      yield* served(process)
      process.say(said("a wakeup", "r2"), answered, idle)
      yield* conversation.waitForIdle
      const all = yield* entries(conversation)
      expect(lines(all)).toEqual([
        "user: hello",
        "assistant: hi",
        "run_end",
        "report: Scripted continued on its own.",
        "assistant: a wakeup",
        "run_end",
      ])
      expect(all.find((entry) => entry.kind === REPORT_KIND)!.data).toBeUndefined()
      expect(process.sent.length).toBe(1)
    }),
  )
})

test("hosted-outside-a-run: a run ends when the harness's turn is over, not at an answer the turn goes on past", async () => {
  await run(
    Effect.gen(function* () {
      const scripted = yield* open()
      const { conversation } = scripted
      yield* ask(
        scripted,
        conversation,
        "go",
        said("first", "r1"),
        answered,
        { type: "began" },
        said("second", "r2"),
        answered,
        idle,
      )
      expect(lines(yield* entries(conversation))).toEqual([
        "user: go",
        "assistant: first",
        "assistant: second",
        "run_end",
      ])
    }),
  )
})

test("hosted-outside-a-run: a call the harness makes in a turn it began by itself waits for the wake run, and is committed in it", async () => {
  await run(
    Effect.gen(function* () {
      const scripted = yield* open()
      const { conversation } = scripted
      const process = yield* ask(scripted, conversation, "start it", command("j1"), answered, idle)
      process.say({ type: "job-ended", id: "j1", status: "completed", summary: "slept" }, { type: "woke" })
      // Asked before any run serves the wake: it resolves with the wake run's callbacks.
      const callbacks = process.host.callbacks(undefined)
      const call = { type: "toolCall" as const, id: "call-read", name: "read", arguments: { path: "a" } }
      process.say({ type: "said", response: "r2", content: [call] })
      yield* Effect.promise(async () => (await callbacks).beforeRun(call))
      process.say(
        { type: "results", results: [{ call: "call-read", text: "contents", isError: false }] },
        said("read it", "r3"),
        answered,
        idle,
      )
      yield* conversation.waitForIdle
      expect(lines(yield* entries(conversation))).toEqual([
        "user: start it",
        "run_end",
        "report j1: slept",
        "call read",
        "result: contents",
        "assistant: read it",
        "run_end",
      ])
    }),
  )
})

test("hosted-outside-a-run: a job a wake turn starts and ends before the wake run attaches is still hosted, ends, and reports", async () => {
  await run(
    Effect.gen(function* () {
      const scripted = yield* open()
      const { harness, conversation } = scripted
      const process = yield* ask(scripted, conversation, "start it", command("j1"), answered, idle)
      // Said at once, before any run attaches: the wake run takes them held.
      process.say(
        { type: "job-ended", id: "j1", status: "completed", summary: "slept" },
        { type: "woke" },
        command("j2"),
        { type: "job-ended", id: "j2", status: "completed", summary: "slept again" },
        said("both slept", "r2"),
        answered,
        idle,
      )
      yield* Effect.promise(() => process.host.callbacks(undefined))
      yield* conversation.waitForIdle
      expect(lines(yield* entries(conversation))).toEqual([
        "user: start it",
        "run_end",
        "report j1: slept",
        "report j2: slept again",
        "assistant: both slept",
        "run_end",
      ])
      const jobs = Object.values((yield* harness.session.snapshot(JobsDoc, conversation.id))?.jobs ?? {})
      expect(jobs.map((job) => [job.task, job.state])).toEqual([
        ["j1", "done"],
        ["j2", "done"],
      ])
    }),
  )
})

test("hosted-outside-a-run: a turn-over the harness said before it took a run's prompt does not end that run", async () => {
  await run(
    Effect.gen(function* () {
      const scripted = yield* open()
      const { conversation } = scripted
      const process = yield* ask(scripted, conversation, "hello", said("hi", "r1"), answered, idle)
      // A turn of its own that no run serves and that wakes nothing, as when a prompt wins the race with its wake: held
      // until the next run, which has sent its prompt by the time it takes them.
      process.sayBefore(said("on its own", "r2"), answered, idle)
      yield* ask(scripted, conversation, "again", said("hi again", "r3"), answered, idle)
      expect(lines(yield* entries(conversation))).toEqual([
        "user: hello",
        "assistant: hi",
        "run_end",
        "user: again",
        "assistant: on its own",
        "assistant: hi again",
        "run_end",
      ])
    }),
  )
})
