// The Agent Client Protocol over one `agy acp` process's stdio: JSON-RPC 2.0, one message per line. Sigma is the
// client: it calls `agy`'s methods, answers the requests `agy` makes of it, and reads its notifications, in order.
import { Inbox } from "@sigma/hosted"

export type Json = Record<string, any>

/** What `agy` says, in order: a notification, a request sigma must answer, or its answer to one of sigma's. */
export type Incoming =
  | { readonly type: "notification"; readonly method: string; readonly params: Json }
  | { readonly type: "request"; readonly id: number | string; readonly method: string; readonly params: Json }
  | { readonly type: "answer"; readonly id: number; readonly answer: Answer }

/** An answer `agy` gave: its result, or its error. */
export type Answer = { readonly result?: any; readonly error?: { readonly code?: number; readonly message: string } }

/** How an `agy` process is started. */
export interface AcpCommand {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

/** One `agy acp` process, as an ACP client sees it. */
export interface Acp {
  /**
   * Calls `method`: its id, which the answer in `incoming` carries, and its answer. One the process ended before
   * answering is an error that says so.
   */
  readonly request: (method: string, params: Json) => { readonly id: number; readonly answer: Promise<Answer> }
  readonly call: (method: string, params: Json) => Promise<Answer>
  readonly notify: (method: string, params: Json) => void
  readonly reply: (id: number | string, result: Json) => void
  readonly refuse: (id: number | string, message: string) => void
  /** Every notification, request and answer, in order; ends when the process does. */
  readonly incoming: AsyncIterable<Incoming>
  /** Completes when the process has exited, with what ended it. */
  readonly exited: Promise<string>
  readonly kill: () => void
}

/** Starts `command` as `agy acp`. */
export const startAcp = (command: AcpCommand): Acp => {
  const incoming = new Inbox<Incoming>()
  const waiting = new Map<number, (answer: Answer) => void>()
  let nextId = 1
  let ended: string | undefined
  let exitedNow: (why: string) => void = () => undefined
  const exited = new Promise<string>((done) => (exitedNow = done))

  const end = (why: string) => {
    if (ended !== undefined) return
    ended = why
    for (const done of waiting.values()) done({ error: { message: why } })
    waiting.clear()
    incoming.close()
    exitedNow(why)
  }

  let child: Bun.Subprocess<"pipe", "pipe", "pipe">
  try {
    child = Bun.spawn([command.executable, "acp", ...command.args], {
      cwd: command.cwd,
      env: { ...command.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    end(`agy did not start: ${error instanceof Error ? error.message : String(error)}`)
    return {
      request: () => ({ id: 0, answer: Promise.resolve({ error: { message: ended! } }) }),
      call: async () => ({ error: { message: ended! } }),
      notify: () => undefined,
      reply: () => undefined,
      refuse: () => undefined,
      incoming,
      exited,
      kill: () => undefined,
    }
  }

  const write = (message: Json) => {
    if (ended !== undefined) return
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
      child.stdin.flush()
    } catch {}
  }

  const read = (line: string) => {
    let message: Json
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method === undefined) {
      const done = waiting.get(message.id)
      waiting.delete(message.id)
      const answer: Answer = message.error === undefined ? { result: message.result } : { error: message.error }
      incoming.push({ type: "answer", id: message.id, answer })
      done?.(answer)
    } else if (message.id === undefined) {
      incoming.push({ type: "notification", method: message.method, params: message.params ?? {} })
    } else {
      incoming.push({ type: "request", id: message.id, method: message.method, params: message.params ?? {} })
    }
  }

  // Read as it comes, so a chatty `agy` never fills the pipe; the tail says why it exited.
  let stderrTail = ""
  const stderr = (async () => {
    const decoder = new TextDecoder()
    // Only what fits in the failed run's message: agy's error is its last line or two.
    for await (const chunk of child.stderr) stderrTail = (stderrTail + decoder.decode(chunk)).slice(-500)
  })().catch(() => undefined)

  void (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line !== "") read(line)
      }
    }
    const code = await child.exited
    await stderr
    const tail = stderrTail.trim()
    end(tail === "" ? `agy exited with code ${code}` : `agy exited with code ${code}: ${tail}`)
  })().catch((error: unknown) => end(`agy stopped: ${error instanceof Error ? error.message : String(error)}`))

  const request = (method: string, params: Json) => {
    const id = nextId++
    const answer = new Promise<Answer>((done) => {
      if (ended !== undefined) return done({ error: { message: ended } })
      waiting.set(id, done)
      write({ jsonrpc: "2.0", id, method, params })
    })
    return { id, answer }
  }
  return {
    request,
    call: (method, params) => request(method, params).answer,
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    reply: (id, result) => write({ jsonrpc: "2.0", id, result }),
    refuse: (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32601, message } }),
    incoming,
    exited,
    kill: () => {
      if (ended === undefined) child.kill()
    },
  }
}

/** What sigma tells `agy` it is: a client with no file system or terminal of its own, so `agy` uses its own tools. */
export const INITIALIZE = {
  protocolVersion: 1,
  clientInfo: { name: "sigma", version: "0" },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
}

/** The error `agy` answers `session/new` with when it is not signed in (measured on 1.5.13: -32000). */
export const signedOut = (answer: Answer) => /authentication required/i.test(answer.error?.message ?? "")

/** The command a person runs to sign `agy` in. */
export const SIGN_IN = "run `agy` in a terminal and sign in"
