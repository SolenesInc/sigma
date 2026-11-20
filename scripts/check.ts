// `bun run check`: every check sigma has, run as parts side by side while the machine has cores for them. Each part's
// output is printed whole when it ends, and the failed parts are named last. Exit 1 when any part fails.
//
// The tests split by wall time: the two slow sigma files run alone, the other sigma files together, and every other
// test file in one more part. The last part is what is left over, so a new test file always runs somewhere.
//
// Each part names the cores it keeps busy, measured as CPU time over wall time with the part running alone on a 10-core
// M5: conformance 4.0 (vitest fills every core with workers), static 1.9, the test parts 0.4 to 0.9 each. A part
// starts once the parts already running leave it room, so the M5 runs all six at once and CI's 3- and 4-core runners
// run them nearly one after another. All six at once on those runners starved the tests and turned main red.
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"

const JUNIT = "node_modules/.cache/junit"
const SIGMA = "packages/sigma/test"
const ALONE = [`${SIGMA}/screen.test.ts`, `${SIGMA}/stack.test.ts`]

// The files `bun test` finds on its own, so this check runs what `bun run coverage` runs. The conformance suite runs
// through its own check.
const TEST_FILE = /(\.test|_test|\.spec|_spec)\.[cm]?[jt]sx?$/

function testFiles(): string[] {
  const top = readdirSync(".", { withFileTypes: true }).filter(
    (e) => e.name !== "node_modules" && !e.name.startsWith("."),
  )
  return top
    .flatMap((e) =>
      e.isDirectory()
        ? readdirSync(e.name, { recursive: true, encoding: "utf8" }).map((f) => `${e.name}/${f}`)
        : [e.name],
    )
    .filter(
      (f) => TEST_FILE.test(f) && !f.split("/").includes("node_modules") && !f.startsWith("packages/conformance/"),
    )
    .sort()
}

const files = testFiles()
const sigmaRest = files.filter((f) => f.startsWith(`${SIGMA}/`) && !ALONE.includes(f))
const others = files.filter((f) => !f.startsWith(`${SIGMA}/`))

function tests(name: string, paths: string[]) {
  const junit = join(JUNIT, `${name}.xml`)
  const cmd = ["bun", "test", "--timeout", "30000", "--reporter=junit", `--reporter-outfile=${junit}`]
  return { name, junit, cores: 1, cmd: [...cmd, ...paths.map((p) => `./${p}`)] }
}

// Longest first, so the slowest part never waits behind a short one.
const parts: { name: string; cmd: string[]; cores: number; junit?: string }[] = [
  { name: "conformance", cores: 4, cmd: ["bun", "packages/conformance/check.ts"] },
  ...ALONE.map((f) => tests(f.slice(SIGMA.length + 1, -".test.ts".length), [f])),
  tests("sigma", sigmaRest),
  {
    name: "static",
    cores: 2,
    cmd: [
      "sh",
      "-c",
      "tsc --noEmit && prettier --check . && bun scripts/boundaries.ts && bun scripts/clock-free-tests.ts",
    ],
  },
  tests("packages", others),
]

rmSync(JUNIT, { recursive: true, force: true })
mkdirSync(JUNIT, { recursive: true })

const start = performance.now()
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`
const cores = availableParallelism()
let busy = 0
const freed: Array<() => void> = []

// A part bigger than the machine runs once nothing else does.
async function room(need: number) {
  while (busy > 0 && busy + Math.min(need, cores) > cores) await new Promise<void>((resolve) => freed.push(resolve))
  busy += Math.min(need, cores)
}

const results = []
for (const part of parts) {
  await room(part.cores)
  const started = performance.now()
  results.push(
    (async () => {
      const proc = Bun.spawn(part.cmd, { stdout: "pipe", stderr: "pipe" })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      busy -= Math.min(part.cores, cores)
      for (const wake of freed.splice(0)) wake()
      const status = code === 0 ? "ok" : `failed (${code})`
      console.log(`\n=== ${part.name}: ${part.cmd.join(" ")}\n${out}${err}`)
      console.log(`check: ${part.name} ${status} in ${seconds(performance.now() - started)}`)
      return { ...part, code }
    })(),
  )
}
const failed = (await Promise.all(results)).filter((r) => r.code !== 0)
if (failed.length > 0) console.log(`\ncheck: failed parts: ${failed.map((r) => r.name).join(", ")}`)

// The feature map reads every test part's results, so it runs after them.
const junits = parts.flatMap((p) => (p.junit ? [p.junit] : []))
const coverage = Bun.spawnSync(["bun", "scripts/coverage.ts", "--quiet", ...junits], {
  stdout: "inherit",
  stderr: "inherit",
})

const ok = failed.length === 0 && coverage.exitCode === 0
console.log(`check: ${ok ? "ok" : "failed"} in ${seconds(performance.now() - start)}`)
process.exit(ok ? 0 : 1)
