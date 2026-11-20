// A fake Streamable HTTP MCP server, as an outside service a test's sigma reaches: it answers each POST with JSON, offers
// no server-sent stream, and logs every request with its headers, so a test judges what sigma sent it.
import { deadline } from "./raw.ts"

/** The one tool the fake serves: it answers with the text it was given, as text and as structured content. */
export const ECHO_TOOL = {
  name: "echo",
  description: "Answers with the text it is given",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
  // Claude Code loads a tool marked so with the others, not behind its tool search.
  _meta: { "anthropic/alwaysLoad": true },
}

/** What the fake's `initialize` tells its clients. */
export const FAKE_INSTRUCTIONS = "Use echo to hear your own words."

export interface FakeMcpRequest {
  /** The HTTP method: POST for a message, DELETE when a client ends its session. */
  readonly http: string
  /** The JSON-RPC method of a POST. */
  readonly method?: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: any
}

export class FakeMcpServer {
  readonly requests: FakeMcpRequest[] = []
  /** Called with each request as it arrives. */
  onRequest: ((request: FakeMcpRequest) => void) | undefined
  readonly #waiters = new Set<() => void>()
  readonly #server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const headers = Object.fromEntries(request.headers)
      if (request.method !== "POST") {
        this.#received({ http: request.method, headers, body: undefined })
        return new Response(null, { status: request.method === "DELETE" ? 200 : 405 })
      }
      const body = await request.json()
      this.#received({ http: "POST", method: body.method, headers, body })
      if (body.id === undefined) return new Response(null, { status: 202 })
      const json = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "fake-session" } })
      switch (body.method) {
        case "initialize":
          return json({
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1.0.0" },
            instructions: FAKE_INSTRUCTIONS,
          })
        case "tools/list":
          return json({ tools: [ECHO_TOOL] })
        case "tools/call": {
          const text = String(body.params.arguments?.text ?? "")
          return json({ content: [{ type: "text", text }], structuredContent: { echoed: text } })
        }
        default:
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no such method" } })
      }
    },
  })

  #received(request: FakeMcpRequest) {
    this.requests.push(request)
    this.onRequest?.(request)
    for (const waiter of this.#waiters) waiter()
  }

  /** Whether a client ended its session, as sigma does when the registration it was opened for ends. */
  ended() {
    return this.requests.some((request) => request.http === "DELETE")
  }

  get url() {
    return `http://127.0.0.1:${this.#server.port}/mcp`
  }

  /** The `tools/call` requests it received, in order. */
  calls() {
    return this.requests.filter((request) => request.method === "tools/call")
  }

  until(predicate: (server: FakeMcpServer) => boolean, what: string, ms = 10_000) {
    let check = () => {}
    return deadline(
      new Promise<void>((resolve) => {
        check = () => predicate(this) && resolve()
        this.#waiters.add(check)
        check()
      }),
      ms,
      what,
    ).finally(() => this.#waiters.delete(check))
  }

  [Symbol.dispose]() {
    void this.#server.stop(true)
  }
}
