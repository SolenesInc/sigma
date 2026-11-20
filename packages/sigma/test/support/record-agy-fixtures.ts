// Records `fixtures/agy` journeys from a real agy: each journey runs a server in process, as the provider tests do, with
// `record-agy` as its agy executable, and types what the recording's user typed. It spends real requests on your agy
// sign-in, on Gemini 4 Hydrogen at low thinking, in agy's default permission mode.
//
//   bun packages/sigma/test/support/record-agy-fixtures.ts [journey...]   (no journey: all of them)
//
// Read every recording before committing it: what Gemini writes may quote the recording machine.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { agyAccount } from "@sigma/agy"
import type { ScriptStep } from "@sigma/models"
import { RawClient } from "./raw.ts"
import { person, runEnds, runningServer, settled, submit, tempHome, type ViewWatch, watchView } from "./server.ts"

const MODEL = "gemini-4-hydrogen"
const EFFORT = "low"
const FIXTURES = join(import.meta.dir, "../../../../fixtures/agy")
const RECORDER = join(import.meta.dir, "record-agy")
/** A real model turn takes seconds, a background command tens of them; only a stuck journey reaches this. */
const TURN = 300_000
const VERSION = (await Bun.$`agy --version`.text()).trim()

type Session = {
  readonly view: ViewWatch
  readonly submit: (text: string, steer?: boolean) => Promise<unknown>
  readonly answer: (allow: boolean) => Promise<void>
  readonly interrupt: () => Promise<void>
  /** Stops the server and starts a new one on the same home. */
  readonly restart: () => Promise<void>
  readonly settle: (runs: number) => Promise<void>
}

type Journey = {
  readonly ask?: "ask" | "auto"
  /** agy signed out: it runs in an empty home of its own. */
  readonly signedOut?: boolean
  /** The steps of the home's `script` provider, which a worker the journey's Gemini starts there plays. */
  readonly script?: ReadonlyArray<ScriptStep>
  readonly run: (session: Session) => Promise<void>
}

/** The real agy binary, not a version manager's shim, which needs the person's own home. */
const REAL = (await Bun.$`mise which agy`.nothrow().text()).trim() || "agy"
const signedOutEnv = () => ({ HOME: mkdtempSync(join(tmpdir(), "agy-signed-out-")), RECORD_AGY_REAL: REAL })

const approvals = (view: ViewWatch) =>
  Object.keys((view.view().docs["sigma.approvals"] as { requests?: object } | undefined)?.requests ?? {})

const journeys: Record<string, Journey> = {
  signed_out: {
    signedOut: true,
    run: async (s) => {
      await s.submit("Reply with exactly: hello")
      await s.settle(1)
    },
  },
  text: {
    run: async (s) => {
      await s.submit("Reply with exactly: fixture text ok")
      await s.settle(1)
    },
  },
  approval_allowed: {
    run: async (s) => {
      await s.submit("Run the shell command `touch allowed.txt`, then reply with exactly: touched")
      await s.answer(true)
      await s.settle(1)
    },
  },
  approval_denied: {
    run: async (s) => {
      await s.submit("Run the shell command `touch denied.txt`, then reply with exactly: touched")
      await s.answer(false)
      await s.settle(1)
    },
  },
  steer: {
    run: async (s) => {
      await s.submit("Run the shell command `touch steered.txt`, then reply with exactly: done")
      await s.view.until((watch) => approvals(watch).length > 0, TURN)
      await s.submit("Also end your reply with the word BANANA.", true)
      await s.answer(true)
      await s.settle(1)
    },
  },
  interrupt: {
    run: async (s) => {
      await s.submit("Write a 600-word essay about rivers.")
      await s.view.until(
        (watch) => (watch.view().docs["pi.live"] as { generation?: object } | undefined)?.generation !== undefined,
        TURN,
      )
      await s.interrupt()
      await s.settle(1)
      await s.submit("Reply with exactly: after the stop")
      await s.settle(2)
    },
  },
  restart: {
    run: async (s) => {
      await s.submit("Remember the word PLUM. Reply with exactly: noted")
      await s.settle(1)
      await s.restart()
      await s.submit("Which word did I ask you to remember? Reply with that word only.")
      await s.settle(2)
    },
  },
  background_wake: {
    ask: "auto",
    run: async (s) => {
      await s.submit("Run the shell command `sleep 30; echo bg-marker` and tell me what it printed.")
      await s.settle(2)
    },
  },
  interrupt_call: {
    run: async (s) => {
      await s.submit("Run the shell command `sleep 3 && echo started && sleep 60`, then reply with exactly: slept")
      await s.answer(true)
      // Stopped while the command runs, before agy would move it to the background.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await s.interrupt()
      await s.settle(1)
      await s.submit("Did your last command finish? Reply with exactly one word: finished or interrupted")
      await s.settle(2)
    },
  },
  wake_interrupted: {
    ask: "auto",
    run: async (s) => {
      await s.submit(
        "Run the shell command `sleep 15; echo wake-marker`. When it finishes, write a 600-word essay about rivers that mentions what it printed.",
      )
      await s.settle(1)
      // The wake run, once Gemini is writing in it.
      await s.view.until(
        (watch) =>
          runEnds(watch.seen()).length === 1 &&
          (watch.view().docs["pi.live"] as { generation?: object } | undefined)?.generation !== undefined,
        TURN,
      )
      await s.interrupt()
      await s.settle(2)
      await s.submit("Reply with exactly: after the wake")
      await s.settle(3)
    },
  },
  job_progress: {
    ask: "auto",
    run: async (s) => {
      await s.submit(
        "Run the shell command `for i in 1 2 3 4; do echo tick $i; sleep 4; done` and tell me its last line when it ends.",
      )
      await s.settle(2)
    },
  },
  worker_parent: {
    script: [{ agent: "/root/helper", text: "hello from the worker" }],
    run: async (s) => {
      await s.submit(
        "Use the mcp_sigma_start_worker tool with task_name helper, provider script and message: Say hello. Then call mcp_sigma_wait_worker, and reply with exactly the text the worker sent.",
      )
      await s.settle(1)
    },
  },
  worker_wait_limit: {
    // The worker's bash call waits for a person nobody is, so it never answers.
    script: [{ agent: "/root/slow", tool: { name: "bash", input: { command: "echo made" } } }],
    run: async (s) => {
      await s.submit(
        "Use the mcp_sigma_start_worker tool with task_name slow, provider script and message: Make it. Then call mcp_sigma_wait_worker once with timeout_ms 600000, and reply with exactly what it returned, without calling it again.",
      )
      await s.settle(1)
    },
  },
  subagent_wake: {
    ask: "auto",
    run: async (s) => {
      await s.submit(
        "Use your invoke_subagent tool to start one subagent whose task is: reply with the single word plum. Do not wait for its answer; reply with exactly: started",
      )
      await s.settle(2)
    },
  },
}

const record = async (name: string, journey: Journey) => {
  const to = join(FIXTURES, `${name}.ndjson.part`)
  rmSync(to, { force: true })
  writeFileSync(
    to,
    `${JSON.stringify({ type: "transcript_start", provider: "agy", scenario: name, metadata: { agy: VERSION, model: MODEL, effort: EFFORT, recorded: "record-agy" } })}\n`,
  )
  const home = tempHome()
  const options = {
    home,
    agy: { executable: RECORDER, env: { RECORD_AGY_TO: to, ...(journey.signedOut ? signedOutEnv() : {}) } },
  }
  let server = await runningServer(journey.script ?? [], options)
  let client = await RawClient.connect(home.socket)
  const conversation = (
    await client.call("conversation/start", {
      author: person("ada"),
      cwd: home.dir,
      provider: "agy",
      model: MODEL,
      effort: EFFORT,
      approvals: journey.ask ?? "ask",
    })
  ).result.conversation as string
  let view = watchView(client, conversation)
  const session: Session = {
    get view() {
      return view
    },
    submit: (text, steer = false) => submit(client, conversation, text, crypto.randomUUID(), person("ada"), steer),
    answer: async (allow) => {
      await view.until((watch) => approvals(watch).length > 0, TURN)
      await client.call("approval/resolve", {
        conversation,
        approval: approvals(view)[0],
        author: person("ada"),
        allow,
      })
    },
    interrupt: async () => {
      await client.call("conversation/interrupt", { author: person("ada"), conversation })
    },
    restart: async () => {
      client.close()
      await server.stop()
      server = await runningServer(journey.script ?? [], options)
      client = await RawClient.connect(home.socket)
      view = watchView(client, conversation)
    },
    settle: (runs) => view.until(settled(runs), TURN),
  }
  try {
    await journey.run(session)
  } finally {
    client.close()
    await server.stop()
    rmSync(home.dir, { recursive: true, force: true })
  }
  renameSync(to, join(FIXTURES, `${name}.ndjson`))
  console.log(`recorded ${name}`)
}

/** The account's probe: the fake plays it for every process whose folder is a probe's. */
const recordProbe = async (name: string, env: Record<string, string> = {}) => {
  const to = join(FIXTURES, `${name}.ndjson`)
  writeFileSync(
    to,
    `${JSON.stringify({ type: "transcript_start", provider: "agy", scenario: name, metadata: { agy: VERSION } })}\n`,
  )
  await Effect.runPromise(agyAccount({ executable: RECORDER, env: { RECORD_AGY_TO: to, ...env } }).health(true))
  console.log(`recorded ${name}`)
}

mkdirSync(FIXTURES, { recursive: true })
const wanted = process.argv.slice(2)
if (wanted.length === 0 || wanted.includes("models")) await recordProbe("models")
if (wanted.length === 0 || wanted.includes("models_signed_out")) await recordProbe("models_signed_out", signedOutEnv())
for (const [name, journey] of Object.entries(journeys)) {
  if (wanted.length === 0 || wanted.includes(name)) await record(name, journey)
}
process.exit(0)
