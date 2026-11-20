// A target connector for tests, as whatever runs sigma would set one: `connector.ts <root> <target> -- sigma-env
// [args...]`. Each target is a folder `<root>/<target>` on this machine; its `instance` and `files` files hold the ids
// its sigma-env reports (D6), and `run` is its runtime folder, so a later agent sweeps an earlier one as on one
// instance. sigma-env's pid is written to `pid`, and the time of each connect is appended to `connects`. A target with no `instance` file is unknown: the connector says so on
// stderr and exits 3.
//
// A `map` file `{ "from": <path>, "to": <path> }` makes the target another machine at one path: the server's `from`
// is the agent's `to`, rewritten in every frame both ways, so a file at `from` on the home is not the one the target
// has there. A `platform` file makes the target another kind of computer: its sigma-env's hello reports that platform.
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const AGENT = Bun.fileURLToPath(import.meta.resolve("@sigma/env/agent"))

const [root, target, separator, , ...args] = process.argv.slice(2)
if (root === undefined || target === undefined || separator !== "--") {
  console.error("usage: connector.ts <root> <target> -- sigma-env [args...]")
  process.exit(2)
}
const dir = join(root, target)
// Each connect is logged with its time, so a test can tell when sigma reached for the target.
if (existsSync(dir)) appendFileSync(join(dir, "connects"), `${Date.now()}\n`)
if (!existsSync(join(dir, "instance"))) {
  console.error(`no target named ${target}`)
  process.exit(3)
}
const text = (name: string) => readFileSync(join(dir, name), "utf8").trim()
const map = existsSync(join(dir, "map"))
  ? (JSON.parse(text("map")) as { readonly from: string; readonly to: string })
  : undefined
const platform = existsSync(join(dir, "platform")) ? text("platform") : undefined
const relayed = map !== undefined || platform !== undefined
mkdirSync(join(dir, "run"), { recursive: true })
const child = spawn(process.execPath, [AGENT, ...args], {
  env: {
    ...process.env,
    SIGMA_TARGET_INSTANCE: text("instance"),
    SIGMA_TARGET_FILES: text("files"),
    XDG_RUNTIME_DIR: join(dir, "run"),
  },
  stdio: relayed ? ["pipe", "pipe", "inherit"] : "inherit",
})
writeFileSync(join(dir, "pid"), String(child.pid))
child.on("exit", (code, signal) => (signal === null ? process.exit(code ?? 1) : process.kill(process.pid, signal)))

if (relayed) {
  const swap = (line: string, a?: string, b?: string) =>
    a === undefined || b === undefined ? line : line.replaceAll(a, b)
  /** The agent's hello reports the target's platform, not this machine's. */
  const told = (line: string) => {
    if (platform === undefined) return line
    const frame = JSON.parse(line)
    return frame.t === "hello" ? JSON.stringify({ ...frame, platform }) : line
  }
  const relay = (
    from: NodeJS.ReadableStream,
    to: NodeJS.WritableStream,
    frame: (line: string) => string,
    end: () => void,
  ) => {
    const lines = createInterface({ input: from })
    lines.on("line", (line) => to.write(`${frame(line)}\n`))
    lines.on("close", end)
  }
  relay(
    process.stdin,
    child.stdin!,
    (line) => swap(line, map?.from, map?.to),
    () => child.stdin!.end(),
  )
  relay(
    child.stdout!,
    process.stdout,
    (line) => told(swap(line, map?.to, map?.from)),
    () => {},
  )
}
