// Records a real `agy acp` as a `fixtures/agy` journey: a server given this as its agy executable runs the real agy,
// and every frame sigma sends (`expect_outbound`) and agy answers (`emit_inbound`) is appended to RECORD_AGY_TO, after a
// `spawn` line per process. A Stop of the session is recorded as a `hook` line where sigma's request that places it
// is answered, which is where the Stop falls in what agy says (`packages/agy/src/hook.ts`); a subagent's Stop, which
// sigma does not place, is not recorded. Sigma's MCP server is wrapped by `record-agy-mcp.ts`. The session's folder
// becomes `<workspace>` and the home directory /home/person.
// Sigma's requests of its own methods (`sigma/…`), and their answers, are left out: the fake agy answers those itself.
// What agy writes may quote the recording machine: read a recording before committing it. RECORD_AGY_REAL names the
// real agy; default `agy` on PATH.
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const to = process.env.RECORD_AGY_TO!
const real = process.env.RECORD_AGY_REAL ?? "agy"
let workspace: string | undefined

const replace = (text: string) => {
  let out = workspace === undefined ? text : text.split(workspace).join("<workspace>")
  out = out.split(homedir()).join("/home/person")
  return out
}
const record = (line: object) => appendFileSync(to, `${replace(JSON.stringify(line))}\n`)

/** Sigma's requests of its own methods, by id, with the session each names. */
const own = new Map<number | string, string | undefined>()

record({ type: "spawn" })
const child = Bun.spawn([real, ...process.argv.slice(2)], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })

const lines = async (stream: ReadableStream<Uint8Array>, each: (line: string) => void) => {
  let buffer = ""
  for await (const chunk of stream) {
    buffer += new TextDecoder().decode(chunk)
    let newline: number
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== "") each(line)
    }
  }
}

const outbound = lines(Bun.stdin.stream(), (line) => {
  const frame = JSON.parse(line)
  if (frame.method === "session/new" || frame.method === "session/load") {
    workspace = frame.params.cwd
    record({
      type: "expect_outbound",
      frame: { ...frame, params: { ...frame.params, additionalDirectories: ["<hooks>"] } },
    })
    // Sigma's MCP server, its bridge, runs under the recorder's, which records what passes through it.
    frame.params.mcpServers = (frame.params.mcpServers ?? []).map((server: any) => ({
      ...server,
      command: process.execPath,
      args: [join(import.meta.dir, "record-agy-mcp.ts"), server.command, ...server.args],
      env: [...(server.env ?? []), { name: "RECORD_AGY_TO", value: to }],
    }))
  } else if (frame.method?.startsWith("sigma/") && frame.id !== undefined) own.set(frame.id, frame.params?.sessionId)
  else record({ type: "expect_outbound", frame })
  child.stdin.write(`${JSON.stringify(frame)}\n`)
  child.stdin.flush()
}).then(() => child.stdin.end())
process.on("SIGTERM", () => child.kill())

await lines(child.stdout, (line) => {
  const frame = JSON.parse(line)
  if (frame.method === undefined && own.has(frame.id)) {
    const session = own.get(frame.id)
    own.delete(frame.id)
    if (session !== undefined) record({ type: "hook", session })
  } else record({ type: "emit_inbound", frame })
  process.stdout.write(`${line}\n`)
})
void outbound
process.exit(await child.exited)
