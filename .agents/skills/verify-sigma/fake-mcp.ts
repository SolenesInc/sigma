#!/usr/bin/env bun
// Serves the tests' fake MCP server and registers it with a run's server as <name>, with each <key>=<value> as a
// header, for as long as this process runs: closing it ends the registration. Each request the fake receives is
// appended to <log.ndjson> with its headers.
import { appendFileSync } from "node:fs"
import { ECHO_TOOL, FakeMcpServer, WAIT_TOOL } from "../../../packages/sigma/test/support/mcp.ts"
import { RawClient } from "../../../packages/sigma/test/support/raw.ts"

const [socket, log, name, ...pairs] = process.argv.slice(2)
if (!socket || !log || !name) {
  console.error("usage: fake-mcp.ts <socket> <log.ndjson> <name> [header=value...]")
  process.exit(1)
}
const headers = Object.fromEntries(
  pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
)

// `echo`, offered from the first request, and `wait`, deferred, which never answers here.
const fake = new FakeMcpServer([ECHO_TOOL, WAIT_TOOL])
fake.onRequest = (request) => {
  appendFileSync(log, `${JSON.stringify(request)}\n`)
  console.log(`${request.http} ${request.method ?? ""}`)
}

const client = await RawClient.connect(socket)
const registration = client.watch<{ name: string }>("mcp/register", { name, url: fake.url, headers })
void registration.ended.then((reply) => {
  console.log(`registration ended: ${JSON.stringify(reply.error ?? reply.result)}`)
  process.exit(1)
})
await registration.until((items) => items.length > 0)
console.log(`fake MCP server ${name} registered at ${fake.url}`)
