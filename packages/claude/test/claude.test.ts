// claude.run through the harness's own seams: a Harness over real SQLite running Claude conversations, with Claude Code
// played by sigma's fake `claude` replaying a recorded process per spawn. These cover what the wire cannot reach yet,
// such as forks.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Scope } from "effect"
import { type EntryRecord, openSqliteStorage } from "@sigma/kernel"
import { fromProviders } from "@sigma/models"
import {
  AssistantEntry,
  approveAutomatically,
  type Conversation,
  createRegistry,
  defineExtension,
  type Extension,
  type Harness,
  openHarness,
  ResetEntry,
  UsageDoc,
  UserEntry,
} from "@sigma/harness"
import { type HostedProcessesOptions, type HostedRunOptions, hostedRunTasks, makeHostedProcesses } from "@sigma/hosted"
import { claudeAdapter } from "../src/index.ts"

const FIXTURES = join(import.meta.dir, "../../../fixtures/claude")
const FAKE = join(import.meta.dir, "../../sigma/test/support/fake-claude")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake Claude Code playing the fixtures' processes one per spawn, in order, and what it logged. */
const fake = (...fixtures: [string, ...string[]]) => {
  const dir = mkdtempSync("/tmp/sigma-claude-")
  dirs.push(dir)
  const played = join(dir, "fixture.ndjson")
  writeFileSync(played, fixtures.map((fixture) => readFileSync(join(FIXTURES, `${fixture}.ndjson`), "utf8")).join("\n"))
  return {
    dir,
    settings: {
      executable: FAKE,
      env: { FAKE_CLAUDE_FIXTURE: played, FAKE_CLAUDE_DIR: dir },
    },
    log: (): Array<any> =>
      readFileSync(join(dir, "log.ndjson"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
  }
}

type Fake = ReturnType<typeof fake>

const spawns = (claude: Fake) =>
  claude
    .log()
    .filter((entry) => entry.argv && entry.probe === undefined)
    .map((entry) => entry.argv as string[])

/** A Harness running Claude conversations on `claude`, closed with the scope. */
const open = (
  claude: Fake,
  reports: Array<unknown> = [],
  processes: HostedProcessesOptions = {},
  extensions: ReadonlyArray<Extension> = [],
  offered?: HostedRunOptions["offered"],
) =>
  Effect.gen(function* () {
    // The fake writes the conversation's directory into its recorded paths as given; on macOS /tmp is /private/tmp.
    const dir = realpathSync(mkdtempSync("/tmp/sigma-harness-"))
    dirs.push(dir)
    const registry = createRegistry()
    const tasks = hostedRunTasks({
      adapters: [claudeAdapter((provider) => (provider === "claude" ? claude.settings : undefined))],
      processes: yield* makeHostedProcesses(processes),
      ...(offered === undefined ? {} : { offered }),
      // These conversations are all local, so none runs with remote hands.
      rootConversation: (conversation) => Effect.succeed(String(conversation)),
      remoteHands: {
        cwd: () => Effect.die("no target"),
        notice: () => Effect.succeed(undefined),
        retell: () => undefined,
      },
    })
    registry.install(defineExtension({ name: "claude", tasks: tasks.tasks }))
    for (const extension of extensions) registry.install(extension)
    const harness = yield* Effect.acquireRelease(
      Effect.flatMap(openSqliteStorage(join(dir, "kernel.sqlite")), (storage) =>
        openHarness(storage, {
          registry,
          models: fromProviders([]),
          runTasks: tasks.runTasks,
          onReport: (report) => reports.push(report),
        }),
      ),
      (harness) => Effect.ignore(harness.close),
    )
    return { harness, cwd: dir }
  })

/** A Claude conversation whose calls run without asking: the fake answers whatever it is told. */
const start = (harness: Harness, cwd: string) =>
  harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { model: { provider: "claude", modelId: "" }, cwd },
    init: (tx, created) => approveAutomatically(tx, created),
  })

const ask = (conversation: Conversation, text: string) =>
  Effect.andThen(conversation.submit({ type: "input", content: text }), conversation.waitForIdle)

const entries = (conversation: Conversation) =>
  Effect.map(conversation.entries({ order: "ascending" }, 1000), (page) => page.items)

const said = (all: ReadonlyArray<EntryRecord>) =>
  all.flatMap((entry) =>
    (entry.model ?? []).flatMap((message: any) => {
      if (message.role === "toolResult")
        return [
          `result ${message.toolName}: ${message.content.map((part: any) => part.text).join("")}${message.isError ? " (error)" : ""}`,
        ]
      if (message.role === "assistant")
        return message.content.map((part: any) =>
          part.type === "toolCall" ? `call ${part.name} ${JSON.stringify(part.arguments)}` : `assistant: ${part.text}`,
        )
      return [`user: ${typeof message.content === "string" ? message.content : ""}`]
    }),
  )

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

test("image-input: an image in a prompt reaches Claude Code beside its text", async () => {
  const claude = fake("text")
  const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" }
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude)
      const conversation = yield* start(harness, cwd)
      yield* conversation.submit({ type: "input", content: [{ type: "text", text: "what is this" }, image] })
      yield* conversation.waitForIdle
    }),
  )
  const sent = claude.log().find((entry) => entry.received?.type === "user")!.received.message.content
  expect(sent).toEqual([
    { type: "text", text: "what is this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ])
})

test("claude-offered-sections: Claude Code's system prompt gets the sections of the extensions it is offered, before the instructions, and no others", async () => {
  const claude = fake("text")
  const offered = defineExtension({
    name: "offered",
    sections: [{ key: "workers", render: () => Effect.succeed("Workers are agents of their own.") }],
  })
  const other = defineExtension({
    name: "other",
    sections: [{ key: "elsewhere", render: () => Effect.succeed("Not for Claude Code.") }],
  })
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [], {}, [offered, other], (agent) =>
        agent.extensions.filter((extension) => extension.name === "offered"),
      )
      const conversation = yield* harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "claude", modelId: "" }, cwd, instructions: "Report with attn when done." },
        init: (tx, created) => approveAutomatically(tx, created),
      })
      yield* ask(conversation, "Reply with exactly: fixture text ok")
    }),
  )
  const initialize = claude.log().find((entry) => entry.initialize)?.initialize
  expect(initialize.systemPrompt).toBeUndefined()
  expect(initialize.appendSystemPrompt).toBe(
    "<workers>\nWorkers are agents of their own.\n</workers>\n\nReport with attn when done.",
  )
})

test("claude-live, claude-resume: an edit to the context closes the live process and starts a fresh session told the edited conversation", async () => {
  const claude = fake("text", "text")
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude)
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "a secret to forget")
      const first = (yield* entries(conversation)).find((entry) => entry.kind === UserEntry.kind)!
      yield* conversation.submit({
        type: "write",
        entry: { kind: "test.forget", edits: [{ target: first.id, action: "omit" }] },
      })
      yield* ask(conversation, "Reply with exactly: fixture text ok")
    }),
  )
  const [before, after] = spawns(claude)
  expect(after!.some((arg) => arg.startsWith("--resume"))).toBe(false)
  expect(after!.find((arg) => arg.startsWith("--session-id"))).not.toBe(
    before!.find((arg) => arg.startsWith("--session-id")),
  )
  const told = claude
    .log()
    .filter((entry) => entry.received?.type === "user" && entry.spawn === 1)
    .flatMap((entry) => entry.received.message.content.map((part: { text: string }) => part.text))
  expect(told.join("\n")).not.toContain("a secret to forget")
  expect(told.at(-1)).toBe("Reply with exactly: fixture text ok")
})

test("claude-live: a reset between runs closes the live process, and the next run starts a fresh session", async () => {
  const claude = fake("text", "text")
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude)
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "a secret to forget")
      yield* conversation.submit({
        type: "write",
        entry: { kind: ResetEntry.kind, head: "self", model: [{ role: "user", content: "start over", timestamp: 0 }] },
      })
      yield* ask(conversation, "Reply with exactly: fixture text ok")
    }),
  )
  const [before, after] = spawns(claude)
  expect(after!.some((arg) => arg.startsWith("--resume"))).toBe(false)
  expect(after!.find((arg) => arg.startsWith("--session-id"))).not.toBe(
    before!.find((arg) => arg.startsWith("--session-id")),
  )
  const told = claude
    .log()
    .filter((entry) => entry.received?.type === "user" && entry.spawn === 1)
    .flatMap((entry) => entry.received.message.content.map((part: { text: string }) => part.text))
  expect(told).toEqual(["start over", "Reply with exactly: fixture text ok"])
})

test("claude-read: parallel calls of one response are each committed with the result Claude Code returned", async () => {
  const claude = fake("parallel_reads_hooked")
  const all = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude)
      const conversation = yield* start(harness, cwd)
      yield* ask(
        conversation,
        "In a single message, call the Read tool twice in parallel: once on a.txt and once on b.txt. Then reply with both contents, separated by a comma.",
      )
      const context = yield* conversation.context()
      return { cwd, entries: yield* entries(conversation), context: context.messages.map((message) => message.role) }
    }),
  )
  // Each call is committed with the arguments Claude Code ran it with, which it made absolute, not as the model wrote it.
  // Each is committed by its own PreToolUse hook, and Claude Code runs the hooks of parallel calls at once, so the two
  // can commit in either order.
  expect(
    said(all.entries)
      .filter((line) => line.startsWith("call"))
      .sort(),
  ).toEqual([
    `call Read ${JSON.stringify({ file_path: join(all.cwd, "a.txt") })}`,
    `call Read ${JSON.stringify({ file_path: join(all.cwd, "b.txt") })}`,
  ])
  expect(said(all.entries).filter((line) => line.startsWith("result"))).toEqual([
    "result Read: 1\tapple\n2\t",
    "result Read: 1\tbanana\n2\t",
  ])
  // One response: both calls, then both results, in the model context.
  expect(all.context).toEqual(["user", "assistant", "assistant", "toolResult", "toolResult", "assistant"])
})

test("claude-resume: a fork of a Claude conversation forks Claude Code's session at the fork's position", async () => {
  const claude = fake("died_while_idle")
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude)
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "Remember the word PLUM. Reply with exactly: noted")
      const [last] = (yield* conversation.entries({}, 1)).items
      const fork = yield* conversation.fork(last!.id, { ownership: { kind: "ownerless" } })
      yield* ask(fork, "Which word did I ask you to remember? Reply with that word only.")
    }),
  )
  const [first, second] = spawns(claude)
  const session = first!.find((arg) => arg.startsWith("--session-id"))!.split("=")[1]
  expect(second).toContain(`--resume=${session}`)
  expect(second).toContain("--fork-session")
  expect(second!.find((arg) => arg.startsWith("--session-id"))).not.toBe(`--session-id=${session}`)
})

test("claude-resume: what each run spent is added to the conversation's usage, once, when each run starts its own process", async () => {
  const claude = fake("died_while_idle")
  const usage = await run(
    Effect.gen(function* () {
      // No live process: the recording's two runs each started one.
      const { harness, cwd } = yield* open(claude, [], { idle: 0 })
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "Remember the word PLUM. Reply with exactly: noted")
      yield* ask(conversation, "Which word did I ask you to remember? Reply with that word only.")
      return (yield* harness.session.snapshot(UsageDoc, conversation.id))!.models
    }),
  )
  // Each process reports its own totals at its result: the two recorded results, added up.
  expect(usage["claude/claude-haiku-5-5"]).toMatchObject({
    input: 6,
    output: 14,
    cacheRead: 47_041,
    cacheWrite: 13_846,
    totalTokens: 60_907,
  })
  expect(usage["claude/claude-haiku-5-5"]!.cost.total).toBeCloseTo(0.00324721, 10)
})

/** Commits a turn another provider answered: the prompt, and its echo. */
const scripted = (conversation: Conversation, text: string) =>
  conversation.commit((tx) =>
    Effect.gen(function* () {
      yield* tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: text, timestamp: 0 }] })
      const answer = {
        role: "assistant",
        content: [{ type: "text", text: `You said: ${text}` }],
        api: "script",
        provider: "script",
        model: "script",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      }
      yield* tx.appendEntry(AssistantEntry, conversation.id, { model: [answer as never] })
    }),
  )

test("claude-switch, claude-live: switching to Claude from another provider retells the conversation to a new Claude Code session", async () => {
  const claude = fake("handoff")
  const question = "Which word did I ask you to remember? Reply with just the word."
  const last = "What was the last thing I said before this message? Reply with just that word."
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude)
      const conversation = yield* harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "script", modelId: "script" }, cwd },
      })
      yield* scripted(conversation, "Remember the word lantern.")
      yield* scripted(conversation, "x".repeat(70_000))
      yield* scripted(conversation, "Nothing else for now.")
      yield* conversation.configure({ model: { provider: "claude", modelId: "haiku" } })
      yield* ask(conversation, question)
      yield* conversation.configure({ model: { provider: "script", modelId: "script" } })
      yield* scripted(conversation, "plum")
      yield* conversation.configure({ model: { provider: "claude", modelId: "haiku" } })
      yield* ask(conversation, last)
    }),
  )
  const told = (spawn: number) =>
    claude
      .log()
      .filter((entry) => entry.received?.type === "user" && entry.spawn === spawn)
      .map((entry) => entry.received.message.content.map((block: { text: string }) => block.text))
  const opening = [
    "This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.",
    "Remember the word lantern.",
    "(3 entries left out here)",
    "Nothing else for now.",
    "You answered: You said: Nothing else for now.",
  ]
  expect(told(0)).toEqual([[...opening, question]])
  expect(told(1)).toEqual([
    [...opening, question, "You answered: lantern", "plum", "You answered: You said: plum", last],
  ])
  const [first, second] = spawns(claude)
  expect(second!.some((arg) => arg.startsWith("--resume"))).toBe(false)
  expect(second!.find((arg) => arg.startsWith("--session-id"))).not.toBe(
    first!.find((arg) => arg.startsWith("--session-id")),
  )
})
