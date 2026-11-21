// The MCP servers connected clients register (D19): each a name, an endpoint and headers, held in this process's memory
// while its registration lasts and never stored, so no header value reaches the database, a log or a client. A
// conversation names the servers it uses (`AgentState.mcpServers`); sigma lists each one's tools and calls them, as
// the conversation's root, so a harness never holds a server's address or headers. Every request carries
// `Sigma-Root-Conversation`, over one connection per root conversation. The client is pi-mcp, which sigma's own loop
// uses too (D19 of the attn plot s-ct56cj); the in-process server Claude Code reaches is the MCP SDK's
// (`@sigma/claude`), the Agent SDK's own.
import {
  type CallToolResult,
  McpAuthRequiredError,
  McpClient,
  McpError,
  McpSessionExpiredError,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp"
import type { McpListing, McpServer, McpServerRef } from "@sigma/harness"
import type { McpObject, McpOffer } from "@sigma/hosted"
import { InvalidMcpServer, OWN_MCP_SERVER } from "@sigma/protocol"
import { Effect } from "effect"
import { VERSION } from "./version.ts"

/** The header that names the root conversation of every request, as the client chose its id. */
export const ROOT_HEADER = "Sigma-Root-Conversation"

/** One registration of a name, live while the stream that made it lasts. */
type Registration = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** The connection of each root conversation, opened by its first request. */
  readonly clients: Map<string, Promise<McpClient>>
}

/** Why a server a conversation names offers it no tools, as the conversation's notice says. */
export type Unlisted = { readonly server: string; readonly reason: string }

export type McpServers = ReturnType<typeof makeMcpServers>

/** What the servers a conversation starts with listed: each with its listing, and why each that did not offers none. */
export type McpListed = { readonly servers: ReadonlyArray<McpServer>; readonly unlisted: ReadonlyArray<Unlisted> }

/**
 * A failure's message, which says what went wrong without the request's headers. pi-mcp's message for a 401 and for a
 * lost session leaves out what the server answered, which for attn names the conversation it refused; it is added
 * here, cut as pi-mcp cuts the answer it puts in its message for every other status.
 */
const reason = (error: unknown) => {
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof McpAuthRequiredError || error instanceof McpSessionExpiredError)) return error.message
  const said = error.body.trim()
  if (said === "") return error.message
  return `${error.message}: ${said.length > ANSWER_CHARS ? `${said.slice(0, ANSWER_CHARS - 3)}...` : said}`
}

/** pi-mcp's `ERROR_MESSAGE_BODY_CHARS`: how much of a server's answer its message for a failed request keeps. */
const ANSWER_CHARS = 500

/** A `tools/call` result that tells the model the call did not reach `name`. */
const refusal = (text: string): McpObject => ({ content: [{ type: "text", text }], isError: true })

export const makeMcpServers = () => {
  /** Each name's live registrations, newest last: the newest answers. */
  const registered = new Map<string, Registration[]>()
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

  /** Closes `root`'s connection to the registration, so its next request opens a new one. */
  const drop = (registration: Registration, root: string, client: Promise<McpClient>) => {
    if (registration.clients.get(root) === client) registration.clients.delete(root)
    void client.then((open) => open.close()).catch(() => undefined)
  }

  /**
   * Lists the server registered as `name` now, as `root`. pi-mcp's 30 s request limit bounds each request; a server on
   * loopback answers both in milliseconds.
   */
  const list = async (name: string, root: string): Promise<McpListing | Unlisted> => {
    const registration = current(name)
    if (registration === undefined) return { server: name, reason: "no client connected to sigma registers it" }
    const client = connection(registration, root)
    try {
      const open = await client
      const tools = (await open.listTools()) as unknown as McpListing["tools"]
      return { tools, ...(open.instructions === undefined ? {} : { instructions: open.instructions }) }
    } catch (error) {
      drop(registration, root, client)
      return { server: name, reason: `it did not list its tools: ${reason(error)}` }
    }
  }

  /**
   * Calls `tool` of the server registered as `name` now, as `root`. A request that failed on the way, not by the
   * server's answer, closes the connection, so the next call reaches a server that restarted; one whose session the
   * server no longer knows, as after a restart, never reached the tool, and goes again once on a new connection.
   */
  const call = async (
    name: string,
    root: string,
    tool: string,
    args: McpObject,
    signal?: AbortSignal,
    again = true,
  ): Promise<McpObject> => {
    const registration = current(name)
    if (registration === undefined)
      return refusal(`The MCP server ${name} is not available: no client connected to sigma registers it now.`)
    const client = connection(registration, root)
    try {
      // The harness that made the call limits how long it waits, and its signal ends the call.
      const result: CallToolResult = await (
        await client
      ).callTool(tool, args as Record<string, unknown>, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 0,
      })
      return result as unknown as McpObject
    } catch (error) {
      if (signal?.aborted) throw error
      if (!(error instanceof McpError)) drop(registration, root, client)
      if (again && error instanceof McpSessionExpiredError) return call(name, root, tool, args, signal, false)
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
     * What each of `servers` lists now, as a conversation of `root` starts with it: each one's listing, and why each
     * that did not list offers no tools.
     */
    list: (servers: ReadonlyArray<McpServerRef>, root: string): Effect.Effect<McpListed> =>
      Effect.promise(async () => {
        const listings = await Promise.all(servers.map(({ name }) => list(name, root)))
        const unlisted = listings.filter((listing): listing is Unlisted => "reason" in listing)
        return {
          servers: servers.map(({ name, description }, at) => {
            const listing = listings[at]!
            return { name, description, ...("reason" in listing ? {} : { listed: listing }) }
          }),
          unlisted,
        }
      }),
    /** Calls `tool` of the server registered as `name` now, as `root`; see `call`. */
    call: (name: string, root: string, tool: string, args: McpObject, signal?: AbortSignal) =>
      call(name, root, tool, args, signal),
    /**
     * The servers of `servers` as a harness of a conversation of `root` is offered them: each one's tools as it listed
     * them when the conversation started. A server that did not list then offers nothing.
     */
    offers: (servers: ReadonlyArray<McpServer>, root: string): ReadonlyArray<McpOffer> =>
      servers.flatMap(({ name, listed }) =>
        listed === undefined
          ? []
          : [
              {
                name,
                ...(listed.instructions === undefined ? {} : { instructions: listed.instructions }),
                tools: listed.tools,
                call: (tool: string, args: McpObject, signal?: AbortSignal) => call(name, root, tool, args, signal),
              },
            ],
      ),
  }
}
