import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ExecutionEnv } from "@sigma/env"
import { LocalExecutionEnv } from "@sigma/env/local"
import { ProcessRegistry } from "@sigma/env/registry"
import type { TargetPool } from "@sigma/env/remote"
import { Deferred, Effect, Fiber } from "effect"
import { alive, link, runtimeDir } from "./support/agent.ts"

const dirs: string[] = []
const pools: TargetPool[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await Effect.runPromise(pool.close())
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Each case runs on this machine's env and on the same env served by `sigma-env` over a pipe, which must behave alike.
const kinds = {
  "env-shell": (cwd: string): ExecutionEnv => new LocalExecutionEnv({ cwd }),
  "env-remote": (cwd: string): ExecutionEnv => {
    const runtime = runtimeDir()
    dirs.push(runtime)
    const { pool } = link({ runtime })
    pools.push(pool)
    return pool.env("here", cwd)
  },
}

for (const [id, make] of Object.entries(kinds)) {
  function env(): ExecutionEnv {
    const cwd = mkdtempSync(join("/tmp", "sigma-env-"))
    dirs.push(cwd)
    return make(cwd)
  }

  test(`${id}: a binary file reads back as the bytes written`, async () => {
    const local = env()
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 10, 13])
    const read = await Effect.runPromise(
      Effect.gen(function* () {
        const path = yield* local.absolutePath("bytes.bin")
        yield* local.writeFile(path, bytes)
        return yield* local.readBinaryFile(path)
      }),
    )
    expect(read).toBeInstanceOf(Uint8Array)
    expect([...read]).toEqual([...bytes])
  })

  test(`${id}: a reader used after it is closed fails as invalid`, async () => {
    const local = env()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const path = yield* local.absolutePath("lines.txt")
        yield* local.writeFile(path, "one\ntwo\n")
        const reader = yield* local.openTextLineReader(path)
        yield* reader.close()
        return yield* Effect.flip(reader.readLine())
      }),
    )
    expect(error).toMatchObject({ code: "invalid" })
  })

  // The join rule (F6): a fiber interrupted while it runs a command must not outlive the command's processes, or a
  // cancelled tool call would leave work running behind the run that cancelled it.
  test(`${id}: interrupting a command returns only once its process and its children are gone`, async () => {
    const local = env()
    const pids = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<number[]>()
        let output = ""
        const fiber = yield* Effect.forkChild(
          local.exec("sleep 60 & echo $$ $!; wait", {
            onOutput: (text) => {
              output += text
              if (output.includes("\n"))
                Deferred.doneUnsafe(started, Effect.succeed(output.trim().split(" ").map(Number)))
            },
          }),
        )
        const pids = yield* Deferred.await(started)
        expect(pids.every(alive)).toBe(true)
        yield* Fiber.interrupt(fiber)
        return pids
      }),
    )
    expect(pids.filter(alive)).toEqual([])
  })

  // Written after the spill started and before the interrupt, so only a spill flushed and ended before the interrupt
  // returns can hold all of it.
  const SPILLED_BYTES = 2_000_000

  test(`${id}: an interrupted command's spill file holds all its output once the interrupt returns`, async () => {
    const local = env()
    // clock: keeps the child alive in its own script; the test waits on its output
    const script = `process.stdout.write("a".repeat(${SPILLED_BYTES}) + "END"); setTimeout(() => {}, 60000)`
    const spill = await Effect.runPromise(
      Effect.gen(function* () {
        const written = yield* Deferred.make<void>()
        let path: string | undefined
        let tail = ""
        const fiber = yield* Effect.forkChild(
          local.exec([process.execPath, "-e", script], {
            spill: { afterBytes: 10, afterLines: 10 },
            onSpill: (spillPath) => {
              path = spillPath
            },
            onOutput: (text) => {
              tail = (tail + text).slice(-3)
              if (tail === "END") Deferred.doneUnsafe(written, Effect.void)
            },
          }),
        )
        yield* Deferred.await(written)
        yield* Fiber.interrupt(fiber)
        return path!
      }),
    )
    dirs.push(join(spill, ".."))
    expect(Bun.file(spill).size).toBe(SPILLED_BYTES + 3)
  })

  test(`${id}: a caller's onSpill that throws fails the command with callback_error`, async () => {
    const local = env()
    const error = await Effect.runPromise(
      Effect.flip(
        local.exec("printf 12345678901234567890", {
          spill: { afterBytes: 5, afterLines: 100 },
          onSpill: (path) => {
            dirs.push(join(path, ".."))
            throw new Error("onSpill failed")
          },
        }),
      ),
    )
    expect(error).toMatchObject({ code: "callback_error", message: "onSpill failed" })
  })
}

test("crash-command-once: a command whose record cannot be written fails with spawn_error and is not left running", async () => {
  const cwd = mkdtempSync(join("/tmp", "sigma-env-"))
  dirs.push(cwd)
  // A folder below a file cannot be made, as a full or read-only runtime folder cannot be written.
  writeFileSync(join(cwd, "file"), "")
  const env = new LocalExecutionEnv({ cwd, processes: new ProcessRegistry(join(cwd, "file", "processes")) })
  const seconds = `61.${process.pid}`
  const error = await Effect.runPromise(Effect.flip(env.exec(["sleep", seconds])))
  expect([error.code, error.message.startsWith("could not record the command:")]).toEqual(["spawn_error", true])
  const running = Bun.spawnSync(["ps", "-A", "-o", "args="]).stdout.toString()
  expect(running.split("\n").filter((args) => args.trim() === `sleep ${seconds}`)).toEqual([])
})
