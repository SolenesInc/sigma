// Records a real `agy acp` as a `fixtures/agy` journey: a server given this as its agy executable runs the real agy,
// and every frame sigma sends (`expect_outbound`) and agy answers (`emit_inbound`) is appended to RECORD_AGY_TO, after a
// `spawn` line per process. The Stop hook sigma gives a session is wrapped: agy runs the recorder's hook, which records
// a `hook` line and then runs sigma's. The session's folder becomes `<workspace>` and the home directory /home/person.
// What agy writes may quote the recording machine: read a recording before committing it. RECORD_AGY_REAL names the
// real agy; default `agy` on PATH.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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

/** The recorder's hook directory: its Stop hook appends a `hook` line, then runs the hook sigma gave the session. */
const wrapHooks = (sigmaHooks: string) => {
  const dir = mkdtempSync(join(tmpdir(), "record-agy-"))
  mkdirSync(join(dir, ".agents"))
  const script = join(dir, ".agents", "stop.sh")
  writeFileSync(
    script,
    `#!/bin/sh
payload=$(cat)
id=$(printf '%s' "$payload" | sed -n 's/.*"conversationId":"\\([^"]*\\)".*/\\1/p')
printf '{"type":"hook","session":"%s"}\\n' "$id" >> '${to}'
printf '%s' "$payload" | '${join(sigmaHooks, ".agents", "stop.sh")}'
`,
  )
  chmodSync(script, 0o755)
  writeFileSync(
    join(dir, ".agents", "hooks.json"),
    JSON.stringify({ record: { Stop: [{ type: "command", command: script }] } }),
  )
  return dir
}

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
    const given = frame.params.additionalDirectories?.[0]
    if (given !== undefined) frame.params.additionalDirectories = [wrapHooks(given)]
    record({
      type: "expect_outbound",
      frame: { ...frame, params: { ...frame.params, additionalDirectories: ["<hooks>"] } },
    })
  } else record({ type: "expect_outbound", frame })
  child.stdin.write(`${JSON.stringify(frame)}\n`)
  child.stdin.flush()
}).then(() => child.stdin.end())
process.on("SIGTERM", () => child.kill())

await lines(child.stdout, (line) => {
  record({ type: "emit_inbound", frame: JSON.parse(line) })
  process.stdout.write(`${line}\n`)
})
void outbound
process.exit(await child.exited)
