// An `ExecutionEnv` on a target, served by `sigma-env` over a channel the target's connector opens (D1). One channel per
// target, shared by every view of it; a lost channel fails its calls with the connector's reason, and the next call
// connects again once (D5). While a call is in flight or a watcher is open the client pings and the agent answers, so
// each end can tell a silent peer: the agent stops its commands (D7), and the client kills the connector and fails its
// calls and watchers (D17).
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { posix } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  type FileChange,
  FileError,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  type SearchQuery,
  type SearchResult,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  type WatchTarget,
} from "./index.ts"
import {
  type AgentFrame,
  type AgentHello,
  type Call,
  decode,
  encode,
  fromWire,
  type Handle,
  PROTOCOL,
  type ServerFrame,
  SILENCE_MS,
  type WireError,
} from "./protocol.ts"

/** Pings while a call is in flight or a watcher open: over 4 minutes at load 2 to 15 they arrived at most 15 ms late (F14). */
const PING_MS = 5_000
/**
 * How long a connector may take to bring the agent's hello: a start through ssh and `docker exec`, with the sweep and
 * reading `AGENTS.md`, took 723 ms (F11). Past 60 s it is hung, as an ssh that never connects is (F14).
 */
const HELLO_MS = 60_000
/** The connector's stderr kept for a reason (D4); the rest is counted. */
const REASON_BYTES = 8 * 1024

/** A byte stream to `sigma-env` on a target, line by line. */
export interface Channel {
  send(line: string): void
  /** Ends the agent's input, which stops its commands and makes it exit. */
  end(): void
  /** Kills the connector, for one that will not bring a hello. */
  kill(): void
  /** Each line the agent writes. */
  onLine(listener: (line: string) => void): void
  /** Once, when the channel is gone, with why, as the connector's stderr tells it. */
  onClose(listener: (reason: string) => void): void
}

/** The channel through a connector process: its stdin and stdout, with its stderr as the reason it ended. */
export const spawnChannel = (argv: readonly string[]): Channel => {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] })
  let stderr = ""
  let dropped = 0
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    const room = REASON_BYTES - Buffer.byteLength(stderr)
    if (room <= 0) dropped += Buffer.byteLength(chunk)
    else {
      const kept = Buffer.from(chunk).subarray(0, room).toString()
      stderr += kept
      dropped += Buffer.byteLength(chunk) - Buffer.byteLength(kept)
    }
  })
  child.stdin.on("error", () => {}) // a connector that exits early; its exit says why
  const lines: ((line: string) => void)[] = []
  let buffer = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      for (const listener of lines) listener(line)
    }
  })
  let reason: string | undefined
  const closes: ((reason: string) => void)[] = []
  const closed = (why: string) => {
    if (reason !== undefined) return
    reason = why
    for (const listener of closes) listener(why)
  }
  child.on("error", (error) => closed(`connector ${argv[0]} failed: ${error.message}`))
  child.on("close", (code, signal) => {
    const told = stderr.trim() + (dropped > 0 ? ` [${dropped} more bytes]` : "")
    closed(`connector exited ${code ?? signal}${told === "" ? "" : `: ${told}`}`)
  })
  return {
    send: (line) => void child.stdin.write(line),
    end: () => child.stdin.end(),
    kill: () => child.kill("SIGKILL"),
    onLine: (listener) => void lines.push(listener),
    onClose: (listener) => (reason === undefined ? void closes.push(listener) : listener(reason)),
  }
}

/** The target could not be reached, or its agent did not complete the hello. */
export class TargetUnreachable extends Error {
  readonly _tag = "TargetUnreachable"
  constructor(
    readonly target: string,
    readonly reason: string,
  ) {
    super(`target ${target} unavailable: ${reason}`)
  }
}

type Settle = (
  frame: Extract<AgentFrame, { t: "ok" | "err" }> | { readonly t: "lost"; readonly reason: string },
) => void
type Listener = (frame: Extract<AgentFrame, { t: "event" }>) => void

/** One channel's life: its hello, the calls waiting on it, and their event listeners. */
class Session {
  readonly hello: Promise<AgentHello>
  #reason: string | undefined
  #next = 1
  readonly #waiting = new Map<number, Settle>()
  readonly #listeners = new Map<number, Listener>()
  readonly #execs = new Set<number>()
  #ping: ReturnType<typeof setInterval> | undefined
  #silence: ReturnType<typeof setTimeout> | undefined
  readonly #silenceMs: number
  readonly #lost: (reason: string) => void
  readonly closed: Promise<void>

  constructor(
    readonly target: string,
    readonly channel: Channel,
    owner: string,
    silenceMs: number,
  ) {
    this.#silenceMs = silenceMs
    let greet!: (hello: AgentHello) => void
    let refuse!: (error: TargetUnreachable) => void
    this.hello = new Promise((resolve, reject) => ((greet = resolve), (refuse = reject)))
    this.hello.catch(() => {})
    let greeted = false
    // A session that cannot go on is lost at once, its connector killed, so the next call connects again (D5).
    const fail = (reason: string) => {
      this.#lost(reason)
      channel.kill()
    }
    const late = setTimeout(() => fail(`no hello from sigma-env within ${HELLO_MS / 1000} s`), HELLO_MS)
    channel.onLine((line) => {
      if (line.trim() === "" || this.#reason !== undefined) return
      let frame: AgentFrame
      try {
        frame = decode(line) as AgentFrame
      } catch {
        return fail(`sigma-env wrote a line that is not a frame: ${line.slice(0, 200)}`)
      }
      if (!greeted) {
        greeted = true
        clearTimeout(late)
        if (frame.t !== "hello") return fail("sigma-env spoke before its hello")
        if (frame.protocol !== PROTOCOL)
          return fail(`target agent speaks env protocol ${frame.protocol}; this server needs ${PROTOCOL}`)
        return greet(frame)
      }
      clearTimeout(this.#silence)
      this.#silence = undefined
      if (frame.t === "event") {
        this.#listeners.get(frame.id)?.(frame)
        return this.#track()
      }
      if (frame.t !== "hello" && frame.t !== "pong") {
        const settle = this.#waiting.get(frame.id)
        this.#waiting.delete(frame.id)
        // A watcher's events outlive its answer; an exec's end with it, and a failed call has none.
        if (this.#execs.delete(frame.id) || frame.t === "err") this.#listeners.delete(frame.id)
        settle?.(frame)
      }
      this.#track()
    })
    let lose!: (reason: string) => void
    this.closed = new Promise((resolve) => {
      lose = (reason) => {
        if (this.#reason !== undefined) return
        clearTimeout(late)
        clearTimeout(this.#silence)
        clearInterval(this.#ping)
        this.#ping = undefined
        this.#reason = reason
        refuse(new TargetUnreachable(target, reason))
        const waiting = [...this.#waiting.values()]
        this.#waiting.clear()
        this.#execs.clear()
        for (const settle of waiting) settle({ t: "lost", reason })
        for (const [id, listener] of this.#listeners)
          listener({ id, t: "event", kind: "change", change: { kind: "failed", error: lostError(target, reason) } })
        this.#listeners.clear()
        resolve()
      }
    })
    this.#lost = lose
    channel.onClose(lose)
    channel.send(encode({ t: "hello", protocol: PROTOCOL, owner: agentOwner(owner, target) }))
  }

  /** Why the channel is gone, once it is. */
  get reason(): string | undefined {
    return this.#reason
  }

  /** Sends a call and returns its id, or the reason the channel is gone. */
  send(call: Omit<Call, "id" | "t">, settle: Settle, listener?: Listener): number | string {
    if (this.#reason !== undefined) return this.#reason
    const id = this.#next++
    this.#waiting.set(id, settle)
    if (listener !== undefined) this.#listeners.set(id, listener)
    if (call.handle === undefined && call.method === "exec") this.#execs.add(id)
    this.#track()
    this.#frame({ id, t: "call", ...call })
    return id
  }

  cancel(id: number): void {
    if (this.#waiting.has(id)) this.#frame({ id, t: "cancel" })
  }

  /** Stops routing events to call `id`, as a stopped watcher does. */
  unlisten(id: number): void {
    this.#listeners.delete(id)
    this.#track()
  }

  /**
   * Pings and arms the silence timer while a call is in flight or a watcher is open, and stops both otherwise; each
   * frame from the agent disarms the timer before this rearms it. A link that dies without closing (F21) gives no EOF,
   * so past the limit the connector is killed, every waiting call fails, a pending cancel too, and every open watcher
   * reports failed (D17).
   */
  #track() {
    if ((this.#waiting.size === 0 && this.#listeners.size === 0) || this.#reason !== undefined) {
      clearTimeout(this.#silence)
      this.#silence = undefined
      clearInterval(this.#ping)
      this.#ping = undefined
      return
    }
    this.#ping ??= setInterval(() => this.#frame({ t: "ping" }), PING_MS)
    this.#silence ??= setTimeout(() => {
      this.#lost(`no frame from sigma-env for ${this.#silenceMs / 1000} s`)
      this.channel.kill()
    }, this.#silenceMs)
  }

  #frame(frame: ServerFrame) {
    this.channel.send(encode(frame))
  }
}

/**
 * The owner an agent sweeps by: the home's, with the target, so a restarted server replaces its own agent on a target
 * and leaves alone those of another home, or of another target of this home on the same computer (D7).
 */
const agentOwner = (owner: string, target: string) =>
  `${owner}-${createHash("sha256").update(target).digest("hex").slice(0, 16)}`

const lostError = (target: string, reason: string): WireError => ({
  tag: "FileError",
  code: "unknown",
  message: `target ${target} unavailable: ${reason}`,
})

export interface TargetPoolOptions {
  /** Whose commands the agents run: a later agent of the same owner kills an earlier one's (D7). */
  readonly owner: string
  /** Opens a channel to `sigma-env` on the target's current instance. */
  readonly connect: (target: string) => Channel
  /** How long a call in flight waits for any frame from the agent; default `SILENCE_MS`. */
  readonly silenceMs?: number
}

/** The channel to each target, opened on first use and opened again on the first call after it is lost. */
export class TargetPool {
  readonly #options: TargetPoolOptions
  readonly #sessions = new Map<string, Session>()

  constructor(options: TargetPoolOptions) {
    this.#options = options
  }

  /** The live session of `target`, connecting when it has none. */
  session(target: string): Effect.Effect<Session, TargetUnreachable> {
    return Effect.callback<Session, TargetUnreachable>((resume) => {
      let session = this.#sessions.get(target)
      if (session === undefined || session.reason !== undefined) {
        const opened = new Session(
          target,
          this.#options.connect(target),
          this.#options.owner,
          this.#options.silenceMs ?? SILENCE_MS,
        )
        this.#sessions.set(target, opened)
        void opened.closed.then(() => {
          if (this.#sessions.get(target) === opened) this.#sessions.delete(target)
        })
        session = opened
      }
      const current = session
      current.hello.then(
        () => resume(Effect.succeed(current)),
        (error: TargetUnreachable) => resume(Effect.fail(error)),
      )
    })
  }

  /** Connects to `target` when no channel is open, and returns its agent's hello. */
  connect(target: string): Effect.Effect<AgentHello, TargetUnreachable> {
    return Effect.flatMap(this.session(target), (session) => Effect.promise(() => session.hello))
  }

  /** The environment at `cwd`, a path on `target`. It connects on its first call. */
  env(target: string, cwd: string): RemoteExecutionEnv {
    return new RemoteExecutionEnv(this, target, cwd)
  }

  /** Ends every channel, which stops their commands, and completes once each is gone. */
  close(): Effect.Effect<void> {
    return Effect.promise(async () => {
      const sessions = [...this.#sessions.values()]
      for (const session of sessions) session.channel.end()
      await Promise.all(sessions.map((session) => session.closed))
    })
  }
}

type Failure = FileError | ExecutionError

/**
 * One call on `session`, interruptible: an interrupt sends `cancel` and completes once the agent answers, which for an
 * exec is once its processes are gone.
 */
const request = <A, E extends Failure>(
  session: Session,
  call: Omit<Call, "id" | "t">,
  lost: (message: string) => E,
  listener?: Listener,
  sent?: (id: number) => void,
): Effect.Effect<A, E> =>
  Effect.callback<A, E>((resume) => {
    let finished: (() => void) | undefined
    const id = session.send(
      call,
      (frame) => {
        if (finished !== undefined) return finished()
        if (frame.t === "ok") return resume(Effect.succeed(frame.value as A))
        if (frame.t === "lost")
          return resume(Effect.fail(lost(`target ${session.target} unavailable: ${frame.reason}`)))
        resume(Effect.fail(fromWire(frame.error) as E))
      },
      listener,
    )
    if (typeof id === "string") return resume(Effect.fail(lost(`target ${session.target} unavailable: ${id}`)))
    sent?.(id)
    return Effect.callback<void>((done) => {
      finished = () => done(Effect.void)
      session.cancel(id)
      if (session.reason !== undefined) done(Effect.void)
    })
  })

const fileLost = (message: string) => new FileError("unknown", message)
const execLost = (message: string) => new ExecutionError("unknown", message)

/** The environment at one working directory on a target, a view over the target's pooled channel. */
export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string
  readonly cwd: string
  readonly #pool: TargetPool
  readonly #target: string
  /** Calls of this view's running execs, for `cleanup`. */
  readonly #execs = new Set<{ session: Session; id: number }>()

  constructor(pool: TargetPool, target: string, cwd: string) {
    this.#pool = pool
    this.#target = target
    this.cwd = cwd
    this.id = `target:${target}`
  }

  #session<E extends Failure>(lost: (message: string) => E): Effect.Effect<Session, E> {
    return Effect.mapError(this.#pool.session(this.#target), (error) => lost(error.message))
  }

  #call<A>(method: string, ...args: unknown[]): Effect.Effect<A, FileError> {
    return Effect.flatMap(this.#session(fileLost), (session) =>
      request<A, FileError>(session, { cwd: this.cwd, method, args }, fileLost),
    )
  }

  /** Opens a reader on the agent and calls its methods through the same session. */
  #open<R>(method: string, args: unknown[], wrap: (on: HandleCall) => R): Effect.Effect<R, FileError> {
    return Effect.flatMap(this.#session(fileLost), (session) =>
      Effect.map(request<Handle, FileError>(session, { cwd: this.cwd, method, args }, fileLost), (handle) =>
        wrap((name, ...rest) =>
          request(session, { cwd: this.cwd, method: name, args: rest, handle: handle.$handle }, fileLost),
        ),
      ),
    )
  }

  /** `path` on the target: posix, with `~` its home (D8 computes this here, not over the channel). */
  absolutePath(path: string): Effect.Effect<string, FileError> {
    const resolve = (normalized: string) =>
      posix.isAbsolute(normalized) ? posix.resolve(normalized) : posix.resolve(this.cwd, normalized)
    // Only `~` needs the target's home, so only it connects.
    if (path === "~" || path.startsWith("~/"))
      return Effect.flatMap(this.#session(fileLost), (session) =>
        Effect.map(
          Effect.promise(() => session.hello),
          (hello) => resolve(path === "~" ? hello.home : posix.join(hello.home, path.slice(2))),
        ),
      )
    let normalized = path
    if (normalized.startsWith("file://")) {
      try {
        normalized = fileURLToPath(normalized)
      } catch {
        // A malformed URL stays an ordinary path, as in the local env.
      }
    }
    return Effect.succeed(resolve(normalized))
  }

  joinPath(parts: string[]): Effect.Effect<string, FileError> {
    return Effect.sync(() => posix.join(...parts))
  }

  readTextFile(path: string) {
    return this.#call<string>("readTextFile", path)
  }

  openTextLineReader(path: string): Effect.Effect<TextLineReader, FileError> {
    return this.#open("openTextLineReader", [path], (on) => ({
      readLine: () => on<TextLine | undefined>("readLine"),
      close: () => Effect.ignore(on<void>("close")),
    }))
  }

  readTextLines(path: string, options?: { maxLines?: number }) {
    return this.#call<string[]>("readTextLines", path, options)
  }

  readBinaryFile(path: string) {
    return this.#call<Uint8Array>("readBinaryFile", path)
  }

  openBinaryReader(path: string, options?: { noFollow?: boolean }): Effect.Effect<BinaryReader, FileError> {
    return this.#open("openBinaryReader", [path, options], (on) => ({
      info: () => on<FileInfo>("info"),
      read: (offset: number, length: number) => on<Uint8Array>("read", offset, length),
      scanLines: (scan: { startLine: number; endLine?: number }) => on<LineScan>("scanLines", scan),
      close: () => Effect.ignore(on<void>("close")),
    }))
  }

  writeFile(path: string, content: string | Uint8Array) {
    return this.#call<void>("writeFile", path, content)
  }

  appendFile(path: string, content: string | Uint8Array) {
    return this.#call<void>("appendFile", path, content)
  }

  truncateFile(path: string, size: number) {
    return this.#call<void>("truncateFile", path, size)
  }

  flushFile(path: string) {
    return this.#call<void>("flushFile", path)
  }

  renameFile(sourcePath: string, destinationPath: string) {
    return this.#call<void>("renameFile", sourcePath, destinationPath)
  }

  fileInfo(path: string) {
    return this.#call<FileInfo>("fileInfo", path)
  }

  listDir(path: string) {
    return this.#call<FileInfo[]>("listDir", path)
  }

  openDirReader(path: string): Effect.Effect<DirReader, FileError> {
    return this.#open("openDirReader", [path], (on) => ({
      next: (maxEntries: number) => on<{ entries: FileInfo[]; done: boolean }>("next", maxEntries),
      close: () => Effect.ignore(on<void>("close")),
    }))
  }

  search(path: string, query: SearchQuery) {
    return this.#call<SearchResult>("search", path, query)
  }

  watch(
    targets: readonly WatchTarget[],
    onChange: (change: FileChange) => void,
  ): Effect.Effect<FileWatcher, FileError> {
    return Effect.flatMap(this.#session(fileLost), (session) => {
      let watchId: number | undefined
      const listener: Listener = (frame) => {
        if (frame.kind !== "change") return
        const change = frame.change as FileChange | { kind: "failed"; error: WireError }
        onChange(
          change.kind === "failed"
            ? { kind: "failed", error: fromWire(change.error as WireError) as FileError }
            : change,
        )
      }
      return Effect.map(
        request<Handle, FileError>(
          session,
          { cwd: this.cwd, method: "watch", args: [targets] },
          fileLost,
          listener,
          (id) => (watchId = id),
        ),
        (handle): FileWatcher => ({
          mode: handle.mode as FileWatcher["mode"],
          stop: () =>
            Effect.ignore(
              Effect.ensuring(
                request<void, FileError>(
                  session,
                  { cwd: this.cwd, method: "stop", args: [], handle: handle.$handle },
                  fileLost,
                ),
                Effect.sync(() => watchId !== undefined && session.unlisten(watchId)),
              ),
            ),
        }),
      )
    })
  }

  canonicalPath(path: string) {
    return this.#call<string>("canonicalPath", path)
  }

  exists(path: string) {
    return this.#call<boolean>("exists", path)
  }

  createDir(path: string, options?: { recursive?: boolean }) {
    return this.#call<void>("createDir", path, options)
  }

  remove(path: string, options?: { recursive?: boolean; force?: boolean }) {
    return this.#call<void>("remove", path, options)
  }

  createTempDir(prefix?: string) {
    return this.#call<string>("createTempDir", prefix)
  }

  createTempFile(options?: { prefix?: string; suffix?: string }) {
    return this.#call<string>("createTempFile", options)
  }

  exec(
    command: string | readonly string[],
    options: ShellExecOptions = {},
  ): Effect.Effect<ShellExecResult, ExecutionError> {
    const { onOutput, onSpill, ...plain } = options
    return Effect.flatMap(this.#session(execLost), (session) => {
      // A caller's callback that throws fails the command, once the agent has stopped it.
      let thrown: Error | undefined
      let id: number | undefined
      const guarded = (run: () => void) => {
        if (thrown !== undefined) return
        try {
          run()
        } catch (error) {
          thrown = error instanceof Error ? error : new Error(String(error))
          if (id !== undefined) session.cancel(id)
        }
      }
      const listener: Listener = (frame) => {
        if (frame.kind === "output") guarded(() => onOutput?.(frame.text, frame.info as never))
        if (frame.kind === "spill") guarded(() => onSpill?.(frame.path))
      }
      const call = {
        cwd: this.cwd,
        method: "exec",
        args: [command, plain],
        want: { output: onOutput !== undefined, spill: onSpill !== undefined },
      }
      let entry: { session: Session; id: number } | undefined
      const callbackError = () => new ExecutionError("callback_error", thrown!.message, thrown)
      return request<ShellExecResult, ExecutionError>(session, call, execLost, listener, (sent) => {
        id = sent
        this.#execs.add((entry = { session, id }))
      }).pipe(
        Effect.ensuring(Effect.sync(() => entry !== undefined && this.#execs.delete(entry))),
        Effect.catch((error) => Effect.fail(thrown === undefined ? error : callbackError())),
        Effect.flatMap((result) => (thrown === undefined ? Effect.succeed(result) : Effect.fail(callbackError()))),
      )
    })
  }

  /** Stops this view's running commands; each exec that ran them completes once its processes are gone. */
  cleanup(): Effect.Effect<void> {
    return Effect.sync(() => {
      for (const { session, id } of this.#execs) session.cancel(id)
    })
  }
}

type HandleCall = <A>(method: string, ...args: unknown[]) => Effect.Effect<A, FileError>
