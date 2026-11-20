// `sigma-env` on this machine, as a target's connector would start it: a channel to a fresh agent per connect, with a
// runtime folder this test owns. `mute` and `deafen` model a link that goes silent without closing (F21).
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { type Channel, spawnChannel, TargetPool } from "@sigma/env/remote"

export const AGENT = Bun.fileURLToPath(import.meta.resolve("@sigma/env/agent"))

export interface Link {
  readonly pool: TargetPool
  /** Call frames sent since the link opened. */
  calls(): number
  /** Settles once `count` call frames have been sent. */
  sent(count: number): Promise<void>
  /** Drops every frame the server sends from now on, as a dead link or a frozen server would. */
  mute(): void
  /**
   * Drops every frame the agent sends from now on too, and its end, as a link dead both ways would: the server sees
   * nothing until it kills the connector.
   */
  deafen(): void
  /** Settles once the latest channel's connector, the agent here, has exited. */
  exited(): Promise<void>
}

/** A zombie has exited and only waits to be reaped by its parent, which for a grandchild is not this process. */
export function alive(pid: number): boolean {
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim()
  return stat !== "" && !stat.startsWith("Z")
}

export const runtimeDir = () => mkdtempSync(join("/tmp", "sigma-env-run-"))

export function link(options: {
  runtime: string
  owner?: string
  agentArgs?: readonly string[]
  silenceMs?: number
}): Link {
  let calls = 0
  let muted = false
  let deaf = false
  const waiting: { count: number; done: () => void }[] = []
  let exited = Promise.resolve()
  const pool = new TargetPool({
    owner: options.owner ?? "test-owner",
    ...(options.silenceMs === undefined ? {} : { silenceMs: options.silenceMs }),
    connect: (): Channel => {
      const channel = spawnChannel([
        "env",
        `XDG_RUNTIME_DIR=${options.runtime}`,
        process.execPath,
        AGENT,
        ...(options.agentArgs ?? []),
      ])
      let killed = false
      exited = new Promise((done) => channel.onClose(() => done()))
      return {
        ...channel,
        kill: () => {
          killed = true
          channel.kill()
        },
        onLine: (listener) => channel.onLine((line) => deaf || listener(line)),
        onClose: (listener) => channel.onClose((reason) => (deaf && !killed) || listener(reason)),
        send: (line) => {
          if (muted) return
          if (line.includes('"t":"call"')) {
            calls++
            for (const waiter of waiting.filter((waiter) => waiter.count <= calls)) waiter.done()
          }
          channel.send(line)
        },
      }
    },
  })
  return {
    pool,
    calls: () => calls,
    sent: (count) => (count <= calls ? Promise.resolve() : new Promise((done) => void waiting.push({ count, done }))),
    mute: () => (muted = true),
    deafen: () => (muted = deaf = true),
    exited: () => exited,
  }
}
