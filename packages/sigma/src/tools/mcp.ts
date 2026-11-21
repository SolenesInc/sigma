// The tools of a conversation's MCP servers on sigma's own loop (D19, D22 of the attn plot s-ct56cj), modeled on pi's
// `apps/p2/plugins/mcp/tools.ts`: each tool as `mcp__<server>__<tool>`, named as pi names it, from what the server
// listed when the conversation started, so they never change after its first request. A tool the server marks
// `anthropic/alwaysLoad` is offered from the first request like sigma's own; every other one is deferred, found with
// `tool_search` by a model that takes tools directly and with `searchTools()` by a code mode script. Each server is a
// code mode namespace whose description is the one the conversation started with, and `describeNamespace()` answers
// with the server's instructions.
import type { CodemodeNamespace } from "@sigma/codemode"
import {
  type Agent,
  defineExtension,
  type Harness,
  section,
  type McpServer,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@sigma/harness"
import type { McpObject } from "@sigma/hosted"
import type { JsonValue } from "@sigma/kernel"
import { createToolSearchTool } from "@sigma/tools"
import {
  type CallToolResult,
  createMcpToolName,
  limitMcpContent,
  mcpNamespace,
  normalizeMcpInputSchema,
  toLlmContent,
  type Tool,
} from "@earendil-works/pi-mcp"
import { Effect } from "effect"
import { rootName } from "../conversations.ts"
import type { McpServers } from "../mcp.ts"

export const MCP_EXTENSION = "mcp"

/** The `_meta` key with which a server asks for a tool to be offered from the first request, as attn's core tools. */
const ALWAYS_LOAD = "anthropic/alwaysLoad"

/** Calls `tool` of the server `name` as the conversation's root, ended by `signal`. */
type Call = (name: string, root: string, tool: string, args: McpObject, signal: AbortSignal) => Promise<McpObject>

/**
 * The tools of `servers` by the names pi gives them: every tool whose name sanitizes to another's also gets pi's hash
 * suffix, so no name depends on the order of the list.
 */
const named = (servers: ReadonlyArray<McpServer>) => {
  const listed = servers.flatMap(({ name, listed }) =>
    (listed?.tools ?? []).map((tool) => ({ server: name, tool: tool as unknown as Tool })),
  )
  const plain = new Map<string, number>()
  for (const { server, tool } of listed) {
    const name = createMcpToolName(server, tool.name)
    plain.set(name, (plain.get(name) ?? 0) + 1)
  }
  const assigned = new Set<string>()
  return listed.map((entry) => {
    const name = createMcpToolName(
      entry.server,
      entry.tool.name,
      (candidate) => (plain.get(candidate) ?? 0) > 1 || assigned.has(candidate),
    )
    assigned.add(name)
    return { name, ...entry }
  })
}

/** One MCP tool as a sigma tool; not replay-safe, so an interrupted call is not repeated. */
const toolOf = (name: string, server: string, tool: Tool, harness: () => Harness, call: Call): ToolRegistration => ({
  name,
  description:
    tool.description?.trim() || tool.title || tool.annotations?.title || `MCP tool ${tool.name} of ${server}`,
  parameters: normalizeMcpInputSchema(tool.inputSchema),
  ...(tool._meta?.[ALWAYS_LOAD] === true ? {} : { deferred: true as const }),
  ...(tool.outputSchema === undefined ? {} : { structuredOutputSchema: tool.outputSchema }),
  execute: (args: McpObject, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      const root = yield* rootName(harness(), api.conversationId)
      // Interrupting the call aborts the signal, which cancels the request.
      const result = (yield* Effect.tryPromise((signal) =>
        call(server, root, tool.name, args, signal),
      )) as unknown as CallToolResult
      const content = toLlmContent(result)
      if (result.isError && !content.some((block) => block.type === "text" && block.text.trim() !== ""))
        content.push({ type: "text", text: `MCP tool ${server}/${tool.name} returned an error` })
      const limited = yield* Effect.promise(() => limitMcpContent(content))
      return {
        output: limited.content,
        isError: result.isError === true,
        details: { server, tool: tool.name },
        ...(tool.outputSchema !== undefined && result.structuredContent !== undefined
          ? { structuredOutput: result.structuredContent as JsonValue }
          : {}),
      }
    }),
})

/**
 * The `mcp` extension: each conversation's MCP tools, from what its servers listed when it started, and `tool_search`
 * when one of them is deferred. A model that takes only code mode is offered neither: its scripts call the tools.
 */
export const mcpTools = (servers: McpServers, harness: () => Harness) => {
  const search = createToolSearchTool()
  return defineExtension({
    name: MCP_EXTENSION,
    sections: [
      section("mcp-servers", (input) =>
        Effect.sync(() => {
          // A request that offers tool_search; code mode lists the servers in its own section.
          if (!input.agent.tools.some((tool) => tool.name === search.name)) return undefined
          const servers = (input.agent.mcpServers ?? []).filter(({ listed }) => listed !== undefined)
          return [
            `Tools of these MCP servers are found with \`${search.name}\`:`,
            ...servers.map(({ name, description }) => `- ${mcpNamespace(name)}: ${description}`),
          ].join("\n")
        }),
      ),
    ],
    stateTools: (state) => {
      const tools = named(state.mcpServers ?? []).map(({ name, server, tool }) =>
        toolOf(name, server, tool, harness, servers.call),
      )
      return tools.some((tool) => tool.deferred === true) ? [...tools, search] : tools
    },
  })
}

/** Each of the agent's MCP servers as a code mode namespace, described as the conversation started with it. */
export const mcpNamespaces = (agent: Agent): ReadonlyArray<CodemodeNamespace> =>
  (agent.mcpServers ?? []).flatMap(({ name, description, listed }) =>
    listed === undefined
      ? []
      : [
          {
            name: mcpNamespace(name),
            prefix: `${mcpNamespace(name)}__`,
            description,
            ...(listed.instructions === undefined ? {} : { instructions: listed.instructions }),
          },
        ],
  )
