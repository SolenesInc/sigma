// `grep` and `glob` through a real Harness, in a git work tree and in a plain directory.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fauxAssistantMessage, fauxToolCall } from "@sigma/models/faux"
import { Effect } from "effect"
import { createGlobTool, createGrepTool } from "../src/index.ts"
import { link, runtimeDir } from "../../env/test/support/agent.ts"
import { type Chat, openChat, removeDirectories, resultText, run } from "./support.ts"

const REPOSITORY = resolve(import.meta.dir, "../../..")

afterEach(removeDirectories)

const calls = (...calls: [string, Record<string, unknown>][]) => [
  ...calls.map(([name, args]) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" })),
  fauxAssistantMessage("done"),
]

/** `src/a.ts`, `src/b.md`, an ignored `build/out.ts` and a binary `logo.bin`, each mentioning `needle`. */
const files = (chat: Chat) => {
  const at = (path: string) => join(chat.workspace, path)
  mkdirSync(at("src"))
  mkdirSync(at("build"))
  writeFileSync(at("src/a.ts"), "const needle = 1\nconst other = 2\nexport { needle }\n")
  writeFileSync(at("src/b.md"), "# Needle\n")
  writeFileSync(at("build/out.ts"), "needle\n")
  writeFileSync(at("logo.bin"), new Uint8Array([0, 110, 101, 101, 100, 108, 101]))
  writeFileSync(at(".gitignore"), "build/\n")
  utimesSync(at("src/a.ts"), 1_000, 1_000)
  utimesSync(at("src/b.md"), 2_000, 2_000)
  return at
}

const git = (cwd: string) => {
  const done = Bun.spawnSync(["git", "init", "-q"], { cwd })
  if (done.exitCode !== 0) throw new Error(`git init failed: ${done.stderr}`)
}

test("tool-grep: grep finds matching lines by path and line, skipping binary and git-ignored files, and honours its options, its glob too when the path is a file", () =>
  run(
    Effect.gen(function* () {
      const chat = yield* openChat({
        tools: [createGrepTool()],
        responses: calls(
          ["grep", { pattern: "needle" }],
          ["grep", { pattern: "needle", case_insensitive: true, glob: "*.md" }],
          ["grep", { pattern: "needle", path: "src" }],
          ["grep", { pattern: "(" }],
          ["grep", { pattern: "x", path: "nowhere" }],
          ["grep", { pattern: "needle", path: "src/a.ts", glob: "*.md" }],
          ["grep", { pattern: "needle", path: "src/a.ts", glob: "*.ts" }],
        ),
      })
      files(chat)
      git(chat.workspace)
      yield* chat.ask("search")
      const results = yield* chat.toolResults()
      expect(results.map(resultText)).toEqual([
        "src/a.ts:1:const needle = 1\nsrc/a.ts:3:export { needle }",
        "src/b.md:1:# Needle",
        "src/a.ts:1:const needle = 1\nsrc/a.ts:3:export { needle }",
        "bad pattern: Invalid regular expression: missing )",
        "nowhere does not exist",
        "No matches.",
        "src/a.ts:1:const needle = 1\nsrc/a.ts:3:export { needle }",
      ])
      expect(results.map((result) => result.isError)).toEqual([false, false, false, true, true, false, false])
    }),
  ))

test("tool-glob: glob lists matching files newest first, outside git skipping hidden names, inside git skipping ignored files", () =>
  run(
    Effect.gen(function* () {
      const chat = yield* openChat({
        tools: [createGlobTool()],
        responses: [
          ...calls(
            ["glob", { pattern: "**/*.ts" }],
            ["glob", { pattern: "*.md", path: "src" }],
            ["glob", { pattern: "*.rs" }],
          ),
          ...calls(["glob", { pattern: "**/*.ts" }]),
        ],
      })
      const at = files(chat)
      writeFileSync(at(".hidden.ts"), "")
      yield* chat.ask("list")
      expect((yield* chat.toolResults()).map(resultText)).toEqual([
        "build/out.ts\nsrc/a.ts",
        "src/b.md",
        "No files found.",
      ])
      git(chat.workspace)
      yield* chat.ask("list again, now in git")
      expect(resultText((yield* chat.toolResults()).at(-1)!)).toBe(".hidden.ts\nsrc/a.ts")
    }),
  ))

test("tool-grep: grep and glob search a directory the model names through a symlink", () =>
  run(
    Effect.gen(function* () {
      const chat = yield* openChat({
        tools: [createGrepTool(), createGlobTool()],
        responses: calls(
          ["grep", { pattern: "needle", path: "linked" }],
          ["glob", { pattern: "*.ts", path: "linked" }],
        ),
      })
      const at = files(chat)
      symlinkSync(at("src"), at("linked"))
      yield* chat.ask("search")
      const results = yield* chat.toolResults()
      expect(results.map(resultText)).toEqual([
        "linked/a.ts:1:const needle = 1\nlinked/a.ts:3:export { needle }",
        "linked/a.ts",
      ])
    }),
  ))

test("tool-grep: grep through a target's environment searches a whole copy of sigma in one call, finding what git grep finds", () =>
  run(
    Effect.gen(function* () {
      const runtime = runtimeDir()
      const remote = link({ runtime })
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          remote.pool.close(),
          Effect.sync(() => rmSync(runtime, { recursive: true })),
        ),
      )
      const chat = yield* openChat({
        tools: [createGrepTool()],
        responses: calls(["grep", { pattern: "ProcessRegistry", glob: "*.ts" }]),
        env: (local) => remote.pool.env("copy", local.cwd),
      })
      const cloned = Bun.spawnSync(["git", "clone", "-q", "--shared", REPOSITORY, chat.workspace])
      if (cloned.exitCode !== 0) throw new Error(`git clone failed: ${cloned.stderr}`)
      const expected = Bun.spawnSync(["git", "grep", "-n", "ProcessRegistry", "--", "*.ts"], { cwd: chat.workspace })
      yield* chat.ask("search")
      // Walking line by line made 192,922 calls for the whole repository; `search` makes one (F13).
      expect(remote.calls()).toBe(1)
      expect(resultText((yield* chat.toolResults())[0]!)).toBe(expected.stdout.toString().trimEnd())
    }),
  ))

test("tool-glob: glob through a target's environment lists a whole copy of sigma in one call, newest first as git lists it", () =>
  run(
    Effect.gen(function* () {
      const runtime = runtimeDir()
      const remote = link({ runtime })
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          remote.pool.close(),
          Effect.sync(() => rmSync(runtime, { recursive: true })),
        ),
      )
      const chat = yield* openChat({
        tools: [createGlobTool()],
        responses: calls(["glob", { pattern: "**/*.ts" }]),
        env: (local) => remote.pool.env("copy", local.cwd),
      })
      const cloned = Bun.spawnSync(["git", "clone", "-q", "--shared", REPOSITORY, chat.workspace])
      if (cloned.exitCode !== 0) throw new Error(`git clone failed: ${cloned.stderr}`)
      const listed = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: chat.workspace,
      })
      const newest = listed.stdout
        .toString()
        .split("\0")
        .filter((path) => path.endsWith(".ts"))
        .sort()
        .map((path) => ({ path, mtime: statSync(join(chat.workspace, path)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .map(({ path }) => path)
      expect(newest.length).toBeGreaterThan(200)
      yield* chat.ask("list")
      // A stat per match made 595 calls and took 24 s over ssh to another computer; `glob` makes one.
      expect(remote.calls()).toBe(1)
      expect(resultText((yield* chat.toolResults())[0]!)).toBe(
        `${newest.slice(0, 200).join("\n")}\n[${newest.length - 200} more not shown]`,
      )
    }),
  ))
