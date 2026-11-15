// The ways a command on a target stops when its server is gone (D7): the channel closes, the channel goes silent while
// the command runs, or the next agent of the same owner sweeps it. Each is driven over a pipe to a real `sigma-env`.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { ExecutionEnv } from "@sigma/env"
import type { TargetPool } from "@sigma/env/remote"
import { Deferred, Effect, Fiber } from "effect"
import { link } from "./support/agent.ts"

const dirs: string[] = []
const pools: TargetPool[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await Effect.runPromise(pool.close())
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temporary = (prefix: string) => {
  const dir = mkdtempSync(join("/tmp", prefix))
  dirs.push(dir)
  return dir
}

const opened = (options: Parameters<typeof link>[0]) => {
  const opened = link(options)
  pools.push(opened.pool)
  return opened
}

/** A zombie has exited and only waits to be reaped by its parent, which for a grandchild is not this process. */
function alive(pid: number): boolean {
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim()
  return stat !== "" && !stat.startsWith("Z")
}

/**
 * Starts a shell on `env` that runs `sleep 60` in the background and waits; returns once it printed the shell's pid,
 * the sleep's and its parent's, the agent's, with the fiber running it.
 */
const started = (env: ExecutionEnv) =>
  Effect.gen(function* () {
    const printed = yield* Deferred.make<{ shell: number; sleep: number; agent: number }>()
    let output = ""
    // Detached, so a test that leaves the command running does not stop it by ending.
    const fiber = yield* Effect.forkDetach(
      Effect.exit(
        env.exec("sleep 60 & echo $$ $! $PPID; wait", {
          onOutput: (text) => {
            output += text
            if (!output.includes("\n")) return
            const [shell, sleep, agent] = output.trim().split(" ").map(Number)
            Deferred.doneUnsafe(printed, Effect.succeed({ shell: shell!, sleep: sleep!, agent: agent! }))
          },
        }),
      ),
    )
    return { ...(yield* Deferred.await(printed)), fiber }
  })

test("env-remote-stop: a target's command is killed, and its agent exits, when the server's channel closes", async () => {
  const { pool } = opened({ runtime: temporary("sigma-env-run-") })
  const env = pool.env("here", temporary("sigma-env-"))
  const pids = await Effect.runPromise(
    Effect.gen(function* () {
      const { fiber, ...pids } = yield* started(env)
      expect(Object.values(pids).every(alive)).toBe(true)
      // What a server crash does: the write end of the agent's stdin closes.
      yield* pool.close()
      const exit = yield* Fiber.join(fiber)
      expect(exit._tag).toBe("Failure")
      return pids
    }),
  )
  expect(Object.values(pids).filter(alive)).toEqual([])
})

test("env-remote-stop: a target's command is killed after the silence limit with no frame from the server, and its result names the limit", async () => {
  const silent = opened({ runtime: temporary("sigma-env-run-"), agentArgs: ["--silence-ms", "1000"] })
  const env = silent.pool.env("here", temporary("sigma-env-"))
  const { pids, error } = await Effect.runPromise(
    Effect.gen(function* () {
      const { fiber, ...pids } = yield* started(env)
      // The link dies without closing, as a lost ssh link can (F21): the server's pings stop arriving.
      silent.mute()
      const exit = yield* Fiber.join(fiber)
      return { pids, error: exit._tag === "Failure" ? exit.cause : undefined }
    }),
  )
  expect(String(error)).toContain("killed by sigma-env: no frame from the server for 1 s")
  expect(Object.values(pids).filter(alive)).toEqual([])
})

test("env-remote-stop: a new agent of the same owner kills an earlier agent and its commands before it answers the hello", async () => {
  const runtime = temporary("sigma-env-run-")
  const cwd = temporary("sigma-env-")
  const frozen = opened({ runtime })
  const pids = await Effect.runPromise(
    Effect.gen(function* () {
      const { fiber: _, ...pids } = yield* started(frozen.pool.env("here", cwd))
      // The old server froze: its channel stays open and says nothing, and the silence limit is far off.
      frozen.mute()
      const restarted = opened({ runtime })
      yield* restarted.pool.connect("here")
      return pids
    }),
  )
  expect(Object.values(pids).filter(alive)).toEqual([])
})

test("env-remote-stop: an agent of another owner leaves the first owner's commands running", async () => {
  const runtime = temporary("sigma-env-run-")
  const cwd = temporary("sigma-env-")
  const first = opened({ runtime, owner: "first" })
  const pids = await Effect.runPromise(
    Effect.gen(function* () {
      const { fiber: _, ...pids } = yield* started(first.pool.env("here", cwd))
      yield* opened({ runtime, owner: "second" }).pool.connect("here")
      return pids
    }),
  )
  expect(Object.values(pids).every(alive)).toBe(true)
})
