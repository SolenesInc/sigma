// Records `fixtures/claude` journeys from a real Claude Code: each journey runs a server in process, as the provider
// tests do, with `record-claude` as its Claude executable, and types what the recording's user typed. It spends real
// requests on your Claude Code sign-in, on claude-haiku-5-5. Your own Claude Code settings stay out of the run, as in
// verify-sigma's `--real-claude`: Claude Code reads only the project's, so a Bash call asks.
//
//   bun packages/sigma/test/support/record-claude-fixtures.ts [journey...]   (no journey: all of them)
//
// Then derive the fixtures made from these (`derive-claude-fixtures.ts`) and read every recording before committing it.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, watch } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { deadline, RawClient } from "./raw.ts"
import { sigmaEnv, stopServer } from "./terminal.ts"
import {
  type ViewWatch,
  person,
  runEnds,
  runningServer,
  serving,
  settled,
  submit,
  tempHome,
  watchView,
} from "./server.ts"

const MODEL = "claude-haiku-5-5"
const FIXTURES = join(import.meta.dir, "../../../../fixtures/claude")
const RECORDER = join(import.meta.dir, "record-claude")
const FAKE = join(import.meta.dir, "fake-claude")
const bundled = Bun.resolveSync(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  `${import.meta.dir}/../../../claude/src`,
)
/** A real model turn takes seconds, a subagent's tens of them; only a stuck journey reaches this. */
const TURN = 300_000

const gnomeSkill = `---
name: gnome-facts
description: Facts about the gnome.
---

Reply with exactly: the gnome lives under the floor
`

const work = `/tmp/sigma-record-${process.pid}`
mkdirSync(work, { recursive: true })
/**
 * The Claude executable a journey's server runs: a sign-in goes to the bundled Claude Code, a probe to the fake
 * `claude` answering signed in with its models, as in the provider tests, and each conversation's process is
 * recorded. Every process reads only the project's settings, and logs its pid and argv.
 */
const executable = (pids: string) => {
  const path = join(work, "claude")
  writeFileSync(
    path,
    `#!/bin/sh
export USER='${userInfo().username}'
[ "$1" = auth ] && exec '${bundled}' "$@"
case " $* " in *" --no-session-persistence "*)
  FAKE_CLAUDE_FIXTURE='${join(FIXTURES, "models.ndjson")}' FAKE_CLAUDE_DIR='${join(work, "probes")}' exec '${FAKE}' "$@";;
esac
echo "$$ $*" >> '${pids}'
exec '${RECORDER}' "$@" --setting-sources=project
`,
  )
  chmodSync(path, 0o755)
  return path
}

interface Journey {
  readonly ask?: "ask" | "auto"
  readonly files?: Record<string, string>
  readonly start?: Record<string, unknown>
  /** Run the `sigma` binary as the server, so it can be killed, rather than a server in process. */
  readonly binary?: true
  readonly play: (session: Session) => Promise<void>
}

type Session = Awaited<ReturnType<typeof open>>

const notes = { "notes.txt": "the gnome lives under the floor\n" }
const subagentPrompt =
  "Use the Task tool to start a general-purpose subagent that reads notes.txt with the Read tool and reports where the gnome lives. Do not read it yourself. Then reply with where the gnome lives, in three words."

const journeys: Record<string, Journey> = {
  text: { play: (s) => s.say("Reply with exactly: fixture text ok") },
  read: {
    files: notes,
    play: (s) => s.say("Use the Read tool to read notes.txt, then reply with where the gnome lives, in three words."),
  },
  bash_allowed: {
    play: async (s) => {
      await s.submit("Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made")
      await s.answer(true)
      await s.settle()
    },
  },
  bash_declined: {
    play: async (s) => {
      await s.submit(
        "Run the bash command `touch declined.txt` with the Bash tool. If it is not allowed, reply with exactly: declined",
      )
      await s.answer(false)
      await s.settle()
    },
  },
  crash_points: {
    ask: "auto",
    files: notes,
    play: (s) =>
      s.say(
        "First write one short sentence saying that you will read the notes. Then use the Read tool to read notes.txt. Then reply with where the gnome lives, in three words.",
      ),
  },
  died_while_idle: {
    play: async (s) => {
      await s.say("Remember the word PLUM. Reply with exactly: noted")
      await s.kill(0)
      await s.say("Which word did I ask you to remember? Reply with that word only.")
    },
  },
  session_gone: {
    play: async (s) => {
      await s.say("Remember the word PLUM. Reply with exactly: noted")
      await s.kill(0)
      s.forgetSession(0)
      await s.say("Which word did I ask you to remember? Reply with that word only.")
      await s.say("Now reply with that word in lowercase.")
    },
  },
  handoff: {
    start: { provider: "script", model: "script" },
    play: async (s) => {
      await s.say("Remember the word lantern.")
      await s.say("x".repeat(70_000))
      await s.say("Nothing else for now.")
      await s.select("claude", MODEL)
      await s.say("Which word did I ask you to remember? Reply with just the word.")
      await s.select("script", "script")
      await s.say("plum")
      await s.select("claude", MODEL)
      await s.say("What was the last thing I said before this message? Reply with just that word.")
    },
  },
  parallel_reads_hooked: {
    files: { "a.txt": "apple\n", "b.txt": "banana\n" },
    play: (s) =>
      s.say(
        "In a single message, call the Read tool twice in parallel: once on a.txt and once on b.txt. Then reply with both contents, separated by a comma.",
      ),
  },
  skill: {
    files: { ".claude/skills/gnome-facts/SKILL.md": gnomeSkill },
    play: (s) => s.say("Use the Skill tool to run the gnome-facts skill, then do what it says."),
  },
  steer: {
    play: async (s) => {
      await s.submit("Run the bash command `touch steered.txt` with the Bash tool, then reply with exactly: done")
      await s.asked()
      await s.submit("Also end your reply with the word BANANA.", true)
      await s.answer(true)
      await s.settle()
    },
  },
  two_steers: {
    play: async (s) => {
      await s.submit(
        "Run the bash command `touch one.txt` with the Bash tool, then, as a separate call, run `touch two.txt` with the Bash tool, then reply with exactly: done",
      )
      await s.asked()
      await s.submit("Also end your reply with the word BANANA.", true)
      await s.answer(true)
      await s.asked()
      await s.submit("And start your reply with the word CHERRY.", true)
      await s.answer(true)
      await s.settle()
      await s.say("Reply with exactly: still here")
    },
  },
  subagent_asks: {
    play: async (s) => {
      await s.submit(
        "Use the Task tool to start a general-purpose subagent that runs the bash command `touch made.txt` with the Bash tool and reports when it is done. Do not run it yourself. Then reply with exactly: made",
      )
      const child = await s.subagent()
      await s.answer(true, child)
      await child.until(settled(1), TURN)
      await s.settle()
    },
  },
  subagent_stopped: {
    files: notes,
    play: async (s) => {
      await s.submit(subagentPrompt)
      const child = await s.subagent()
      await child.until((watch) => watch.seen().some((e) => e.kind === "pi.tool-result"), TURN)
      await s.interrupt(child.conversation)
      await child.until(settled(1), TURN)
      await s.settle()
    },
  },
  subagent: {
    files: notes,
    play: async (s) => {
      await s.say(subagentPrompt)
      await (await s.subagent()).until(settled(1), TURN)
    },
  },
  fork_wake: {
    ask: "auto",
    play: async (s) => {
      await s.submit(
        'Use the Agent tool with subagent_type "fork" to have a forked subagent reply with exactly: forked. Then reply with exactly what it said.',
      )
      await (await s.subagent()).until(settled(1), TURN)
      // Claude Code answers the fork's end in the same run or in a run of its own: either way, it goes quiet first.
      await s.quiet(1)
      await s.say("Reply with exactly: second")
    },
  },
  subagent_background_asks: {
    play: async (s) => {
      await s.submit(
        "Use the Agent tool with run_in_background set to true to start a general-purpose subagent that runs the bash command `touch made.txt` with the Bash tool and reports when it is done. Do not wait for it, and do not run it yourself. Reply with exactly: started",
      )
      // Claude Code ends its turn while the subagent works, then waits on the subagent's approval before it goes idle.
      const child = await s.subagent()
      await s.answer(true, child)
      await child.until(settled(1), TURN)
      await s.quiet(1)
    },
  },
  bash_background_stopped: {
    ask: "auto",
    play: async (s) => {
      await s.say(
        "Use the Bash tool with run_in_background set to true to run: sleep 600. Do not wait for it. Reply with exactly: started",
      )
      // Esc during a run stops the run, not the background command.
      await s.submit("Use the Bash tool to run: sleep 30. Then reply with exactly: slept")
      await s.until(() => s.calls() >= 2)
      await s.interrupt()
      await s.until(() => runEnds(s.seen()).length >= 2)
      await s.quiet()
      // Esc while idle stops the background command.
      await s.interrupt()
      await s.until(() => s.jobs().every((job) => job.state !== "working"))
      await s.quiet()
      await s.say("Reply with exactly: done")
    },
  },
  bash_background_cut_off: {
    ask: "auto",
    binary: true,
    play: async (s) => {
      await s.say(
        "Use the Bash tool with run_in_background set to true to run: sleep 600. Do not wait for it. Reply with exactly: started",
      )
      // Sigma is killed while the command runs; the next server's run resumes the session, told it was cut off.
      await s.crash()
      await s.say("Is the background command still running? Reply in one short sentence.")
    },
  },
  resume_after_kill: {
    binary: true,
    play: async (s) => {
      await s.submit(
        "Run the bash command `echo started > started.fifo && python3 -c 'import time; time.sleep(120)'` with the Bash tool. If the call is cut off or interrupted, do not run anything again; reply with exactly: resumed ok",
      )
      await s.answer(true)
      await appears(join(s.cwd, "started.fifo"))
      // Sigma is killed while the call runs; the next server resumes the run.
      await s.crash()
      await s.settle()
    },
  },
}

const open = async (name: string, journey: Journey) => {
  const to = join(work, `${name}.ndjson`)
  const pids = join(work, `${name}.pids`)
  rmSync(to, { force: true })
  rmSync(pids, { force: true })
  const home = tempHome()
  for (const [path, text] of Object.entries(journey.files ?? {})) {
    mkdirSync(join(home.dir, path, ".."), { recursive: true })
    writeFileSync(join(home.dir, path), text)
  }
  const claude = executable(pids)
  const serve = async () => {
    if (!journey.binary) {
      const server = await runningServer([], { home, claude: { executable: claude, env: { RECORD_CLAUDE_TO: to } } })
      return { stop: server.stop, kill: () => Promise.reject(new Error("only a binary server can be killed")) }
    }
    const server = await serving(sigmaEnv(home, { SIGMA_CLAUDE: claude, RECORD_CLAUDE_TO: to }))
    return {
      stop: async () => {
        await stopServer(home)
        await server.exited
      },
      kill: async () => {
        server.kill("SIGKILL")
        await server.exited
      },
    }
  }
  let server = await serve()
  let client = await RawClient.connect(home.socket)
  const conversation = (
    await client.call("conversation/start", {
      author: person("ada"),
      cwd: home.dir,
      provider: "claude",
      model: MODEL,
      approvals: journey.ask ?? "ask",
      ...journey.start,
    })
  ).result.conversation as string
  let view = watchView(client, conversation)
  let ended = 0
  const approvals = (on: ViewWatch) =>
    Object.keys((on.view().docs["sigma.approvals"] as { requests?: object } | undefined)?.requests ?? {})
  const answered = new Set<string>()
  const spawns = () =>
    existsSync(pids)
      ? readFileSync(pids, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const [pid, ...argv] = line.split(" ")
            return { pid: Number(pid), argv }
          })
      : []
  const session = {
    to,
    cwd: home.dir,
    submit: (text: string, steer = false) => {
      // A prompt to an idle conversation runs next, after any run Claude Code's own wake started.
      if (!steer) ended = runEnds(view.seen()).length + 1
      return submit(client, conversation, text, crypto.randomUUID(), person("ada"), steer)
    },
    settle: async () => {
      await view.until(settled(ended), TURN)
      await recorderIdle(to)
    },
    /** Until the conversation has `reports` job reports, runs nothing, and Claude Code went idle. */
    quiet: async (reports = 0) => {
      await view.until(
        (watch) =>
          watch.seen().filter((e) => e.kind === "claude.report").length >= reports &&
          (watch.view().docs["pi.live"] as { run?: unknown } | undefined)?.run === undefined,
        TURN,
      )
      await recorderIdle(to)
    },
    /** The calls Claude made in the journey's conversation. */
    calls: () =>
      view
        .seen()
        .filter((e) => e.kind === "pi.assistant")
        .flatMap((e) => (e.model![0] as { content: Array<{ type: string }> }).content)
        .filter((block) => block.type === "toolCall").length,
    /** The conversation's jobs. */
    jobs: () =>
      Object.values(
        (view.view().docs["claude.jobs"] as { jobs?: Record<string, { state: string }> } | undefined)?.jobs ?? {},
      ),
    say: async (text: string) => {
      await session.submit(text)
      await session.settle()
    },
    /** Until a call waits for a person. */
    asked: (on: ViewWatch = view) => on.until(() => approvals(on).some((id) => !answered.has(id)), TURN),
    /** Answers the first call waiting in `on`'s conversation, the journey's own by default. */
    answer: async (allow: boolean, on?: ViewWatch & { conversation: string }) => {
      const watch = on ?? view
      await session.asked(watch)
      const approval = approvals(watch).find((id) => !answered.has(id))!
      answered.add(approval)
      await client.call("approval/resolve", {
        conversation: on?.conversation ?? conversation,
        approval,
        author: person("ada"),
        allow,
      })
    },
    until: (predicate: () => boolean) => view.until(predicate, TURN),
    seen: () => view.seen(),
    select: async (provider: string, model: string) => {
      const reply = await client.call("conversation/select_model", {
        conversation,
        author: person("ada"),
        selection: { provider, model },
      })
      if (reply.error) throw new Error(`select_model: ${JSON.stringify(reply.error)}`)
    },
    /** Kills spawn `n` as a crash would, once it has gone idle. */
    kill: async (n: number) => {
      await recorderIdle(to)
      await killRecorder(spawns()[n]!.pid)
    },
    /** Deletes spawn `n`'s Claude Code session, as if Claude Code had lost it. */
    forgetSession: (n: number) => {
      const argv = spawns()[n]!.argv
      const joined = argv.find((arg) => arg.startsWith("--session-id="))
      const id = joined ? joined.slice("--session-id=".length) : argv[argv.indexOf("--session-id") + 1]!
      const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
      const files = readdirSync(projects).flatMap((dir) =>
        existsSync(join(projects, dir, `${id}.jsonl`)) ? [join(projects, dir, `${id}.jsonl`)] : [],
      )
      if (files.length !== 1) throw new Error(`session ${id}: found ${files.length} files`)
      rmSync(files[0]!)
    },
    /** The first subagent Claude started, once it has. */
    subagent: async () => {
      await view.until((watch) => watch.seen().some((e) => e.kind === "sigma.subagent"), TURN)
      const entry = view.seen().find((e) => e.kind === "sigma.subagent")!
      const id = String((entry.data as { conversation: number }).conversation)
      return Object.assign(watchView(client, id), { conversation: id })
    },
    interrupt: (on = conversation) =>
      client.call("conversation/interrupt", { author: person("ada"), conversation: on }),
    /** Kills the server, as a crash would, and starts another on the same home. */
    crash: async () => {
      client.close()
      await server.kill()
      // A killed server leaves its Claude Code processes running: one would finish its turn into the recording.
      for (const { pid } of spawns()) await killRecorder(pid)
      server = await serve()
      client = await RawClient.connect(home.socket)
      view = watchView(client, conversation)
      await view.until(() => true)
    },
    close: async () => {
      client.close()
      await server.stop()
      await recorderIdle(to)
      rmSync(home.dir, { recursive: true, force: true })
    },
  }
  await view.until(() => true)
  return session
}

/**
 * Kills a recorder and the Claude Code it runs, and waits until both are gone: a Claude Code left alone after its
 * recorder dies can go on spending requests and writing its session.
 */
const killRecorder = async (pid: number) => {
  const children = Bun.spawnSync(["pgrep", "-P", String(pid)])
    .stdout.toString()
    .split("\n")
    .filter(Boolean)
    .map(Number)
  for (const each of [pid, ...children]) {
    try {
      process.kill(each, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
  for (const each of [pid, ...children]) await gone(each)
}

/** Until process `pid` no longer exists. */
const gone = (pid: number) =>
  deadline(
    (async () => {
      while (alive(pid)) await Bun.sleep(50)
    })(),
    10_000,
    `process ${pid} to exit`,
  )
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Until `path` exists. */
const appears = (path: string) =>
  deadline(
    new Promise<void>((resolve) => {
      const check = () => {
        if (existsSync(path)) {
          watcher.close()
          resolve()
        }
      }
      const watcher = watch(join(path, ".."), check)
      check()
    }),
    TURN,
    `${path} to appear`,
  )

/** The recording's frames sigma's Claude Code answered: `R` a result, `i` an idle. */
const shape = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .filter((line) => line.type === "emit_inbound")
    .map((line) =>
      line.frame.type === "result"
        ? "R"
        : line.frame.subtype === "session_state_changed" && line.frame.state === "idle"
          ? "i"
          : "",
    )
    .join("")

/** Until every result in the recording so far is followed by Claude Code's idle. */
const recorderIdle = (path: string) =>
  watching(() => !existsSync(path) || !/R$/.test(shape(path)), 60_000, `idle in ${path}`)

/** Until `done` holds, checked on each change to the run's files. */
const watching = (done: () => boolean, ms: number, what: string) =>
  deadline(
    new Promise<void>((resolve) => {
      const check = () => {
        if (done()) {
          watcher.close()
          resolve()
        }
      }
      const watcher = watch(work, check)
      check()
    }),
    ms,
    what,
  )

/** The recording as a fixture: a header, and the argv as sigma gave it, without the run's own settings source. */
const fixture = (name: string, path: string) => {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
  const version = lines.find((line) => line.frame?.subtype === "init")?.frame.claude_code_version
  for (const line of lines)
    if (line.frame?.argv) line.frame.argv = line.frame.argv.filter((arg: string) => arg !== "--setting-sources=project")
  const header = {
    metadata: { model: MODEL, recorded: `Claude Code ${version} by record-claude-fixtures.ts` },
    provider: "claude",
    scenario: name,
    type: "transcript_start",
  }
  writeFileSync(
    join(FIXTURES, `${name}.ndjson`),
    [header, ...lines].map((line) => `${JSON.stringify(line)}\n`).join(""),
  )
}

const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(journeys)
for (const name of names) {
  const journey = journeys[name]
  if (!journey) throw new Error(`no journey ${name}; journeys: ${Object.keys(journeys).join(", ")}`)
  console.error(`recording ${name}`)
  const session = await open(name, journey)
  try {
    await journey.play(session)
  } finally {
    await session.close()
  }
  fixture(name, session.to)
  console.error(`${name}: ${shape(session.to)}`)
}
rmSync(work, { recursive: true, force: true })
process.exit(0)
