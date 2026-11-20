// `glob`: files whose path matches a glob, newest first, through the call's environment.
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@sigma/harness"
import { obj, opt, type Static, str } from "@sigma/schema"
import { FileError, type GlobQuery } from "@sigma/env"
import { globFiles } from "@sigma/env/search"
import { Effect } from "effect"
import { normalizeToolPath, requireEnv } from "./environment.ts"

const GLOB_LIMIT = 200

const globSchema = obj({
  pattern: str({ description: "The glob to match paths against." }),
  path: opt(str({ description: "The directory to search. Default the working directory." })),
})

export type GlobToolInput = Static<typeof globSchema>

const text = (text: string, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
})

/** Lists files whose path below the searched directory matches a glob, newest first, up to 200; replay-safe. */
export function createGlobTool() {
  return defineTool({
    name: "glob",
    description: `Find files whose path matches a glob, such as \`**/*.ts\` or \`src/*.json\`. Returns paths, newest first, up to ${GLOB_LIMIT}. Inside a git repository, skips files that git ignores.`,
    parameters: globSchema,
    replay: "safe",
    execute: (input: GlobToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        const env = yield* requireEnv(api)
        const path = normalizeToolPath(input.path ?? ".")
        const query: GlobQuery = { pattern: input.pattern, maxPaths: GLOB_LIMIT }
        // An environment that globs where its files are answers in one call; otherwise glob walks through it.
        const found = yield* Effect.catchIf(
          env.glob === undefined ? globFiles(env, path, query) : env.glob(path, query),
          (error) => error.code === "not_found",
          (error) => Effect.succeed(error),
        )
        if (found instanceof FileError) return text(`${input.path} does not exist`, true)
        if (found.total === 0) return text("No files found.")
        const shownRoot = input.path === undefined || input.path === "." ? "" : input.path.replace(/\/+$/, "")
        const shown = found.paths.map((file) => (shownRoot === "" ? file : `${shownRoot}/${file}`))
        return text(
          found.total > GLOB_LIMIT
            ? `${shown.join("\n")}\n[${found.total - GLOB_LIMIT} more not shown]`
            : shown.join("\n"),
        )
      }),
  })
}
