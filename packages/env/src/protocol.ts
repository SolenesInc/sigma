// The env protocol between a sigma server and `sigma-env` on a target (D1): one JSON object per line on the channel,
// the connector's stdin and stdout. Bytes travel as `{"$b64": …}`.
import { ExecutionError, type ExecutionErrorCode, FileError, type FileErrorCode } from "./index.ts"

/** Bumped on any change a peer of another version would misread; the hello refuses a mismatch. */
export const PROTOCOL = 1

/** What the server opens with: whose commands this agent runs, so it can sweep that owner's earlier agents. */
export type ServerHello = { readonly t: "hello"; readonly protocol: number; readonly owner: string }

/** The agent's answer, written after its sweep (D7). */
export type AgentHello = {
  readonly t: "hello"
  readonly protocol: number
  /** The machine or container, from `SIGMA_TARGET_INSTANCE`, else the hostname (D6). */
  readonly instance: string
  /** The storage behind the work folder, from `SIGMA_TARGET_FILES`, else `instance` (D6). */
  readonly files: string
  readonly platform: string
  /** The home directory, which `~` names in paths. */
  readonly home: string
}

/**
 * A method of the environment at `cwd`, or of an open reader or watcher when `handle` is set. `want` asks for exec's
 * output and spill events.
 */
export type Call = {
  readonly id: number
  readonly t: "call"
  readonly cwd: string
  readonly method: string
  readonly args: readonly unknown[]
  readonly handle?: number
  readonly want?: { readonly output?: boolean; readonly spill?: boolean }
}

/** Stops call `id`; its answer comes once what it started is gone. */
export type Cancel = { readonly id: number; readonly t: "cancel" }

/** Sent every few seconds while an exec runs, so the agent can tell a live server from a silent one. */
export type Ping = { readonly t: "ping" }

export type ServerFrame = ServerHello | Call | Cancel | Ping

export type WireError = {
  readonly tag: "FileError" | "ExecutionError"
  readonly code: string
  readonly message: string
  readonly path?: string
  readonly spillPath?: string
}

/** An open reader or watcher, which later calls name by `handle`. */
export type Handle = { readonly $handle: number; readonly mode?: string }

export type Answer =
  | { readonly id: number; readonly t: "ok"; readonly value?: unknown }
  | {
      readonly id: number
      readonly t: "err"
      readonly error: WireError
    }

export type Event =
  | { readonly id: number; readonly t: "event"; readonly kind: "output"; readonly text: string; readonly info: unknown }
  | { readonly id: number; readonly t: "event"; readonly kind: "spill"; readonly path: string }
  | { readonly id: number; readonly t: "event"; readonly kind: "change"; readonly change: unknown }

export type AgentFrame = AgentHello | Answer | Event

const replacer = (_key: string, value: unknown) =>
  value instanceof Uint8Array ? { $b64: Buffer.from(value).toString("base64") } : value

const reviver = (_key: string, value: unknown) =>
  value !== null && typeof value === "object" && typeof (value as { $b64?: unknown }).$b64 === "string"
    ? new Uint8Array(Buffer.from((value as { $b64: string }).$b64, "base64"))
    : value

export const encode = (frame: ServerFrame | AgentFrame): string => `${JSON.stringify(frame, replacer)}\n`

export const decode = (line: string): unknown => JSON.parse(line, reviver)

export const toWire = (error: unknown): WireError => {
  if (error instanceof FileError)
    return { tag: "FileError", code: error.code, message: error.message, ...(error.path ? { path: error.path } : {}) }
  if (error instanceof ExecutionError)
    return {
      tag: "ExecutionError",
      code: error.code,
      message: error.message,
      ...(error.spillPath ? { spillPath: error.spillPath } : {}),
    }
  return { tag: "FileError", code: "unknown", message: error instanceof Error ? error.message : String(error) }
}

export const fromWire = (error: WireError): FileError | ExecutionError => {
  if (error.tag === "ExecutionError") {
    const failure = new ExecutionError(error.code as ExecutionErrorCode, error.message)
    if (error.spillPath !== undefined) failure.spillPath = error.spillPath
    return failure
  }
  return new FileError(error.code as FileErrorCode, error.message, error.path)
}
