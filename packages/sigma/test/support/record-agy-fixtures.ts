// Records `fixtures/agy` journeys from a real agy: each journey runs a server in process, as the provider tests do, with
// `record-agy` as its agy executable, and types what the recording's user typed. It spends real requests on your agy
// sign-in, on Gemini 4 Hydrogen at low thinking, in agy's default permission mode.
//
//   bun packages/sigma/test/support/record-agy-fixtures.ts [journey...]   (no journey: all of them)
//
// Read every recording before committing it: what Gemini writes may quote the recording machine.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { agyAccount } from "@sigma/agy"
import { RawClient } from "./raw.ts"
import { person, runningServer, settled, submit, tempHome, type ViewWatch, watchView } from "./server.ts"

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

type Journey = { readonly ask?: "ask" | "auto"; readonly run: (session: Session) => Promise<void> }

const approvals = (view: ViewWatch) =>
  Object.keys((view.view().docs["sigma.approvals"] as { requests?: object } | undefined)?.requests ?? {})

const journeys: Record<string, Journey> = {
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
  const options = { home, agy: { executable: RECORDER, env: { RECORD_AGY_TO: to } } }
  let server = await runningServer([], options)
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
      server = await runningServer([], options)
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
const recordModels = async () => {
  const to = join(FIXTURES, "models.ndjson")
  writeFileSync(
    to,
    `${JSON.stringify({ type: "transcript_start", provider: "agy", scenario: "models", metadata: { agy: VERSION } })}\n`,
  )
  await Effect.runPromise(agyAccount({ executable: RECORDER, env: { RECORD_AGY_TO: to } }).health(true))
  console.log("recorded models")
}

mkdirSync(FIXTURES, { recursive: true })
const wanted = process.argv.slice(2)
if (wanted.length === 0 || wanted.includes("models")) await recordModels()
for (const [name, journey] of Object.entries(journeys)) {
  if (wanted.length === 0 || wanted.includes(name)) await record(name, journey)
}
process.exit(0)
