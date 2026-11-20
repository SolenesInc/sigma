// `bun run check` step: fails naming each test line that waits on the wall clock. A test that sleeps, polls, paces a
// scripted answer or times itself passes on an idle machine and fails on a loaded one; it waits on a signal instead.
//
// A line that must keep the clock, such as the deadline every wait shares or a window that measures idle CPU, says
// why in a `// clock: <reason>` comment on that line or the line above it.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

// Where the gate's own tests live. `upstream/` is pi-durable's suite, kept unedited; its tests are amended instead.
const TEST_DIRS = [
  ...readdirSync(join(ROOT, "packages"))
    .filter((name) => name !== "conformance")
    .map((name) => join(ROOT, "packages", name, "test")),
  join(ROOT, "packages/conformance/amended"),
]
// Recorders run a real Claude Code or agy by hand to make fixtures; the gate never runs them.
const RECORDER = /\/support\/record-[^/]*$/

const RULES: Array<{ readonly pattern: RegExp; readonly instead: string }> = [
  {
    pattern: /\bdelayMs\b/,
    instead:
      "give the script step a `hold` (support/server.ts `hold()`) and release it when the test is done with the run",
  },
  {
    pattern: /\bBun\.sleep\(|\bsleep\(|\bsetTimeout\(|\bsetInterval\(/,
    instead:
      "wait on the event itself: a watch's `until`, a process's exit, a FIFO, a file watch, or `deadline()` (support/raw.ts) around a promise",
  },
  { pattern: /\beventually\(/, instead: "await the signal the work gives when it is done, with a deadline" },
  {
    pattern: /\bperformance\.now\(\)/,
    instead:
      "assert on what happened, not how long it took; a time the product keeps goes on a clock the test controls",
  },
]

const EXEMPT = /\/\/ clock: \S/

function files(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    if (name === "node_modules" || name === "fixtures") return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.[cm]?tsx?$/.test(name) && !RECORDER.test(path) ? [path] : []
  })
}

/** The line without a trailing `//` comment, or "" for a comment line. */
const code = (line: string) => {
  const trimmed = line.trimStart()
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return ""
  return line.replace(/\s\/\/ .*$/, "")
}

const problems: string[] = []
for (const file of TEST_DIRS.flatMap(files)) {
  const lines = readFileSync(file, "utf8").split("\n")
  lines.forEach((line, index) => {
    if (EXEMPT.test(line) || EXEMPT.test(lines[index - 1] ?? "")) return
    for (const rule of RULES) {
      const match = rule.pattern.exec(code(line))
      if (match === null) continue
      problems.push(`${relative(ROOT, file)}:${index + 1}: ${match[0]} waits on the wall clock; ${rule.instead}`)
    }
  })
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  console.error(
    `\n${problems.length} test line(s) wait on the wall clock. A line that must keep it says why in a \`// clock: <reason>\` comment on it or the line above.`,
  )
  process.exit(1)
}
