// The ways a command on a target stops when its server is gone (D7): the channel closes, the channel goes silent while
// the command runs, or the next agent of the same owner sweeps it. Each is driven over a pipe to a real `sigma-env`.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ExecutionEnv, FileChange } from "@sigma/env"
import { spawnChannel, TargetPool } from "@sigma/env/remote"
import { Deferred, Effect, Fiber } from "effect"
import { AGENT, alive, link } from "./support/agent.ts"

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
      // The command's processes are gone with its answer; the agent exits once that answer is written.
      expect([pids.shell, pids.sleep].filter(alive)).toEqual([])
      yield* Effect.promise(() => silent.exited())
      return { pids, error: exit._tag === "Failure" ? exit.cause : undefined }
    }),
  )
  expect(String(error)).toContain("killed by sigma-env: no frame from the server for 1 s")
  expect(Object.values(pids).filter(alive)).toEqual([])
})

test("env-remote-stop: a call on a channel gone silent without closing, and the cancel of another, fail with the silence limit once it passes", async () => {
  // The client's limit is past the agent's, so the agent has stopped its commands when the connector is killed.
  const dead = opened({ runtime: temporary("sigma-env-run-"), agentArgs: ["--silence-ms", "1000"], silenceMs: 1500 })
  const env = dead.pool.env("here", temporary("sigma-env-"))
  const { quiet, interrupted } = await Effect.runPromise(
    Effect.gen(function* () {
      yield* dead.pool.connect("here")
      const quiet = yield* Effect.forkDetach(Effect.exit(env.exec("sleep 60")))
      const cancelled = yield* Effect.forkDetach(env.exec("sleep 60"))
      yield* Effect.promise(() => dead.sent(2))
      // The link dies both ways without an EOF, as a connector or ssh link that dies alone can (F21).
      dead.deafen()
      const interrupted = yield* Effect.exit(Fiber.interrupt(cancelled))
      return { quiet: yield* Fiber.join(quiet), interrupted }
    }),
  )
  expect(interrupted._tag).toBe("Success")
  expect(String(quiet._tag === "Failure" ? quiet.cause : "")).toContain(
    "target here unavailable: no frame from sigma-env for 1.5 s",
  )
})

test("env-remote-stop: an open watcher on a channel gone silent without closing reports failed once the silence limit passes", async () => {
  const dead = opened({ runtime: temporary("sigma-env-run-"), silenceMs: 1000 })
  const env = dead.pool.env("here", temporary("sigma-env-"))
  const changes = await Effect.runPromise(
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>()
      const changes: FileChange[] = []
      yield* env.watch([{ path: env.cwd }], (change) => {
        changes.push(change)
        if (change.kind === "failed") Deferred.doneUnsafe(failed, Effect.void)
      })
      // No call waits now: only the watcher is open when the link dies both ways without an EOF (F21).
      dead.deafen()
      yield* Deferred.await(failed)
      return changes
    }),
  )
  expect(changes.map((change) => (change.kind === "failed" ? change.error.message : change.kind))).toEqual([
    "target here unavailable: no frame from sigma-env for 1 s",
  ])
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

test("env-remote-stop: another target of the same home on the same computer leaves the first target's commands running", async () => {
  const runtime = temporary("sigma-env-run-")
  const cwd = temporary("sigma-env-")
  const home = opened({ runtime })
  const pids = await Effect.runPromise(
    Effect.gen(function* () {
      const { fiber: _, ...pids } = yield* started(home.pool.env("here", cwd))
      yield* home.pool.connect("elsewhere")
      return pids
    }),
  )
  expect(Object.values(pids).every(alive)).toBe(true)
})

test("env-remote: a watcher or reader whose open answers across its interrupt is released on the target, and the watcher reports nothing", async () => {
  const slow = opened({ runtime: temporary("sigma-env-run-") })
  const cwd = temporary("sigma-env-")
  const env = slow.pool.env("here", cwd)
  const changes: FileChange[] = []
  /** Interrupts `open` after the agent answered it and before that answer arrives; returns once the interrupt completes. */
  let cancels = 0
  const crossed = (open: Effect.Effect<unknown, unknown>) =>
    Effect.gen(function* () {
      const answered = slow.hold('"$handle"')
      const fiber = yield* Effect.forkDetach(open)
      yield* Effect.promise(() => answered)
      const interrupted = yield* Effect.forkDetach(Fiber.interrupt(fiber))
      yield* Effect.promise(() => slow.wrote('"t":"cancel"', ++cancels))
      slow.release()
      yield* Fiber.join(interrupted)
    })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* slow.pool.connect("here")
      yield* crossed(env.watch([{ path: cwd }], (change) => changes.push(change)))
      yield* Effect.promise(() => slow.wrote('"method":"stop"'))
      writeFileSync(join(cwd, "a.txt"), "a")
      yield* crossed(env.openTextLineReader(join(cwd, "a.txt")))
      yield* Effect.promise(() => slow.wrote('"method":"close"'))
      // A watcher that is held sees the next change; the abandoned one, on the same folder, saw none of them.
      const seen = yield* Deferred.make<void>()
      const watcher = yield* env.watch([{ path: cwd }], () => Deferred.doneUnsafe(seen, Effect.void))
      writeFileSync(join(cwd, "b.txt"), "b")
      yield* Deferred.await(seen)
      yield* watcher.stop()
    }),
  )
  expect(changes).toEqual([])
})

test("env-remote: a connector that prints a banner before sigma-env fails the call with the banner, and the next call connects again", async () => {
  const runtime = temporary("sigma-env-run-")
  let connects = 0
  const pool = new TargetPool({
    owner: "test-owner",
    connect: () =>
      spawnChannel([
        "sh",
        "-c",
        `${connects++ === 0 ? "echo Welcome to here; " : ""}exec env XDG_RUNTIME_DIR=${runtime} ${process.execPath} ${AGENT}`,
      ]),
  })
  pools.push(pool)
  const env = pool.env("here", temporary("sigma-env-"))
  const first = await Effect.runPromise(Effect.flip(env.exists("/")))
  expect(first.message).toContain("not a frame: Welcome to here")
  expect(await Effect.runPromise(env.exists("/"))).toBe(true)
})
