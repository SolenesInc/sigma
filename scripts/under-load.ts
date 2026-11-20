// `bun scripts/under-load.ts [--burners=N] [--runs=N] -- <command...>`: runs a command while N processes spin on the CPU,
// to show a test does not depend on how fast the machine is. N defaults to twice the cores, so every process the
// command starts competes for a core with two spinners. With --runs, the command runs that many times one after
// another under the same load, and the script prints how many passed. Exit 0 only when every run passed.
//
// The spinners are this script's own children, killed by the pids it spawned them with.
import { availableParallelism, loadavg } from "node:os"

const args = process.argv.slice(2)
const split = args.indexOf("--")
const flags = split < 0 ? [] : args.slice(0, split)
const command = split < 0 ? args : args.slice(split + 1)
const flag = (name: string, fallback: number) => {
  const value = flags.find((f) => f.startsWith(`--${name}=`))?.split("=")[1]
  return value === undefined ? fallback : Number(value)
}
if (command.length === 0) {
  console.error("usage: bun scripts/under-load.ts [--burners=N] [--runs=N] -- <command...>")
  process.exit(2)
}

const burners = flag("burners", availableParallelism() * 2)
const runs = flag("runs", 1)
const spinners = Array.from({ length: burners }, () =>
  Bun.spawn(["bun", "-e", "for (;;) {}"], { stdout: "ignore", stderr: "ignore" }),
)
const stop = () => {
  for (const spinner of spinners) spinner.kill("SIGKILL")
}
process.on("SIGINT", () => {
  stop()
  process.exit(130)
})

let passed = 0
for (let run = 1; run <= runs; run++) {
  const started = performance.now()
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code === 0) passed++
  const load = loadavg()[0]!.toFixed(0)
  console.log(
    `under-load: run ${run}/${runs} ${code === 0 ? "ok" : `failed (${code})`} in ${Math.round((performance.now() - started) / 1000)}s, ${burners} spinners, load ${load}`,
  )
}
stop()
console.log(`under-load: ${passed}/${runs} passed`)
process.exit(passed === runs ? 0 : 1)
