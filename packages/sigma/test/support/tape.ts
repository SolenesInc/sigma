// A tape: the model wire of one journey on one harness, as NDJSON in `fixtures/tapes/<harness>/<journey>.ndjson`.
//
//   transcript_start   the header: provider, dialect, scenario, and where the tape came from
//   lane               one model conversation in the journey, named by words its first user text contains
//   bind               a value the harness chooses at run time, captured from a tool result by `pattern`'s group
//   expect_outbound    what the newest message of a lane's request at a turn must match
//   emit_inbound       one frame of the reply to a lane's turn; a `gate` holds that reply until the journey releases it
//
// A turn is the number of model replies the request already holds, plus one: a lane's first request is its turn 1.
// In a frame, `<any>` matches any value, `<any>` inside a string matches any text there, and `<name:N>` is the Nth
// value bound to `name`, in a reply as in an expectation.
import { readFileSync } from "node:fs"

export const ANY = "<any>"

export interface Header {
  readonly type: "transcript_start"
  readonly provider: string
  readonly dialect: string
  readonly scenario: string
  readonly metadata: Readonly<Record<string, unknown>>
}
export interface Lane {
  readonly name: string
  readonly when: string
}
export interface Bind {
  readonly name: string
  readonly from: "tool_result"
  readonly pattern: RegExp
}
/** The request one lane makes at one turn, and the reply it gets. */
export interface Exchange {
  readonly lane: string
  readonly turn: number
  readonly newest: unknown
  readonly gate: string | undefined
  readonly frames: ReadonlyArray<unknown>
}
export interface Tape {
  readonly path: string
  readonly header: Header
  readonly lanes: ReadonlyArray<Lane>
  readonly binds: ReadonlyArray<Bind>
  readonly exchanges: ReadonlyArray<Exchange>
}

export const exchangeKey = (lane: string, turn: number) => `${lane} ${turn}`

/** Reads a tape, refusing one that holds a credential. */
export const readTape = (path: string): Tape => {
  const text = readFileSync(path, "utf8")
  if (/"authorization"\s*:/i.test(text)) throw new Error(`${path}: a tape holds no authorization value`)
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`${path}:${index + 1}: ${(error as Error).message}`)
      }
    })
  const header = lines[0]
  if (header?.type !== "transcript_start") throw new Error(`${path}: the first line is not transcript_start`)
  const lanes: Array<Lane> = []
  const binds: Array<Bind> = []
  const exchanges = new Map<string, { lane: string; turn: number; newest: unknown; gate?: string; frames: unknown[] }>()
  const exchange = (line: { lane: string; turn: number }, at: number) => {
    if (!lanes.some((lane) => lane.name === line.lane)) throw new Error(`${path}:${at}: no lane ${line.lane}`)
    const key = exchangeKey(line.lane, line.turn)
    if (!exchanges.has(key)) exchanges.set(key, { lane: line.lane, turn: line.turn, newest: ANY, frames: [] })
    return exchanges.get(key)!
  }
  lines.slice(1).forEach((line, index) => {
    const at = index + 2
    if (line.type === "lane") lanes.push({ name: line.name, when: line.when })
    else if (line.type === "bind")
      binds.push({ name: line.name, from: line.from, pattern: new RegExp(line.pattern, "g") })
    else if (line.type === "expect_outbound") exchange(line, at).newest = line.frame.newest
    else if (line.type === "emit_inbound") {
      const into = exchange(line, at)
      if (line.gate !== undefined) into.gate = line.gate
      into.frames.push(line.frame)
    } else throw new Error(`${path}:${at}: unknown line type ${line.type}`)
  })
  for (const [key, each] of exchanges)
    if (each.frames.length === 0) throw new Error(`${path}: ${key} expects a request and has no reply`)
  return {
    path,
    header,
    lanes,
    binds,
    exchanges: [...exchanges.values()].map((each) => ({ ...each, gate: each.gate })),
  }
}

/** The values bound so far, by name, in the order they were first seen. */
export class Bindings {
  readonly #values = new Map<string, Array<string>>()

  /** Binds each value `binds` find in `texts` that is not bound yet. */
  capture(binds: ReadonlyArray<Bind>, texts: ReadonlyArray<string>) {
    for (const bind of binds)
      for (const text of texts)
        for (const found of text.matchAll(bind.pattern)) {
          const value = found[1] ?? found[0]
          const values = this.#values.get(bind.name) ?? []
          if (!values.includes(value)) this.#values.set(bind.name, [...values, value])
        }
  }

  /** `value` with each `<name:N>` replaced by its bound value; throws on one not bound yet. */
  fill<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value).replace(/<([a-z_]+):(\d+)>/g, (placeholder, name: string, n: string) => {
        const bound = this.#values.get(name)?.[Number(n) - 1]
        if (bound === undefined) throw new Error(`${placeholder} is not bound yet`)
        return JSON.stringify(bound).slice(1, -1)
      }),
    )
  }
}

const wildcard = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split(ANY)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "s",
  )

export interface Difference {
  readonly at: string
  readonly expected: unknown
  readonly actual: unknown
}

/**
 * Where `actual` first differs from `expected`, or `undefined` when it matches. An expected object names the fields
 * that must match and leaves the rest free; an expected array matches item by item, with as many items.
 */
export const difference = (actual: unknown, expected: unknown, at = "newest"): Difference | undefined => {
  const differs = { at, expected, actual }
  if (expected === ANY) return undefined
  if (typeof expected === "string" && expected.includes(ANY))
    return typeof actual === "string" && wildcard(expected).test(actual) ? undefined : differs
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return differs
    for (const [index, item] of expected.entries()) {
      const found = difference(actual[index], item, `${at}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return differs
    for (const [key, item] of Object.entries(expected)) {
      const found = difference((actual as Record<string, unknown>)[key], item, `${at}.${key}`)
      if (found !== undefined) return found
    }
    return undefined
  }
  return actual === expected ? undefined : differs
}
