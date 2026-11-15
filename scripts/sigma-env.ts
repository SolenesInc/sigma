// Builds sigma-env, the agent a target runs (D16): a JS bundle for targets that have bun, and a compiled binary per
// platform for those that do not. `bun scripts/sigma-env.ts [outdir]`, default `dist/sigma-env`.
import { resolve } from "node:path"

const out = resolve(process.argv[2] ?? "dist/sigma-env")
const entry = resolve(import.meta.dir, "../packages/env/src/agent.ts")
const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"] as const

const run = (args: string[]) => {
  const done = Bun.spawnSync([process.execPath, "build", entry, ...args], { stdout: "inherit", stderr: "inherit" })
  if (done.exitCode !== 0) process.exit(done.exitCode ?? 1)
}

run(["--target=bun", "--minify", `--outfile=${out}/sigma-env.js`])
for (const platform of PLATFORMS)
  run(["--compile", `--target=bun-${platform}`, `--outfile=${out}/sigma-env-${platform}`])
