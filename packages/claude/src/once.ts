// An ephemeral run on Claude Code: one prompt answered by a Claude Code process that has no tools, reads no settings,
// MCP servers or hooks, and keeps no session, as attn's `claude -p --setting-sources ""` does. A schema is Claude
// Code's structured output, which it answers through its StructuredOutput tool, so a schema answer takes two turns
// by its count.
import { query, type EffortLevel, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { type OnceAnswer, type OnceRequest, ProviderError } from "@sigma/models"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { claudeEnvironment } from "./environment.ts"
import { bundledExecutable, type ClaudeProcessSettings } from "./process.ts"

const failure = (message: string) => new ProviderError({ message })

/** Why a result that is not a success ended, in Claude Code's words where it gave them. */
const whyEnded = (result: SDKResultMessage, maxTurns: number | undefined) => {
  if (result.subtype === "success") return result.result || "Claude Code failed without saying why"
  if (result.subtype === "error_max_turns")
    return `Claude Code ended the run at its turn limit${maxTurns === undefined ? "" : ` of ${maxTurns}`}`
  if (result.subtype === "error_max_structured_output_retries") return "Claude Code gave up on answering to the schema"
  return result.errors.join("\n") || result.subtype
}

export const claudeOnce =
  (settings: ClaudeProcessSettings) =>
  (request: OnceRequest): Effect.Effect<OnceAnswer, ProviderError> =>
    Effect.gen(function* () {
      const abort = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (abort) => Effect.sync(() => abort.abort()),
      )
      const messages = query({
        prompt: request.prompt,
        options: {
          cwd: tmpdir(),
          abortController: abort,
          pathToClaudeCodeExecutable: settings.executable ?? bundledExecutable(),
          env: { ...claudeEnvironment(settings.env), ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
          tools: [],
          settingSources: [],
          settings: { disableAllHooks: true },
          strictMcpConfig: true,
          mcpServers: {},
          persistSession: false,
          systemPrompt: request.system ?? "",
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.effort === undefined ? {} : { effort: request.effort as EffortLevel }),
          ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
          ...(request.schema === undefined ? {} : { outputFormat: { type: "json_schema", schema: request.schema } }),
        },
      })
      const result = yield* Effect.tryPromise({
        try: async () => {
          for await (const message of messages) if (message.type === "result") return message
          return undefined
        },
        catch: (error) => failure(error instanceof Error ? error.message : String(error)),
      })
      if (result === undefined) return yield* failure("Claude Code ended without an answer")
      if (result.subtype !== "success" || result.is_error) return yield* failure(whyEnded(result, request.maxTurns))
      const models = Object.keys(result.modelUsage)
      const usage = result.usage
      const input = usage.input_tokens
      const cacheRead = usage.cache_read_input_tokens ?? 0
      const cacheWrite = usage.cache_creation_input_tokens ?? 0
      return {
        text: result.result,
        ...(request.schema === undefined ? {} : { output: result.structured_output }),
        model: models[0] ?? request.model ?? "",
        turns: result.num_turns,
        usage: {
          input,
          output: usage.output_tokens,
          cacheRead,
          cacheWrite,
          totalTokens: input + cacheRead + cacheWrite + usage.output_tokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.total_cost_usd },
        },
      }
    }).pipe(Effect.scoped)
