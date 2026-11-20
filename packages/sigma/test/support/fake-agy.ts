// The fake `agy`: plays one recorded `agy acp` process of a `fixtures/agy` journey per spawn, and logs what sigma sent
// it to FAKE_AGY_DIR/log.ndjson. A journey is ndjson: a `spawn` line starts each process; `expect_outbound` waits for
// the frame sigma sends (a request by method, an answer by id, a notification by method); `emit_inbound` writes what
// agy said; `hook` runs the Stop hook sigma gave the session as `additionalDirectories`, as agy does at a turn-over, and
// waits for it to exit; and `exit` ends the process. What agy said before a `hook` reaches sigma only after the hook
// has run or sigma asked something, so sigma always reads a Stop before what agy said ahead of it, which it can on a
// real agy. A request of sigma's own methods (`sigma/…`) is answered at once with -32601, as agy 1.5.13 answers a
// method it does not know; recordings leave those out. `mcp_inbound` writes what agy sent sigma's MCP server, which it
// starts from the session's `mcpServers` as agy does, and `mcp_outbound` waits for that server's answer of the same id
// and logs it. The ids sigma chose are mapped to the ones it sends now; `<workspace>` is the session's folder. An account probe, a process whose folder is a `sigma-agy-probe-` one, plays FAKE_AGY_PROBE instead, by
// default `models.ndjson`.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const dir = process.env.FAKE_AGY_DIR!
mkdirSync(dir, { recursive: true })
const probe = basename(process.cwd()).startsWith("sigma-agy-probe-")
const fixture = probe
  ? (process.env.FAKE_AGY_PROBE ?? join(import.meta.dir, "../../../../fixtures/agy/models.ndjson"))
  : process.env.FAKE_AGY_FIXTURE!

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
  hook?.kill()
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

/** What agy said and sigma has not been given yet: it reaches sigma before anything agy says next. */
let held: Array<unknown> = []
const flush = () => {
  for (const frame of held) process.stdout.write(`${JSON.stringify(frame)}\n`)
  held = []
}
const write = (frame: unknown) => held.push(frame)

/** The Stop hook running now, which ends with the process, as agy's does. */
let hook: Bun.Subprocess | undefined

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
      if (line.trim() === "") continue
      const frame = JSON.parse(line)
      if (frame.method?.startsWith("sigma/") && frame.id !== undefined) {
        log({ received: frame })
        write({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } })
        flush()
        continue
      }
      inbound.push(frame)
      wake?.()
    }
  }
  ended = true
  wake?.()
})()

/** The next frame sigma sent that `wanted` takes; what it sends that the journey does not expect waits unanswered. */
const receive = async (wanted: (frame: any) => boolean) => {
  flush()
  while (true) {
    const index = inbound.findIndex(wanted)
    if (index >= 0) return inbound.splice(index, 1)[0]
    if (ended) {
      hook?.kill()
      log({ exited: "stdin closed" })
      process.exit(0)
    }
    await new Promise<void>((resolve) => (wake = resolve))
  }
}

/** Sigma's MCP server for the session, the first of its `mcpServers`, started at the first `mcp_inbound`. */
let mcpServers: Array<{ command: string; args: string[]; env?: Array<{ name: string; value: string }> }> = []
let mcp: { write: (frame: unknown) => void; receive: (wanted: (frame: any) => boolean) => Promise<any> } | undefined
const startMcp = () => {
  const server = mcpServers[0]!
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const { name, value } of server.env ?? []) env[name] = value
  const child = Bun.spawn([server.command, ...server.args], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env })
  const frames: Array<any> = []
  let arrived: (() => void) | undefined
  void (async () => {
    let buffer = ""
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk)
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== "") frames.push(JSON.parse(line))
        arrived?.()
      }
    }
  })()
  return {
    write: (frame: unknown) => {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      child.stdin.flush()
    },
    receive: async (wanted: (frame: any) => boolean) => {
      while (true) {
        const index = frames.findIndex(wanted)
        if (index >= 0) return frames.splice(index, 1)[0]
        await new Promise<void>((resolve) => (arrived = resolve))
      }
    },
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
      hook = Bun.spawn(["/bin/sh", "-c", handler.command], {
        cwd: join(hooks, ".agents"),
        stdin: new Blob([payload]),
        stdout: "pipe",
      })
      await hook.exited
      hook = undefined
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
        mcpServers = params.mcpServers ?? []
      }
    } else received = await receive((frame) => frame.method === undefined && frame.id === expected.id)
    log({ received })
  } else if (step.type === "emit_inbound") write(substitute(step.frame))
  else if (step.type === "mcp_inbound") {
    // What agy announced on ACP comes before its MCP call, as recorded.
    flush()
    ;(mcp ??= startMcp()).write(substitute(step.frame))
  } else if (step.type === "mcp_outbound") {
    flush()
    log({ mcp: await mcp!.receive((frame) => frame.id === step.frame.id) })
  } else if (step.type === "hook") {
    await stop(step.session)
    flush()
  } else if (step.type === "exit") {
    flush()
    log({ exited: `exit ${step.code}` })
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
    process.exit(step.code)
  }
}
await receive(() => false)
