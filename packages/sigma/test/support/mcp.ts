// A fake Streamable HTTP MCP server, as an outside service a test's sigma reaches: it answers each POST with JSON, or
// over a server-sent stream for `wait`, offers no GET stream, and logs every request with its headers, so a test judges
// what sigma sent it. It ends a `wait` call its client cancels. Each server process has its own session id and refuses any other with 404, as a restarted real
// server forgets the sessions of the one before.
import { DEADLINE, deadline } from "./raw.ts"

/** The tool the fake serves by default: it answers with the text it was given, as text and as structured content. */
export const ECHO_TOOL = {
  name: "echo",
  description: "Answers with the text it is given",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
  // Claude Code loads a tool marked so with the others, not behind its tool search; sigma offers it from the start.
  _meta: { "anthropic/alwaysLoad": true },
}

/**
 * A deferred tool that answers over a server-sent stream, once the test releases it: `{ waited: <text> }`. Its stream
 * stays open until then, or until the client gives up.
 */
export const WAIT_TOOL = {
  name: "wait",
  description: "Waits for a signal from the operator, then answers with the text it is given",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  outputSchema: { type: "object", properties: { waited: { type: "string" } }, required: ["waited"] },
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
  /** When set, every POST is answered 401 with this text, as attn refuses a conversation no session holds. */
  refusal: string | undefined
  /** The texts of the `wait` calls their client cancelled with `notifications/cancelled` before they were released. */
  readonly cancelled: string[] = []
  readonly #waiters = new Set<() => void>()
  readonly #held = new Map<string, { readonly id: unknown; readonly answer: () => void; readonly end: () => void }>()
  readonly #tools: ReadonlyArray<{ readonly name: string }>
  #session = crypto.randomUUID()
  #server: ReturnType<typeof Bun.serve>

  constructor(tools: ReadonlyArray<{ readonly name: string }> = [ECHO_TOOL]) {
    this.#tools = tools
    this.#server = this.#serve(0)
  }

  #serve(port: number) {
    return Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, fetch: (request) => this.#answer(request) })
  }

  async #answer(request: Request) {
    const headers = Object.fromEntries(request.headers)
    if (request.method !== "POST") {
      this.#received({ http: request.method, headers, body: undefined })
      return new Response(null, { status: request.method === "DELETE" ? 200 : 405 })
    }
    const body = await request.json()
    this.#received({ http: "POST", method: body.method, headers, body })
    if (this.refusal !== undefined) return new Response(this.refusal, { status: 401 })
    const session = headers["mcp-session-id"]
    if (body.method !== "initialize" && session !== this.#session) return new Response(null, { status: 404 })
    if (body.method === "notifications/cancelled") this.#cancel(body.params?.requestId)
    if (body.id === undefined) return new Response(null, { status: 202 })
    const json = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": this.#session } })
    switch (body.method) {
      case "initialize":
        return json({
          protocolVersion: body.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
          instructions: FAKE_INSTRUCTIONS,
        })
      case "tools/list":
        return json({ tools: this.#tools })
      case "tools/call": {
        const text = String(body.params.arguments?.text ?? "")
        if (body.params.name === WAIT_TOOL.name) return this.#wait(body.id, text)
        return json({ content: [{ type: "text", text }], structuredContent: { echoed: text } })
      }
      default:
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no such method" } })
    }
  }

  /** Answers a `wait` call over a server-sent stream once `release(text)` is called, or ends it when it is cancelled. */
  #wait(id: unknown, text: string) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#held.set(text, {
          id,
          answer: () => {
            const result = { content: [{ type: "text", text }], structuredContent: { waited: text } }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`))
            controller.close()
          },
          end: () => controller.close(),
        })
        // A comment opens the stream, so the client reads it before the answer.
        controller.enqueue(encoder.encode(": waiting\n\n"))
        this.#notify()
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "mcp-session-id": this.#session },
    })
  }

  /** Ends the held `wait` call of request `id`, as a server stops the work its client cancelled. */
  #cancel(id: unknown) {
    const held = [...this.#held].find(([, call]) => call.id === id)
    if (held === undefined) return
    this.#held.delete(held[0])
    this.cancelled.push(held[0])
    held[1].end()
  }

  /** Answers the `wait` call given `text`, which must be waiting. */
  release(text: string) {
    const held = this.#held.get(text)
    if (held === undefined) throw new Error(`no wait call holds ${text}`)
    this.#held.delete(text)
    held.answer()
  }

  /** The texts of the `wait` calls waiting for `release`. */
  waiting() {
    return [...this.#held.keys()]
  }

  /** Stops and serves again on the same address, as a new process that knows none of the sessions before. */
  async restart() {
    const port = this.#server.port
    await this.#server.stop(true)
    this.#session = crypto.randomUUID()
    this.#server = this.#serve(port!)
  }

  #received(request: FakeMcpRequest) {
    this.requests.push(request)
    this.onRequest?.(request)
    this.#notify()
  }

  #notify() {
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

  until(predicate: (server: FakeMcpServer) => boolean, what: string, ms = DEADLINE) {
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
