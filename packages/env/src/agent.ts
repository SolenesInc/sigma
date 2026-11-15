// sigma-env: serves this computer's `LocalExecutionEnv` to a sigma server over stdin and stdout, in the env protocol
// (protocol.ts). The server's connector starts it on a target and holds its stdin. It stops every command it runs, and
// exits, when stdin closes, when no frame arrives for the silence limit while a command runs, or when a later agent of
// the same owner sweeps it (D7).
//   sigma-env [--silence-ms <ms>]
import { hostname, homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Cause, Effect, Exit } from "effect"
import { ExecutionError, type FileChange } from "./index.ts"
import { LocalExecutionEnv } from "./local.ts"
import {
  type AgentFrame,
  type Call,
  decode,
  encode,
  type Handle,
  PROTOCOL,
  type ServerFrame,
  type ServerHello,
  toWire,
} from "./protocol.ts"
import { ProcessRegistry } from "./registry.ts"

/**
 * How long a running command waits for any frame before the agent decides its server is gone. Pings come every 5 s,
 * and over 4 minutes at load 2 to 15 the worst gap was 5,015 ms while single calls stalled up to 5.2 s; 120 s is 23
 * times the worst stall, so only a dead link or a frozen server reaches it (F14).
 */
export const SILENCE_MS = 120_000

/** The environment methods a call may name; everything else is refused. */
const METHODS = new Set([
  "absolutePath",
  "joinPath",
  "readTextFile",
  "openTextLineReader",
  "readTextLines",
  "readBinaryFile",
  "openBinaryReader",
  "writeFile",
  "appendFile",
  "truncateFile",
  "flushFile",
  "renameFile",
  "fileInfo",
  "listDir",
  "openDirReader",
  "search",
  "watch",
  "canonicalPath",
  "exists",
  "createDir",
  "remove",
  "createTempDir",
  "createTempFile",
  "exec",
])
const OPENS = new Set(["openTextLineReader", "openBinaryReader", "openDirReader"])
/** The methods of an open reader or watcher that release it. */
const RELEASES = new Set(["close", "stop"])

type Running = { readonly controller: AbortController; readonly exec: boolean; readonly settled: Promise<void> }

const main = () => {
  const at = process.argv.indexOf("--silence-ms")
  const silenceMs = at === -1 ? SILENCE_MS : Number(process.argv[at + 1])
  const write = (frame: AgentFrame) => {
    try {
      process.stdout.write(encode(frame))
    } catch {
      // The server is gone; stdin closing stops everything.
    }
  }
  // A server gone mid-write is no reason to crash before the commands are stopped.
  process.stdout.on("error", () => {})

  let registry: ProcessRegistry | undefined
  const envs = new Map<string, LocalExecutionEnv>()
  const envAt = (cwd: string) => {
    let env = envs.get(cwd)
    if (env === undefined) envs.set(cwd, (env = new LocalExecutionEnv({ cwd, processes: registry! })))
    return env
  }
  const handles = new Map<number, Record<string, (...args: unknown[]) => Effect.Effect<unknown, unknown>>>()
  let nextHandle = 1
  const running = new Map<number, Running>()
  /** Set when the agent stops its commands for the silence limit, so their answers say why. */
  let silenced: string | undefined
  let stopping = false

  const stop = (why: string) => {
    if (stopping) return
    stopping = true
    process.stderr.write(`sigma-env ${process.pid}: ${why}; stopping ${running.size} calls\n`)
    for (const call of running.values()) call.controller.abort()
    void Promise.all([...running.values()].map((call) => call.settled)).finally(() => {
      registry?.removeProcess(process.pid)
      process.exit(0)
    })
  }

  let silence: ReturnType<typeof setTimeout> | undefined
  /** Restarts the silence timer while a command runs; a frame or a command's start or end calls it. */
  const watch = () => {
    if (silence !== undefined) clearTimeout(silence)
    silence = undefined
    const execs = [...running.values()].some((call) => call.exec)
    if (!execs || stopping) return
    silence = setTimeout(() => {
      silenced = `killed by sigma-env: no frame from the server for ${silenceMs / 1000} s`
      stop(`no frame for ${silenceMs} ms`)
    }, silenceMs)
  }

  const effectOf = (call: Call): Effect.Effect<unknown, unknown> => {
    if (call.handle !== undefined) {
      const target = handles.get(call.handle)
      const method = target?.[call.method]
      if (method === undefined)
        return Effect.fail(new ExecutionError("unknown", `no open ${call.method} handle ${call.handle}`))
      const done = method.apply(target, [...call.args])
      return RELEASES.has(call.method)
        ? Effect.ensuring(
            done,
            Effect.sync(() => handles.delete(call.handle!)),
          )
        : done
    }
    if (!METHODS.has(call.method)) return Effect.fail(new ExecutionError("unknown", `no env method ${call.method}`))
    const env = envAt(call.cwd)
    const opened = (value: unknown, mode?: string): Handle => {
      const handle = nextHandle++
      handles.set(handle, value as never)
      return { $handle: handle, ...(mode === undefined ? {} : { mode }) }
    }
    switch (call.method) {
      case "exec": {
        const [command, options = {}] = call.args as [string | string[], object?]
        return env.exec(command, {
          ...options,
          ...(call.want?.output
            ? { onOutput: (text, info) => write({ id: call.id, t: "event", kind: "output", text, info }) }
            : {}),
          ...(call.want?.spill ? { onSpill: (path) => write({ id: call.id, t: "event", kind: "spill", path }) } : {}),
        })
      }
      case "watch": {
        const onChange = (change: FileChange) =>
          write({
            id: call.id,
            t: "event",
            kind: "change",
            change: change.kind === "failed" ? { kind: "failed", error: toWire(change.error) } : change,
          })
        return Effect.map(env.watch(call.args[0] as never, onChange), (watcher) => opened(watcher, watcher.mode))
      }
      default: {
        const done = (env as unknown as Record<string, (...args: unknown[]) => Effect.Effect<unknown, unknown>>)[
          call.method
        ]!.apply(env, [...call.args])
        return OPENS.has(call.method) ? Effect.map(done, (value) => opened(value)) : done
      }
    }
  }

  const answer = (call: Call) => {
    const controller = new AbortController()
    const exec = call.handle === undefined && call.method === "exec"
    const settled = Effect.runPromiseExit(effectOf(call), { signal: controller.signal }).then((exit) => {
      running.delete(call.id)
      watch()
      if (Exit.isSuccess(exit))
        return write(exit.value === undefined ? { id: call.id, t: "ok" } : { id: call.id, t: "ok", value: exit.value })
      const error = Cause.hasInterruptsOnly(exit.cause)
        ? new ExecutionError(silenced !== undefined && exec ? "unknown" : "aborted", silenced ?? "interrupted")
        : Cause.squash(exit.cause)
      write({ id: call.id, t: "err", error: toWire(error) })
    })
    running.set(call.id, { controller, exec, settled })
    watch()
  }

  const hello = (frame: ServerHello) => {
    const reply: AgentFrame = {
      t: "hello",
      protocol: PROTOCOL,
      instance: process.env.SIGMA_TARGET_INSTANCE ?? hostname(),
      files: process.env.SIGMA_TARGET_FILES ?? process.env.SIGMA_TARGET_INSTANCE ?? hostname(),
      platform: process.platform,
      home: homedir(),
    }
    // The server reports a mismatch from this hello; an owner unfit for a folder name is a broken server.
    if (frame.protocol !== PROTOCOL || !/^[\w-]{1,128}$/.test(String(frame.owner))) {
      write(reply)
      process.exit(2)
    }
    // Earlier agents of this owner, and their commands, die before this one answers, so no command from before a
    // restart runs beside the restarted server's calls.
    registry = new ProcessRegistry(join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "sigma-env", frame.owner))
    registry.sweep()
    registry.recordProcess(process.pid)
    write(reply)
  }

  const lines = createInterface({ input: process.stdin })
  lines.on("line", (line) => {
    if (line.trim() === "" || stopping) return
    const frame = decode(line) as ServerFrame
    if (registry === undefined) {
      if (frame.t !== "hello") return stop("the server spoke before its hello")
      return hello(frame)
    }
    watch()
    if (frame.t === "call") answer(frame)
    else if (frame.t === "cancel") running.get(frame.id)?.controller.abort()
  })
  lines.on("close", () => stop("input closed"))
}

if (import.meta.main) main()
