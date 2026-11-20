// The fake `agy`: plays one recorded `agy acp` process of a `fixtures/agy` journey per spawn, and logs what sigma sent
// it to FAKE_AGY_DIR/log.ndjson. A journey is ndjson: a `spawn` line starts each process; `expect_outbound` waits for
// the frame sigma sends (a request by method, an answer by id, a notification by method); `emit_inbound` writes what
// agy said; `hook` runs the Stop hook sigma gave the session as `additionalDirectories`, as agy does at a turn-over; and
// `exit` ends the process. The ids sigma chose are mapped to the ones it sends now; `<workspace>` is the session's
// folder. An account probe, a process whose folder is a `sigma-agy-probe-` one, plays `models.ndjson` instead.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const dir = process.env.FAKE_AGY_DIR!
mkdirSync(dir, { recursive: true })
const probe = basename(process.cwd()).startsWith("sigma-agy-probe-")
const fixture = probe ? join(import.meta.dir, "../../../../fixtures/agy/models.ndjson") : process.env.FAKE_AGY_FIXTURE!

// A test's FakeAgy listens on log.sock to learn when a line is logged; without one, nothing listens.
const pings = await Bun.connect({ unix: join(dir, "log.sock"), socket: { data: () => undefined } }).catch(
  () => undefined,
)
pings?.unref()

const counterFile = join(dir, probe ? "probes" : "spawns")
const spawn = Number(readFileSync(counterFile, { encoding: "utf8", flag: "a+" }) || "0")
writeFileSync(counterFile, String(spawn + 1))

const log = (entry: object) => {
  appendFileSync(
    join(dir, "log.ndjson"),
    `${JSON.stringify(probe ? { probe: spawn, ...entry } : { spawn, ...entry })}\n`,
  )
  pings?.write("\n")
}
log({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  rootConversation: process.env.SIGMA_ROOT_CONVERSATION,
  pid: process.pid,
})
process.on("SIGTERM", () => {
  log({ exited: "SIGTERM" })
  process.exit(143)
})

const segments: Array<Array<any>> = []
for (const line of readFileSync(fixture, "utf8").split("\n")) {
  if (line.trim() === "") continue
  const step = JSON.parse(line)
  if (step.type === "spawn") segments.push([])
  else if (step.type !== "transcript_start") segments.at(-1)?.push(step)
}

/** Recorded ids of sigma's requests, by the ids it sends now. */
const ids = new Map<number, number>()
let workspace = process.cwd()
let hooks: string | undefined
const substitute = (frame: any) => {
  const text = JSON.stringify(frame).split("<workspace>").join(workspace)
  const out = JSON.parse(text)
  if (out.method === undefined && typeof out.id === "number" && ids.has(out.id)) out.id = ids.get(out.id)
  return out
}

const inbound: Array<any> = []
let wake: (() => void) | undefined
let ended = false
void (async () => {
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk)
    let newline: number
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== "") inbound.push(JSON.parse(line))
      wake?.()
    }
  }
  ended = true
  wake?.()
})()

const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`)

/** The next frame sigma sent that `wanted` takes; what it sends that the journey does not expect is logged and answered. */
const receive = async (wanted: (frame: any) => boolean) => {
  while (true) {
    const index = inbound.findIndex(wanted)
    if (index >= 0) return inbound.splice(index, 1)[0]
    if (ended) {
      log({ exited: "stdin closed" })
      process.exit(0)
    }
    await new Promise<void>((resolve) => (wake = resolve))
  }
}

/** Runs the Stop hook sigma gave the session, with agy's payload for `session`. */
const stop = async (session: string) => {
  if (hooks === undefined) return
  const config = JSON.parse(readFileSync(join(hooks, ".agents", "hooks.json"), "utf8"))
  for (const handlers of Object.values<any>(config)) {
    for (const handler of handlers.Stop ?? []) {
      const payload = JSON.stringify({
        conversationId: session,
        hookEventName: "Stop",
        terminationReason: "NO_TOOL_CALL",
      })
      const child = Bun.spawn(["/bin/sh", "-c", handler.command], {
        cwd: join(hooks, ".agents"),
        stdin: new Blob([payload]),
        stdout: "pipe",
      })
      await child.exited
    }
  }
}

// Every probe plays the one recorded probe.
for (const step of segments[probe ? 0 : spawn] ?? []) {
  if (step.type === "expect_outbound") {
    const expected = step.frame
    let received: any
    if (expected.method !== undefined) {
      received = await receive((frame) => frame.method === expected.method)
      if (expected.id !== undefined) ids.set(expected.id, received.id)
      const params = received.params ?? {}
      if (expected.method === "session/new" || expected.method === "session/load") {
        workspace = params.cwd ?? workspace
        hooks = params.additionalDirectories?.[0]
      }
    } else received = await receive((frame) => frame.method === undefined && frame.id === expected.id)
    log({ received })
  } else if (step.type === "emit_inbound") write(substitute(step.frame))
  else if (step.type === "hook") await stop(step.session)
  else if (step.type === "exit") {
    log({ exited: `exit ${step.code}` })
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
    process.exit(step.code)
  }
}
await receive(() => false)
