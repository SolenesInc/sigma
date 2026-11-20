// The wire: a real server in process, driven as a raw JSON-RPC client over its socket.
import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TestTargets } from "./support/targets.ts"
import type { ScriptStep } from "@sigma/models"
import { DEADLINE, deadline, errorTag, hangUpMidAnswer, RawClient, TEST_TIMEOUT } from "./support/raw.ts"
import {
  hold,
  idleGrace,
  stillServing,
  person,
  runEnds,
  runningServer,
  servingUntilIdle,
  settled,
  start,
  submit,
  transcript,
  type ViewWatch,
  waitClock,
  watchView,
  tempHome,
} from "./support/server.ts"
import { applyImmutable, type Op } from "@sigma/delta"
import { DEFAULT_MAX_BYTES } from "@sigma/env/truncate"
import { type EntryRecord, PROTOCOL_VERSION, RUN_END_KIND, USER_KIND, type View } from "@sigma/protocol"
import { VERSION } from "../src/version.ts"
import { ECHO_TOOL, FAKE_INSTRUCTIONS, FakeMcpServer, WAIT_TOOL } from "./support/mcp.ts"

setDefaultTimeout(TEST_TIMEOUT)

type Tree = { _tag: "tree"; conversation: string; seq: number; status: string; ended?: Record<string, string> }
type Trees = { _tag: "trees"; seq: number; trees: Array<Tree> } | Tree
const opened = (watch: ViewWatch) => watch.until(() => true)

/** The model has said something the view shows live, before the run ends. */
/** The answer's first words are committed: a held step is held there. */
const speaking = (watch: ViewWatch) => {
  const live = watch.view().docs["pi.live"] as
    | { generation?: { message?: { content?: Array<{ text?: string }> } } }
    | undefined
  return (live?.generation?.message?.content?.[0]?.text ?? "").length > 0
}

test("answer-wire, answer-shared: every client of a conversation sees the prompt, the answer and how the run ended", async () => {
  await using server = await runningServer([{ text: "hello ada" }])
  const ada = await RawClient.connect(server.home.socket)
  const grace = await RawClient.connect(server.home.socket)
  const conversation = await start(ada)
  const adaView = watchView(ada, conversation)
  const graceView = watchView(grace, conversation)
  await Promise.all([opened(adaView), opened(graceView)])
  await submit(ada, conversation, "hi")
  await adaView.until(settled(1))
  await graceView.until(settled(1))
  expect(transcript(adaView.view().entries)).toEqual(["user: hi", "assistant: hello ada", "run_end: answered"])
  const answer = adaView.view().entries.find((entry) => entry.kind === "pi.assistant")!.id
  expect(runEnds(adaView.view().entries)).toEqual([{ outcome: "answered", answer }])
  expect(graceView.view()).toEqual(adaView.view())
  ada.close()
  grace.close()
})

test("queue-idempotent: submitting again with the same request id is answered once", async () => {
  await using server = await runningServer([{ text: "once" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  const first = await submit(
    client,
    conversation,
    "hi",
    "request-1" as `${string}-${string}-${string}-${string}-${string}`,
  )
  const again = await submit(
    client,
    conversation,
    "hi",
    "request-1" as `${string}-${string}-${string}-${string}-${string}`,
  )
  expect(again.result).toEqual(first.result)
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual(["user: hi", "assistant: once", "run_end: answered"])
  client.close()
})

test("queue-run: prompts sent while sigma is working wait and run in order, each to its own end", async () => {
  using held = hold()
  await using server = await runningServer([{ text: "the first answer", hold: held.path }, { text: "second answer" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(speaking)
  await submit(client, conversation, "two")
  await view.until((watch) => (watch.view().docs["pi.inbox"] as { items: Array<unknown> }).items.length === 1)
  held.release()
  await view.until(settled(2))
  expect(transcript(view.view().entries)).toEqual([
    "user: one",
    "assistant: the first answer",
    "run_end: answered",
    "user: two",
    "assistant: second answer",
    "run_end: answered",
  ])
  client.close()
})

test("queue-run: a prompt sent while sigma works runs after the run fails, instead of waiting for another prompt", async () => {
  using held = hold()
  await using server = await runningServer([
    { text: "half an answer", hold: held.path, fail: "provider went away" },
    { text: "second answer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(speaking)
  await submit(client, conversation, "two")
  // Queued behind the run that is about to fail, not started after it.
  await view.until((watch) => (watch.view().docs["pi.inbox"] as { items: Array<unknown> }).items.length === 1)
  held.release()
  await view.until(settled(2))
  expect(transcript(view.view().entries)).toEqual([
    "user: one",
    "assistant: half an answer [error]",
    "run_end: failed (provider went away)",
    "user: two",
    "assistant: second answer",
    "run_end: answered",
  ])
  expect(view.view().docs["pi.inbox"]).toEqual({ items: [] })
  client.close()
})

test("interrupt-wire: interrupting keeps what sigma already said and marks the run interrupted", async () => {
  // Held until the interrupt ends it.
  using held = hold()
  await using server = await runningServer([{ text: "one two three four five six seven eight", hold: held.path }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "count")
  await view.until(speaking)
  expect(await client.call("conversation/interrupt", { author: person("ada"), conversation })).toMatchObject({
    result: { withdrawn: [] },
  })
  await view.until(settled(1))
  const said = transcript(view.view().entries)
  expect(said[0]).toBe("user: count")
  expect(said[1]).toMatch(/^assistant: one /)
  expect(said.slice(2)).toEqual(["run_end: interrupted (aborted)"])
  client.close()
})

test("interrupt-withdraw: interrupting withdraws the prompts that wait, and the transcript names each by its requestId", async () => {
  // Held until the interrupt ends it.
  using held = hold()
  await using server = await runningServer([{ text: "one two three four five six seven eight", hold: held.path }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "count")
  await view.until(speaking)
  await submit(client, conversation, "then this", "waiting-1")
  await submit(client, conversation, "and this", "waiting-2")
  await client.call("conversation/interrupt", { author: person("ada"), conversation })
  await view.until(settled(1))
  const said = transcript(view.view().entries)
  expect(said[0]).toBe("user: count")
  // The interrupt withdraws what waits before the run it stops ends.
  expect(said.slice(1).filter((line) => !line.startsWith("assistant"))).toEqual([
    "withdrawn: waiting-1",
    "withdrawn: waiting-2",
    "run_end: interrupted (aborted)",
  ])
  client.close()
})

test("interrupt-withdraw: the interrupt answers which prompts it withdrew, each with its id, requestId, author and text, oldest first", async () => {
  // Held until the interrupt ends it.
  using held = hold()
  await using server = await runningServer([{ text: "one two three four five six seven eight", hold: held.path }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "count")
  await view.until(speaking)
  const first = await submit(client, conversation, "then this", "waiting-1")
  const second = await submit(client, conversation, "and this", "waiting-2", person("bo"), true)
  const stopped = await client.call("conversation/interrupt", { author: person("ada"), conversation })
  expect(stopped).toMatchObject({
    result: {
      withdrawn: [
        { submission: first.result.submission, requestId: "waiting-1", author: person("ada"), text: "then this" },
        { submission: second.result.submission, requestId: "waiting-2", author: person("bo"), text: "and this" },
      ],
    },
  })
  // Interrupting again finds nothing waiting.
  await view.until(settled(1))
  expect(await client.call("conversation/interrupt", { author: person("ada"), conversation })).toMatchObject({
    result: { withdrawn: [] },
  })
  client.close()
})

test("answer-failed: a model failure is recorded after what was said and the conversation goes idle", async () => {
  await using server = await runningServer([{ text: "half", fail: "provider went away" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual([
    "user: hi",
    "assistant: half [error]",
    "run_end: failed (provider went away)",
  ])
  client.close()
})

test("wire-dropped: a client that stops reading is dropped while the others keep up", async () => {
  // A client that reads peaked at 34 queued changes with 100 prompts submitted at once; 200 prompts make about 600.
  const connectionQueue = 128
  const prompts = 200
  await using server = await runningServer(
    Array.from({ length: prompts }, () => ({ text: "ok" })),
    { connectionQueue },
  )
  const reader = await RawClient.connect(server.home.socket)
  const stalled = await RawClient.connect(server.home.socket, { ack: false })
  const conversation = await start(reader)
  const live = watchView(reader, conversation)
  const behind = watchView(stalled, conversation)
  await Promise.all([opened(live), opened(behind)])
  for (let batch = 0; batch < prompts / 100; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => submit(reader, conversation, `prompt ${batch}-${i}`)))
  }
  // Every run ends while the stalled client holds the server's queue full: its commits never waited for it.
  await live.until(settled(prompts))
  stalled.resumeAcks(behind.id)
  const dropped = await deadline(behind.ended, DEADLINE, "stalled client told it fell behind")
  expect(errorTag(dropped)).toBe("FellBehind")
  expect(behind.items).toHaveLength(1)
  reader.close()
  stalled.close()
})

test("wire-hangup: a client that hangs up while the server still writes to it is not logged as an error", async () => {
  await using server = await runningServer([{ text: "long ".repeat(5000) }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await opened(view)
  await submit(client, conversation, "go")
  await view.until(settled(1))
  await hangUpMidAnswer(server.home.socket, "conversation/watch", { conversation })
  await submit(client, conversation, "still here")
  await view.until(settled(2))
  client.close()
  await server.stop()
  expect(server.logged.filter((entry) => entry.level === "Error")).toEqual([])
})

test("wire-unknown: watching a conversation that does not exist says so", async () => {
  await using server = await runningServer()
  const client = await RawClient.connect(server.home.socket)
  for (const conversation of ["nope", "999"]) {
    const reply = await client.watch("conversation/watch", { conversation }).ended
    expect(errorTag(reply)).toBe("NoSuchConversation")
  }
  expect(errorTag(await submit(client, "999", "hi"))).toBe("NoSuchConversation")
  client.close()
})

test("server-idle-exit: the server exits once no client is connected and nothing is running", async () => {
  const home = tempHome()
  const grace = idleGrace()
  const served = await deadline(
    servingUntilIdle(home, "1 hour", [], { idleClock: grace.clock }),
    DEADLINE,
    "server listening",
  )
  const client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  await opened(watchView(client, conversation))
  client.close()
  grace.pass()
  await deadline(served.exited, DEADLINE, "server exit")
})

test("server-idle-exit: a submission's run keeps the server up after its client leaves, past the idle grace", async () => {
  const home = tempHome()
  const grace = idleGrace()
  using held = hold()
  const served = await deadline(
    servingUntilIdle(home, "1 hour", [{ text: "one two three four", hold: held.path }], { idleClock: grace.clock }),
    DEADLINE,
    "server listening",
  )
  let client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  // No watch: only the submission's run keeps the server up once the client goes.
  await submit(client, conversation, "count")
  client.close()
  grace.pass()
  await stillServing(home)
  held.release()
  await deadline(served.exited, DEADLINE, "server exit")

  // A server that went idle mid-run would have left no answer and no run_end.
  await using again = await runningServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(transcript(after.view().entries)).toEqual([
    "user: count",
    "assistant: one two three four",
    "run_end: answered",
  ])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
})

test("server-idle-exit, child-tools: a subagent's work keeps the server up after its client leaves, past the idle grace", async () => {
  const home = tempHome()
  const grace = idleGrace()
  using held = hold()
  const served = await deadline(
    servingUntilIdle(
      home,
      "1 hour",
      [
        call("start_worker", { task_name: "writer", message: "count", fork_turns: "none" }),
        { text: "spawned" },
        { text: "one two three four", hold: held.path, agent: "/root/writer" },
        { text: "heard it" },
      ],
      { idleClock: grace.clock },
    ),
    DEADLINE,
    "server listening",
  )
  let client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  await submit(client, conversation, "delegate")
  client.close()
  grace.pass()
  await stillServing(home)
  held.release()
  await deadline(served.exited, DEADLINE, "server exit")

  // A server that went idle while the subagent worked would have mailed nothing back to the parent.
  await using again = await runningServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(mails(after)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  expect(transcript(after.view().entries).slice(-2)).toEqual(["assistant: heard it", "run_end: answered"])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
})

test("server-stop, child-tools: stopping the server lets a working subagent finish and report first", async () => {
  const home = tempHome()
  using held = hold()
  const served = await deadline(
    servingUntilIdle(home, "1 hour", [
      call("start_worker", { task_name: "writer", message: "count", fork_turns: "none" }),
      { text: "spawned" },
      { text: "one two three four", hold: held.path, agent: "/root/writer" },
      { text: "heard it" },
    ]),
    DEADLINE,
    "server listening",
  )
  let client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate")
  await view.until(settled(1))
  const stopping = client.call("server/stop", null)
  await served.printed("sigma stopping once its runs settle")
  held.release()
  expect(await stopping).toMatchObject({ result: null })
  client.close()
  await deadline(served.exited, DEADLINE, "server exit")

  // A stop that cut the subagent off would have mailed nothing back to the parent.
  await using again = await runningServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(mails(after)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
})

test("server-stop: stopping the server answers the caller, then the server exits", async () => {
  const home = tempHome()
  const served = await deadline(servingUntilIdle(home, "1 hour"), DEADLINE, "server listening")
  const client = await RawClient.connect(home.socket)
  expect(await client.call("server/stop", null)).toMatchObject({ result: null })
  await deadline(served.exited, DEADLINE, "server exit")
  client.close()
})

test("wire-initialize: a client is answered with the server's version and the protocol", async () => {
  await using server = await runningServer()
  const client = await RawClient.connect(server.home.socket)
  const reply = await client.call("initialize", { client: "test", version: "0", protocol: PROTOCOL_VERSION })
  expect(reply.result).toEqual({ version: VERSION, protocol: PROTOCOL_VERSION, readOnly: false })
  client.close()
})

test("watch-rpc: a watch through a window opens on the newest entries, and from a position gets only what followed", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }, { text: "c" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const all = watchView(client, conversation)
  for (const [i, text] of ["one", "two", "three"].entries()) {
    await submit(client, conversation, text)
    await all.until(settled(i + 1))
  }
  const entries = all.view().entries
  const third = entries.findIndex((entry) => transcript([entry])[0] === "user: three")

  const newest = watchView(client, conversation, { min: 3, max: 6 })
  await newest.until(() => true)
  expect(transcript(newest.view().entries)).toEqual(["user: three", "assistant: c", "run_end: answered"])
  expect(newest.view().before).toBe(entries[third - 1]!.id)

  const resumed = watchView(client, conversation, { from: entries[3]!.id })
  await resumed.until(() => true)
  expect(resumed.view().entries.map((entry) => entry.id)).toEqual(entries.slice(3).map((entry) => entry.id))
  client.close()
})

test("watch-rpc: a window that is not one is refused by name, and the connection's other watches go on", async () => {
  await using server = await runningServer([{ text: "still here" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await opened(view)
  const refused = await client.watch("conversation/watch", { conversation, window: { min: 10, max: 5 } }).ended
  expect(errorTag(refused)).toBe("InvalidWindow")
  expect(JSON.stringify(refused.error)).toContain("Window max must be an integer >= min (10), got 5")
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual(["user: hi", "assistant: still here", "run_end: answered"])
  client.close()
})

test("server-stop: stopping the server while sigma answers lets the answer finish first", async () => {
  const home = tempHome()
  using held = hold()
  const served = await deadline(
    servingUntilIdle(home, "1 hour", [{ text: "one two three four", hold: held.path }]),
    DEADLINE,
    "server listening",
  )
  let client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "count")
  await view.until(speaking)
  const stopping = client.call("server/stop", null)
  await served.printed("sigma stopping once its runs settle")
  held.release()
  expect(await stopping).toMatchObject({ result: null })
  await deadline(served.exited, DEADLINE, "server exit")
  client.close()

  // What the stopped server committed, as a fresh server shows it: the whole answer, and its run's end.
  await using again = await runningServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(transcript(after.view().entries)).toEqual([
    "user: count",
    "assistant: one two three four",
    "run_end: answered",
  ])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
})

type Approvals = { auto?: true; requests: Record<string, { tool: string; answer?: unknown }> }
const approvalsOf = (watch: ViewWatch) => watch.view().docs["sigma.approvals"] as Approvals | undefined
const waitingApproval = async (watch: ViewWatch) => {
  await watch.until((current) => Object.keys(approvalsOf(current)?.requests ?? {}).length > 0)
  return Object.keys(approvalsOf(watch)!.requests)[0]!
}
const toolResults = (watch: ViewWatch) =>
  watch
    .seen()
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => {
      const message = entry.model![0] as { content: Array<{ text?: string }>; isError: boolean }
      return { text: message.content.map((block) => block.text ?? "").join(""), isError: message.isError }
    })
const ECHO = [{ text: "checking", tool: { name: "bash", input: { command: "echo approved" } } }, { text: "all done" }]

test("approval-wire: two clients answer one approval at once and the first answer counts", async () => {
  await using server = await runningServer(ECHO)
  const ada = await RawClient.connect(server.home.socket)
  const bo = await RawClient.connect(server.home.socket)
  const conversation = await start(ada, server.home.dir)
  const view = watchView(ada, conversation)
  await submit(ada, conversation, "check it")
  const approval = await waitingApproval(view)
  expect(approvalsOf(view)!.requests[approval]).toMatchObject({ tool: "bash" })
  const answers = await Promise.all([
    ada.call("approval/resolve", { conversation, approval, author: person("ada"), allow: true }),
    bo.call("approval/resolve", { conversation, approval, author: person("bo"), allow: false }),
  ])
  const accepted = answers.map((reply) => (reply.result as { accepted: boolean }).accepted)
  expect(accepted.filter(Boolean)).toHaveLength(1)
  const winner = accepted[0] ? { author: person("ada"), allow: true } : { author: person("bo"), allow: false }
  await view.until(settled(1))
  const answered = view.seen().filter((entry) => entry.kind === "sigma.approval")
  expect(answered.map((entry) => entry.data)).toEqual([expect.objectContaining({ approval, ...winner })])
  expect(toolResults(view)).toEqual([
    winner.allow
      ? { text: "approved\n", isError: false }
      : { text: expect.stringContaining("denied by bo: the person did not allow this call"), isError: true },
  ])
  // The request leaves with its call, and a late answer is not accepted.
  expect(approvalsOf(view)!.requests).toEqual({})
  const late = await ada.call("approval/resolve", { conversation, approval, author: person("cy"), allow: true })
  expect(late.result).toEqual({ accepted: false })
  expect(transcript(view.view().entries).slice(-2)).toEqual(["assistant: all done", "run_end: answered"])
  ada.close()
  bo.close()
})

test("bash-default-timeout: a bash command past the default ends with an error naming the limit and the timeout argument", async () => {
  await using server = await runningServer(
    [
      { tool: { name: "bash", input: { command: "sleep 60" } } },
      { tool: { name: "bash", input: { command: "sleep 60", timeout: 2 } } },
      { text: "all done" },
    ],
    { bashTimeout: 1 },
  )
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "hang")
  for (const answered of [1, 2]) {
    const approval = await waitingApproval(view)
    await client.call("approval/resolve", { conversation, approval, author: person("ada"), allow: true })
    await view.until(() => toolResults(view).length === answered)
  }
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([
    {
      text: expect.stringContaining(
        "Command timed out after 1 seconds. That is the default limit; pass the timeout argument, in seconds, to allow a command longer",
      ),
      isError: true,
    },
    { text: "<harness>\n[error] Command timed out after 2 seconds\n</harness>", isError: true },
  ])
  client.close()
})

test("approval-wire: a denied call is reported to the model as denied and does not run, and an unknown approval is refused by name", async () => {
  await using server = await runningServer([
    { tool: { name: "bash", input: { command: "touch made" } } },
    { text: "all done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "make it")
  const approval = await waitingApproval(view)
  const reply = await client.call("approval/resolve", { conversation, approval, author: person("bo"), allow: false })
  expect(reply.result).toEqual({ accepted: true })
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([
    { text: expect.stringContaining("denied by bo: the person did not allow this call"), isError: true },
  ])
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)
  expect(
    errorTag(
      await client.call("approval/resolve", { conversation, approval: "999", author: person("bo"), allow: true }),
    ),
  ).toBe("NoSuchApproval")
  client.close()
})

test("codemode-nested-policy: a script's call that changes things asks first, and a denied one fails in the script without running", async () => {
  const code = 'try { await tools.bash({ command: "touch made" }) } catch (error) { text("refused: " + error.message) }'
  await using server = await runningServer([{ tool: { name: "codemode", input: { code } } }, { text: "all done" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", { author: person("ada"), cwd: server.home.dir, model: "script-code-mode" })
  ).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "make it")
  const approval = await waitingApproval(view)
  expect(approvalsOf(view)!.requests[approval]).toMatchObject({ tool: "bash" })
  await client.call("approval/resolve", { conversation, approval, author: person("bo"), allow: false })
  await view.until(settled(1))
  const result = toolResults(view).at(-1)
  expect(result!.text).toStartWith("Script completed")
  expect(result!.text).toContain("refused: ")
  expect(result!.text).toContain("denied by bo: the person did not allow this call")
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)
  expect(transcript(view.view().entries).slice(-2)).toEqual(["assistant: all done", "run_end: answered"])
  client.close()
})

test("tool-read-only, approval-auto: reading calls and conversations started with auto approvals run without asking", async () => {
  await using server = await runningServer([
    { tool: { name: "read", input: { path: "notes.txt" } } },
    { text: "read it" },
    ...ECHO,
  ])
  await Bun.write(`${server.home.dir}/notes.txt`, "the gnome lives under the floor\n")
  const client = await RawClient.connect(server.home.socket)
  const reading = await start(client, server.home.dir)
  const readView = watchView(client, reading)
  await submit(client, reading, "read it")
  await readView.until(settled(1))
  expect(toolResults(readView)).toEqual([{ text: expect.stringContaining("the gnome lives"), isError: false }])
  const auto = (
    await client.call("conversation/start", { author: person("ada"), cwd: server.home.dir, approvals: "auto" })
  ).result.conversation as string
  const autoView = watchView(client, auto)
  await submit(client, auto, "check it")
  await autoView.until(settled(1))
  expect(toolResults(autoView)).toEqual([{ text: "approved\n", isError: false }])
  expect(autoView.seen().some((entry) => entry.kind === "sigma.approval")).toBe(false)
  client.close()
})

test("start-with-id: starting a conversation with an id it already has answers with that conversation, and an all-digit id is refused by name", async () => {
  await using server = await runningServer([{ text: "hello" }])
  const client = await RawClient.connect(server.home.socket)
  const id = crypto.randomUUID()
  const first = await client.call("conversation/start", { author: person("ada"), id, cwd: "/work" })
  const again = await client.call("conversation/start", { author: person("ada"), id, cwd: "/elsewhere" })
  expect(first.result).toEqual({ conversation: id, model: { provider: "script", model: "script" } })
  expect(again.result).toEqual({ conversation: id, model: { provider: "script", model: "script" } })
  const view = watchView(client, id)
  await submit(client, id, "hi")
  await view.until(settled(1))
  expect((view.view().docs["pi.agent"] as { cwd?: string }).cwd).toBe("/work")
  expect(errorTag(await client.call("conversation/start", { author: person("ada"), id: "42", cwd: "/work" }))).toBe(
    "InvalidConversationId",
  )
  client.close()
})

test("mcp-register: a name or address sigma cannot register is refused by name, as is a conversation that names sigma's own tools", async () => {
  await using server = await runningServer()
  const client = await RawClient.connect(server.home.socket)
  const refusal = async (params: unknown) => {
    const reply = await client.watch("mcp/register", params).ended
    return [errorTag(reply), reply.error?.message]
  }
  expect(await refusal({ name: "sigma", url: "http://127.0.0.1:1/mcp" })).toEqual([
    "InvalidMcpServer",
    expect.stringContaining("sigma names sigma's own tools"),
  ])
  expect(await refusal({ name: "files", url: "file:///etc/passwd" })).toEqual([
    "InvalidMcpServer",
    expect.stringContaining("the MCP server files needs an http or https URL"),
  ])
  expect(
    (await client.watch("mcp/register", { name: "two words", url: "http://127.0.0.1:1/mcp" }).ended).error,
  ).toBeDefined()
  const own = await client.call("conversation/start", {
    author: person("ada"),
    cwd: "/work",
    mcpServers: [{ name: "sigma", description: "mine" }],
  })
  expect(errorTag(own)).toBe("InvalidMcpServer")
  client.close()
})

test("mcp-start: a conversation keeps the MCP servers it started with, and a fork of it uses them too", async () => {
  await using server = await runningServer([{ text: "hello" }])
  const client = await RawClient.connect(server.home.socket)
  const servers = [
    { name: "attn", description: "Tracks work" },
    { name: "docs", description: "Reads the docs" },
  ]
  await client.call("conversation/start", { author: person("ada"), id: "with", cwd: "/work", mcpServers: servers })
  await client.call("conversation/start", { author: person("ada"), id: "without", cwd: "/work" })
  const view = watchView(client, "with")
  await submit(client, "with", "hi")
  await view.until(settled(1))
  const at = view.seen().at(-1)!.id
  await client.call("conversation/fork", { author: person("ada"), conversation: "with", at, id: "forked" })
  const listed = (await client.call("conversation/list")).result as Array<{ id: string; mcpServers?: unknown }>
  expect(Object.fromEntries(listed.map((info) => [info.id, info.mcpServers]))).toEqual({
    with: servers,
    without: undefined,
    forked: servers,
  })
  client.close()
})

/** Registers `mcp` as `fake` from `client`, with a secret Authorization; it lasts while the client is connected. */
const registerFake = async (client: RawClient, mcp: FakeMcpServer, url = mcp.url) => {
  const registered = client.watch<{ name: string }>("mcp/register", {
    name: "fake",
    url,
    headers: { Authorization: "Bearer s3cret" },
  })
  await registered.until((items) => items.length > 0)
}

/** Starts the conversation `talk` with `fake` on `model`, watched. */
const talkWithFake = async (client: RawClient, cwd: string, model = "script") => {
  await client.call("conversation/start", {
    author: person("ada"),
    id: "talk",
    cwd,
    model,
    approvals: "auto",
    mcpServers: [{ name: "fake", description: "Echoes text" }],
  })
  const view = watchView(client, "talk")
  await view.until(() => true)
  return view
}

/** What the fake's calls asked for, with the Authorization and root each carried. */
const fakeCalls = (mcp: FakeMcpServer) =>
  mcp.calls().map((call) => [call.body.params, call.headers.authorization, call.headers["sigma-root-conversation"]])

test("mcp-openai, mcp-typed: a code mode script calls a server's tool by its namespaced name and gets the result its outputSchema types, and describeNamespace() answers with the server's instructions", async () => {
  using mcp = new FakeMcpServer([ECHO_TOOL, WAIT_TOOL])
  const code = [
    'const said = await tools.mcp__fake__echo({ text: "hi" })',
    'text(typeof said + " " + said.echoed)',
    'text(JSON.stringify(await describeNamespace("mcp__fake")))',
  ].join("\n")
  await using server = await runningServer([{ tool: { name: "codemode", input: { code } } }, { text: "done" }])
  const client = await RawClient.connect(server.home.socket)
  await registerFake(client, mcp)
  const view = await talkWithFake(client, server.home.dir, "script-code-mode")
  await submit(client, "talk", "echo hi")
  await view.until(settled(1))
  const result = toolResults(view)[0]!
  expect(result.isError).toBe(false)
  expect(result.text).toContain("object hi")
  expect(result.text).toContain(
    JSON.stringify({
      name: "mcp__fake",
      description: "Echoes text",
      instructions: FAKE_INSTRUCTIONS,
      tools: ["mcp__fake__echo", "mcp__fake__wait"],
    }),
  )
  expect(fakeCalls(mcp)).toEqual([[{ name: "echo", arguments: { text: "hi" } }, "Bearer s3cret", "talk"]])
  client.close()
})

test("mcp-openai: a model that takes tools directly is offered an always-loaded tool, and calls a deferred one only once tool_search loaded it, over a stream the server holds open", async () => {
  using mcp = new FakeMcpServer([ECHO_TOOL, WAIT_TOOL])
  await using server = await runningServer([
    call("mcp__fake__echo", { text: "first" }),
    call("mcp__fake__wait", { text: "early" }),
    call("tool_search", { query: "wait for a signal from the operator" }),
    call("mcp__fake__wait", { text: "later" }),
    { text: "done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  await registerFake(client, mcp)
  const view = await talkWithFake(client, server.home.dir)
  await submit(client, "talk", "wait for it")
  await mcp.until((fake) => fake.waiting().includes("later"), "the wait call to reach the server")
  mcp.release("later")
  await view.until(settled(1))
  const [echo, early, search, later] = toolResults(view)
  expect(echo).toEqual({ text: "first", isError: false })
  expect(early!.isError).toBe(true)
  expect(search).toEqual({
    text: expect.stringContaining("- mcp__fake__wait: Waits for a signal from the operator"),
    isError: false,
  })
  expect(later).toEqual({ text: "later", isError: false })
  expect(fakeCalls(mcp).map(([params]) => params)).toEqual([
    { name: "echo", arguments: { text: "first" } },
    { name: "wait", arguments: { text: "later" } },
  ])
  client.close()
})

test("mcp-openai, mcp-start: a forked and a fresh subagent each call their root's server, naming the root", async () => {
  using mcp = new FakeMcpServer()
  await using server = await runningServer([
    call("start_worker", { task_name: "forked", message: "echo forked" }),
    call("start_worker", { task_name: "fresh", message: "echo fresh", fork_turns: "none" }),
    call("mcp__fake__echo", { text: "forked" }, "/root/forked"),
    { text: "echoed", agent: "/root/forked" },
    call("mcp__fake__echo", { text: "fresh" }, "/root/fresh"),
    { text: "echoed", agent: "/root/fresh" },
    call("wait_worker", { timeout_ms: 600_000 }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { text: "both echoed" },
  ])
  const client = await RawClient.connect(server.home.socket)
  await registerFake(client, mcp)
  const view = await talkWithFake(client, server.home.dir)
  await submit(client, "talk", "have two subagents echo")
  await mcp.until((fake) => fake.calls().length === 2, "both subagents to call the server")
  expect(fakeCalls(mcp).sort()).toEqual([
    [{ name: "echo", arguments: { text: "forked" } }, "Bearer s3cret", "talk"],
    [{ name: "echo", arguments: { text: "fresh" } }, "Bearer s3cret", "talk"],
  ])
  await view.until(settled(1), DEADLINE)
  client.close()
})

test("mcp-cancel: interrupting a run cancels the server's call it waits on", async () => {
  using mcp = new FakeMcpServer([ECHO_TOOL, WAIT_TOOL])
  const code = 'text(JSON.stringify(await tools.mcp__fake__wait({ text: "held" })))'
  await using server = await runningServer([{ tool: { name: "codemode", input: { code } } }])
  const client = await RawClient.connect(server.home.socket)
  await registerFake(client, mcp)
  const view = await talkWithFake(client, server.home.dir, "script-code-mode")
  await submit(client, "talk", "wait")
  await mcp.until((fake) => fake.waiting().includes("held"), "the wait call to reach the server")
  await client.call("conversation/interrupt", { author: person("ada"), conversation: "talk" })
  await mcp.until((fake) => fake.cancelled.includes("held"), "sigma to cancel the call it waited on")
  await view.until(settled(1))
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  client.close()
})

test("mcp-reconnect: after the server restarts on its address, the next call reaches it", async () => {
  using mcp = new FakeMcpServer()
  await using server = await runningServer([
    call("mcp__fake__echo", { text: "before" }),
    { text: "one" },
    call("mcp__fake__echo", { text: "after" }),
    { text: "two" },
  ])
  const client = await RawClient.connect(server.home.socket)
  await registerFake(client, mcp)
  const view = await talkWithFake(client, server.home.dir)
  await submit(client, "talk", "echo before")
  await view.until(settled(1))
  await mcp.restart()
  await submit(client, "talk", "echo after")
  await view.until(settled(2))
  expect(toolResults(view)).toEqual([
    { text: "before", isError: false },
    { text: "after", isError: false },
  ])
  client.close()
})

test("mcp-unlisted: a server no client registers, or one that does not answer, offers no tools, and the conversation says why", async () => {
  using gone = new FakeMcpServer()
  const url = gone.url
  gone[Symbol.dispose]()
  await using server = await runningServer([{ text: "hello" }])
  const client = await RawClient.connect(server.home.socket)
  await registerFake(client, gone, url)
  await client.call("conversation/start", {
    author: person("ada"),
    id: "talk",
    cwd: server.home.dir,
    mcpServers: [
      { name: "fake", description: "Echoes text" },
      { name: "ghost", description: "Never registered" },
    ],
  })
  const view = watchView(client, "talk")
  await view.until((watch) => watch.seen().filter((entry) => entry.kind === "sigma.mcp_unlisted").length === 2)
  expect(
    view
      .seen()
      .filter((entry) => entry.kind === "sigma.mcp_unlisted")
      .map((entry) => entry.data),
  ).toEqual([
    { server: "fake", reason: expect.stringMatching(/^it did not list its tools: /) },
    { server: "ghost", reason: "no client connected to sigma registers it" },
  ])
  // The conversation still lists both, as it started with them.
  const listed = (await client.call("conversation/list")).result as Array<{ id: string; mcpServers?: unknown }>
  expect(listed.find((info) => info.id === "talk")?.mcpServers).toEqual([
    { name: "fake", description: "Echoes text" },
    { name: "ghost", description: "Never registered" },
  ])
  client.close()
})

const call = (name: string, input: Record<string, unknown>, agent?: string) => ({
  tool: { name, input },
  ...(agent === undefined ? {} : { agent }),
})
const mails = (watch: ViewWatch) =>
  watch
    .seen()
    .filter((entry) => entry.kind === "sigma.mail")
    .map((entry) => entry.data as { kind: string; task: string; sender: string })

test("start-with-id: a chosen id that names an object property, such as toString, opens its own conversation", async () => {
  await using server = await runningServer([{ text: "hello" }])
  const client = await RawClient.connect(server.home.socket)
  await client.call("conversation/start", { author: person("ada"), id: "first", cwd: "/work" })
  expect(
    (await client.call("conversation/start", { author: person("ada"), id: "toString", cwd: "/work" })).result,
  ).toEqual({
    conversation: "toString",
    model: { provider: "script", model: "script" },
  })
  const view = watchView(client, "toString")
  await submit(client, "toString", "hi")
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual(["user: hi", "assistant: hello", "run_end: answered"])
  client.close()
})

test("child-tools, worker-answer: the model starts a worker, and the wait returns its final answer, which is not also delivered as a message", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { text: "the note is written", agent: "/root/writer" },
    call("list_workers", {}),
    { text: "writer finished" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until(settled(1), DEADLINE)
  const results = toolResults(view).map((result) => JSON.parse(result.text))
  expect(results[0]).toEqual({ task_name: "/root/writer" })
  expect(results[1]).toEqual({
    timed_out: false,
    received: [{ from: "/root/writer", kind: "final_answer", text: "the note is written" }],
  })
  expect(results[2]).toEqual({
    workers: [
      { name: "/root", status: "running" },
      { name: "/root/writer", status: { completed: "the note is written" } },
    ],
  })
  // The wait took the answer, so it reached the model once, and nothing waits in the inbox.
  expect(mails(view)).toEqual([])
  expect((view.view().docs["pi.inbox"] as { items: unknown[] } | undefined)?.items ?? []).toEqual([])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: writer finished", "run_end: answered"])
  client.close()
})

test("worker-provider: start_worker refuses a provider the home does not have and one that is not ready, naming the ready ones, and a fork onto another provider", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "a", message: "go", provider: "gemini" }),
    call("start_worker", { task_name: "b", message: "go", provider: "openai" }),
    call("start_worker", { task_name: "c", message: "go", provider: "claude", fork_turns: "all" }),
    { text: "none started" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "start them")
  await view.until(settled(1), DEADLINE)
  // The test home's ChatGPT is not signed in; its fake Claude Code and agy are.
  expect(toolResults(view)).toEqual([
    { text: "no provider gemini; the ready providers are script, claude, agy", isError: true },
    { text: "provider openai is not ready; the ready providers are script, claude, agy", isError: true },
    {
      text: 'a worker on another provider starts from your message alone; set fork_turns to "none"',
      isError: true,
    },
  ])
  expect((await client.call("conversation/list")).result).toHaveLength(1)
  client.close()
})

test("worker-wait: a wait that nothing reaches in time returns timed out, with the minimum it was clamped to, and the worker keeps working", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "slow", message: "make it", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 0 }),
    { text: "still waiting on slow" },
    call("bash", { command: "echo made" }, "/root/slow"),
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "start a slow one")
  // The worker holds on its approval, so the wait reaches its minimum of 10 s.
  await view.until(settled(1), DEADLINE)
  expect(JSON.parse(toolResults(view)[1]!.text)).toEqual({
    timed_out: true,
    received: [],
    message: "Requested timeout of 0ms was clamped to the minimum of 10000ms.",
  })
  const slow = watchView(client, spawned(view, "/root/slow"))
  await waitingApproval(slow)
  expect(runEnds(slow.seen())).toEqual([])
  client.close()
})

test("worker-wait: two waits at once never both return the same answer: one returns it, the other times out", async () => {
  // The waits keep time on a clock that moves only once the answer is in, so a slow writer cannot time out both.
  const wait = await waitClock("10 seconds")
  await using server = await runningServer(
    [
      call("start_worker", { task_name: "writer", message: "write a note", fork_turns: "none" }),
      {
        tools: [
          { name: "wait_worker", input: { timeout_ms: 10_000 } },
          { name: "wait_worker", input: { timeout_ms: 10_000 } },
        ],
      },
      { text: "the note is written", agent: "/root/writer" },
      { text: "done waiting" },
    ],
    { clock: wait.clock },
  )
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await wait.began(2)
  await view.until((watch) => toolResults(watch).some((result) => result.text.includes("the note is written")))
  await wait.advance()
  await view.until(settled(1))
  const waits = toolResults(view)
    .slice(1)
    .map((result) => JSON.parse(result.text))
  expect(waits.flatMap((wait) => wait.received)).toEqual([
    { from: "/root/writer", kind: "final_answer", text: "the note is written" },
  ])
  expect(waits.map((wait) => wait.timed_out).sort()).toEqual([false, true])
  expect(mails(view)).toEqual([])
  client.close()
})

test("worker-person: a person's message to a worker is answered in the worker's conversation, and its parent is told nothing", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "helper", message: "first", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { text: "first done", agent: "/root/helper" },
    { text: "helper finished" },
    { text: "hello ada", agent: "/root/helper" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until(settled(1), DEADLINE)
  const helper = watchView(client, spawned(view, "/root/helper"))
  await helper.until(settled(1), DEADLINE)

  await submit(client, spawned(view, "/root/helper"), "hi helper")
  await helper.until(settled(2), DEADLINE)
  expect(transcript(helper.seen()).slice(-3)).toEqual(["user: hi helper", "assistant: hello ada", "run_end: answered"])
  // Nothing reaches the parent: no mail, nothing queued, no run.
  expect(mails(view)).toEqual([])
  expect((view.view().docs["pi.inbox"] as { items: unknown[] }).items).toEqual([])
  expect(runEnds(view.seen())).toHaveLength(1)
  client.close()
})

/** The conversation of the subagent a start_worker call started, from its result's details. */
const spawned = (watch: ViewWatch, task: string) => {
  const result = watch
    .seen()
    .map((entry) => (entry.model?.[0] as { details?: { task?: string; conversation?: number } } | undefined)?.details)
    .find((details) => details?.task === task)
  return String(result!.conversation)
}

test("child-tools: a prompt queued while the model waits on a subagent does not end the wait, and runs after it", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { text: "writer finished" },
    { text: "now the next prompt" },
    { tool: { name: "bash", input: { command: "echo noted" } }, agent: "/root/writer" },
    { text: "the note is written", agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  // The writer holds on its approval, so the prompt below is queued while the parent's run goes on.
  await view.until((current) => toolResults(current).length > 0)
  const child = spawned(view, "/root/writer")
  const writer = watchView(client, child)
  const approval = await waitingApproval(writer)
  await submit(client, conversation, "and then this")
  await client.call("approval/resolve", { conversation: child, approval, author: person("ada"), allow: true })
  await view.until(settled(2), DEADLINE)
  expect(JSON.parse(toolResults(view)[1]!.text)).toEqual({
    timed_out: false,
    received: [{ from: "/root/writer", kind: "final_answer", text: "the note is written" }],
  })
  expect(transcript(view.seen()).filter((line) => !line.startsWith("assistant: ") || line.includes("next"))).toEqual([
    "user: delegate it",
    "run_end: answered",
    "user: and then this",
    "assistant: now the next prompt",
    "run_end: answered",
  ])
  client.close()
})

test("child-tools, approval-auto: a subagent of a conversation that runs calls without asking does not ask either", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { text: "writer finished" },
    { tool: { name: "bash", input: { command: "echo noted" } }, agent: "/root/writer" },
    { text: "the note is written", agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", { author: person("ada"), cwd: server.home.dir, approvals: "auto" })
  ).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until(settled(1), DEADLINE)
  expect(JSON.parse(toolResults(view)[1]!.text).received).toEqual([
    { from: "/root/writer", kind: "final_answer", text: "the note is written" },
  ])
  const writer = watchView(client, spawned(view, "/root/writer"))
  await writer.until(() => true)
  expect(toolResults(writer)).toEqual([{ text: "noted\n", isError: false }])
  client.close()
})

test("worker-types: starting an agent of a type sigma doesn't know is refused, naming it", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "review", message: "review it", agent_type: "reviewer" }),
    { text: "no reviewer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "get it reviewed")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: "no agent type reviewer; there are none", isError: true }])
  client.close()
})

/** Six subagents `/root/a1`.. that each hold on an approval, and a seventh the limit refuses, spawned at once. */
const SEVEN = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]
const holding = SEVEN.map((name) => ({
  tool: { name: "bash", input: { command: "echo held" } },
  agent: `/root/${name}`,
}))
const spawnSeven = {
  tools: SEVEN.map((name) => ({
    name: "start_worker",
    input: { task_name: name, message: "hold", fork_turns: "none" },
  })),
}
const MAX_THREADS = "at most 6 workers work at once (max_threads); 6 are working, so wait for one to finish"

test("worker-limits, child-tools: start_worker calls in one response start at most maxThreads workers", async () => {
  await using server = await runningServer([spawnSeven, { text: "spawned them" }, ...holding])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "fan out")
  await view.until(settled(1), DEADLINE)
  const results = toolResults(view)
  expect(results.filter((result) => result.isError)).toEqual([{ text: MAX_THREADS, isError: true }])
  expect(results.filter((result) => !result.isError)).toHaveLength(6)
  client.close()
})

test("worker-limits, child-tools: a follow-up task does not wake an idle worker while maxThreads workers work", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "idle", message: "answer", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { ...spawnSeven, tools: spawnSeven.tools.slice(0, 6) },
    call("assign_worker", { target: "idle", message: "again" }),
    { text: "asked" },
    { text: "answered", agent: "/root/idle" },
    ...holding,
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "fan out")
  await view.until(settled(1), DEADLINE)
  const results = toolResults(view)
  expect(results.slice(2, 8).every((result) => !result.isError)).toBe(true)
  expect(results[8]).toEqual({ text: MAX_THREADS, isError: true })
  client.close()
})

test("child-tools: a subagent's answer that waits in its parent's queue still reaches it when the person stops the parent", async () => {
  await using server = await runningServer([
    {
      tools: [
        { name: "start_worker", input: { task_name: "writer", message: "write a note", fork_turns: "none" } },
        { name: "bash", input: { command: "echo waiting" } },
      ],
    },
    { text: "the note is written", agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  // The parent holds on its call's approval while the writer's answer queues behind it.
  await waitingApproval(view)
  await view.until((current) => ((current.view().docs["pi.inbox"] as { items?: unknown[] })?.items ?? []).length > 0)
  await client.call("conversation/interrupt", { author: person("ada"), conversation })
  await view.until((current) => mails(current).length > 0)
  expect(mails(view)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  client.close()
})

test("child-tools: a follow-up task reaches a working subagent at its next step, in the same run", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("assign_worker", { target: "writer", message: "sign it too" }),
    { text: "asked" },
    { tool: { name: "bash", input: { command: "echo noted" } }, agent: "/root/writer" },
    { text: "written and signed", agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until((current) => toolResults(current).length > 0)
  const child = spawned(view, "/root/writer")
  const writer = watchView(client, child)
  const approval = await waitingApproval(writer)
  // The follow-up waits in the writer's queue while its call holds on the approval.
  await writer.until((current) => ((current.view().docs["pi.inbox"] as { items?: unknown[] })?.items ?? []).length > 0)
  await client.call("approval/resolve", { conversation: child, approval, author: person("ada"), allow: true })
  await writer.until(settled(1), DEADLINE)
  expect(mails(writer).map((mail) => mail.kind)).toEqual(["new_task", "new_task"])
  expect(transcript(writer.seen()).slice(-2)).toEqual(["assistant: written and signed", "run_end: answered"])
  expect(runEnds(writer.seen())).toHaveLength(1)
  client.close()
})

test("child-tools, worker-message, worker-assign: a worker takes messages and follow-up tasks", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "helper", message: "first", fork_turns: "none" }),
    { text: "first done", agent: "/root/helper" },
    call("wait_worker", { timeout_ms: 600_000 }),
    call("message_worker", { target: "helper", message: "fyi" }),
    call("assign_worker", { target: "/root/helper", message: "second" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { text: "second done", agent: "/root/helper" },
    { text: "all done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until(settled(1), DEADLINE)
  const helper = watchView(client, spawned(view, "/root/helper"))
  await helper.until(settled(2), DEADLINE)
  // Each answer came back through a wait, so none was delivered as a message too.
  expect(mails(view)).toEqual([])
  expect(
    toolResults(view)
      .filter((result) => result.text.startsWith('{"timed_out"'))
      .flatMap((result) => JSON.parse(result.text).received),
  ).toEqual([
    { from: "/root/helper", kind: "final_answer", text: "first done" },
    { from: "/root/helper", kind: "final_answer", text: "second done" },
  ])
  expect(mails(helper)).toEqual([
    { kind: "new_task", task: "/root/helper", sender: "/root" },
    { kind: "message", task: "/root/helper", sender: "/root" },
    { kind: "new_task", task: "/root/helper", sender: "/root" },
  ])
  expect(transcript(helper.seen()).filter((line) => line.startsWith("assistant: ") && line !== "assistant: ")).toEqual([
    "assistant: first done",
    "assistant: second done",
  ])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: all done", "run_end: answered"])
  client.close()
})

test("child-tools, worker-list: interrupting a worker stops its turn and reports what it was doing", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "slow", message: "make it", fork_turns: "none" }),
    call("bash", { command: "echo ready" }),
    call("bash", { command: "touch made" }, "/root/slow"),
    call("stop_worker", { target: "slow" }),
    call("list_workers", {}),
    { text: "stopped it" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "start and stop")
  // The root waits on its own approval until the subagent waits on one too, so the subagent is working.
  const rootApproval = await waitingApproval(view)
  const slow = watchView(client, spawned(view, "/root/slow"))
  await waitingApproval(slow)
  await client.call("approval/resolve", { conversation, approval: rootApproval, author: person("ada"), allow: true })
  await view.until(settled(1), DEADLINE)
  await slow.until(settled(1), DEADLINE)
  const results = toolResults(view).map((result) => result.text)
  expect(JSON.parse(results[2]!)).toEqual({ previous_status: "running" })
  expect(JSON.parse(results[3]!).workers).toEqual([
    { name: "/root", status: "running" },
    { name: "/root/slow", status: "interrupted" },
  ])
  expect(runEnds(slow.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
  expect(approvalsOf(slow)!.requests).toEqual({})
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)
  client.close()
})

/** What the people in a conversation see of its calls: each call and each result, in order. */
const callsAndResults = (watch: ViewWatch) =>
  watch.seen().flatMap((entry): Array<string> => {
    const message = entry.model?.[0] as
      | { content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>; isError?: boolean }
      | undefined
    if (entry.kind === "pi.assistant")
      return message!.content.flatMap((block) =>
        block.type === "toolCall" ? [`call ${block.name} ${JSON.stringify(block.arguments)}`] : [],
      )
    if (entry.kind === "pi.tool-result") {
      const text = message!.content.map((block) => block.text ?? "").join("")
      return [`result${message!.isError ? " error" : ""}: ${text}`]
    }
    return []
  })
const startAuto = async (client: RawClient, cwd: string, id?: string) =>
  (
    await client.call("conversation/start", {
      author: person("ada"),
      cwd,
      approvals: "auto",
      ...(id === undefined ? {} : { id }),
    })
  ).result.conversation as string

test("worker-root-env, tool-root-env: a worker's command knows the conversation people started by the id its client chose", async () => {
  await using server = await runningServer([
    { tool: { name: "start_worker", input: { task_name: "envy", message: "show your root", fork_turns: "none" } } },
    { tool: { name: "wait_worker", input: { timeout_ms: 600000 } } },
    { text: "envy answered" },
    { agent: "/root/envy", tool: { name: "bash", input: { command: "echo root=$SIGMA_ROOT_CONVERSATION" } } },
    { agent: "/root/envy", text: "shown" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, server.home.dir, "chosen-root")
  expect(conversation).toBe("chosen-root")
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate")
  await view.until(settled(1), DEADLINE)
  const child = watchView(client, spawned(view, "/root/envy"))
  await child.until(() => toolResults(child).length > 0)
  expect(toolResults(child).map((result) => result.text)).toEqual([`root=${conversation}\n`])
  client.close()
})
test("approval-restart, status-snapshot: a call waiting for approval across a restart asks again after it, and runs once allowed", async () => {
  const home = tempHome()
  let conversation: string
  let approval: string
  {
    await using server = await runningServer(
      [{ tool: { name: "bash", input: { command: "echo one" } } }, { text: "done" }],
      { home },
    )
    const client = await RawClient.connect(server.home.socket)
    conversation = await start(client, home.dir)
    const view = watchView(client, conversation)
    await submit(client, conversation, "say it")
    approval = await waitingApproval(view)
    expect(approvalsOf(view)!.requests[approval]).toMatchObject({ arguments: { command: "echo one" } })
    client.close()
  }
  {
    await using server = await runningServer([{ text: "done" }], { home })
    const client = await RawClient.connect(server.home.socket)
    const view = watchView(client, conversation)
    const asked = (watch: ViewWatch) => approvalsOf(watch)?.requests[approval] as { arguments?: unknown } | undefined
    await view.until((watch) => JSON.stringify(asked(watch)?.arguments) === `{"command":"echo one"}`)
    const status = client.watch<Trees>("status/watch")
    await status.until((items) => items.length > 0)
    expect(status.items[0]).toMatchObject({ _tag: "trees", trees: [{ conversation, status: "waiting" }] })
    expect(asked(view)).not.toHaveProperty("answer")
    await client.call("approval/resolve", { conversation, approval, author: person("ada"), allow: true })
    await view.until(settled(1))
    expect(toolResults(view)).toEqual([{ text: "one\n", isError: false }])
    client.close()
  }
  rmSync(home.dir, { recursive: true })
})

const treesOf = (items: ReadonlyArray<Trees>, conversation: string) =>
  items.filter((item): item is Tree => item._tag === "tree" && item.conversation === conversation)

test("status-follow, status-ended: watching status follows each run of a tree and says how it ended", async () => {
  await using server = await runningServer([{ text: "all done" }, { text: "again" }])
  const client = await RawClient.connect(server.home.socket)
  const watch = client.watch<Trees>("status/watch")
  await watch.until((items) => items.length > 0)
  expect(watch.items[0]).toMatchObject({ _tag: "trees", trees: [] })
  const conversation = (
    await client.call("conversation/start", { author: person("ada"), cwd: "/work", id: "followed" })
  ).result.conversation as string
  await submit(client, conversation, "go")
  await watch.until((items) => treesOf(items, conversation).some((tree) => tree.ended))
  await submit(client, conversation, "go again")
  await watch.until((items) => treesOf(items, conversation).filter((tree) => tree.ended).length === 2)

  const seen = treesOf(watch.items, conversation)
  expect(seen.map(({ status, ended }) => ({ status, ended }))).toEqual([
    { status: "working", ended: undefined },
    { status: "idle", ended: { outcome: "answered", said: "all done" } },
    { status: "working", ended: undefined },
    { status: "idle", ended: { outcome: "answered", said: "again" } },
  ])
  const seqs = seen.map((tree) => tree.seq)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(new Set(seqs).size).toBe(4)
  client.close()
})

test("status-subagent, status-snapshot: a subagent waiting on a person shows as its whole tree waiting, to watchers then and later", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { tool: { name: "bash", input: { command: "echo noted" } }, agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const watch = client.watch<Trees>("status/watch")
  await watch.until((items) => items.length > 0)
  const conversation = await start(client, server.home.dir)
  await submit(client, conversation, "have someone write a note")
  await watch.until((items) => treesOf(items, conversation).at(-1)?.status === "waiting", DEADLINE)

  const late = await RawClient.connect(server.home.socket)
  const lateWatch = late.watch<Trees>("status/watch")
  await lateWatch.until((items) => items.length > 0)
  expect(lateWatch.items[0]).toMatchObject({
    _tag: "trees",
    trees: [{ _tag: "tree", conversation, status: "waiting" }],
  })
  expect(treesOf(watch.items, conversation).map((tree) => tree.status)).toEqual(["working", "waiting"])
  // An interrupt of the root's run leaves its subagent waiting; a second, on the idle root, stops the subagent too.
  await client.call("conversation/interrupt", { author: person("ada"), conversation })
  await watch.until((items) => treesOf(items, conversation).some((tree) => tree.ended), DEADLINE)
  expect(treesOf(watch.items, conversation).at(-1)?.status).toBe("waiting")
  await client.call("conversation/interrupt", { author: person("ada"), conversation })
  await watch.until((items) => treesOf(items, conversation).at(-1)?.status === "idle", DEADLINE)
  const ended = treesOf(watch.items, conversation).filter((tree) => tree.ended)
  expect(ended.map((tree) => tree.ended)).toEqual([{ outcome: "interrupted", message: "aborted" }])
  client.close()
  late.close()
})

test("submit-author, queue-shared: every client sees who wrote each prompt, while it waits and once it runs", async () => {
  using held = hold()
  await using server = await runningServer([{ text: "the first answer", hold: held.path }, { text: "second answer" }])
  const ada = await RawClient.connect(server.home.socket)
  const bo = await RawClient.connect(server.home.socket)
  const conversation = await start(ada)
  const view = watchView(bo, conversation)
  await submit(ada, conversation, "one", undefined, person("ada"))
  await view.until(speaking)
  await submit(bo, conversation, "two", undefined, person("bo"))
  await view.until((watch) => ((watch.view().docs["pi.inbox"] as { items?: unknown[] })?.items ?? []).length > 0)
  expect((view.view().docs["pi.inbox"] as { items: unknown[] }).items).toEqual([
    expect.objectContaining({ entry: { kind: USER_KIND, data: expect.objectContaining({ author: person("bo") }) } }),
  ])
  held.release()
  await view.until(settled(2))
  const users = view.seen().filter((entry) => entry.kind === USER_KIND)
  expect(users.map((entry) => (entry.data as { author: unknown }).author)).toEqual([person("ada"), person("bo")])
  expect(transcript(view.seen()).filter((line) => line.startsWith("user: "))).toEqual(["user: one", "user: two"])
  ada.close()
  bo.close()
})

test("worker-limits: a tree runs at most as many workers at once as config.toml allows", async () => {
  await using server = await runningServer([spawnSeven, { text: "spawned them" }, ...holding], {
    config: { agents: { max_threads: 2 } },
  })
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "fan out")
  await view.until(settled(1), DEADLINE)
  const results = toolResults(view)
  expect(results.filter((result) => !result.isError)).toHaveLength(2)
  expect(results.filter((result) => result.isError)).toHaveLength(5)
  expect(results.find((result) => result.isError)?.text).toContain("at most 2 workers work at once (max_threads)")
  client.close()
})

test("worker-limits: with max_threads 0 in config.toml the root conversation is not offered start_worker", async () => {
  await using server = await runningServer(
    [call("start_worker", { task_name: "scout", message: "go", fork_turns: "none" }), { text: "alone then" }],
    { config: { agents: { max_threads: 0 } } },
  )
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "send a scout")
  await view.until(settled(1), DEADLINE)
  expect(toolResults(view)).toEqual([
    { text: expect.stringContaining("Tool start_worker is not available"), isError: true },
  ])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: alone then", "run_end: answered"])
  expect((await client.call("conversation/list")).result).toHaveLength(1)
  client.close()
})

test("worker-limits, child-tools: under the default config a worker starts a worker of its own, told only its own task", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "helper", message: "go", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    call("start_worker", { task_name: "deeper", message: "dig", fork_turns: "none" }, "/root/helper"),
    call("wait_worker", { timeout_ms: 600_000 }, "/root/helper"),
    { text: "dug", agent: "/root/helper/deeper" },
    { text: "helper done", agent: "/root/helper" },
    { text: "all done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", {
      author: person("ada"),
      cwd: server.home.dir,
      instructions: "Report with attn when done.",
    })
  ).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "send a helper")
  await view.until(settled(1), DEADLINE)
  const helper = watchView(client, spawned(view, "/root/helper"))
  await helper.until(settled(1), DEADLINE)
  const deeper = watchView(client, spawned(helper, "/root/helper/deeper"))
  await deeper.until(settled(1), DEADLINE)
  // The deeper agent keeps what the helper inherited, not the helper's own notice.
  expect((deeper.view().docs["pi.agent"] as { instructions?: string }).instructions).toBe(
    "Report with attn when done.\n\nYour task name is /root/helper/deeper. You are a worker; your final answer goes to /root/helper.",
  )
  expect(mails(deeper)).toEqual([{ kind: "new_task", task: "/root/helper/deeper", sender: "/root/helper" }])
  // The helper's wait took the deeper agent's answer.
  expect(mails(helper)).toEqual([{ kind: "new_task", task: "/root/helper", sender: "/root" }])
  expect(transcript(deeper.seen()).slice(-2)).toEqual(["assistant: dug", "run_end: answered"])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: all done", "run_end: answered"])
  client.close()
})

const idle = (watch: ViewWatch) => (watch.view().docs["pi.live"] as { run?: unknown } | undefined)?.run === undefined

test("worker-interrupt, interrupt-idle: interrupting a conversation's run leaves its workers working, and interrupting it again, idle, stops them, so the tree goes idle", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "slow", message: "make it", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    call("bash", { command: "touch made" }, "/root/slow"),
    call("list_workers", {}),
    call("assign_worker", { target: "slow", message: "try again" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { text: "made it this time", agent: "/root/slow" },
    { text: "slow is done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "start a slow one")
  await view.until((current) => toolResults(current).length > 0)
  const slow = watchView(client, spawned(view, "/root/slow"))
  // The subagent waits on a person while its parent waits on it.
  await waitingApproval(slow)

  await client.call("conversation/interrupt", { author: person("ada"), conversation })
  await view.until(settled(1))
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  // The subagent still waits on the person.
  expect(Object.keys(approvalsOf(slow)!.requests)).toHaveLength(1)
  expect(runEnds(slow.seen())).toEqual([])

  await client.call("conversation/interrupt", { author: person("ada"), conversation })
  await slow.until(settled(1))
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  expect(runEnds(slow.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  expect(approvalsOf(slow)!.requests).toEqual({})
  await view.until(idle)
  await slow.until(idle)
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)

  // The subagent stays in the tree, and takes a new task.
  await submit(client, conversation, "go on")
  await view.until(settled(2), DEADLINE)
  expect(JSON.parse(toolResults(view).at(-3)!.text).workers).toEqual([
    { name: "/root", status: "running" },
    { name: "/root/slow", status: "interrupted" },
  ])
  expect(transcript(slow.seen()).slice(-2)).toEqual(["assistant: made it this time", "run_end: answered"])
  expect(JSON.parse(toolResults(view).at(-1)!.text).received).toEqual([
    { from: "/root/slow", kind: "final_answer", text: "made it this time" },
  ])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: slow is done", "run_end: answered"])
  client.close()
})

type Listed = {
  id: string
  number: number
  title?: string
  cwd: string
  target: string
  model: { provider: string; model?: string; effort?: string }
  approvals: string
  lineage?: Record<string, string>
  instructions?: string
  ended?: { outcome: string; message?: string; said?: string }
}
const list = async (client: RawClient) => {
  const reply = await client.call("conversation/list")
  if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error))
  return reply.result as Array<Listed>
}

test("worker-start, worker-model: conversation/list shows each worker with its lineage, on its parent's model or the one its start_worker names, and an unlisted model fails the call", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "same", message: "go", fork_turns: "none" }),
    call("start_worker", { task_name: "other", message: "go", fork_turns: "none", model: "script-code-mode" }),
    call("start_worker", { task_name: "nope", message: "go", fork_turns: "none", model: "no-such-model" }),
    { text: "spawned" },
    { text: "same done", agent: "/root/same" },
    { text: "other done", agent: "/root/other" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", {
      author: person("ada"),
      cwd: server.home.dir,
      id: "lead",
      instructions: "Be brief.",
    })
  ).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate")
  await view.until(settled(1), DEADLINE)
  const same = watchView(client, spawned(view, "/root/same"))
  const other = watchView(client, spawned(view, "/root/other"))
  await same.until(settled(1), DEADLINE)
  await other.until(settled(1), DEADLINE)
  expect(toolResults(view)[2]).toEqual({
    text: expect.stringContaining("no model no-such-model on script"),
    isError: true,
  })
  const calls = view
    .seen()
    .filter((entry) => entry.kind === "pi.assistant")
    .flatMap((entry) => (entry.model![0] as { content: Array<{ type: string; id?: string }> }).content)
    .filter((block) => block.type === "toolCall")
    .map((block) => block.id!)
  const listed = await list(client)
  expect(listed).toEqual([
    {
      id: "lead",
      number: expect.any(Number),
      title: "delegate",
      cwd: server.home.dir,
      target: "local",
      model: { provider: "script", model: "script" },
      approvals: "ask",
      instructions: "Be brief.",
      ended: { outcome: "answered", said: "spawned" },
    },
    {
      id: spawned(view, "/root/same"),
      number: Number(spawned(view, "/root/same")),
      title: "same",
      cwd: server.home.dir,
      target: "local",
      model: { provider: "script", model: "script" },
      approvals: "ask",
      lineage: { parent: "lead", root: "lead", call: calls[0]!, title: "same", task: "/root/same" },
      ended: { outcome: "answered", said: "same done" },
    },
    {
      id: spawned(view, "/root/other"),
      number: Number(spawned(view, "/root/other")),
      title: "other",
      cwd: server.home.dir,
      target: "local",
      model: { provider: "script", model: "script-code-mode" },
      approvals: "ask",
      lineage: { parent: "lead", root: "lead", call: calls[1]!, title: "other", task: "/root/other" },
      ended: { outcome: "answered", said: "other done" },
    },
  ])
  client.close()
})

test("model-switch, model-switch-provider: switching a conversation's model is recorded with who switched it, and the next run answers on it", async () => {
  await using server = await runningServer([{ text: "first" }, { text: "second" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  const selection = { provider: "script", model: "script-code-mode", effort: "low" }
  expect(
    (await client.call("conversation/select_model", { conversation, author: person("bo"), selection })).error,
  ).toBe(undefined)
  await submit(client, conversation, "two")
  await view.until(settled(2))
  const switched = view.seen().filter((entry) => entry.kind === "sigma.model")
  expect(switched.map((entry) => entry.data)).toEqual([{ author: person("bo"), selection }])
  const answers = view.seen().filter((entry) => entry.kind === "pi.assistant")
  expect(answers.map((entry) => (entry.model![0] as { model: string }).model)).toEqual(["script", "script-code-mode"])
  expect((await list(client))[0]!.model).toEqual(selection)
  const unknown = await client.call("conversation/select_model", {
    conversation,
    author: person("bo"),
    selection: { provider: "nowhere" },
  })
  expect(errorTag(unknown)).toBe("UnknownProvider")
  client.close()
})

test("model-switch: a switch made while a run works is recorded at once and answers from the next run, not mid-run", async () => {
  await using server = await runningServer([...ECHO, { text: "next" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "check it")
  const approval = await waitingApproval(view)
  const selection = { provider: "script", model: "script-code-mode" }
  expect(
    (await client.call("conversation/select_model", { conversation, author: person("bo"), selection })).error,
  ).toBe(undefined)
  await view.until((current) => current.seen().some((entry) => entry.kind === "sigma.model"))
  await client.call("approval/resolve", { conversation, approval, author: person("ada"), allow: true })
  await view.until(settled(1))
  await submit(client, conversation, "again")
  await view.until(settled(2))
  const answers = view.seen().filter((entry) => entry.kind === "pi.assistant")
  expect(answers.map((entry) => (entry.model![0] as { model: string }).model)).toEqual([
    "script",
    "script",
    "script-code-mode",
  ])
  expect((await list(client))[0]!.model).toEqual(selection)
  client.close()
})

test("entries-rpc: a client reads a long transcript a page at a time, newest first or in order from an entry", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }, { text: "c" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  for (const [index, text] of ["one", "two", "three"].entries()) {
    await submit(client, conversation, text)
    await view.until(settled(index + 1))
  }
  const all = view.seen()
  const page = async (args: Record<string, unknown>) =>
    (await client.call("conversation/entries", { conversation, ...args })).result as {
      entries: typeof all
      next?: unknown
    }
  const pages: Array<typeof all> = []
  let cursor: unknown
  do {
    const read = await page({ limit: 4, ...(cursor === undefined ? {} : { cursor }) })
    pages.push(read.entries)
    cursor = read.next
  } while (cursor !== undefined)
  expect(pages.length).toBe(Math.ceil(all.length / 4))
  expect(pages.flat()).toEqual([...all].reverse())
  const two = all.findIndex((entry) => transcript([entry])[0] === "user: two")
  const middle = await page({ from: all[two]!.id, to: all[two + 2]!.id, order: "ascending", limit: 10 })
  expect(transcript(middle.entries)).toEqual(["user: two", "assistant: b", "run_end: answered"])
  expect(middle.next).toBeUndefined()
  const refused = await client.call("conversation/entries", { conversation, limit: 0 })
  expect(refused.error?.message).toContain("limit")
  expect(errorTag(await client.call("conversation/entries", { conversation: "99", limit: 1 }))).toBe(
    "NoSuchConversation",
  )
  client.close()
})

test("context-rpc: a client reads the exact context the model is sent, now or as it was at an entry", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const other = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  await submit(client, conversation, "two")
  await view.until(settled(2))
  const context = async (at?: number) =>
    (await client.call("conversation/context", { conversation, ...(at === undefined ? {} : { at }) })).result as {
      messages: Array<{ role: string; content: unknown }>
      entries: Array<number>
    }
  const roles = (read: { messages: Array<{ role: string }> }) => read.messages.map((message) => message.role)
  const now = await context()
  expect(roles(now).filter((role) => role !== "system")).toEqual(["user", "assistant", "user", "assistant"])
  const firstAnswer = view.seen().find((entry) => entry.kind === "pi.assistant")!.id
  const then = await context(firstAnswer)
  expect(roles(then).filter((role) => role !== "system")).toEqual(["user", "assistant"])
  expect(then.entries.at(-1)).toBe(firstAnswer)
  const foreign = watchView(client, other)
  await opened(foreign)
  await submit(client, other, "elsewhere")
  await foreign.until(settled(1))
  const notHere = await client.call("conversation/context", { conversation, at: foreign.seen()[0]!.id })
  expect(errorTag(notHere)).toBe("NoSuchEntry")
  client.close()
})

test("wire-malformed: a call missing a field is answered with an error that names it, and the connection goes on", async () => {
  await using server = await runningServer([{ text: "fine" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const missing = await client.call("conversation/submit", { conversation, requestId: "r", author: person("ada") })
  // It names the field in words, not in the cause encoded as JSON.
  expect(missing.error?.message).toContain("text")
  expect(missing.error?.message).not.toContain('"_tag"')
  const view = watchView(client, conversation)
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual(["user: hi", "assistant: fine", "run_end: answered"])
  client.close()
})

test("wire-errors: every error a call answers says what went wrong in its message, a fault included, and keeps the cause in its data", async () => {
  await using server = await runningServer([{ text: "fine" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const replies = {
    noConversation: await client.call("conversation/continue", { author: person("ada"), conversation: "nope" }),
    noSubmission: await client.call("submission/withdraw", { author: person("ada"), conversation, submission: 9999 }),
    noEntry: await client.call("conversation/fork", { author: person("ada"), conversation, at: 9999 }),
    badParams: await client.call("conversation/configure", { conversation, author: person("ada"), maxTurns: 0 }),
    noMethod: await client.call("conversation/frobnicate", {}),
  }
  expect(Object.fromEntries(Object.entries(replies).map(([name, reply]) => [name, reply.error?.message]))).toEqual({
    noConversation: "no conversation nope",
    noSubmission: "the conversation has no submission 9999",
    noEntry: "the conversation's transcript has no entry 9999",
    // The fault's own words, which Effect writes: what sigma promises is that they name the thing, not their wording.
    badParams: expect.stringContaining("maxTurns"),
    noMethod: expect.stringContaining("conversation/frobnicate"),
  })
  for (const reply of [replies.badParams, replies.noMethod]) expect(reply.error?.message).not.toContain('"_tag"')
  expect(errorTag(replies.noConversation)).toBe("NoSuchConversation")
  expect(replies.badParams.error?.data).toEqual([{ _tag: "Die", defect: expect.stringContaining("maxTurns") }])
  client.close()
})

test("approval-ask: a call that changes things waits for a person, and every client sees what it asks and that the tree waits", async () => {
  await using server = await runningServer(ECHO)
  const client = await RawClient.connect(server.home.socket)
  const status = client.watch<Trees>("status/watch")
  await status.until((items) => items.length > 0)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "check it")
  const approval = await waitingApproval(view)
  expect(approvalsOf(view)!.requests[approval]).toMatchObject({ tool: "bash", arguments: { command: "echo approved" } })
  await status.until((items) => treesOf(items, conversation).at(-1)?.status === "waiting")
  await client.call("approval/resolve", { conversation, approval, author: person("ada"), allow: true })
  await view.until(settled(1))
  client.close()
})

test("conversation-ended: conversation/list tells a client that was not watching how a conversation's last run ended, also after a restart", async () => {
  const home = tempHome()
  try {
    let conversation: string
    {
      await using server = await runningServer(
        [{ text: "all done" }, { text: "Writing the note.", tool: { name: "bash", input: { command: "echo hi" } } }],
        { home },
      )
      const client = await RawClient.connect(server.home.socket)
      conversation = await start(client, home.dir)
      const endedOf = async () => (await list(client)).find((listed) => listed.id === conversation)?.ended
      expect(await endedOf()).toBeUndefined()
      const view = watchView(client, conversation)
      await submit(client, conversation, "go")
      await view.until(settled(1))
      expect(await endedOf()).toEqual({ outcome: "answered", said: "all done" })
      await submit(client, conversation, "write a note")
      await waitingApproval(view)
      expect(await endedOf()).toEqual({ outcome: "answered", said: "all done" })
      await client.call("conversation/interrupt", { author: person("ada"), conversation })
      await view.until(settled(2))
      expect(await endedOf()).toEqual({ outcome: "interrupted", message: "aborted", said: "Writing the note." })
      client.close()
    }
    await using server = await runningServer([], { home })
    const client = await RawClient.connect(server.home.socket)
    expect((await list(client)).find((listed) => listed.id === conversation)?.ended).toEqual({
      outcome: "interrupted",
      message: "aborted",
      said: "Writing the note.",
    })
    client.close()
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test("reopen-continue: a conversation reopened from a new server and connection goes on with a new prompt", async () => {
  const home = tempHome()
  try {
    let conversation: string
    {
      await using server = await runningServer([{ text: "before" }], { home })
      const client = await RawClient.connect(server.home.socket)
      conversation = await start(client, home.dir)
      const view = watchView(client, conversation)
      await submit(client, conversation, "one")
      await view.until(settled(1))
      client.close()
    }
    await using server = await runningServer([{ text: "after" }], { home })
    const client = await RawClient.connect(server.home.socket)
    const view = watchView(client, conversation)
    await opened(view)
    await submit(client, conversation, "two")
    await view.until(settled(2))
    expect(transcript(view.view().entries)).toEqual([
      "user: one",
      "assistant: before",
      "run_end: answered",
      "user: two",
      "assistant: after",
      "run_end: answered",
    ])
    client.close()
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

/** Every state the view went through, in order: the first view and each change applied to it. */
const states = (watch: ViewWatch) => {
  const views: Array<View> = []
  for (const item of watch.items) {
    views.push(item._tag === "view" ? item.view : applyImmutable(views.at(-1), item.ops as ReadonlyArray<Op>))
  }
  return views
}
type Slot = { callId: string; status: string; output?: string }
const liveSlots = (view: View) => (view.docs["pi.live"] as { tools?: Array<Slot> } | undefined)?.tools ?? []
/** Each running call's live output, in every state the view went through. */
const liveOutputs = (watch: ViewWatch) =>
  states(watch).flatMap((view) => liveSlots(view).flatMap((slot) => (slot.output === undefined ? [] : [slot.output])))
/** A shell loop that waits until the test makes `file`, so a command's next step follows what the test saw. */
const waitFor = (file: string) => `while [ ! -e ${file} ]; do sleep 0.01; done`
const workdir = (home: { dir: string }) => {
  const dir = `${home.dir}/work`
  mkdirSync(dir)
  return dir
}

test("tool-output-live: a running command's output streams live and ends as its result", async () => {
  await using server = await runningServer([
    { tool: { name: "bash", input: { command: `echo first; ${waitFor("go")}; echo second` } } },
    { text: "done" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "run it")
  await view.until((current) => liveSlots(current.view()).some((slot) => slot.output === "first\n"))
  expect(runEnds(view.seen())).toEqual([])
  writeFileSync(`${cwd}/go`, "")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: "first\nsecond\n", isError: false }])
  expect(liveSlots(view.view()).every((slot) => slot.output === undefined)).toBe(true)
  client.close()
})

test("tool-output-live: a command's output keeps characters split across reads and between streams whole", async () => {
  await using server = await runningServer([
    {
      tool: {
        name: "bash",
        input: { command: "printf '\\342'; sleep 0.1; printf 'err\\n' >&2; sleep 0.1; printf '\\202\\254\\n'" },
      },
    },
    { text: "done" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "euro")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: "err\n€\n", isError: false }])
  expect(liveOutputs(view).some((output) => output.includes("�"))).toBe(false)
  client.close()
})

test("tool-output-live: a verbose command's live output stays a bounded tail", async () => {
  await using server = await runningServer([
    {
      tool: { name: "bash", input: { command: `head -c 2000000 /dev/zero | tr '\\0' x; echo end; ${waitFor("go")}` } },
    },
    { text: "done" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "flood")
  await view.until((current) => liveSlots(current.view()).some((slot) => slot.output?.endsWith("end\n")))
  writeFileSync(`${cwd}/go`, "")
  await view.until(settled(1))
  const outputs = liveOutputs(view)
  expect(Math.max(...outputs.map((output) => Buffer.byteLength(output)))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
  // The model gets the same tail, and is told how much was dropped.
  expect(toolResults(view)[0]!.text).toMatch(
    /^x+end\n<harness>\n.*\n\[warn\] Output truncated to its end: 0 lines, \d+ bytes dropped\n<\/harness>$/,
  )
  client.close()
})

test("tool-output-live: output a background process writes after its call ends never reaches the conversation", async () => {
  await using server = await runningServer([
    // The call's output pipe is closed once it ends, so the late echo fails (SIGPIPE, ignored here) and the process
    // still marks that it tried.
    {
      tool: {
        name: "bash",
        input: { command: `(trap '' PIPE; ${waitFor("go")}; echo late; touch wrote) & echo now` },
      },
    },
    { tool: { name: "bash", input: { command: waitFor("wrote") } } },
    { text: "done" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "background")
  await view.until((current) => toolResults(current).length > 0)
  writeFileSync(`${cwd}/go`, "")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([
    { text: "now\n", isError: false },
    { text: expect.not.stringContaining("late"), isError: false },
  ])
  expect(liveOutputs(view).some((output) => output.includes("late"))).toBe(false)
  client.close()
})

test("tool-grep-lines: grep reports only the lines a file has, whatever its line endings", async () => {
  await using server = await runningServer([{ tool: { name: "grep", input: { pattern: "^$" } } }, { text: "done" }])
  const cwd = workdir(server.home)
  await Bun.write(`${cwd}/notes.txt`, "alpha\n\nbeta\n")
  await Bun.write(`${cwd}/windows.txt`, "alpha\r\n\r\nbeta\r\n")
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "blank lines")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: "notes.txt:2:\nwindows.txt:2:", isError: false }])
  client.close()
})

test("approval-interrupt: interrupting while sigma waits for an answer withdraws the question", async () => {
  await using server = await runningServer([{ tool: { name: "bash", input: { command: "touch made" } } }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "make it")
  const approval = await waitingApproval(view)
  await client.call("conversation/interrupt", { author: person("ada"), conversation })
  await view.until(settled(1))
  expect(approvalsOf(view)!.requests).toEqual({})
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  const late = await client.call("approval/resolve", { conversation, approval, author: person("ada"), allow: true })
  expect(late.result).toEqual({ accepted: false })
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)
  client.close()
})

test("steer-wire, steer-place: a steering prompt reaches sigma during the run instead of after it", async () => {
  await using server = await runningServer([
    { tool: { name: "bash", input: { command: waitFor("go") } } },
    { text: "steered" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "start")
  await view.until((current) => liveSlots(current.view()).some((slot) => slot.status === "running"))
  await submit(client, conversation, "also do this", crypto.randomUUID(), person("ada"), true)
  writeFileSync(`${cwd}/go`, "")
  await view.until(settled(1))
  expect(callsAndResults(view)).toEqual([expect.stringContaining("call bash"), "result: "])
  expect(transcript(view.view().entries)).toEqual([
    "user: start",
    "assistant: ",
    "user: also do this",
    "assistant: steered",
    "run_end: answered",
  ])
  client.close()
})

test("worker-answer: a worker's answer reaches its idle parent as input that starts a run, so the parent acts on it", async () => {
  await using server = await runningServer([
    call("start_worker", { task_name: "kid", message: "look around", fork_turns: "none" }),
    { text: "asked the kid" },
    { tool: { name: "bash", input: { command: "echo looked" } }, agent: "/root/kid" },
    { text: "all quiet", agent: "/root/kid" },
    { text: "the kid says all quiet" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "ask the kid")
  // The kid holds on its approval until the parent's run has ended, so its answer reaches an idle parent.
  await view.until(settled(1))
  const child = spawned(view, "/root/kid")
  const approval = await waitingApproval(watchView(client, child))
  await client.call("approval/resolve", { conversation: child, approval, author: person("ada"), allow: true })
  await view.until(settled(2))
  expect(mails(view)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/kid" }])
  const kinds = view.seen().map((entry) => entry.kind)
  expect(kinds.slice(kinds.lastIndexOf("sigma.mail"))).toEqual(["sigma.mail", "pi.assistant", RUN_END_KIND])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: the kid says all quiet", "run_end: answered"])
  expect(runEnds(view.seen())).toHaveLength(2)
  client.close()
})

/** The text of each message of `conversation`'s context the model is sent, system messages left out. */
const contextOf = async (client: RawClient, conversation: string) => {
  const reply = await client.call("conversation/context", { conversation })
  const messages = (reply.result as { messages: Array<{ role: string; content: unknown }> }).messages
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const content = message.content
      const text =
        typeof content === "string"
          ? content
          : (content as Array<{ type: string; text?: string }>).map((block) => block.text ?? "").join("")
      return `${message.role}: ${text}`
    })
}

const liveOf = (watch: ViewWatch) =>
  watch.view().docs["pi.live"] as
    | {
        run?: unknown
        generation?: { retry?: { at: number; error: string } }
        compactions?: Array<{ trigger: string }>
        compactionFailure?: { error: string }
      }
    | undefined

test("fork-rpc, fork-shown: a fork goes on from an earlier entry with only what came before it and the settings as they are now, the list says what it forked, and the conversation it left is unchanged", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }, { text: "c" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  await submit(client, conversation, "two")
  await view.until(settled(2))
  const firstEnd = view.seen().find((entry) => entry.kind === RUN_END_KIND)!.id
  // Changed after the fork's entry, and still what the fork runs with.
  await client.call("conversation/configure", { conversation, author: person("bo"), maxTurns: 3 })
  const forked = await client.call("conversation/fork", {
    author: person("ada"),
    conversation,
    at: firstEnd,
    id: "other-way",
  })
  expect(forked.result).toEqual({ conversation: "other-way" })
  const fork = watchView(client, "other-way")
  await opened(fork)
  expect(fork.view().conversation.parent).toEqual({ conversationId: Number(conversation), at: firstEnd })
  expect(fork.view().docs["pi.agent"]).toMatchObject({ maxTurns: 3 })
  const listed = (await client.call("conversation/list")).result as Array<{
    id: string
    fork?: unknown
    title?: string
  }>
  expect(listed.find((each) => each.id === "other-way")).toMatchObject({
    fork: { of: conversation, at: firstEnd },
    title: "one",
  })
  expect(listed.find((each) => each.id === conversation)!.fork).toBe(undefined)
  await submit(client, "other-way", "three")
  await fork.until(settled(2))
  expect(transcript(fork.seen())).toEqual([
    "user: one",
    "assistant: a",
    "run_end: answered",
    "user: three",
    "assistant: c",
    "run_end: answered",
  ])
  expect(await contextOf(client, "other-way")).toEqual(["user: one", "assistant: a", "user: three", "assistant: c"])
  expect(transcript(view.seen())).toEqual([
    "user: one",
    "assistant: a",
    "run_end: answered",
    "user: two",
    "assistant: b",
    "run_end: answered",
  ])
  const unnamed = await client.call("conversation/fork", { author: person("ada"), conversation, at: firstEnd })
  expect((unnamed.result as { conversation: string }).conversation).toMatch(/^\d+$/)
  expect(
    errorTag(
      await client.call("conversation/fork", { author: person("ada"), conversation, at: firstEnd, id: "other-way" }),
    ),
  ).toBe("InvalidConversationId")
  expect(errorTag(await client.call("conversation/fork", { author: person("ada"), conversation, at: 9999 }))).toBe(
    "NoSuchEntry",
  )
  client.close()
})

test("reset-rpc, reset-handoff: a reset starts an empty context with the handoff as its first message, and the transcript keeps everything", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  expect(
    (await client.call("conversation/reset", { conversation, author: person("bo"), handoff: "we were counting" }))
      .error,
  ).toBe(undefined)
  await view.until((current) => current.seen().some((entry) => entry.kind === "pi.reset"))
  const reset = view.seen().find((entry) => entry.kind === "pi.reset")!
  expect(reset.data).toEqual({ author: person("bo") })
  expect(await contextOf(client, conversation)).toEqual(["user: we were counting"])
  await submit(client, conversation, "two")
  await view.until(settled(2))
  expect(await contextOf(client, conversation)).toEqual(["user: we were counting", "user: two", "assistant: b"])
  expect(transcript(view.seen())).toEqual([
    "user: one",
    "assistant: a",
    "run_end: answered",
    "user: two",
    "assistant: b",
    "run_end: answered",
  ])
  client.close()
})

test("compact-rpc, compaction-live-status: compacting shows live, then a summary replaces the context; a failed one says why", async () => {
  // Past the 20,000 tokens a summary keeps by default, so the run before it is summarized.
  const long = "word ".repeat(20_000)
  using held = hold()
  await using server = await runningServer([
    { text: "a" },
    { text: "b" },
    { text: "summary of one", hold: held.path },
    { text: "c" },
    { fail: "the summary model is gone" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  const compact = (instructions?: string) =>
    client.call("conversation/compact", {
      conversation,
      author: person("ada"),
      ...(instructions === undefined ? {} : { instructions }),
    })
  expect((await compact()).result).toEqual({ outcome: "nothing_to_compact" })
  await submit(client, conversation, long)
  await view.until(settled(1))
  await submit(client, conversation, long)
  await view.until(settled(2))
  const compacting = compact()
  await view.until((current) => (liveOf(current)?.compactions ?? []).length > 0)
  expect(liveOf(view)!.compactions!.map((status) => status.trigger)).toEqual(["manual"])
  const summary = view.seen().find((entry) => entry.kind === "pi.compaction")
  expect(summary).toBe(undefined)
  held.release()
  expect((await compacting).result).toEqual({ outcome: "compacted" })
  await view.until((current) => current.seen().some((entry) => entry.kind === "pi.compaction"))
  expect(liveOf(view)?.compactions).toBe(undefined)
  const context = await contextOf(client, conversation)
  expect(context[0]).toContain("summary of one")
  expect(context.slice(1)).toEqual([`user: ${long}`, "assistant: b"])
  await submit(client, conversation, long)
  await view.until(settled(3))
  expect((await compact("keep the numbers")).result).toMatchObject({ outcome: "failed" })
  expect(liveOf(view)!.compactionFailure!.error).toContain("the summary model is gone")
  client.close()
})

test("continue-rpc: a conversation whose run failed goes on with no new input; one that works, never ran or answered is refused by name", async () => {
  await using server = await runningServer([
    { fail: "provider went away" },
    { text: "back on it", tool: { name: "bash", input: { command: "echo held" } } },
    { text: "back on it now" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  const go = () => client.call("conversation/continue", { author: person("ada"), conversation })
  expect(errorTag(await go())).toBe("NothingToContinue")
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  expect((await go()).error).toBe(undefined)
  // The run waits on its approval, so it is still working when continue is asked again.
  const approval = await waitingApproval(view)
  expect(errorTag(await go())).toBe("ConversationBusy")
  await client.call("approval/resolve", { conversation, approval, author: person("bo"), allow: true })
  await view.until(settled(2))
  expect(errorTag(await go())).toBe("NothingToContinue")
  expect(transcript(view.seen())).toEqual([
    "user: hi",
    "assistant:  [error]",
    "run_end: failed (provider went away)",
    "assistant: back on it",
    "assistant: back on it now",
    "run_end: answered",
  ])
  client.close()
})

test("continue-rpc: continue while a run works says the conversation is busy, whether the run before it answered or none has ended", async () => {
  await using server = await runningServer([
    { text: "checking", tool: { name: "bash", input: { command: "echo held" } } },
    { text: "first done" },
    { text: "checking again", tool: { name: "bash", input: { command: "echo held" } } },
    { text: "second done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  const go = () => client.call("conversation/continue", { author: person("ada"), conversation })
  // Each run waits on its approval, so it is still working when continue is asked.
  await submit(client, conversation, "one")
  const first = await waitingApproval(view)
  expect(errorTag(await go())).toBe("ConversationBusy")
  await client.call("approval/resolve", { conversation, approval: first, author: person("bo"), allow: true })
  await view.until(settled(1))
  await submit(client, conversation, "two")
  const second = await waitingApproval(view)
  expect(errorTag(await go())).toBe("ConversationBusy")
  await client.call("approval/resolve", { conversation, approval: second, author: person("bo"), allow: true })
  await view.until(settled(2))
  expect(errorTag(await go())).toBe("NothingToContinue")
  client.close()
})

test("withdraw-rpc: a queued prompt taken back never runs, and one already run cannot be", async () => {
  await using server = await runningServer(ECHO)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  const first = (await submit(client, conversation, "one")).result as { submission: number }
  // The run waits on its approval, so "two" waits in the queue.
  const approval = await waitingApproval(view)
  const second = (await submit(client, conversation, "two", "two")).result as { submission: number }
  const inbox = () => (view.view().docs["pi.inbox"] as { items: Array<{ id: number }> }).items.map((item) => item.id)
  await view.until(() => inbox().includes(second.submission))
  const withdraw = (submission: number) =>
    client.call("submission/withdraw", { author: person("ada"), conversation, submission })
  expect((await withdraw(second.submission)).result).toEqual({ result: "withdrawn" })
  expect(inbox()).not.toContain(second.submission)
  await client.call("approval/resolve", { conversation, approval, author: person("bo"), allow: true })
  await view.until(settled(1))
  expect(transcript(view.seen())).toEqual([
    "user: one",
    "assistant: checking",
    "withdrawn: two",
    "assistant: all done",
    "run_end: answered",
  ])
  expect((await withdraw(first.submission)).result).toEqual({ result: "settled" })
  expect(errorTag(await withdraw(9999))).toBe("NoSuchSubmission")
  client.close()
})

test("queue-update: a queued prompt changes its text and its mode in place, keeping its place, and one already run cannot change", async () => {
  await using server = await runningServer(ECHO)
  const ada = await RawClient.connect(server.home.socket)
  const bo = await RawClient.connect(server.home.socket)
  const conversation = await start(ada, server.home.dir)
  const view = watchView(bo, conversation)
  const first = (await submit(ada, conversation, "one", "one")).result as { submission: number }
  // The run waits on its approval, so "two" and "three" wait in the queue.
  const approval = await waitingApproval(view)
  const second = (await submit(ada, conversation, "two", "two")).result as { submission: number }
  const third = (await submit(ada, conversation, "three", "three")).result as { submission: number }
  type Item = { id: number; mode: string; content: unknown; entry: { data: Record<string, unknown> } }
  const inbox = () => (view.view().docs["pi.inbox"] as { items: Item[] }).items
  await view.until(() => inbox().length === 2)
  const update = (submission: number, change: { text?: string; steer?: boolean }) =>
    bo.call("submission/update", { conversation, submission, author: person("bo"), ...change })

  expect((await update(second.submission, { text: "two, edited", steer: true })).result).toEqual({ result: "updated" })
  // Bo's client sees the change, and the item is still first in line under its own id and requestId.
  await view.until(() => inbox()[0]?.mode === "steer")
  expect(inbox().map((item) => item.id)).toEqual([second.submission, third.submission])
  expect(inbox()[0]).toMatchObject({
    content: "two, edited",
    entry: { data: { author: person("ada"), requestId: "two", editedBy: person("bo") } },
  })
  expect(inbox()[1]).toMatchObject({ mode: "followUp", content: "three" })
  expect(inbox()[1]!.entry.data).not.toHaveProperty("editedBy")

  // The run took "one" in already.
  expect((await update(first.submission, { text: "uno" })).result).toEqual({ result: "already_placed" })
  expect(errorTag(await update(9999, { text: "x" }))).toBe("NoSuchSubmission")

  await ada.call("approval/resolve", { conversation, approval, author: person("ada"), allow: true })
  await view.until(settled(2))
  // The steer reaches the run in flight with its new text; the follow-up runs after, as it was.
  expect(transcript(view.seen()).filter((line) => line.startsWith("user: "))).toEqual([
    "user: one",
    "user: two, edited",
    "user: three",
  ])
  expect(
    view
      .seen()
      .filter((entry) => entry.kind === USER_KIND)
      .map((entry) => entry.data),
  ).toEqual([
    { author: person("ada"), requestId: "one" },
    { author: person("ada"), requestId: "two", editedBy: person("bo") },
    { author: person("ada"), requestId: "three" },
  ])
  expect((await update(first.submission, { text: "uno" })).result).toEqual({ result: "settled" })
  ada.close()
  bo.close()
})

test("author-every-change: two people steer one conversation, and its committed entries name who made each change", async () => {
  // Past the 20,000 tokens a summary keeps by default, so the compaction has a run to summarize.
  const long = "word ".repeat(20_000)
  const held = { tool: { name: "bash", input: { command: "echo held" } } }
  await using server = await runningServer([
    { text: "a" },
    { text: "b" },
    { text: "summary of both" },
    { text: "checking", ...held },
    { text: "checking again", ...held },
    { text: "done" },
  ])
  const ada = await RawClient.connect(server.home.socket)
  const bo = await RawClient.connect(server.home.socket)
  const conversation = (
    await ada.call("conversation/start", { cwd: server.home.dir, id: "shared", author: person("ada") })
  ).result.conversation as string
  const view = watchView(bo, conversation)
  await submit(ada, conversation, long, undefined, person("ada"))
  await view.until(settled(1))
  await submit(bo, conversation, long, undefined, person("bo"))
  await view.until(settled(2))
  expect((await ada.call("conversation/compact", { conversation, author: person("ada") })).result).toEqual({
    outcome: "compacted",
  })
  // The run waits on its approval, so bo's prompt waits in the queue until ada withdraws it, and bo interrupts.
  await submit(ada, conversation, "go", undefined, person("ada"))
  await waitingApproval(view)
  const queued = (await submit(bo, conversation, "later", "later", person("bo"))).result as { submission: number }
  const withdrawn = await ada.call("submission/withdraw", {
    conversation,
    submission: queued.submission,
    author: person("ada"),
  })
  expect(withdrawn.result).toEqual({ result: "withdrawn" })
  await bo.call("conversation/interrupt", { conversation, author: person("bo") })
  await view.until(settled(3))
  expect((await ada.call("conversation/continue", { conversation, author: person("ada") })).error).toBe(undefined)
  const approval = await waitingApproval(view)
  await bo.call("approval/resolve", { conversation, approval, author: person("bo"), allow: true })
  await view.until(settled(4))
  await bo.call("conversation/select_model", { conversation, author: person("bo"), selection: { provider: "script" } })
  const last = view.seen().at(-1)!.id
  const fork = (await bo.call("conversation/fork", { conversation, at: last, author: person("bo") })).result
    .conversation as string

  // A client that saw none of it reads who did what from the committed transcript.
  const reader = await RawClient.connect(server.home.socket)
  const authored = async (id: string) => {
    const page = await reader.call("conversation/entries", { conversation: id, order: "ascending", limit: 200 })
    return (page.result.entries as ReadonlyArray<EntryRecord>).flatMap((entry) => {
      const author = (entry.data as { author?: unknown } | undefined)?.author
      return author === undefined ? [] : [{ kind: entry.kind, author }]
    })
  }
  const changes = [
    { kind: "sigma.started", author: person("ada") },
    { kind: "sigma.user", author: person("ada") },
    { kind: "sigma.user", author: person("bo") },
    { kind: "pi.compaction", author: person("ada") },
    { kind: "sigma.user", author: person("ada") },
    { kind: "sigma.withdrawn", author: person("ada") },
    { kind: "sigma.interrupted", author: person("bo") },
    { kind: "sigma.continued", author: person("ada") },
    { kind: "sigma.approval", author: person("bo") },
    { kind: "sigma.model", author: person("bo") },
  ]
  expect(await authored(conversation)).toEqual(changes)
  expect(await authored(fork)).toEqual([...changes, { kind: "sigma.forked", author: person("bo") }])
  ada.close()
  bo.close()
  reader.close()
})

test("configure-rpc, run-turn-limit: the transcript says who set the turn limit, and the limit ends a looping run by name", async () => {
  const echo = { tool: { name: "bash", input: { command: "echo again" } } }
  await using server = await runningServer([echo, echo, echo, echo, { text: "b" }])
  const client = await RawClient.connect(server.home.socket)
  const reply = await client.call("conversation/start", {
    author: person("ada"),
    cwd: server.home.dir,
    approvals: "auto",
  })
  const conversation = (reply.result as { conversation: string }).conversation
  const view = watchView(client, conversation)
  const configure = (maxTurns: unknown) =>
    client.call("conversation/configure", { conversation, author: person("bo"), maxTurns })
  expect((await configure(1)).error).toBe(undefined)
  await submit(client, conversation, "loop")
  await view.until(settled(1))
  expect(runEnds(view.seen())[0]).toEqual({ outcome: "failed", message: "reached the turn limit of 1 turn" })
  expect((await configure(null)).error).toBe(undefined)
  await submit(client, conversation, "two")
  await view.until(settled(2))
  // Two tool rounds, past the limit removed.
  expect(runEnds(view.seen())[1]!.outcome).toBe("answered")
  const configured = view.seen().filter((entry) => entry.kind === "sigma.configured")
  expect(configured.map((entry) => entry.data)).toEqual([
    { author: person("bo"), maxTurns: 1 },
    { author: person("bo"), maxTurns: null },
  ])
  expect((await configure(0)).error?.message).toContain("maxTurns")
  client.close()
})

test("usage-rpc, usage-per-model, usage-total, cache-shown: a client reads the tokens each conversation spent, by model, cached input apart, and the home's total", async () => {
  await using server = await runningServer([
    { text: "a", usage: { input: 100, output: 10, cacheWrite: 40 } },
    { text: "b", usage: { input: 200, output: 20, cacheRead: 1000 } },
    { text: "c", usage: { input: 50, output: 5 } },
  ])
  const client = await RawClient.connect(server.home.socket)
  const first = await start(client, server.home.dir)
  const second = await start(client, server.home.dir)
  for (const [conversation, prompts] of [
    [first, ["one", "two"]],
    [second, ["three"]],
  ] as const) {
    const view = watchView(client, conversation)
    for (const [index, prompt] of prompts.entries()) {
      await submit(client, conversation, prompt)
      await view.until(settled(index + 1))
    }
  }
  const usage = async (conversation?: string) =>
    (await client.call("usage/get", conversation === undefined ? {} : { conversation })).result as {
      models: Record<string, { input: number; output: number; totalTokens: number }>
    }
  expect((await usage(first)).models["script/script"]).toMatchObject({
    input: 300,
    output: 30,
    cacheRead: 1000,
    cacheWrite: 40,
    totalTokens: 1370,
  })
  expect((await usage(second)).models["script/script"]).toMatchObject({ input: 50, output: 5, totalTokens: 55 })
  expect((await usage()).models["script/script"]).toMatchObject({
    input: 350,
    output: 35,
    cacheRead: 1000,
    cacheWrite: 40,
    totalTokens: 1425,
  })
  expect(errorTag(await client.call("usage/get", { conversation: "99" }))).toBe("NoSuchConversation")
  client.close()
})

test("task-graph-rpc: a client watches the home's live work, a run and the call it waits on, until it is done, and the list names the conversation each works in", async () => {
  await using server = await runningServer(ECHO)
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", { author: person("ada"), cwd: server.home.dir, id: "talk" })
  ).result.conversation as string
  const view = watchView(client, conversation)
  type Graph = { tasks: Record<string, { kind: string; conversationId: number; state: { status: string } }> }
  const watch = client.watch<{ _tag: "graph"; graph: Graph } | { _tag: "change"; ops: ReadonlyArray<Op> }>(
    "tasks/watch",
  )
  let graph: Graph | undefined
  let applied = 0
  const current = () => {
    for (; applied < watch.items.length; applied++) {
      const item = watch.items[applied]!
      graph = item._tag === "graph" ? item.graph : applyImmutable(graph, item.ops)
    }
    return graph!
  }
  await watch.until(() => current() !== undefined)
  expect(current().tasks).toEqual({})
  await submit(client, conversation, "check it")
  await waitingApproval(view)
  await watch.until(() => Object.values(current().tasks).some((task) => task.kind === "pi.tool"))
  const kinds = Object.values(current().tasks).map((task) => [task.kind, task.state.status])
  expect(kinds).toContainEqual(["pi.generation", "waiting"])
  // The graph names a conversation by its number, which the list joins to the id and title a person knows.
  const listed = (await client.call("conversation/list")).result as Array<{
    id: string
    number: number
    title?: string
  }>
  const working = new Set(Object.values(current().tasks).map((task) => task.conversationId))
  expect([...working].map((number) => listed.find((each) => each.number === number))).toEqual([
    expect.objectContaining({ id: "talk", title: "check it" }),
  ])
  const approval = Object.keys((view.view().docs["sigma.approvals"] as { requests: object }).requests)[0]!
  await client.call("approval/resolve", { conversation, approval, author: person("ada"), allow: true })
  await view.until(settled(1))
  await watch.until(() => Object.keys(current().tasks).length === 0)
  client.close()
})

test("run-retry-live: a provider hiccup shows its retry and when it comes, and stopping it ends the run", async () => {
  await using server = await runningServer([{ fail: "503 service unavailable" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "hi")
  await view.until((current) => liveOf(current)?.generation?.retry !== undefined)
  const retry = liveOf(view)!.generation!.retry!
  expect(retry.error).toContain("503")
  // When the retry comes is still ahead when a client first sees it.
  expect(retry.at).toBeGreaterThan(Date.now())
  await client.call("conversation/interrupt", { author: person("ada"), conversation })
  await view.until(settled(1))
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  client.close()
})

test("serve-read-only: a read-only server shows a home's conversations without resuming the run left in flight, and refuses every change by name", async () => {
  const home = tempHome()
  // Held while the writable server stops with the run in flight and the viewer looks; the resumed run goes on.
  using held = hold()
  const slow = { text: "one two three four five six seven eight", hold: held.path }
  let conversation = ""
  try {
    {
      await using writable = await runningServer([slow], { home })
      const client = await RawClient.connect(writable.home.socket)
      conversation = await start(client, home.dir)
      const view = watchView(client, conversation)
      await submit(client, conversation, "count")
      await view.until(speaking)
      client.close()
    }
    {
      // Had the viewer resumed the run, it would answer with this at once.
      await using viewer = await runningServer([{ text: "answered by the viewer" }], { home, readOnly: true })
      const client = await RawClient.connect(viewer.home.socket)
      expect(
        (await client.call("initialize", { client: "test", version: "0", protocol: PROTOCOL_VERSION })).result,
      ).toEqual({
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        readOnly: true,
      })
      const view = watchView(client, conversation)
      await opened(view)
      const said = transcript(view.seen())
      expect(said).toEqual(["user: count"])
      expect((view.view().docs["pi.live"] as { run?: unknown }).run).toBeDefined()
      expect(((await client.call("conversation/list")).result as Array<{ id: string }>).map((each) => each.id)).toEqual(
        [conversation],
      )
      const refused = await Promise.all([
        client.call("conversation/start", { author: person("ada"), cwd: home.dir }),
        submit(client, conversation, "more"),
        client.call("conversation/interrupt", { author: person("ada"), conversation }),
        client.call("conversation/reset", { conversation, author: person("bo") }),
        client.call("conversation/configure", { conversation, author: person("bo"), maxTurns: 2 }),
        client.call("conversation/fork", { author: person("ada"), conversation, at: view.seen()[0]!.id }),
        client.call("conversation/select_model", {
          conversation,
          author: person("bo"),
          selection: { provider: "script", model: "script" },
        }),
        client.call("conversation/compact", { conversation, author: person("bo") }),
        client.call("conversation/continue", { author: person("ada"), conversation }),
        client.call("submission/withdraw", { author: person("ada"), conversation, submission: 1 }),
        client.call("submission/update", { author: person("ada"), conversation, submission: 1, text: "x" }),
        client.call("approval/resolve", { conversation, approval: "1", author: person("bo"), allow: true }),
        client.call("auth/start", { provider: "openai" }),
        client.call("auth/logout", { provider: "openai" }),
      ])
      expect(refused.map(errorTag)).toEqual(Array(refused.length).fill("ReadOnlyServer"))
      expect(JSON.stringify(refused[0]!.error)).toContain("read-only")
      expect((await client.call("usage/get", {})).error).toBe(undefined)
      client.close()
    }
    {
      held.release()
      await using resumed = await runningServer([slow], { home })
      const client = await RawClient.connect(resumed.home.socket)
      const view = watchView(client, conversation)
      await view.until(settled(1))
      // What the first server had said when it closed stays, cut off, before the answer.
      const resumedSaid = transcript(view.seen())
      expect(resumedSaid[0]).toBe("user: count")
      expect(resumedSaid.slice(-2)).toEqual(["assistant: one two three four five six seven eight", "run_end: answered"])
      expect(resumedSaid.join("\n")).not.toContain("answered by the viewer")
      client.close()
    }
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

/** A server whose home reaches `targets` through their test connector. */
const targetServer = (targets: TestTargets, script: ReadonlyArray<ScriptStep>) =>
  runningServer(script, { config: { target_connector: targets.connector } })

const startOn = async (client: RawClient, target: string, cwd: string, extra: Record<string, unknown> = {}) =>
  client.call("conversation/start", { cwd, target, author: person("ada"), approvals: "auto", ...extra })

const listed = async (client: RawClient) =>
  (await client.call("conversation/list")).result as Array<{ id: string; target: string; cwd: string }>

test("target-start: a conversation started on a target runs its tools on the target's instance, in the target's folder", async () => {
  using targets = new TestTargets()
  const work = targets.add("box", "box-1")
  await using server = await targetServer(targets, [
    { tool: { name: "bash", input: { command: 'echo "$SIGMA_TARGET_INSTANCE" > made; pwd' } } },
    { text: "made it" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (await startOn(client, "box", work, { id: "on-box" })).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "make a file")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: `${work}\n`, isError: false }])
  // Written by a command that ran under the target's sigma-env.
  expect(readFileSync(join(work, "made"), "utf8")).toBe("box-1\n")
  expect((await listed(client)).map(({ id, target, cwd }) => ({ id, target, cwd }))).toEqual([
    { id: "on-box", target: "box", cwd: work },
  ])
  // An id that names a conversation keeps its target.
  const again = await startOn(client, "elsewhere", "/nowhere", { id: "on-box" })
  expect(again.result.conversation).toBe("on-box")
  expect((await listed(client)).map(({ target }) => target)).toEqual(["box"])
  client.close()
})

test("target-start: a conversation started without a target is local, as conversation/list says", async () => {
  await using server = await runningServer([])
  const client = await RawClient.connect(server.home.socket)
  await start(client, server.home.dir)
  expect((await listed(client)).map(({ target }) => target)).toEqual(["local"])
  client.close()
})

test("target-unavailable: a start on a target its connector cannot reach fails with the connector's reason and creates nothing", async () => {
  using targets = new TestTargets()
  await using server = await targetServer(targets, [])
  const client = await RawClient.connect(server.home.socket)
  const refused = await startOn(client, "nope", "/work", { id: "never" })
  expect(errorTag(refused)).toBe("TargetUnavailable")
  const failure = refused.error!.data.find((each) => each._tag === "Fail")!.error as unknown as {
    target: string
    reason: string
  }
  expect(failure).toMatchObject({ target: "nope", reason: "connector exited 3: no target named nope" })
  expect(await listed(client)).toEqual([])
  client.close()
})

test("target-unavailable: a home with no target_connector refuses a remote start, naming the setting", async () => {
  await using server = await runningServer([])
  const client = await RawClient.connect(server.home.socket)
  const refused = await startOn(client, "box", "/work")
  expect(errorTag(refused)).toBe("TargetUnavailable")
  const failure = refused.error!.data.find((each) => each._tag === "Fail")!.error as unknown as { reason: string }
  expect(failure.reason).toBe(
    `this home has no target_connector in ${join(server.home.dir, "config.toml")}; whatever runs sigma sets it to the command that reaches a target`,
  )
  expect(await listed(client)).toEqual([])
  client.close()
})

test("target-remote-hands: Claude Code can start on a target, and a conversation there can switch to it, since it runs only sigma's tools there", async () => {
  using targets = new TestTargets()
  const work = targets.add("box")
  await using server = await targetServer(targets, [])
  const client = await RawClient.connect(server.home.socket)
  const started = await startOn(client, "box", work, { provider: "claude" })
  expect(started.error).toBeUndefined()
  const conversation = (await startOn(client, "box", work)).result.conversation as string
  const switched = await client.call("conversation/select_model", {
    conversation,
    author: person("bo"),
    selection: { provider: "claude" },
  })
  expect(switched.error).toBeUndefined()
  const providers = (await list(client)).map((each) => each.model.provider).sort()
  expect(providers).toEqual(["claude", "claude"])
  client.close()
})

type TargetChange = { target: string; from: Record<string, string>; to: Record<string, string>; filesKept: boolean }
const targetChanges = (watch: ViewWatch) =>
  watch
    .seen()
    .filter((entry) => entry.kind === "sigma.target_changed")
    .map((entry) => entry.data as TargetChange)

/** The text of each system entry's `target` section, as the model is told it. */
const targetNotices = (watch: ViewWatch) =>
  watch.seen().flatMap((entry) => {
    const message = entry.model?.[0] as { role?: string; sections?: Record<string, string> } | undefined
    return message?.role === "system" && message.sections?.target !== undefined ? [message.sections.target] : []
  })

/**
 * A run whose first call stops the target's sigma-env after giving it new ids, as a restarted or replaced instance
 * would; the run's next request reaches the new one.
 */
const changeInstance = async (instance: string, files: string) => {
  const targets = new TestTargets()
  const work = targets.add("box", "box-1", "vol-1")
  const server = await targetServer(targets, [
    {
      tool: {
        name: "bash",
        input: { command: `echo ${instance} > ../instance; echo ${files} > ../files; ${targets.killCommand("box")}` },
      },
    },
    { text: "noted" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (await startOn(client, "box", work)).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "go")
  await view.until(settled(1))
  return {
    view,
    async [Symbol.asyncDispose]() {
      client.close()
      await server[Symbol.asyncDispose]()
      targets[Symbol.dispose]()
    },
  }
}

test("target-restarted: a new instance on the same files is committed as sigma.target_changed, and the model is told its files are kept before its next request", async () => {
  await using run = await changeInstance("box-2", "vol-1")
  expect(targetChanges(run.view)).toEqual([
    {
      target: "box",
      from: { instance: "box-1", files: "vol-1" },
      to: { instance: "box-2", files: "vol-1" },
      filesKept: true,
    },
  ])
  expect(targetNotices(run.view)).toEqual([
    "The computer behind this conversation restarted (now instance box-2). Your files are as you left them; processes you started are gone.",
  ])
  // Announced after the call that lost the instance, before the model's answer.
  const kinds = run.view.seen().map((entry) => entry.kind)
  expect(kinds.indexOf("sigma.target_changed")).toBeGreaterThan(kinds.indexOf("pi.tool-result"))
  expect(kinds.lastIndexOf("pi.system")).toBeLessThan(kinds.lastIndexOf("pi.assistant"))
  expect(transcript(run.view.seen()).slice(-2)).toEqual(["assistant: noted", "run_end: answered"])
})

test("target-replaced: a new instance on new files is committed with filesKept false, and the model is told what is gone", async () => {
  await using run = await changeInstance("box-9", "vol-9")
  expect(targetChanges(run.view)).toEqual([
    {
      target: "box",
      from: { instance: "box-1", files: "vol-1" },
      to: { instance: "box-9", files: "vol-9" },
      filesKept: false,
    },
  ])
  expect(targetNotices(run.view)).toEqual([
    "The computer behind this conversation was replaced (now instance box-9). Files, processes and changes from before are gone.",
  ])
})

test("target-lost: a call on a target that is gone fails with the connector's reason, and the run goes on to the model's next step", async () => {
  using targets = new TestTargets()
  const work = targets.add("box")
  await using server = await targetServer(targets, [
    { tool: { name: "bash", input: { command: `rm ../instance; ${targets.killCommand("box")}` } } },
    { tool: { name: "bash", input: { command: "echo still here" } } },
    { text: "the target is gone; reporting it" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (await startOn(client, "box", work)).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "go")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([
    { text: expect.stringContaining("target box unavailable: connector exited SIGKILL"), isError: true },
    { text: expect.stringContaining("target box unavailable: connector exited 3: no target named box"), isError: true },
  ])
  expect(targetChanges(view)).toEqual([])
  expect(transcript(view.seen()).slice(-2)).toEqual([
    "assistant: the target is gone; reporting it",
    "run_end: answered",
  ])
  client.close()
})

test("target-worker-fork: a worker's calls and a fork's calls act on their parent's target", async () => {
  using targets = new TestTargets()
  const work = targets.add("box", "box-1")
  const where = { tool: { name: "bash", input: { command: 'echo "$SIGMA_TARGET_INSTANCE $PWD"' } } }
  await using server = await targetServer(targets, [
    call("start_worker", { task_name: "helper", message: "look around", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { ...where, agent: "/root/helper" },
    { text: "looked", agent: "/root/helper" },
    { text: "helper looked" },
    where,
    { text: "the fork looked" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (await startOn(client, "box", work)).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate")
  await view.until(settled(1), DEADLINE)
  const helper = watchView(client, spawned(view, "/root/helper"))
  await helper.until(settled(1))
  expect(toolResults(helper)).toEqual([{ text: `box-1 ${work}\n`, isError: false }])

  const at = view.seen().findLast((entry) => entry.kind === "sigma.run_end")!.id
  const fork = (await client.call("conversation/fork", { author: person("ada"), conversation, at })).result
    .conversation as string
  const forked = watchView(client, fork)
  await submit(client, fork, "look yourself")
  await forked.until(settled(2))
  expect(toolResults(forked).at(-1)).toEqual({ text: `box-1 ${work}\n`, isError: false })
  const targetOf = async (id: string) => (await listed(client)).find((each) => each.id === id)!.target
  expect([await targetOf(spawned(view, "/root/helper")), await targetOf(fork)]).toEqual(["box", "box"])
  client.close()
})

test("ephemeral-refused: an ephemeral run is refused saying why on agy, which cannot run one, and on a read-only server", async () => {
  await using server = await runningServer()
  const client = await RawClient.connect(server.home.socket)
  const onAgy = await client.call("ephemeral/run", { provider: "agy", prompt: "hi" })
  expect(errorTag(onAgy)).toBe("EphemeralFailed")
  expect(onAgy.error!.message).toBe("agy cannot answer an ephemeral run")
  const unknown = await client.call("ephemeral/run", { provider: "nope", prompt: "hi" })
  expect(errorTag(unknown)).toBe("UnknownProvider")
  client.close()

  await using viewer = await runningServer([], { readOnly: true })
  const reader = await RawClient.connect(viewer.home.socket)
  const readOnly = await reader.call("ephemeral/run", { provider: "script", prompt: "hi" })
  expect(errorTag(readOnly)).toBe("ReadOnlyServer")
  reader.close()
})
