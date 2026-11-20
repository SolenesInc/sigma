// The TUI: the real TUI in a PTY on an @xterm/headless screen, typed into, against a real server.
import { afterEach, expect, test } from "bun:test"
import { readFileSync, rmSync, watch, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ScriptStep } from "@sigma/models"
import type { AuthState } from "@sigma/protocol"
import { FakeAgy } from "./support/agy.ts"
import { FakeClaude } from "./support/claude.ts"
import { TestTargets } from "./support/targets.ts"
import { FakeOpenAi, signIn } from "./support/openai.ts"
import { DEADLINE, deadline, RawClient } from "./support/raw.ts"
import {
  hold,
  scriptEnv,
  runningServer,
  serving,
  settled,
  start,
  submit,
  watchView,
  tempHome,
} from "./support/server.ts"
import { png } from "./support/png.ts"
import { screenSession, stopServer } from "./support/terminal.ts"

const homes: Array<ReturnType<typeof tempHome>> = []
const home = () => {
  const created = tempHome()
  homes.push(created)
  return created
}

afterEach(async () => {
  for (const created of homes.splice(0)) {
    await stopServer(created)
    rmSync(created.dir, { recursive: true, force: true })
  }
})

type Home = ReturnType<typeof tempHome>
type Session = ReturnType<typeof screenSession>

/** The TUI, in `sigmaHome`, whose server answers from `script` when the TUI starts it. */
const open = async (
  script: ReadonlyArray<ScriptStep> = [],
  args: Array<string> = [],
  sigmaHome: Home = home(),
  extra: Record<string, string | undefined> = {},
) => screenSession(args, { ...(await scriptEnv(sigmaHome, script)), ...extra })

const quit = async (session: Session) => {
  session.type("\x03")
  expect(await session.exited).toBe(0)
}

const call = (name: string, input: Record<string, unknown>, agent?: string): ScriptStep => ({
  tool: { name, input },
  ...(agent === undefined ? {} : { agent }),
})

/** The mouse wheel turned once over the transcript, as an SGR mouse report. */
const wheelUp = "\x1b[<64;20;5M"
const wheelDown = "\x1b[<65;20;5M"

/** Turns the wheel until `predicate` holds, waiting for each turn to show before the next. */
const scrollUntil = (wheel: string) => async (session: Session, predicate: (screen: string) => boolean) => {
  for (let turn = 0; turn < 400; turn++) {
    const before = session.screen()
    if (predicate(before)) return before
    session.type(wheel.repeat(5))
    // At an end, a turn changes nothing until a load or a commit does.
    await session.waitFor((screen) => screen !== before)
  }
  throw new Error(`never scrolled to it:\n${session.screen()}`)
}
const scrollUpUntil = scrollUntil(wheelUp)
const scrollDownUntil = scrollUntil(wheelDown)

/** `count` prompts `prompt 1`.. answered `answer 1`.., each run settled before the next is sent. */
const converse = async (client: RawClient, conversation: string, count: number, from = 1) => {
  const view = watchView(client, conversation)
  for (let n = from; n < from + count; n++) {
    await submit(client, conversation, `prompt ${n}`)
    await view.until(settled(n - from + 1))
  }
}

const answers = (count: number): Array<ScriptStep> =>
  Array.from({ length: count }, (_, n) => ({ text: `answer ${n + 1}` }))

test("answer-tui, answer-author: a person types a prompt, presses enter and reads the answer under their name", async () => {
  const session = await open([{ text: "hello ada" }])
  await session.waitFor((screen) => screen.includes("PROMPT") && screen.includes("READY"))
  session.type("hello sigma")
  await session.waitFor((screen) => screen.includes("hello sigma"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("hello ada") && screen.includes("READY"))
  expect(screen).toContain("ADA")
  expect(screen).toContain("SIGMA")
  await quit(session)
})

test("target-cli: sigma --target --cwd starts a conversation on the target, the TUI shows the target, and reopening shows it again", async () => {
  using targets = new TestTargets()
  const work = targets.add("box", "box-1")
  const sigmaHome = home()
  writeFileSync(join(sigmaHome.dir, "config.toml"), targets.configToml)
  const script = [
    { tool: { name: "bash", input: { command: 'echo "on $SIGMA_TARGET_INSTANCE"' } } },
    { text: "looked around" },
  ]
  const args = ["--conversation", "remote", "--target", "box", "--cwd", work, "--auto"]
  const session = await open(script, args, sigmaHome)
  await session.waitFor((screen) => screen.includes(`on box  ${work}`) && screen.includes("READY"))
  session.type("look\r")
  await session.waitFor((screen) => screen.includes("on box-1") && screen.includes("looked around"))
  await quit(session)
  const reopened = await open(script, ["--conversation", "remote"], sigmaHome)
  await reopened.waitFor((screen) => screen.includes(`on box  ${work}`) && screen.includes("looked around"))
  await quit(reopened)
})

test("target-restarted, target-replaced: the TUI shows when the computer behind its target restarted or was replaced", async () => {
  using targets = new TestTargets()
  const work = targets.add("box", "box-1", "vol-1")
  const sigmaHome = home()
  writeFileSync(join(sigmaHome.dir, "config.toml"), targets.configToml)
  const restart = `echo box-2 > ../instance; ${targets.killCommand("box")}`
  const replace = `echo box-3 > ../instance; echo vol-3 > ../files; ${targets.killCommand("box")}`
  const script = [
    { tool: { name: "bash", input: { command: restart } } },
    { text: "noted" },
    { tool: { name: "bash", input: { command: replace } } },
    { text: "noted again" },
  ]
  const session = await open(script, ["--target", "box", "--cwd", work, "--auto"], sigmaHome)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("go\r")
  await session.waitFor(
    (screen) => screen.includes("box restarted as box-2: files kept, processes gone") && screen.includes("READY"),
  )
  session.type("again\r")
  await session.waitFor(
    (screen) =>
      screen.includes("box was replaced by box-3: files, processes and changes from before are gone") &&
      screen.includes("noted again"),
  )
  await quit(session)
})

test("target-reaching: while a target's connector holds its hello the TUI shows it reaching the target, and the notice goes at the hello", async () => {
  using targets = new TestTargets()
  const work = targets.add("box", "box-1")
  const sigmaHome = home()
  writeFileSync(join(sigmaHome.dir, "config.toml"), targets.configToml)
  // The call holds the target's next connects and stops its sigma-env, so the next request waits to reach it again.
  const hold = `touch ${join(targets.root, "box", "hold")}; ${targets.killCommand("box")}`
  const script = [{ tool: { name: "bash", input: { command: hold } } }, { text: "reached again" }]
  const session = await open(script, ["--target", "box", "--cwd", work, "--auto"], sigmaHome)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("go\r")
  await session.waitFor((screen) => screen.includes("reaching box") && screen.includes("WORKING"))
  targets.release("box")
  const screen = await session.waitFor((screen) => screen.includes("reached again") && screen.includes("READY"))
  expect(screen).not.toContain("reaching box")
  await quit(session)
})

test("answer-author: without USER the TUI names a person's message after the system's user name", async () => {
  const session = await open([{ text: "hello" }], [], home(), { USER: undefined })
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("who am i\r")
  const screen = await session.waitFor((screen) => screen.includes("hello") && screen.includes("READY"))
  // The system's user name, as a process without USER is told it.
  const { USER: _, ...withoutUser } = process.env
  const name = Bun.spawnSync(["bun", "-e", "console.log(require('node:os').userInfo().username)"], { env: withoutUser })
  expect(screen).toContain(name.stdout.toString().trim().toUpperCase())
  await quit(session)
})

test("author-launch: a TUI started for someone sends as them, by the name shown and the id the transcript keeps", async () => {
  const sigmaHome = home()
  const erika = { id: "person:p-7k3f9m", name: "Erika" }
  const session = await open([{ text: "hello erika" }], ["-c", "shared"], sigmaHome, {
    SIGMA_AUTHOR_ID: erika.id,
    SIGMA_AUTHOR_NAME: erika.name,
  })
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("who am i\r")
  const screen = await session.waitFor((screen) => screen.includes("hello erika") && screen.includes("READY"))
  expect(screen).toContain("◆ erika started the conversation")
  expect(screen).toContain("ERIKA")
  expect(screen).not.toContain("ADA")
  const client = await RawClient.connect(sigmaHome.socket)
  const page = await client.call("conversation/entries", { conversation: "shared", order: "ascending", limit: 10 })
  const authors = (page.result.entries as Array<{ kind: string; data?: { author?: unknown } }>).flatMap((entry) =>
    entry.data?.author === undefined ? [] : [{ kind: entry.kind, author: entry.data.author }],
  )
  expect(authors).toEqual([
    { kind: "sigma.started", author: erika },
    { kind: "sigma.user", author: erika },
  ])
  client.close()
  await quit(session)
})

test("answer-newline: alt+enter adds a line to the prompt, and enter sends every line as one message", async () => {
  const session = await open([{ text: "got both" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("line one")
  session.type("\x1b\r")
  session.type("line two")
  await session.waitFor((screen) => screen.includes("line one") && screen.includes("line two"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("got both") && screen.includes("READY"))
  const lines = screen.split("\n")
  const first = lines.findIndex((line) => line.includes("line one"))
  expect(lines[first + 1]).toContain("line two")
  expect(lines.findIndex((line) => line.includes("ADA"))).toBe(first - 1)
  await quit(session)
})

test("tui-hangup, idle-closed: closing the terminal ends sigma instead of leaving it running unseen", async () => {
  const session = await open()
  await session.waitFor((screen) => screen.includes("READY"))
  session.hangUp()
  await deadline(session.exited, DEADLINE, "sigma exited")
})

test("reopen-hint, reopen-tui: quitting prints the command that reopens the conversation, and it opens with its transcript", async () => {
  const sigmaHome = home()
  const first = await open([{ text: "I remember" }], [], sigmaHome)
  await first.waitFor((screen) => screen.includes("READY"))
  first.type("remember me\r")
  await first.waitFor((screen) => screen.includes("I remember") && screen.includes("READY"))
  await quit(first)
  const id = first.output().match(/sigma --conversation (\w+)/)?.[1]
  expect(id).toBeDefined()
  const second = await open([], ["--conversation", id!], sigmaHome)
  const screen = await second.waitFor((screen) => screen.includes("I remember") && screen.includes("READY"))
  expect(screen).toContain("remember me")
  await quit(second)
})

test("start-with-id: a launcher opens sigma on an id it chose with a first prompt, and that id reopens the conversation", async () => {
  const sigmaHome = home()
  const first = await open(
    [{ text: "You said: first words" }],
    ["--conversation", "chosen-by-attn", "first words"],
    sigmaHome,
  )
  await first.waitFor((screen) => screen.includes("You said: first words") && screen.includes("READY"))
  await quit(first)
  expect(first.output()).toContain("sigma --conversation chosen-by-attn")
  const second = await open([], ["--conversation", "chosen-by-attn"], sigmaHome)
  const screen = await second.waitFor((screen) => screen.includes("You said: first words") && screen.includes("READY"))
  expect(screen.split("You said: first words").length).toBe(2)
  await quit(second)
})

test("interrupt-tui: escape stops sigma mid-answer and the answer shows it was interrupted", async () => {
  // Held until escape ends it.
  using held = hold()
  const session = await open([{ text: "one two three four five six seven eight nine ten", hold: held.path }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("count\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("one"))
  session.type("\x1b")
  await session.waitFor((screen) => screen.includes("interrupted") && screen.includes("READY"))
  await quit(session)
})

test("queue-show: a prompt sent while sigma works waits in the queue, then runs", async () => {
  using held = hold()
  const session = await open([{ text: "slow one two three", hold: held.path }, { text: "fast reply" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("first\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("STEER · tab"))
  session.type("\t")
  await session.waitFor((screen) => screen.includes("QUEUE · tab"))
  session.type("second\r")
  await session.waitFor((screen) => screen.includes("queued · second"))
  held.release()
  const screen = await session.waitFor((screen) => screen.includes("fast reply"))
  expect(screen).not.toContain("queued · second")
  await quit(session)
})

test("approval-ask, approval-allow-tui: sigma asks before a command runs, ctrl+y allows it and its output shows under the call", async () => {
  const session = await open([call("bash", { command: "echo hello-from-bash" }), { text: "all done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("run it\r")
  await session.waitFor(
    (screen) =>
      screen.includes("▸ bash(echo hello-from-bash)") &&
      screen.includes("allow this call?") &&
      screen.includes("WAITING"),
  )
  session.type("\x19")
  const screen = await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  expect(screen.indexOf("✓ allowed by ada")).toBeGreaterThan(screen.indexOf("▸ bash(echo hello-from-bash)"))
  expect(screen.indexOf("     hello-from-bash")).toBeGreaterThan(screen.indexOf("✓ allowed by ada"))
  expect(screen).not.toContain("allow this call?")
  await quit(session)
})

test("approval-ask, codemode-nested-policy: a script's call that waits for a person shows its command under the script before ctrl+y allows it", async () => {
  const code = 'await tools.bash({ command: "echo nested-hello" })'
  const session = await open([call("codemode", { code }), { text: "all done" }], ["--model", "script-code-mode"])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("run it\r")
  const asking = await session.waitFor((screen) => screen.includes("WAITING") && screen.includes("allow this call?"))
  expect(asking.indexOf("▸ bash(echo nested-hello)")).toBeGreaterThan(asking.indexOf("▸ codemode"))
  expect(asking.indexOf("allow this call?")).toBeGreaterThan(asking.indexOf("▸ bash(echo nested-hello)"))
  session.type("\x19")
  await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  await quit(session)
})

test("approval-deny-tui: ctrl+n denies a call, the denial shows as its result and the run goes on", async () => {
  const session = await open([call("bash", { command: "echo never-ran" }), { text: "carrying on" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("run it\r")
  await session.waitFor((screen) => screen.includes("allow this call?"))
  session.type("\x0e")
  const screen = await session.waitFor((screen) => screen.includes("carrying on") && screen.includes("READY"))
  expect(screen.indexOf("✗ denied by ada")).toBeGreaterThan(screen.indexOf("▸ bash(echo never-ran)"))
  expect(screen.indexOf("denied by ada: the person did not allow this call")).toBeGreaterThan(
    screen.indexOf("✗ denied by ada"),
  )
  expect(screen).not.toContain("harness>")
  expect(screen).not.toContain("     never-ran")
  expect(screen).not.toContain("allow this call?")
  await quit(session)
})

test("steer-toggle, steer-show: enter steers a prompt sent mid-run, tab switches to queueing and back, and the steer shows until it lands", async () => {
  const session = await open([call("bash", { command: "sleep 1" }), { text: "turning left now" }], ["--auto"])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("drive\r")
  await session.waitFor((screen) => screen.includes("▸ bash(sleep 1)") && screen.includes("STEER · tab"))
  session.type("\t")
  await session.waitFor((screen) => screen.includes("QUEUE · tab"))
  session.type("\t")
  await session.waitFor((screen) => screen.includes("STEER · tab"))
  session.type("turn left\r")
  await session.waitFor((screen) => screen.includes("steering · turn left"))
  const screen = await session.waitFor((screen) => screen.includes("turning left now") && screen.includes("READY"))
  expect(screen.indexOf("turn left")).toBeLessThan(screen.indexOf("turning left now"))
  expect(screen).not.toContain("steering ·")
  await quit(session)
})

test("signin-status: the splash lists every provider and how it is signed in", async () => {
  const session = await open()
  const screen = await session.waitFor(
    (screen) => screen.includes("person@example.com · Claude Max") && screen.includes("signed out"),
  )
  expect(screen).toMatch(/● claude +person@example\.com · Claude Max/)
  expect(screen).toMatch(/○ openai +signed out/)
  expect(screen).toContain("^L  sign in")
  await quit(session)
})

test("model-list, model-status: /model lists every provider's models, enter switches the conversation's model, and the status bar names it", async () => {
  const session = await open([], ["--provider", "claude"])
  await session.waitFor((screen) => screen.includes("READY") && screen.includes("claude  sigma"))
  session.type("/model\r")
  await session.waitFor((screen) => screen.includes("claude · Sonnet") && screen.includes("openai · GPT-5.5"))
  // The picker opens on the conversation's model, Claude's own choice; Sonnet is the next row.
  session.type("\x1b[B")
  session.type("\x1b[C")
  await session.waitFor((screen) => screen.includes("claude · Sonnet ‹ low ›"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("◆ ada switched to claude · sonnet · low"))
  expect(screen).not.toContain("claude · Sonnet ‹")
  expect(screen).toContain("claude · sonnet · low  sigma")
  await quit(session)
}, 20_000)

const signInFixture = join(import.meta.dir, "../../../fixtures/claude/terminal_sign_in.ndjson")

test("signin-terminal: ^L signs in to a signed-out Claude by running its own sign-in in the terminal", async () => {
  const session = await open([], [], home(), { FAKE_CLAUDE_FIXTURE: signInFixture })
  await session.waitFor((screen) => /○ claude +signed out/.test(screen))
  session.type("\x0c")
  const screen = await session.waitFor((screen) => /● claude +person@example\.com · Claude Max/.test(screen), 30_000)
  expect(session.output()).toContain("fake claude auth login done")
  expect(screen).not.toContain("SIGN IN")
  await quit(session)
}, 40_000)

test("signin-cancel: a sign-in cancelled from another connection stops Claude's sign-in in the terminal", async () => {
  const sigmaHome = home()
  const session = await open([], [], sigmaHome, { FAKE_CLAUDE_FIXTURE: signInFixture, FAKE_CLAUDE_AUTH_WAITS: "1" })
  await session.waitFor((screen) => /○ claude +signed out/.test(screen))
  session.type("\x0c")
  await session.waitFor((screen) => screen.includes("fake claude auth login waiting"))
  const other = await RawClient.connect(sigmaHome.socket)
  const auth = other.watch<AuthState>("auth/watch")
  await auth.until((states) => states.some((state) => state.phase === "waiting"))
  const waiting = auth.items.find((state) => state.phase === "waiting")!
  await other.call("auth/cancel", { provider: "claude", flow: waiting.flow })
  other.close()

  await session.waitFor(
    (screen) => /○ claude +signed out/.test(screen) && !screen.includes("SIGN IN") && screen.includes("READY"),
  )
  const fakeDir = join(sigmaHome.dir, "fake-claude")
  const ended = () => readFileSync(join(fakeDir, "log.ndjson"), "utf8").includes('"authEnded":"SIGTERM"')
  const watcher = watch(fakeDir)
  await deadline(
    new Promise<void>((resolve) => {
      const check = () => ended() && resolve()
      watcher.on("change", check)
      check()
    }),
    DEADLINE,
    "the sign-in in the terminal ended",
  ).finally(() => watcher.close())
  session.type("\x03")
  await session.exited
}, 40_000)

test("signin-shared: an open TUI shows a sign-in another connection finished", async () => {
  const sigmaHome = home()
  const session = await open([], [], sigmaHome, { FAKE_CLAUDE_FIXTURE: signInFixture })
  await session.waitFor((screen) => /○ claude +signed out/.test(screen))
  const other = await RawClient.connect(sigmaHome.socket)
  const auth = other.watch<AuthState>("auth/watch")
  const started = (await other.call("auth/start", { provider: "claude" })).result as AuthState
  await auth.until((states) => states.some((state) => state.phase === "waiting"))
  // Answered the moment the waiting state shows, as a fast client does.
  const answered = await other.call("auth/respond", {
    provider: "claude",
    flow: started.flow,
    response: { _tag: "terminal_exited", success: true },
  })
  expect(answered.result).toEqual({ accepted: true })
  await auth.until((states) => states.at(-1)?.phase === "succeeded", 30_000)
  other.close()
  await session.waitFor((screen) => /● claude +person@example\.com · Claude Max/.test(screen))
  await quit(session)
}, 40_000)

test("worker-card: a worker shows as a card under its parent, and ctrl+y answers the call it asks about", async () => {
  const session = await open([
    call("start_worker", { task_name: "scribe", message: "write it down", fork_turns: "none" }),
    call("wait_worker", { timeout_ms: 600_000 }),
    { text: "the scribe is done" },
    call("bash", { command: "echo scribbled" }, "/root/scribe"),
    { agent: "/root/scribe", text: "wrote it" },
  ])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  await session.waitFor(
    (screen) =>
      screen.includes("⧉ scribe") &&
      screen.includes("waiting on you") &&
      screen.includes("allow bash(echo scribbled)?"),
  )
  session.type("\x19")
  const screen = await session.waitFor(
    (screen) => screen.includes("the scribe is done") && screen.includes("READY") && /⧉ scribe +done/.test(screen),
  )
  // The worker's answer, which the parent's wait returned, reads as what it said under its name.
  const lines = screen.split("\n")
  expect(lines[lines.findIndex((line) => line.includes("/root/scribe")) + 1]).toContain("wrote it")
  expect(screen).not.toContain("Payload:")
  await quit(session)
}, 30_000)

test("worker-card, codemode-nested-policy: a worker a script started shows as a card under the script, and ctrl+y answers the call it asks about", async () => {
  const spawn = 'await tools.start_worker({ task_name: "scribe", message: "write it down", fork_turns: "none" })'
  const session = await open(
    [
      call("codemode", { code: `${spawn}\nawait tools.wait_worker({ timeout_ms: 600000 })` }),
      { text: "the scribe is done" },
      call("codemode", { code: 'await tools.bash({ command: "echo scribbled" })' }, "/root/scribe"),
      { agent: "/root/scribe", text: "wrote it" },
    ],
    ["--model", "script-code-mode"],
  )
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  const asking = await session.waitFor(
    (screen) => /⧉ scribe +waiting on you/.test(screen) && screen.includes("allow bash(echo scribbled)?"),
  )
  expect(asking.indexOf("⧉ scribe")).toBeGreaterThan(asking.indexOf("▸ codemode"))
  session.type("\x19")
  await session.waitFor(
    (screen) => screen.includes("the scribe is done") && screen.includes("READY") && /⧉ scribe +done/.test(screen),
  )
  await quit(session)
})

test("worker-approve: a call a worker's worker asks about shows on the card above it, and ctrl+y answers it", async () => {
  const sigmaHome = home()
  const session = await open(
    [
      call("start_worker", { task_name: "lead", message: "delegate further", fork_turns: "none" }),
      call("wait_worker", { timeout_ms: 600_000 }),
      { text: "the lead is done" },
      call("start_worker", { task_name: "deep", message: "dig", fork_turns: "none" }, "/root/lead"),
      call("wait_worker", { timeout_ms: 600_000 }, "/root/lead"),
      { agent: "/root/lead", text: "deep reported" },
      call("bash", { command: "echo dug" }, "/root/lead/deep"),
      { agent: "/root/lead/deep", text: "dug it" },
    ],
    [],
    sigmaHome,
  )
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  await session.waitFor((screen) => /⧉ lead +waiting on you/.test(screen) && screen.includes("allow bash(echo dug)?"))
  session.type("\x19")
  await session.waitFor((screen) => screen.includes("the lead is done") && screen.includes("READY"))
  await quit(session)
}, 30_000)

test("subagent-claude: a Claude subagent shows as a card in place of its call's result, and its own screen sends input to its parent", async () => {
  const sigmaHome = home()
  const extra = { FAKE_CLAUDE_FIXTURE: join(import.meta.dir, "../../../fixtures/claude/subagent.ndjson") }
  const parent = await open([], ["--provider", "claude"], sigmaHome, extra)
  await parent.waitFor((screen) => screen.includes("READY"))
  parent.type("go\r")
  const screen = await parent.waitFor(
    (screen) =>
      /⧉ Locate gnome in notes\.txt \(general-purpose\) +done/.test(screen) &&
      screen.includes("The gnome lives under the floor.") &&
      screen.includes("READY"),
    20_000,
  )
  expect(screen).not.toContain("Subagent hand-back")
  expect(screen.match(/⧉/g)).toHaveLength(1)
  await quit(parent)

  const client = await RawClient.connect(sigmaHome.socket)
  const listed = (await client.call("conversation/list")).result as Array<{ id: string; lineage?: unknown }>
  client.close()
  const child = listed.find((conversation) => conversation.lineage !== undefined)!
  const own = await open([], ["--conversation", child.id], sigmaHome, extra)
  const opened = await own.waitFor((screen) => screen.includes("INPUT GOES THROUGH ITS PARENT"))
  expect(opened).toContain("the gnome lives under the floor")
  await quit(own)
}, 40_000)

const BACKGROUND_WAKE =
  "Use the Bash tool with run_in_background set to true to run: sleep 8; echo done. Do not wait for it. Reply with exactly: started"
const BACKGROUND_SLEEP =
  "Use the Bash tool with run_in_background set to true to run: sleep 600. Do not wait for it. Reply with exactly: started"

/** The screen's rows from the one holding `text`, down to the bottom. */
const rowsFrom = (screen: string, text: string) => {
  const lines = screen.split("\n")
  return lines.slice(lines.findIndex((line) => line.includes(text)))
}

test("claude-job-card, background-count: a background command's card reads running while it works and done after, the status bar counts it, and its report shows under its name before Sigma's follow-up", async () => {
  using claude = new FakeClaude("bash_background_wake").holdBefore("task_notification")
  const session = await open([], ["--provider", "claude"], home(), claude.options.env)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type(`${BACKGROUND_WAKE}\r`)
  const running = await session.waitFor(
    (screen) => screen.includes("READY") && screen.includes("started") && claude.holding(),
    20_000,
  )
  expect(running).toContain("▸ Bash(sleep 8; echo done) in background · running")
  expect(running).toMatch(/READY +⧉ 1 in background/)
  expect(running).toContain("esc  stop 1 background job")
  // The call's own result, that the command went to the background, is what the card says.
  expect(running).not.toContain("Command running in background")

  claude.release()
  const done = await session.waitFor(
    (screen) => screen.includes("finished with exit code 0") && screen.includes("READY"),
    20_000,
  )
  expect(done).toContain("▸ Bash(sleep 8; echo done) in background · done")
  expect(done).not.toContain("in background · running")
  expect(done).not.toContain("⧉ 1 in background")
  expect(done).not.toContain("esc  stop")
  // The report speaks under the job's name, then Sigma answers it.
  const rows = rowsFrom(done, "Start background sleep-then-echo command  ─")
  expect(rows[1]).toContain('Background command "Start background sleep-then-echo command" completed (exit code 0)')
  expect(rows.findIndex((row) => row.includes("SIGMA"))).toBeGreaterThan(1)
  await quit(session)
}, 40_000)

test("claude-job-card: a background command cut off by a server stop reads cut off on its card, and a line under its name says so", async () => {
  using claude = new FakeClaude("bash_background_cut_off")
  const sigmaHome = home()
  const env = { ...(await scriptEnv(sigmaHome)), ...claude.options.env }
  const server = await serving(env)
  const session = screenSession(["--provider", "claude", "--auto"], env)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type(`${BACKGROUND_SLEEP}\r`)
  await session.waitFor(
    (screen) => screen.includes("in background · running") && screen.includes("READY") && screen.includes("started"),
    20_000,
  )
  server.kill("SIGKILL")
  await server.exited
  // The TUI brings a server back, which cuts off the job its last one held.
  const screen = await session.waitFor(
    (screen) => screen.includes("in background · cut off") && screen.includes("was cut off"),
    20_000,
  )
  // The line wraps at the screen's edge.
  expect(screen.replace(/\s+/g, " ")).toContain("Sleep 600 seconds in background ─")
  expect(screen.replace(/\s+/g, " ")).toContain(
    'The background command "Sleep 600 seconds in background" was cut off: Claude Code ended before it did.',
  )
  expect(screen).not.toContain("⧉ 1 in background")
  await quit(session)
}, 40_000)

test("approval-panel: with the conversation and two subagents asking, the panel lists every ask in its own rows, its own first, and ctrl+y answers them in that order", async () => {
  const session = await open([
    {
      tools: [
        { name: "start_worker", input: { task_name: "docs", message: "update the docs", fork_turns: "none" } },
        { name: "start_worker", input: { task_name: "deps", message: "bump the dependencies", fork_turns: "none" } },
      ],
    },
    call("bash", { command: "echo docs" }, "/root/docs"),
    call("bash", { command: "echo deps" }, "/root/deps"),
    call("bash", { command: "echo parent" }),
    { text: "the parent is done" },
    { agent: "/root/docs", text: "docs updated" },
    { agent: "/root/deps", text: "deps bumped" },
  ])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  const asking = await session.waitFor((screen) => screen.includes("WAITING ON YOU · 3"))
  expect(asking).toContain("◆ WAITING · 3 asks")
  const panel = rowsFrom(asking, "WAITING ON YOU · 3")
  // Its own ask first with the keys; each subagent's after it, next.
  expect(panel[1]).toMatch(/^│ SIGMA allow bash\(echo parent\)\? +\^Y +allow +\^N +deny +│$/)
  expect(panel[2]).toMatch(/^│ ⧉ (docs|deps) allow bash\(echo (docs|deps)\)\? · next +│$/)
  expect(panel[3]).toMatch(/^│ ⧉ (docs|deps) allow bash\(echo (docs|deps)\)\? · next +│$/)
  expect(panel[2]).not.toBe(panel[3])
  // Nothing is drawn over anything else: the panel's own borders, the prompt below it and the transcript above it.
  expect(panel[4]).toMatch(/^╰─+╯$/)
  expect(panel[5]).toMatch(/^╭─ STEER · tab ─+╮$/)
  const lines = asking.split("\n")
  const above = lines.slice(0, lines.indexOf(panel[0]!)).findLast((line) => line.trim() !== "")
  expect(above).toMatch(/^ +allow this call\? · answer below +$/)
  // Only the panel shows the keys; the call and the cards point to it.
  expect(asking.match(/\^Y/g)).toHaveLength(1)
  expect(asking.match(/allow bash\(echo (docs|deps)\)\? · answer below/g)).toHaveLength(2)
  const oldest = /⧉ (docs|deps)/.exec(panel[2]!)![1]!
  const other = oldest === "docs" ? "deps" : "docs"

  session.type("\x19")
  const second = await session.waitFor((screen) => screen.includes("WAITING ON YOU · 2"))
  expect(second).toContain("✓ allowed by")
  const left = rowsFrom(second, "WAITING ON YOU · 2")
  expect(left[1]).toMatch(new RegExp(`^│ ⧉ ${oldest} allow bash\\(echo ${oldest}\\)\\? +\\^Y`))
  expect(left[2]).toContain(`⧉ ${other} allow bash(echo ${other})? · next`)

  session.type("\x19")
  const last = await session.waitFor((screen) => screen.includes("WAITING ON YOU · 1"))
  expect(rowsFrom(last, "WAITING ON YOU · 1")[1]).toMatch(new RegExp(`^│ ⧉ ${other} .*\\^Y`))
  expect(last).toMatch(/◆ WAITING( \d+s)? /)
  expect(last).not.toContain("asks")
  session.type("\x19")
  await session.waitFor((screen) => !screen.includes("WAITING ON YOU") && screen.includes("the parent is done"))
  await quit(session)
}, 40_000)

test("approval-panel: a split terminal keeps the active approval visible while later approvals scroll", async () => {
  const workers = ["docs", "deps", "tests", "types"]
  const command = (name: string) =>
    `git diff -- packages/sigma/src/${name}/component.tsx packages/sigma/src/${name}/other-component.tsx packages/sigma/src/${name}/third-component.tsx`
  const session = await open([
    {
      tools: workers.map((task_name) => ({
        name: "start_worker",
        input: { task_name, message: `Review ${task_name}`, fork_turns: "none" },
      })),
    },
    ...workers.map((name) => call("bash", { command: command(name) }, `/root/${name}`)),
    call("bash", { command: command("parent") }),
  ])
  const title = "WAITING ON YOU · 5"
  const panelIn = (screen: string) => {
    const rows = rowsFrom(screen, title)
    return rows.slice(
      1,
      rows.findIndex((row) => row.startsWith("╰")),
    )
  }
  const atWidth = (columns: number) => (screen: string) =>
    screen.split("\n").some((line) => line.includes(title) && line.endsWith("╮") && line.length === columns)
  try {
    await session.waitFor((screen) => screen.includes("READY"))
    session.type("delegate\r")
    const full = await session.waitFor(atWidth(100))
    const original = panelIn(full).flatMap((row) => /⧉ (docs|deps|tests|types)/.exec(row)?.[1] ?? [])
    expect(original, full).toHaveLength(workers.length)

    // At this size the old panel covered the transcript, prompt and status.
    session.resize(65, 19)
    const split = await session.waitFor(atWidth(65))
    expect(split).toContain("answer below")
    expect(split).toContain("STEER · tab")
    expect(split).toContain("type a message")
    expect(split).toContain("◆ WAITING · 5 asks")
    const splitPanel = panelIn(split)
    expect(rowsFrom(split, title)[splitPanel.length + 1]).toMatch(/^╰─+╯$/)
    const active = splitPanel[0]!
    expect(active).toMatch(/SIGMA .*\^Y.*\^N/)
    expect(splitPanel.join("\n")).not.toContain(`⧉ ${original.at(-1)}`)

    const panelTop = split.split("\n").findIndex((line) => line.includes(title))
    // Send wheel events inside the scrolling list, below the active approval.
    session.type(`\x1b[<65;20;${panelTop + 3}M`.repeat(workers.length))
    const scrolled = await session.waitFor((screen) =>
      panelIn(screen).some((row) => row.includes(`⧉ ${original.at(-1)}`)),
    )
    expect(panelIn(scrolled)[0]).toBe(active)
    expect(scrolled).toContain("STEER · tab")

    session.resize(100, 30)
    const enlarged = await session.waitFor(atWidth(100))
    expect(panelIn(enlarged).flatMap((row) => /⧉ (docs|deps|tests|types)/.exec(row)?.[1] ?? [])).toEqual(original)
    session.type("\x0e")
    const next = await session.waitFor((screen) => screen.includes("WAITING ON YOU · 4"))
    expect(rowsFrom(next, "WAITING ON YOU · 4")[1]).toMatch(new RegExp(`⧉ ${original[0]} .*\\^Y.*\\^N`))
  } finally {
    await quit(session)
  }
}, 40_000)

test("skills-tui: a message that names a skill shows which skills came with it, also after a reopen", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  const sigmaHome = home()
  await Bun.write(
    join(sigmaHome.dir, "skills", "ship", "SKILL.md"),
    "---\nname: ship\ndescription: Ship it\n---\nShip.",
  )
  await using _server = await runningServer([], { home: sigmaHome, openai: fake.options() })
  await signIn(sigmaHome)
  const first = await open([], ["--provider", "openai", "--conversation", "shipping"], sigmaHome)
  await first.waitFor((screen) => screen.includes("READY"))
  first.type("$ship it now\r")
  await first.waitFor((screen) => screen.includes("Hello there") && screen.includes("READY"))
  const lines = first.screen().split("\n")
  expect(lines[lines.findIndex((line) => line.includes("$ship it now")) + 1]).toContain("with ship")
  await quit(first)
  const second = await open([], ["--conversation", "shipping"], sigmaHome)
  const reopened = await second.waitFor((screen) => screen.includes("Hello there"))
  expect(reopened).toContain("with ship")
  await quit(second)
})

test("image-attach: a dragged image's pasted path shows on the prompt as attached, and the model receives the image with the message", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  const sigmaHome = home()
  const path = join(sigmaHome.dir, "Screen Shot.png")
  await Bun.write(path, png(3, 2))
  await using _server = await runningServer([], { home: sigmaHome, openai: fake.options() })
  await signIn(sigmaHome)
  const session = await open([], ["--provider", "openai"], sigmaHome)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("what is this? ")
  // A terminal pastes a file dropped on it as its path, with spaces escaped.
  session.type(`\x1b[200~${path.replaceAll(" ", "\\ ")}\x1b[201~`)
  await session.waitFor((screen) => screen.includes("attaching Screen Shot.png"))
  session.type("\r")
  await session.waitFor((screen) => screen.includes("Hello there") && screen.includes("READY"))
  const lines = session.screen().split("\n")
  expect(lines[lines.findIndex((line) => line.includes("ADA")) + 2]).toContain("with Screen Shot.png")
  expect(session.screen()).not.toContain("attaching")
  const input = JSON.parse(fake.responses()[0]!.body).input as Array<{ role?: string; content?: Array<any> }>
  const content = input.find((item) => item.role === "user")!.content!
  expect(content.map((part) => part.type)).toEqual(["input_text", "input_image"])
  expect(content[1].image_url).toBe(`data:image/png;base64,${Buffer.from(png(3, 2)).toString("base64")}`)
  await quit(session)
})

test("image-attach: an image the server cannot decode is refused on screen by name, and nothing is sent", async () => {
  const sigmaHome = home()
  // Its header says PNG, so the prompt attaches it; its pixels are cut off.
  await Bun.write(join(sigmaHome.dir, "cut.png"), png(4, 4).subarray(0, 40))
  const session = await open([{ text: "never" }], [], sigmaHome)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type(`look ${join(sigmaHome.dir, "cut.png")}`)
  await session.waitFor((screen) => screen.includes("attaching cut.png"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("✗ cut.png (image/png) cannot be decoded"))
  expect(screen).not.toContain("ADA")
  await quit(session)
})

test("crash-tui: the open TUI finishes the answer after the server is killed mid-answer", async () => {
  const sigmaHome = home()
  using held = hold()
  const env = await scriptEnv(sigmaHome, [
    { text: "one two three four five six seven eight nine ten", hold: held.path },
  ])
  const server = await serving(env)
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("count\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("one"))
  server.kill("SIGKILL")
  await server.exited
  held.release()
  // The TUI brings a server back; the run picks up where it was cut off and answers once.
  const screen = await session.waitFor(
    (screen) => screen.includes("one two three four five six seven eight nine ten") && screen.includes("READY"),
    20_000,
  )
  expect(screen).not.toContain("missing messages")
  await quit(session)
}, 30_000)

test("crash-tui: quitting while the server cannot come back ends sigma, though a typed prompt waits to be sent", async () => {
  const sigmaHome = home()
  const env = await scriptEnv(sigmaHome, [])
  const server = await serving(env)
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  // Every server the TUI starts now refuses this config, so the prompt is sent again and again while the TUI waits.
  await Bun.write(join(sigmaHome.dir, "config.toml"), "[providers.claude\n")
  server.kill("SIGKILL")
  await server.exited
  session.type("never sent\r")
  await quit(session)
}, 30_000)

test("server-cannot-start: an open TUI whose server cannot start shows why, starts one at most once a second, and carries on once it can", async () => {
  const sigmaHome = home()
  const env = await scriptEnv(sigmaHome, [{ text: "back again" }])
  const server = await serving(env)
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  const config = join(sigmaHome.dir, "config.toml")
  await Bun.write(config, "[providers.claude\n")
  server.kill("SIGKILL")
  await server.exited
  // A server that refuses takes 0.6 s to start and exit on a quiet machine, and up to 4.7 s on one under load (100
  // starts at load average 30): each wait here allows several of them.
  await session.waitFor(
    (screen) => screen.includes("sigma's server cannot start") && screen.includes("TOML Parse error"),
    20_000,
  )
  // Each server the TUI starts writes its refusal to the home's log as it exits, and the TUI waits a second after it
  // before starting the next: the gap between two refusals is more than that second.
  const refusals = () => readFileSync(sigmaHome.log, "utf8").split("TOML Parse error").length - 1
  const watcher = watch(sigmaHome.dir)
  const seen: Array<{ readonly count: number; readonly at: number }> = []
  await deadline(
    new Promise<void>((resolve) => {
      const check = () => {
        const count = refusals()
        if (count !== seen.at(-1)?.count) seen.push({ count, at: performance.now() })
        if (seen.length >= 3) resolve()
      }
      watcher.on("change", check)
      check()
    }),
    20_000,
    "three refusals in the home's log",
  ).finally(() => watcher.close())
  expect(seen.map(({ count }) => count - seen[0]!.count)).toEqual([0, 1, 2])
  expect(seen[2]!.at - seen[1]!.at).toBeGreaterThan(900)
  // A prompt typed now is taken and waits, and the notice says why while the server still refuses: a refusal after the
  // prompt shows it again. The prompt clears the notice, but a refusal the TUI hears in the same frame shows it at once,
  // and the test types just as one arrives, so whether a frame without it is drawn is timing, not a promise.
  const before = refusals()
  session.type("hi\r")
  const after = watch(sigmaHome.dir)
  await deadline(
    new Promise<void>((resolve) => {
      const check = () => refusals() > before && resolve()
      after.on("change", check)
      check()
    }),
    20_000,
    "a refusal after the prompt",
  ).finally(() => after.close())
  await session.waitFor((screen) => screen.includes("type a message") && screen.includes("cannot start"), 20_000)
  // The config fixed, the next server starts, the notice goes and the prompt is answered.
  rmSync(config)
  await session.waitFor(
    (screen) => screen.includes("back again") && screen.includes("READY") && !screen.includes("cannot start"),
    20_000,
  )
  await quit(session)
}, 90_000)

test("idle-tui: the TUI draws nothing and uses no CPU while nothing changes", async () => {
  const session = await open([{ text: "done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("hi\r")
  await session.waitFor((screen) => screen.includes("done") && screen.includes("READY"))
  // The second after an answer still settles, so the measure starts after it.
  await Bun.sleep(1000)
  const drawn = session.output().length
  const before = cpuSeconds(session.pid)
  await Bun.sleep(3000)
  expect(session.output().length).toBe(drawn)
  // Drawing nothing is the promise; CPU only catches heavy work that draws nothing. Bun's GC runs in bursts
  // after an answer: these 3 s measured 0-2 hundredths locally and 10 on a macOS CI runner. Idle wakeups cost
  // less than that noise (a 30 fps render loop 3-6, a 1 ms timer 2), so 50 is a tripwire for a spin or a
  // relayout on every frame, not for timers.
  expect(Math.round((cpuSeconds(session.pid) - before) * 100)).toBeLessThanOrEqual(50)
  await quit(session)
}, 20_000)

test("answer-scroll, tui-load-earlier: a conversation longer than the window scrolls back to its first message, loading earlier entries on the way, and a reconnect leaves no gap", async () => {
  const sigmaHome = home()
  const env = await scriptEnv(sigmaHome, answers(41))
  const server = await serving(env)
  const client = await RawClient.connect(sigmaHome.socket)
  const conversation = await start(client, sigmaHome.dir)
  // 40 runs of three entries each: more than the window's 50 newest, and than twice that.
  await converse(client, conversation, 40)
  client.close()

  const session = screenSession(["--conversation", conversation], env)
  await session.waitFor((screen) => screen.includes("answer 40") && screen.includes("READY"))
  expect(session.screen()).not.toContain("answer 1\n")
  const top = await scrollUpUntil(session, (screen) => /^ +prompt 1 *$/m.test(screen))
  expect(top).not.toContain("earlier messages")
  // Eighty speaker bars, and no warning about listeners printed over the screen.
  expect(session.output()).not.toContain("MaxListeners")
  expect(top).toMatch(/^ +answer 1 *$/m)

  // The server goes away. A prompt typed now waits for the server the TUI brings back, where the TUI watches again
  // from the newest entry it holds.
  server.kill("SIGKILL")
  await server.exited
  // The server the TUI brings back plays its script from the start.
  await Bun.write(join(sigmaHome.dir, "script.json"), JSON.stringify([{ text: "answer 41" }]))
  session.type("prompt 41\r")
  await scrollDownUntil(session, (screen) => screen.includes("answer 41"))
  await session.waitFor((screen) => screen.includes("answer 41") && screen.includes("READY"), 20_000)
  const back = await scrollUpUntil(session, (screen) => /^ +prompt 1 *$/m.test(screen))
  expect(back).not.toContain("missing messages")
  await quit(session)
}, 120_000)

test("tui-fill-gap: a TUI that fell behind marks where entries are missing, and loads them once scrolled to", async () => {
  const sigmaHome = home()
  await using _server = await runningServer(answers(45), { home: sigmaHome, connectionQueue: 16 })
  const client = await RawClient.connect(sigmaHome.socket)
  const conversation = await start(client, sigmaHome.dir)
  await converse(client, conversation, 2)
  const session = await open([], ["--conversation", conversation], sigmaHome)
  await session.waitFor((screen) => screen.includes("answer 2") && screen.includes("READY"))
  // A frozen TUI reads nothing; its watch falls behind while 40 more runs commit, more than a window holds.
  session.pause()
  await converse(client, conversation, 40, 3)
  session.resume()
  await session.waitFor((screen) => screen.includes("answer 42") && screen.includes("READY"), 20_000)
  await scrollUpUntil(session, (screen) => screen.includes("missing messages") || /^ +answer 3 *$/m.test(screen))
  const filled = await scrollUpUntil(session, (screen) => /^ +answer 2 *$/m.test(screen))
  expect(filled).not.toContain("missing messages")
  expect(filled).toMatch(/^ +prompt 3 *$/m)
  client.close()
  await quit(session)
}, 120_000)

/** A process's CPU time in seconds, user and system, to the hundredth. */
const cpuSeconds = (pid: number) => {
  if (process.platform === "linux") {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")
    return (Number(fields[11]) + Number(fields[12])) / 100
  }
  const out = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)])
    .stdout.toString()
    .trim()
  const [minutes, seconds] = out.split(":")
  return Number(minutes) * 60 + Number(seconds)
}

/** The TUI on the conversation `talk`, and a raw client of its server for what is slow to type. */
const openTalk = async (script: ReadonlyArray<ScriptStep>) => {
  const sigmaHome = home()
  const session = await open(script, ["--conversation", "talk"], sigmaHome)
  await session.waitFor((screen) => screen.includes("READY"))
  const client = await RawClient.connect(sigmaHome.socket)
  return { session, client }
}

const ask = async (session: Session, prompt: string, answer: string) => {
  session.type(`${prompt}\r`)
  await session.waitFor((screen) => screen.includes(answer) && screen.includes("READY"))
}

test("fork-rpc, fork-shown: /fork moves the screen to a new conversation that goes on from before the last prompt, and its header says what it forked", async () => {
  const session = await open([{ text: "answer one" }, { text: "answer two" }, { text: "another way" }])
  await session.waitFor((screen) => screen.includes("READY"))
  await ask(session, "prompt one", "answer one")
  await ask(session, "prompt two", "answer two")
  const before = session.screen().split("\n")[0]!
  session.type("/fork\r")
  const forked = await session.waitFor(
    (screen) => screen.split("\n")[0] !== before && screen.includes("answer one") && screen.includes("READY"),
  )
  expect(forked).not.toContain("answer two")
  const left = /conversation (\S+)/.exec(before)![1]
  expect(forked.split("\n")[0]).toContain(`⑂ fork of ${left} · prompt one`)
  await ask(session, "prompt three", "another way")
  await quit(session)
})

test("reset-rpc, reset-handoff: /reset draws a new context with its handoff, and the conversation goes on after it", async () => {
  const session = await open([{ text: "answer one" }])
  await session.waitFor((screen) => screen.includes("READY"))
  await ask(session, "prompt one", "answer one")
  session.type("/reset we were counting sheep\r")
  const screen = await session.waitFor((screen) => screen.includes("started a new context"))
  expect(screen).toContain("we were counting sheep")
  // With no step left the script repeats the newest user text it was sent.
  await ask(session, "go on", "You said: go on")
  await quit(session)
})

test("compact-rpc, compaction-live-status: /compact says when there is nothing to compact, shows a compaction running, and why one failed", async () => {
  using held = hold()
  // Past the 20,000 tokens a summary keeps by default, so the run before it is summarized.
  const long = "word ".repeat(20_000)
  const { session, client } = await openTalk([
    { text: "answer one" },
    { text: "answer two" },
    { text: "the summary of it all", hold: held.path },
    { text: "answer three" },
    { fail: "the summary model is gone" },
  ])
  session.type("/compact\r")
  await session.waitFor((screen) => screen.includes("nothing to compact"))
  const view = watchView(client, "talk")
  for (const runs of [1, 2]) {
    await submit(client, "talk", long)
    await view.until(settled(runs))
  }
  session.type("/compact keep the numbers\r")
  await session.waitFor((screen) => screen.includes("◆ compacting"))
  held.release()
  await session.waitFor((screen) => screen.includes("compacted the context") && !screen.includes("◆ compacting"))
  await submit(client, "talk", long)
  await view.until(settled(3))
  session.type("/compact\r")
  // The cause, named once: not "compaction failed: Summarization failed: ...".
  await session.waitFor((screen) => screen.includes("✗ compaction failed: the summary model is gone"))
  client.close()
  await quit(session)
})

test("compact-rpc, claude-compact: /compact in a Claude conversation sends Claude Code /compact as the person's input, and shows the compaction", async () => {
  using claude = new FakeClaude("compaction_resume")
  const sigmaHome = home()
  // A run resumes at the position only when no process stayed live, as in the recording.
  await using _server = await runningServer([], { home: sigmaHome, claude: claude.options, claudeIdle: 0 })
  const session = await open([], ["--provider", "claude"], sigmaHome)
  await session.waitFor((screen) => screen.includes("READY"))
  const client = await RawClient.connect(sigmaHome.socket)
  const conversation = ((await client.call("conversation/list")).result as Array<{ id: string }>)[0]!.id
  const view = watchView(client, conversation)
  session.type("Remember the word PLUM. Reply with exactly: noted\r")
  await view.until(settled(1))
  client.close()
  session.type("/compact\r")
  const screen = await session.waitFor((screen) => screen.includes("compacted the context") && screen.includes("READY"))
  expect(screen).not.toContain("nothing to compact")
  expect(claude.userTexts(1)).toEqual([["/compact"]])
  await quit(session)
})

test("continue-rpc: /continue goes on after a failed run with no new input, and says why when there is nothing to go on with", async () => {
  const session = await open([{ fail: "provider went away" }, { text: "back on it" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("/continue\r")
  await session.waitFor((screen) => screen.includes("no run has ended here yet"))
  session.type("hi\r")
  await session.waitFor((screen) => screen.includes("provider went away") && screen.includes("READY"))
  session.type("/continue\r")
  await session.waitFor((screen) => screen.includes("back on it") && screen.includes("READY"))
  await quit(session)
})

test("withdraw-rpc: /withdraw takes back the queued prompt before it runs", async () => {
  const session = await open([call("bash", { command: "echo hi" }), { text: "all done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("first\r")
  // The run waits on its approval, so "second" waits in the queue.
  await session.waitFor((screen) => screen.includes("allow this call?"))
  session.type("\t")
  await session.waitFor((screen) => screen.includes("QUEUE · tab"))
  session.type("second\r")
  await session.waitFor((screen) => screen.includes("queued · second"))
  session.type("/withdraw\r")
  await session.waitFor((screen) => screen.includes("withdrew: second") && !screen.includes("queued · second"))
  session.type("\x19")
  const screen = await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  expect(screen).not.toContain("You said: second")
  await quit(session)
})

/** The rows of the prompt panel, from its top border to its bottom one. */
const promptPanel = (screen: string) => {
  const lines = screen.split("\n")
  const top = lines.findLastIndex((line) => /^╭─ /.test(line))
  return lines.slice(top, lines.findIndex((line, at) => at > top && /^╰/.test(line)) + 1).join("\n")
}

const up = "\x1b[A"
const down = "\x1b[B"

test("queue-edit: up on an empty prompt opens your newest pending prompt, up again an older one, and enter saves the edit in place, tab flipping it between steering and queueing", async () => {
  const session = await open([call("bash", { command: "echo hi" }), { text: "all done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("first\r")
  // The run waits on its approval, so what is sent meanwhile waits too.
  await session.waitFor((screen) => screen.includes("allow this call?"))
  session.type("second\r")
  await session.waitFor((screen) => screen.includes("steering · second"))
  session.type("third\r")
  await session.waitFor((screen) => screen.includes("steering · third"))
  session.type(up)
  await session.waitFor(
    (screen) => promptPanel(screen).includes("EDIT STEER · tab") && promptPanel(screen).includes("❯ third"),
  )
  session.type(up)
  await session.waitFor((screen) => promptPanel(screen).includes("❯ second"))
  // Down goes back to the newer one, and past the newest closes the edit.
  session.type(down)
  await session.waitFor((screen) => promptPanel(screen).includes("❯ third"))
  session.type(down)
  await session.waitFor(
    (screen) => promptPanel(screen).includes("STEER · tab") && !promptPanel(screen).includes("EDIT"),
  )
  session.type(up + up)
  await session.waitFor((screen) => promptPanel(screen).includes("❯ second"))
  session.type(" please\t")
  await session.waitFor((screen) => promptPanel(screen).includes("EDIT QUEUED · tab"))
  session.type("\r")
  const saved = await session.waitFor((screen) => screen.includes("queued · second please"))
  // It keeps its place: it was sent before third, and still runs before it.
  expect(saved.indexOf("queued · second please")).toBeLessThan(saved.indexOf("steering · third"))
  expect(promptPanel(saved)).not.toContain("EDIT")
  expect(promptPanel(saved)).not.toContain("second")
  session.type("\x19")
  const screen = await session.waitFor(
    (screen) => screen.includes("You said: second please") && screen.includes("READY"),
  )
  expect(screen.indexOf("third")).toBeLessThan(screen.indexOf("all done"))
  expect(screen.indexOf("all done")).toBeLessThan(screen.indexOf("You said: second please"))
  await quit(session)
}, 20_000)

test("queue-edit: emptying the prompt you opened withdraws it, esc closes an edit unsaved, and an edit saved after the prompt went stays in the composer to send anew", async () => {
  const session = await open([call("bash", { command: "echo hi" }), { text: "all done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("first\r")
  await session.waitFor((screen) => screen.includes("allow this call?"))
  session.type("\tsecond\r")
  await session.waitFor((screen) => screen.includes("queued · second"))
  session.type("third\r")
  await session.waitFor((screen) => screen.includes("queued · third"))
  session.type(up)
  await session.waitFor((screen) => promptPanel(screen).includes("EDIT QUEUED · tab"))
  session.type("\x7f".repeat("third".length) + "\r")
  const withdrawn = await session.waitFor((screen) => screen.includes("withdrew: third"))
  expect(withdrawn).not.toContain("queued · third")
  expect(withdrawn).toContain("queued · second")
  // Esc leaves an edit without saving it, and without stopping the run.
  session.type(up)
  await session.waitFor((screen) => promptPanel(screen).includes("❯ second"))
  session.type(" changed")
  await session.waitFor((screen) => promptPanel(screen).includes("❯ second changed"))
  session.type("\x1b")
  const cancelled = await session.waitFor((screen) => !promptPanel(screen).includes("EDIT"))
  expect(promptPanel(cancelled)).not.toContain("second")
  expect(cancelled).toContain("queued · second")
  expect(cancelled).toContain("allow this call?")
  // Opened again, it waits while the run ends and runs it; the edit saved then comes too late.
  session.type(up)
  await session.waitFor((screen) => promptPanel(screen).includes("❯ second"))
  session.type(" again")
  session.type("\x19")
  await session.waitFor((screen) => screen.includes("You said: second") && screen.includes("READY"))
  session.type("\r")
  const late = await session.waitFor((screen) => screen.includes("too late to edit: second already"))
  expect(promptPanel(late)).toContain("❯ second again")
  expect(promptPanel(late)).not.toContain("EDIT")
  session.type("\r")
  await session.waitFor((screen) => screen.includes("You said: second again"))
  await quit(session)
}, 20_000)

test("interrupt-restore: escape mid-run gives the text of your pending prompts back to the composer, oldest first, before what you were typing", async () => {
  // Held until escape ends it.
  using held = hold()
  const session = await open([{ text: "one two three four five six seven eight nine ten", hold: held.path }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("count\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("one"))
  session.type("go left\r")
  await session.waitFor((screen) => screen.includes("steering · go left"))
  session.type("\tthen right\r")
  await session.waitFor((screen) => screen.includes("queued · then right"))
  session.type("half typed")
  await session.waitFor((screen) => promptPanel(screen).includes("half typed"))
  session.type("\x1b")
  const screen = await session.waitFor(
    (screen) => screen.includes("interrupted") && screen.includes("READY") && promptPanel(screen).includes("go left"),
  )
  expect(screen).not.toContain("steering ·")
  expect(screen).not.toContain("queued ·")
  const panel = promptPanel(screen)
  expect(panel).toContain("❯ go left")
  expect(panel.indexOf("go left")).toBeLessThan(panel.indexOf("then right"))
  expect(panel.indexOf("then right")).toBeLessThan(panel.indexOf("half typed"))
  // Enter sends what came back as one prompt.
  session.type("\r")
  await session.waitFor((screen) => /You said: go left\s+then right\s+half typed/.test(screen))
  await quit(session)
}, 20_000)

test("configure-rpc, run-turn-limit: /max-turns shows who set the limit, and a looping run ends naming it", async () => {
  const echo = call("bash", { command: "echo again" })
  const session = await open([echo, echo], ["--auto"])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("/max-turns 1\r")
  await session.waitFor((screen) => screen.includes("set the turn limit to 1 turn"))
  session.type("/max-turns zero\r")
  await session.waitFor((screen) => screen.includes("max turns takes a whole number 1 or more, got zero"))
  session.type("loop\r")
  await session.waitFor((screen) => screen.includes("✗ reached the turn limit of 1 turn") && screen.includes("READY"))
  await quit(session)
})

test("usage-rpc, usage-context-live, cache-shown: the status bar counts tokens and the context, and /usage lists them by model with cached input apart", async () => {
  const { session, client } = await openTalk([
    { text: "answer one", usage: { input: 1200, output: 300 } },
    { text: "answer two", usage: { input: 2000, output: 500, cacheRead: 1000, cacheWrite: 200 } },
  ])
  await converse(client, "talk", 1)
  await session.waitFor((screen) => screen.includes("1.5k tokens · context 1.5k"))
  await converse(client, "talk", 1, 2)
  await session.waitFor((screen) => screen.includes("5.2k tokens · context 3.7k"))
  session.type("/usage\r")
  const screen = await session.waitFor((screen) => screen.includes("USAGE") && screen.includes("every conversation"))
  expect(screen).toContain("this conversation: 5.2k tokens")
  expect(screen).toContain("script/script  5.2k (3.2k in, 1.0k cached, 200 cache write, 800 out)")
  session.type("\x1b")
  await session.waitFor((screen) => !screen.includes("USAGE") && screen.includes("answer two"))
  client.close()
  await quit(session)
})

test("task-graph-rpc: /tasks lists the work running now under the conversation it works in, by its id and first prompt, and it empties once the work is done", async () => {
  const session = await open([call("bash", { command: "echo hi" }), { text: "all done" }], ["--conversation", "talk"])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("check\r")
  await session.waitFor((screen) => screen.includes("allow this call?"))
  session.type("/tasks\r")
  const screen = await session.waitFor((screen) => screen.includes("TASKS") && screen.includes("pi.tool"))
  expect(screen).toContain("pi.generation")
  expect(screen).toContain("conversation talk · check  (this one)")
  session.type("\x19")
  await session.waitFor((screen) => screen.includes("nothing is running"))
  session.type("\x1b")
  await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  await quit(session)
})

test("run-retry-live: the status bar counts down a provider's retry, and escape stops it", async () => {
  const session = await open([{ fail: "503 service unavailable" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("hi\r")
  await session.waitFor((screen) => /retrying in \d+s · .*503/.test(screen))
  session.type("\x1b")
  await session.waitFor((screen) => screen.includes("interrupted") && screen.includes("READY"))
  await quit(session)
})

test("commands-help: /help lists every command with what it does, and escape goes back", async () => {
  const session = await open([])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("/help\r")
  const screen = await session.waitFor((screen) => screen.includes("COMMANDS"))
  for (const command of ["/fork", "/reset", "/compact", "/continue", "/withdraw", "/max-turns"])
    expect(screen).toContain(command)
  // A conversation's instructions are fixed once it starts.
  expect(screen).not.toContain("/instructions")
  session.type("\x1b")
  await session.waitFor((screen) => !screen.includes("COMMANDS"))
  await quit(session)
})

test("serve-read-only: under sigma serve --read-only the TUI shows a conversation and runs commands, but keeps a typed message unsent and says why", async () => {
  const sigmaHome = home()
  const first = await open([{ text: "answer one" }], ["--conversation", "talk"], sigmaHome)
  await first.waitFor((screen) => screen.includes("READY"))
  await ask(first, "prompt one", "answer one")
  await quit(first)
  // Replaces the server the first TUI started, once it stops.
  const env = await scriptEnv(sigmaHome, [])
  const viewer = await serving(env, undefined, ["serve", "--read-only", "--restart"])
  const session = screenSession(["--conversation", "talk"], env)
  await session.waitFor((screen) => screen.includes("READ ONLY") && screen.includes("answer one"))
  session.type("/help\r")
  await session.waitFor((screen) => screen.includes("COMMANDS"))
  session.type("\x1b")
  await session.waitFor((screen) => !screen.includes("COMMANDS"))
  session.type("prompt two\r")
  const refused = await session.waitFor((screen) => screen.includes("read-only and sends nothing"))
  // Still in the prompt, not in the transcript.
  expect(refused).toMatch(/❯ prompt two/)
  await quit(session)
  viewer.kill()
  await viewer.exited
})

test("server-restart, serve-read-only: an open TUI keeps drawing while sigma serve --restart replaces its server, read-only and back", async () => {
  const sigmaHome = home()
  const session = await open([{ text: "answer one" }], ["--conversation", "talk"], sigmaHome)
  await session.waitFor((screen) => screen.includes("READY"))
  await ask(session, "prompt one", "answer one")
  // Replaces the server the TUI started; the TUI now shows a read-only home.
  const env = await scriptEnv(sigmaHome, [])
  const viewer = await serving(env, undefined, ["serve", "--read-only", "--restart"])
  await session.waitFor((screen) => screen.includes("READ ONLY"))
  session.type("held back\r")
  await session.waitFor((screen) => screen.includes("read-only and sends nothing"))
  // And back to a server that writes: the TUI takes input again, with no read-only warning left, and draws what it
  // sends.
  const writer = await serving(env, undefined, ["serve", "--restart"])
  await viewer.exited
  await session.waitFor(
    (screen) => !screen.includes("READ ONLY") && !screen.includes("sends nothing") && screen.includes("PROMPT"),
  )
  session.type("\x15")
  await ask(session, "prompt two", "You said: prompt two")
  expect(session.screen()).toContain("answer one")
  await quit(session)
  writer.kill()
  await writer.exited
  // Two restarts and two runs took at most 17.3 s at load ~105 on 10 cores.
}, 60_000)

test("gemini-approval: agy's permission request shows the command it would run on the approval card, and ^Y lets it run", async () => {
  using agy = new FakeAgy("approval_allowed")
  const sigmaHome = home()
  await using _server = await runningServer([], { home: sigmaHome, agy: agy.options })
  const session = await open([], ["--provider", "agy", "--model", "gemini-4-hydrogen", "--effort", "low"], sigmaHome)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("Run the shell command `touch allowed.txt`, then reply with exactly: touched\r")
  const asking = await session.waitFor((screen) => screen.includes("allow this call?"))
  expect(asking).toContain("▸ run_command(touch allowed.txt)")
  session.type("\x19")
  const screen = await session.waitFor((screen) => screen.includes("✓ allowed by ada") && screen.includes("READY"))
  expect(screen).toMatch(/^.*touched\s*$/m)
  await quit(session)
})

test("gemini-health, signin-status: a signed-out agy is listed with how to sign in to it, which sigma cannot do", async () => {
  const session = await open([], [], home(), {
    FAKE_AGY_PROBE: join(import.meta.dir, "../../../fixtures/agy/models_signed_out.ndjson"),
  })
  const screen = await session.waitFor((screen) => /○ agy +not signed in/.test(screen))
  expect(screen).toMatch(/○ agy +not signed in to agy: run `agy` in a terminal and sign in/)
  await quit(session)
})
