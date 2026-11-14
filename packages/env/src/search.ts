// The files below a directory, as `grep` and `glob` search them, and grep's matching over them, through an environment.
// `LocalExecutionEnv.search` runs `searchFiles` where the files are, so a remote search is one call (D8).
import { Effect } from "effect"
import { type ExecutionEnv, FileError, type SearchMatch, type SearchQuery, type SearchResult } from "./index.ts"

const BINARY_PROBE = 8192

/**
 * Paths of the files below `root`, relative to it with `/` separators, sorted. Inside a git work tree, what git
 * tracks or would track (`git ls-files --cached --others --exclude-standard`), so ignored files are skipped; elsewhere
 * a walk that skips names starting with `.`. `undefined` when `root` does not exist; a file lists itself as `""`.
 */
export const filesBelow = (env: ExecutionEnv, root: string): Effect.Effect<string[] | undefined, FileError> =>
  Effect.gen(function* () {
    // `fileInfo` does not follow symlinks, so a symlinked root is classified by what it points to.
    const info = yield* Effect.option(Effect.flatMap(env.canonicalPath(root), (target) => env.fileInfo(target)))
    if (info._tag === "None") return undefined
    if (info.value.kind !== "directory") return [""]
    const tracked = yield* gitFiles(env, root)
    return (tracked ?? (yield* walk(env, root, ""))).sort()
  })

const gitFiles = (env: ExecutionEnv, root: string) =>
  Effect.gen(function* () {
    let output = ""
    const exit = yield* Effect.exit(
      env.exec(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        onOutput: (text, info) => {
          if (info.stream === "stdout") output += text
        },
      }),
    )
    if (exit._tag === "Failure" || exit.value.exitCode !== 0) return undefined
    return output.split("\0").filter((path) => path !== "")
  })

const walk = (env: ExecutionEnv, root: string, prefix: string): Effect.Effect<string[], FileError> =>
  Effect.gen(function* () {
    const directory = prefix === "" ? root : yield* env.joinPath([root, prefix])
    const files: string[] = []
    for (const entry of yield* env.listDir(directory)) {
      if (entry.name.startsWith(".")) continue
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.kind === "directory") files.push(...(yield* walk(env, root, path)))
      else if (entry.kind === "file") files.push(path)
    }
    return files
  })

/** A glob test of a path relative to the searched directory: a pattern without `/` matches the file name alone. */
export const globMatcher = (pattern: string): ((path: string) => boolean) => {
  const glob = new Bun.Glob(pattern)
  return pattern.includes("/") ? (path) => glob.match(path) : (path) => glob.match(path.split("/").at(-1)!)
}

/**
 * The lines matching `query` in the text files below `path`, through `env`'s own operations: what
 * `FileSystem.search` answers, for an environment that runs it where the files are and for callers of one that does not.
 */
export const searchFiles = (
  env: ExecutionEnv,
  path: string,
  query: SearchQuery,
): Effect.Effect<SearchResult, FileError> =>
  Effect.gen(function* () {
    let regex: RegExp
    try {
      regex = new RegExp(query.pattern, query.caseInsensitive ? "i" : "")
    } catch (error) {
      return yield* Effect.fail(new FileError("invalid", `bad pattern: ${(error as Error).message}`))
    }
    const root = yield* env.absolutePath(path)
    const files = yield* filesBelow(env, root)
    if (files === undefined) return yield* Effect.fail(new FileError("not_found", `${path} does not exist`, path))
    const wanted = query.glob === undefined ? () => true : globMatcher(query.glob)
    const matches: SearchMatch[] = []
    for (const file of files) {
      // A file named by `path` is matched as the caller wrote it.
      if (!wanted(file === "" ? path : file)) continue
      const at = file === "" ? root : yield* env.joinPath([root, file])
      if (!(yield* Effect.orElseSucceed(isText(env, at), () => false))) continue
      yield* Effect.orElseSucceed(
        searchLines(env, at, regex, (line, text) => {
          const cut = text.length > query.maxLineChars
          matches.push({
            path: file,
            line,
            text: cut ? text.slice(0, query.maxLineChars) : text,
            ...(cut ? { cut } : {}),
          })
          return matches.length < query.maxMatches
        }),
        () => undefined,
      )
      if (matches.length === query.maxMatches) return { matches, truncated: true }
    }
    return { matches, truncated: false }
  })

/** Whether the file's first bytes hold no NUL, read without loading the rest. */
const isText = (env: ExecutionEnv, path: string) =>
  Effect.acquireUseRelease(
    env.openBinaryReader(path),
    (reader) => Effect.map(reader.read(0, BINARY_PROBE), (head) => !head.includes(0)),
    (reader) => reader.close(),
  )

/**
 * Hands each line of the file that matches `regex` to `found`, one line in memory at a time, until `found` returns
 * false.
 */
const searchLines = (
  env: ExecutionEnv,
  path: string,
  regex: RegExp,
  found: (number: number, line: string) => boolean,
): Effect.Effect<void, FileError> =>
  Effect.acquireUseRelease(
    env.openTextLineReader(path),
    (reader) =>
      Effect.gen(function* () {
        for (let number = 1; ; number++) {
          const line = yield* reader.readLine()
          if (line === undefined) return
          const text = line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text
          if (regex.test(text) && !found(number, text)) return
        }
      }),
    (reader) => reader.close(),
  )
