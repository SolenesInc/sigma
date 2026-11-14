// `grep`: regular expression search of file contents through the call's environment.
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@sigma/harness"
import { bool, obj, opt, type Static, str } from "@sigma/schema"
import type { SearchQuery } from "@sigma/env"
import { searchFiles } from "@sigma/env/search"
import { Effect } from "effect"
import { normalizeToolPath, requireEnv } from "./environment.ts"

const MATCH_LIMIT = 200
const LINE_CHARS = 500

const grepSchema = obj({
  pattern: str({ description: "The regular expression to search for." }),
  path: opt(str({ description: "The file or directory to search. Default the working directory." })),
  glob: opt(str({ description: "Only search files whose path matches this glob, such as `*.ts` or `src/**/*.ts`." })),
  case_insensitive: opt(bool({ description: "Ignore case. Default false." })),
})

export type GrepToolInput = Static<typeof grepSchema>

const text = (text: string, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
})

/** Searches file contents for a JavaScript regular expression, up to 200 matching lines; read-only, so replay-safe. */
export function createGrepTool() {
  return defineTool({
    name: "grep",
    description: `Search file contents for a regular expression (JavaScript syntax). Returns \`path:line:text\` for each matching line, in path order, up to ${MATCH_LIMIT} matches; very long lines are cut. Skips binary files and, inside a git repository, files that git ignores.`,
    parameters: grepSchema,
    replay: "safe",
    execute: (input: GrepToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        try {
          new RegExp(input.pattern)
        } catch (error) {
          return text(`bad pattern: ${(error as Error).message}`, true)
        }
        const env = yield* requireEnv(api)
        const path = normalizeToolPath(input.path ?? ".")
        const query: SearchQuery = {
          pattern: input.pattern,
          maxMatches: MATCH_LIMIT,
          maxLineChars: LINE_CHARS,
          ...(input.case_insensitive ? { caseInsensitive: true } : {}),
          ...(input.glob === undefined ? {} : { glob: input.glob }),
        }
        // An environment that searches where its files are answers in one call; otherwise grep walks through it.
        const found = yield* Effect.catchIf(
          env.search === undefined ? searchFiles(env, path, query) : env.search(path, query),
          (error) => error.code === "not_found",
          () => Effect.succeed(undefined),
        )
        if (found === undefined) return text(`${input.path} does not exist`, true)
        const { matches, truncated } = found
        const shownRoot = input.path === undefined || input.path === "." ? "" : input.path.replace(/\/+$/, "")
        const lines = matches.map(({ path: file, line, text, cut }) => {
          const shown = file === "" ? (input.path ?? path) : shownRoot === "" ? file : `${shownRoot}/${file}`
          return `${shown}:${line}:${cut ? `${text} [line cut]` : text}`
        })
        if (truncated)
          return text(`${lines.join("\n")}\n[stopped at ${MATCH_LIMIT} matches; narrow the pattern or path]`)
        return text(lines.length === 0 ? "No matches." : lines.join("\n"))
      }),
  })
}
