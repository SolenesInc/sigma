// Gemini through agy: a real server in process, driven as a raw JSON-RPC client, with agy played by the fake `agy`
// replaying a recorded `agy acp` process per spawn (fixtures/agy, recorded with Gemini 4 Hydrogen at low thinking).
import { expect, test } from "bun:test"
import type { EntryRecord, ProviderModels, ProviderSnapshot } from "@sigma/protocol"
import { FakeAgy } from "./support/agy.ts"
import { TestTargets } from "./support/targets.ts"
import { RawClient } from "./support/raw.ts"
import {
  person,
  runEnds,
  runningServer,
  settled,
  submit,
  transcript,
  type ViewWatch,
  watchView,
  type ServerOptions,
} from "./support/server.ts"

const MODEL = "gemini-4-hydrogen"

type Approvals = { requests: Record<string, { tool: string; arguments: Record<string, unknown> }> }
const approvalsOf = (watch: ViewWatch) => watch.view().docs["sigma.approvals"] as Approvals | undefined
const waitingApproval = async (watch: ViewWatch) => {
  await watch.until((current) => Object.keys(approvalsOf(current)?.requests ?? {}).length > 0)
  return Object.keys(approvalsOf(watch)!.requests)[0]!
}
const results = (entries: ReadonlyArray<EntryRecord>) =>
  entries
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => {
      const message = entry.model![0] as { content: Array<{ text?: string }>; isError: boolean; toolCallId: string }
      return {
        call: message.toolCallId,
        text: message.content.map((b) => b.text ?? "").join(""),
        isError: message.isError,
      }
    })
const calls = (entries: ReadonlyArray<EntryRecord>) =>
  entries.flatMap((entry) =>
    entry.kind === "pi.assistant"
      ? (
          entry.model![0] as { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }
        ).content
          .filter((block) => block.type === "toolCall")
          .map((block) => ({ id: block.id!, name: block.name!, arguments: block.arguments }))
      : [],
  )
const usageOf = (watch: ViewWatch) =>
  watch.view().docs["pi.usage"] as { models?: Record<string, { input: number; output: number; cacheRead: number }> }

const conversationWith = async (agy: FakeAgy, ask: Record<string, string> = {}, options: ServerOptions = {}) => {
  let server = await runningServer([], { ...options, agy: agy.options })
  let client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", {
      author: person("ada"),
      cwd: server.home.dir,
      provider: "agy",
      model: MODEL,
      effort: "low",
      approvals: "ask",
      ...ask,
    })
  ).result.conversation as string
  let view = watchView(client, conversation)
  await view.until(() => true)
  return {
    get server() {
      return server
    },
    get client() {
      return client
    },
    conversation,
    get view() {
      return view
    },
    submit: (text: string, steer = false) =>
      submit(client, conversation, text, crypto.randomUUID(), person("ada"), steer),
    answer: async (allow: boolean) => {
      const approval = await waitingApproval(view)
      await client.call("approval/resolve", { conversation, approval, author: person("ada"), allow })
    },
    /** Stops the server and starts another on the same home, as a person's restart does. */
    restart: async () => {
      client.close()
      await server.stop()
      server = await runningServer([], { ...options, agy: agy.options, home: server.home })
      client = await RawClient.connect(server.home.socket)
      view = watchView(client, conversation)
      await view.until(() => true)
    },
    [Symbol.asyncDispose]: async () => {
      client.close()
      await server[Symbol.asyncDispose]()
    },
  }
}

test("gemini-answer, provider-agy: Gemini's answer through agy is committed as sigma's message, with what the turn spent", async () => {
  using agy = new FakeAgy("text")
  await using session = await conversationWith(agy)
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(1))
  expect(transcript(session.view.view().entries)).toEqual([
    "user: Reply with exactly: fixture text ok",
    "assistant: fixture text ok",
    "run_end: answered",
  ])
  expect(agy.prompts()).toEqual(["Reply with exactly: fixture text ok"])
  // The recorded result's usage: 9601 input and 33 output tokens.
  expect(usageOf(session.view).models?.[`agy/${MODEL}`]).toMatchObject({ input: 9601, output: 33, cacheRead: 0 })
  // The session opened with the conversation's model and thinking level, and sigma's Stop hook beside it.
  const [opened] = agy.received("session/new")
  expect(opened.params.additionalDirectories).toHaveLength(1)
  expect(opened.params.mcpServers).toEqual([])
  expect(agy.received("session/set_config_option").map((frame) => [frame.params.configId, frame.params.value])).toEqual(
    [
      ["model", MODEL],
      ["thought_level", "low"],
    ],
  )
})

const reportsOf = (entries: ReadonlyArray<EntryRecord>) =>
  entries.filter((entry) => entry.kind === "hosted.report").map((entry) => entry.data)
const jobsOf = (watch: ViewWatch) =>
  Object.values((watch.view().docs["hosted.jobs"] as { jobs: Record<string, object> } | undefined)?.jobs ?? {})

test("gemini-approval: a command Gemini wants to run waits for a person, showing the command, and agy hears the allow", async () => {
  using agy = new FakeAgy("approval_allowed")
  await using session = await conversationWith(agy)
  await session.submit("Run the shell command `touch allowed.txt`, then reply with exactly: touched")
  const approval = await waitingApproval(session.view)
  expect(approvalsOf(session.view)!.requests[approval]).toMatchObject({
    tool: "run_command",
    arguments: expect.objectContaining({ CommandLine: "touch allowed.txt" }),
  })
  await session.answer(true)
  await session.view.until(settled(1))
  const [call] = calls(session.view.seen())
  expect(call).toMatchObject({ name: "run_command" })
  expect(results(session.view.seen())).toEqual([
    { call: call!.id, text: expect.stringContaining("Created At"), isError: false },
  ])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: touched", "run_end: answered"])
  expect(agy.received().filter((frame) => frame.method === undefined)).toEqual([
    expect.objectContaining({ result: { outcome: { outcome: "selected", optionId: "allow" } } }),
  ])
})

test("gemini-deny: a denied call's result says the person did not allow it, and the run ends with no answer", async () => {
  using agy = new FakeAgy("approval_denied")
  await using session = await conversationWith(agy)
  await session.submit("Run the shell command `touch denied.txt`, then reply with exactly: touched")
  await session.answer(false)
  await session.view.until(settled(1))
  const [call] = calls(session.view.seen())
  expect(results(session.view.seen())).toEqual([
    { call: call!.id, text: "the person did not allow this call", isError: true },
  ])
  expect(transcript(session.view.seen()).at(-1)).toBe("run_end: answered")
  expect(transcript(session.view.seen()).filter((line) => line.startsWith("assistant: touched"))).toEqual([])
  expect(agy.received().filter((frame) => frame.method === undefined)).toEqual([
    expect.objectContaining({ result: { outcome: { outcome: "selected", optionId: "deny" } } }),
  ])
})

test("gemini-steer: a steer sent while Gemini works reaches agy in the same run", async () => {
  using agy = new FakeAgy("steer")
  await using session = await conversationWith(agy)
  await session.submit("Run the shell command `touch steered.txt`, then reply with exactly: done")
  await waitingApproval(session.view)
  await session.submit("Also end your reply with the word BANANA.", true)
  await session.answer(true)
  await session.view.until(settled(1))
  expect(agy.prompts()).toEqual([
    "Run the shell command `touch steered.txt`, then reply with exactly: done",
    "Also end your reply with the word BANANA.",
  ])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: done\n\nBANANA", "run_end: answered"])
  expect(runEnds(session.view.seen())).toHaveLength(1)
})

test("gemini-interrupt: stopping a run cancels agy's turn, and the same process takes the next prompt", async () => {
  using agy = new FakeAgy("interrupt")
  await using session = await conversationWith(agy)
  await session.submit("Write a 600-word essay about rivers.")
  await session.view.until(
    (watch) => (watch.view().docs["pi.live"] as { generation?: object } | undefined)?.generation !== undefined,
  )
  await session.client.call("conversation/interrupt", { author: person("ada"), conversation: session.conversation })
  await session.view.until(settled(1))
  expect(runEnds(session.view.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
  expect(agy.received("session/cancel")).toHaveLength(1)

  await session.submit("Reply with exactly: after the stop")
  await session.view.until(settled(2))
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: after the stop", "run_end: answered"])
  expect(agy.spawns()).toBe(1)
})

test("gemini-resume: after a restart a new agy process loads the session, sets the model again, and is told only the new prompt", async () => {
  using agy = new FakeAgy("restart")
  await using session = await conversationWith(agy)
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
  await session.restart()
  await session.submit("Which word did I ask you to remember? Reply with that word only.")
  await session.view.until(settled(2))
  const [opened] = agy.received("session/new")
  const [loaded] = agy.received("session/load")
  expect(loaded).toMatchObject({ spawn: 1, params: { sessionId: opened.result?.sessionId ?? expect.any(String) } })
  expect(agy.received("session/set_config_option").filter((frame) => frame.spawn === 1)).toHaveLength(2)
  expect(agy.prompts()).toEqual([
    "Remember the word PLUM. Reply with exactly: noted",
    "Which word did I ask you to remember? Reply with that word only.",
  ])
  // The load's replay of the first turn is not committed again.
  expect(transcript(session.view.seen())).toEqual([
    "user: Remember the word PLUM. Reply with exactly: noted",
    "assistant: noted",
    "run_end: answered",
    "user: Which word did I ask you to remember? Reply with that word only.",
    "assistant: PLUM",
    "run_end: answered",
  ])
})

test("gemini-job: a command still running at agy's turn-over is a job; its end is a report, and Gemini's answer comes in a wake run", async () => {
  using agy = new FakeAgy("background_wake")
  await using session = await conversationWith(agy, { approvals: "auto" })
  await session.submit("Run the shell command `sleep 30; echo bg-marker` and tell me what it printed.")
  await session.view.until(settled(2))
  const told = transcript(session.view.seen())
  expect(told[0]).toBe("user: Run the shell command `sleep 30; echo bg-marker` and tell me what it printed.")
  expect(told.slice(-5)).toEqual([
    expect.stringMatching(/^assistant: I have started the command .* once it finishes\.$/s),
    "run_end: answered",
    expect.stringMatching(/^report: /),
    expect.stringMatching(/^assistant: .*bg-marker/s),
    "run_end: answered",
  ])
  const [call] = calls(session.view.seen())
  expect(results(session.view.seen())).toEqual([
    { call: call!.id, text: "still running in the background; its end comes as a report", isError: false },
  ])
  expect(reportsOf(session.view.seen())).toEqual([
    expect.objectContaining({ kind: "command", call: call!.id, status: "done" }),
  ])
  // agy went on past the call, so it was a job from there: its result comes before the holding message, the first run's answer.
  const seen = session.view.seen()
  const result = seen.find((entry) => entry.kind === "pi.tool-result")!
  const [first] = runEnds(seen)
  const answer = seen.find((entry) => entry.id === (first as { answer?: number }).answer)!
  expect(transcript([answer])).toEqual([expect.stringMatching(/^assistant: I have started the command/)])
  expect(result.id).toBeLessThan(answer.id)
  expect(jobsOf(session.view)).toEqual([expect.objectContaining({ kind: "command", state: "done" })])
  // The wake run sent agy nothing.
  expect(agy.prompts()).toHaveLength(1)
})

test("gemini-wake: agy answering on its own after its turn, as for its subagent, wakes the conversation with no job's report", async () => {
  using agy = new FakeAgy("subagent_wake")
  await using session = await conversationWith(agy, { approvals: "auto" })
  await session.submit(
    "Use your invoke_subagent tool to start one subagent whose task is: reply with the single word plum. Do not wait for its answer; reply with exactly: started",
  )
  await session.view.until(settled(2))
  expect(transcript(session.view.seen()).slice(-5)).toEqual([
    "assistant: started",
    "run_end: answered",
    expect.stringMatching(/^report: .*continued on its own/),
    expect.stringMatching(/^assistant: .*replied: `plum`\.$/s),
    "run_end: answered",
  ])
  expect(agy.prompts()).toHaveLength(1)
})

test("gemini-health: agy says once that it is signed in, its version, and its models and levels, without asking Gemini anything", async () => {
  using agy = new FakeAgy("models")
  await using server = await runningServer([], { agy: agy.options })
  const client = await RawClient.connect(server.home.socket)
  const providers = (await client.call("providers/list", {})).result as Array<ProviderSnapshot>
  const models = (await client.call("models/list", {})).result as Array<ProviderModels>
  await client.call("providers/list", {})
  client.close()
  expect(providers.find((provider) => provider.id === "agy")).toMatchObject({
    driver: "agy",
    health: { status: "ready", version: "1.5.13" },
  })
  const listed = models.find((list) => list.provider === "agy")!
  expect(listed.models.find((model) => model.id === MODEL)).toMatchObject({
    efforts: expect.arrayContaining(["low", "high"]),
  })
  // One probe, which opened and closed a session and sent no prompt.
  expect(agy.log().filter((entry) => entry.argv && entry.probe !== undefined)).toHaveLength(1)
  expect(agy.log().some((entry) => entry.received?.method === "session/prompt")).toBe(false)
  expect(agy.spawns()).toBe(0)
})

test("gemini-remote: a Gemini conversation on a target is refused, saying agy's tools act only on the server's machine, and no agy starts", async () => {
  using targets = new TestTargets()
  using agy = new FakeAgy("text")
  const work = targets.add("box")
  await using session = await conversationWith(
    agy,
    { target: "box", cwd: work },
    {
      config: { target_connector: targets.connector },
    },
  )
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(1))
  expect(runEnds(session.view.seen())).toEqual([
    expect.objectContaining({
      outcome: "failed",
      message: expect.stringContaining("agy runs only on the server's machine"),
    }),
  ])
  expect(agy.spawns()).toBe(0)
})
