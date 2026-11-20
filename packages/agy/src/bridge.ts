// How sigma's own tools reach `agy` (D14): `agy` takes MCP servers that it starts itself over stdio, and sigma has no
// network listener, so each process offers one stdio server, `sigma mcp-bridge <socket>`, which pipes its stdio to a
// unix socket this file serves. The socket lives in the home's `bridges` folder, goes with the process, and the server
// removes any a killed server left when it starts.
//
// What it serves is MCP over newline-delimited JSON-RPC, as agy 1.5.13 speaks it: `server/discover`, `initialize`,
// `tools/list`, `tools/call` and `notifications/cancelled`. A `tools/call` carries no call id, only the conversation
// that made it in `_meta` (F17); the process pairs it with the ACP call it announced.
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { OwnResult } from "@sigma/hosted"
import type { Json } from "./acp.ts"

/** Where a process's bridge socket is made, and the command `agy` runs to reach it. */
export interface BridgeOptions {
  readonly dir: string
  readonly command: (socket: string) => { readonly command: string; readonly args: ReadonlyArray<string> }
}

/** One tool the bridge lists. */
export type BridgeTool = { readonly name: string; readonly description: string; readonly inputSchema: unknown }

/** A `tools/call` that arrived over the bridge, from the `agy` conversation `conversation`. */
export type BridgeCall = {
  readonly name: string
  readonly arguments: Json
  readonly conversation: string | undefined
  readonly signal: AbortSignal
}

/** A unix socket path's limit, less its terminating NUL: 104 bytes on macOS, 108 on Linux. A tripwire for a deep home. */
const SOCKET_PATH_LIMIT = 103

/** The MCP protocol version sigma answers with when `agy` asks for none. */
const PROTOCOL = "2025-11-25"

/** Removes the sockets a server that was killed left behind; run when the home's server starts. */
export const clearBridges = (dir: string) => rmSync(dir, { recursive: true, force: true })

/**
 * Serves `tools` on a new socket in `options.dir`, answering each call with `call`. The socket is removed with the
 * scope; every call still waiting is aborted then.
 */
export const openBridge = (
  options: BridgeOptions,
  tools: ReadonlyArray<BridgeTool>,
  call: (request: BridgeCall) => Promise<OwnResult>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      mkdirSync(options.dir, { recursive: true })
      const path = join(options.dir, `${crypto.randomUUID().slice(0, 8)}.sock`)
      if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT)
        throw new Error(`the bridge socket ${path} is longer than a unix socket allows; use a shorter SIGMA_HOME`)
      const calls = new Map<string, AbortController>()
      const listener = Bun.listen<{ buffer: string }>({
        unix: path,
        socket: {
          open: (socket) => void (socket.data = { buffer: "" }),
          data: (socket, chunk) => {
            socket.data.buffer += chunk.toString()
            for (let at = socket.data.buffer.indexOf("\n"); at !== -1; at = socket.data.buffer.indexOf("\n")) {
              const line = socket.data.buffer.slice(0, at)
              socket.data.buffer = socket.data.buffer.slice(at + 1)
              if (line.trim() === "") continue
              const send = (frame: Json) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`)
              handle(JSON.parse(line), send)
            }
          },
        },
      })

      const handle = (message: Json, send: (frame: Json) => void) => {
        const { id, method, params } = message
        const answer = (result: Json) => send({ id, result })
        switch (method) {
          case "initialize":
            return answer({
              protocolVersion: params?.protocolVersion ?? PROTOCOL,
              capabilities: { tools: {} },
              serverInfo: { name: "sigma", version: "0" },
            })
          case "tools/list":
            return answer({ tools })
          case "tools/call": {
            const aborted = new AbortController()
            const key = String(id)
            calls.set(key, aborted)
            const meta = params?._meta ?? {}
            void call({
              name: String(params?.name),
              arguments: params?.arguments ?? {},
              conversation: meta["antigravity.google/conversation_id"],
              signal: aborted.signal,
            })
              .catch((error): OwnResult => ({ content: [{ type: "text", text: String(error) }], isError: true }))
              .then((result) => {
                if (!calls.delete(key)) return
                answer({ content: result.content, isError: result.isError })
              })
            return
          }
          case "notifications/cancelled": {
            const key = String(params?.requestId)
            calls.get(key)?.abort()
            calls.delete(key)
            return
          }
          default:
            // `server/discover`, `ping` and anything newer: an empty answer, as to an optional request.
            if (id !== undefined) answer({})
        }
      }
      return { path, listener, calls }
    }),
    ({ path, listener, calls }) =>
      Effect.sync(() => {
        for (const aborted of calls.values()) aborted.abort()
        listener.stop(true)
        rmSync(path, { force: true })
      }),
  ).pipe(Effect.map(({ path }) => ({ server: { name: "sigma", ...options.command(path) } })))
