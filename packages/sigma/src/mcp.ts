// The MCP servers connected clients register (D19): each a name, an endpoint and headers, held in this process's memory
// while its registration lasts and never stored, so no header value reaches the database, a log or a client. A
// conversation names the servers it uses (`AgentState.mcpServers`); sigma lists each one's tools and calls them, as
// the conversation's root, so a harness never holds a server's address or headers. Every request carries
// `Sigma-Root-Conversation`, over one connection per root conversation. The client is pi-mcp, which sigma's own loop
// uses too (D19 of the attn plot s-ct56cj); the in-process server Claude Code reaches is the MCP SDK's
// (`@sigma/claude`), the Agent SDK's own.
import { type CallToolResult, McpClient, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp"
import type { McpServerRef } from "@sigma/harness"
import type { McpObject, McpOffer } from "@sigma/hosted"
import { InvalidMcpServer, OWN_MCP_SERVER } from "@sigma/protocol"
import { Effect } from "effect"
import { VERSION } from "./version.ts"

/** The header that names the root conversation of every request, as the client chose its id. */
export const ROOT_HEADER = "Sigma-Root-Conversation"

/** What a server said of itself when sigma first listed it: its instructions and its tools. */
type Listing = { readonly instructions?: string; readonly tools: ReadonlyArray<Tool> }

/** One registration of a name, live while the stream that made it lasts. */
type Registration = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** The connection of each root conversation, opened by its first request. */
  readonly clients: Map<string, Promise<McpClient>>
  /**
   * Its listing, made once, by the first conversation that offers it. A server that did not answer offers no tools
   * until it is registered again, so it holds up one run, not each.
   */
  listing?: Promise<Listing | undefined>
}

export type McpServers = ReturnType<typeof makeMcpServers>

/** A failure's message, which says what went wrong without the request's headers. */
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A `tools/call` result that tells the model the call did not reach `name`. */
const refusal = (text: string): McpObject => ({ content: [{ type: "text", text }], isError: true })

export const makeMcpServers = () => {
  /** Each name's live registrations, newest last: the newest answers. */
  const registered = new Map<string, Registration[]>()
  /**
   * Each name's newest listing, kept after its registration ends: a conversation offered its tools keeps them, so its
   * process key holds and each call is refused by name (C24 of s-h55463), and a client that registers again does
   * not restart the processes that use it.
   */
  const listed = new Map<string, Listing>()

  const current = (name: string) => registered.get(name)?.at(-1)

  /** The connection of `root` to the registration, opened at its first use; a failed one is opened again next time. */
  const connection = (registration: Registration, root: string) => {
    const open = registration.clients.get(root)
    if (open !== undefined) return open
    const opening = (async () => {
      const client = new McpClient({ name: "sigma", version: VERSION })
      const headers = Object.fromEntries(
        Object.entries(registration.headers).filter(([key]) => key.toLowerCase() !== ROOT_HEADER.toLowerCase()),
      )
      await client.connect(
        new StreamableHttpTransport({ url: registration.url, headers: { ...headers, [ROOT_HEADER]: root } }),
      )
      client.onClose(() => {
        if (registration.clients.get(root) === opening) registration.clients.delete(root)
      })
      return client
    })()
    registration.clients.set(root, opening)
    opening.catch(() => {
      if (registration.clients.get(root) === opening) registration.clients.delete(root)
    })
    return opening
  }

  /**
   * The registration's tools and instructions, listed once, through `root`'s connection. pi-mcp's 30 s request limit
   * bounds each request; a server on loopback answers both in milliseconds.
   */
  const listingOf = (name: string, registration: Registration, root: string) =>
    (registration.listing ??= (async () => {
      try {
        const client = await connection(registration, root)
        const tools = await client.listTools()
        const listing = { tools, ...(client.instructions === undefined ? {} : { instructions: client.instructions }) }
        if (current(name) === registration) listed.set(name, listing)
        return listing
      } catch (error) {
        console.error(`sigma: the MCP server ${name} did not list its tools: ${reason(error)}`)
        return undefined
      }
    })())

  /** Calls `tool` of the server registered as `name` now, as `root`. */
  const call = async (name: string, root: string, tool: string, args: McpObject, signal?: AbortSignal) => {
    const registration = current(name)
    if (registration === undefined)
      return refusal(`The MCP server ${name} is not available: no client connected to sigma registers it now.`)
    try {
      const client = await connection(registration, root)
      // The harness that made the call limits how long it waits, and its signal ends the call.
      const result: CallToolResult = await client.callTool(tool, args as Record<string, unknown>, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 0,
      })
      return result as unknown as McpObject
    } catch (error) {
      if (signal?.aborted) throw error
      return refusal(`The MCP server ${name} failed: ${reason(error)}`)
    }
  }

  return {
    /**
     * Registers `name` until the scope closes, which removes it and closes its connections. A later registration of
     * the same name answers while it lasts.
     */
    register: (name: string, url: string, headers: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        if (name === OWN_MCP_SERVER)
          return yield* new InvalidMcpServer({ name, message: `${OWN_MCP_SERVER} names sigma's own tools` })
        const protocol = URL.canParse(url) ? new URL(url).protocol : undefined
        if (protocol !== "http:" && protocol !== "https:")
          return yield* new InvalidMcpServer({ name, message: `the MCP server ${name} needs an http or https URL` })
        const registration: Registration = { url, headers: { ...headers }, clients: new Map() }
        yield* Effect.acquireRelease(
          Effect.sync(() => registered.set(name, [...(registered.get(name) ?? []), registration])),
          () =>
            Effect.promise(async () => {
              const left = (registered.get(name) ?? []).filter((each) => each !== registration)
              if (left.length === 0) registered.delete(name)
              else registered.set(name, left)
              const clients = [...registration.clients.values()]
              registration.clients.clear()
              await Promise.allSettled(clients.map(async (client) => (await client).close()))
            }),
        )
      }),
    /**
     * The servers of `servers` as a conversation of `root` is offered them: each registered one's tools as it listed
     * them, or, for one no client registers now, the tools it listed last. A server with no listing offers nothing.
     */
    offers: (servers: ReadonlyArray<McpServerRef>, root: string): Effect.Effect<ReadonlyArray<McpOffer>> =>
      Effect.promise(async () => {
        const offers: McpOffer[] = []
        for (const { name } of servers) {
          const registration = current(name)
          const listing = (registration && (await listingOf(name, registration, root))) ?? listed.get(name)
          if (listing === undefined) continue
          offers.push({
            name,
            ...(listing.instructions === undefined ? {} : { instructions: listing.instructions }),
            tools: listing.tools as unknown as McpOffer["tools"],
            call: (tool, args, signal) => call(name, root, tool, args, signal),
          })
        }
        return offers
      }),
  }
}
