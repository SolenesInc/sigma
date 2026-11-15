// `sigma-env` on this machine, as a target's connector would start it: a channel to a fresh agent per connect, with a
// runtime folder this test owns. `mute` models a link that goes silent without closing (F21).
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { type Channel, spawnChannel, TargetPool } from "@sigma/env/remote"

const AGENT = Bun.fileURLToPath(import.meta.resolve("@sigma/env/agent"))

export interface Link {
  readonly pool: TargetPool
  /** Call frames sent since the link opened. */
  calls(): number
  /** Drops every frame the server sends from now on, as a dead link or a frozen server would. */
  mute(): void
}

export const runtimeDir = () => mkdtempSync(join("/tmp", "sigma-env-run-"))

export function link(options: { runtime: string; owner?: string; agentArgs?: readonly string[] }): Link {
  let calls = 0
  let muted = false
  const pool = new TargetPool({
    owner: options.owner ?? "test-owner",
    connect: (): Channel => {
      const channel = spawnChannel([
        "env",
        `XDG_RUNTIME_DIR=${options.runtime}`,
        process.execPath,
        AGENT,
        ...(options.agentArgs ?? []),
      ])
      return {
        ...channel,
        send: (line) => {
          if (muted) return
          if (line.includes('"t":"call"')) calls++
          channel.send(line)
        },
      }
    },
  })
  return { pool, calls: () => calls, mute: () => (muted = true) }
}
