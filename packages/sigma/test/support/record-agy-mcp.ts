// The MCP server `record-agy` gives agy in place of sigma's: it runs sigma's `mcp-bridge` command, given as its
// arguments, and appends each frame agy sends it (`mcp_inbound`) and each it answers (`mcp_outbound`) to RECORD_AGY_TO,
// among the ACP frames, in the order they pass.
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"

const to = process.env.RECORD_AGY_TO!
const record = (type: string, line: string) =>
  appendFileSync(
    to,
    `${JSON.stringify({ type, frame: JSON.parse(line) })
      .split(homedir())
      .join("/home/person")}\n`,
  )

const child = Bun.spawn(process.argv.slice(2), { stdin: "pipe", stdout: "pipe", stderr: "inherit" })

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

void lines(Bun.stdin.stream(), (line) => {
  record("mcp_inbound", line)
  child.stdin.write(`${line}\n`)
  child.stdin.flush()
}).then(() => child.stdin.end())
await lines(child.stdout, (line) => {
  record("mcp_outbound", line)
  process.stdout.write(`${line}\n`)
})
