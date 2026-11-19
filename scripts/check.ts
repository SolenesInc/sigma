// `bun run check`: every check sigma has, run as parts side by side. Each part's output is printed whole when it
// ends, failures last. Exit 1 when any part fails.
//
// The tests split by wall time: the two slow sigma files run alone, the other sigma files together, and every other
// test file in one more part. The last part is what is left over, so a new test file always runs somewhere.
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const JUNIT = "node_modules/.cache/junit"
const SIGMA = "packages/sigma/test"
const ALONE = [`${SIGMA}/screen.test.ts`, `${SIGMA}/stack.test.ts`]

function testFiles(): string[] {
  return readdirSync("packages", { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".test.ts") && !f.includes("node_modules") && !f.startsWith("conformance/"))
    .map((f) => `packages/${f}`)
    .sort()
}

const files = testFiles()
const sigmaRest = files.filter((f) => f.startsWith(`${SIGMA}/`) && !ALONE.includes(f))
const others = files.filter((f) => !f.startsWith(`${SIGMA}/`))

function tests(name: string, paths: string[]) {
  const junit = join(JUNIT, `${name}.xml`)
  const cmd = ["bun", "test", "--timeout", "30000", "--reporter=junit", `--reporter-outfile=${junit}`]
  return { name, junit, cmd: [...cmd, ...paths.map((p) => `./${p}`)] }
}

const parts: { name: string; cmd: string[]; junit?: string }[] = [
  { name: "static", cmd: ["sh", "-c", "tsc --noEmit && prettier --check . && bun scripts/boundaries.ts"] },
  ...ALONE.map((f) => tests(f.slice(SIGMA.length + 1, -".test.ts".length), [f])),
  tests("sigma", sigmaRest),
  tests("packages", others),
  { name: "conformance", cmd: ["bun", "packages/conformance/check.ts"] },
]

rmSync(JUNIT, { recursive: true, force: true })
mkdirSync(JUNIT, { recursive: true })

const start = performance.now()
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`
const results = await Promise.all(
  parts.map(async (part) => {
    const proc = Bun.spawn(part.cmd, { stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const result = { ...part, out: out + err, code, time: performance.now() - start }
    console.log(`check: ${part.name} ${code === 0 ? "ok" : `failed (${code})`} in ${seconds(result.time)}`)
    return result
  }),
)

const failed = results.filter((r) => r.code !== 0)
for (const r of failed) console.log(`\n=== ${r.name}: ${r.cmd.join(" ")}\n${r.out}`)

// The feature map reads every test part's results, so it runs after them.
const junits = parts.flatMap((p) => (p.junit ? [p.junit] : []))
const coverage = Bun.spawnSync(["bun", "scripts/coverage.ts", "--quiet", ...junits], {
  stdout: "inherit",
  stderr: "inherit",
})

const ok = failed.length === 0 && coverage.exitCode === 0
console.log(`check: ${ok ? "ok" : "failed"} in ${seconds(performance.now() - start)}`)
process.exit(ok ? 0 : 1)
