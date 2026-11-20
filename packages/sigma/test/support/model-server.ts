// The model server: plays a tape to a harness over its model wire. It answers each request from the request alone, its
// lane and turn, so a retried request gets the same reply; a request the tape does not expect gets a 400 naming the
// lane, the turn, the expected and the actual content. Closing it fails when a request was refused or an exchange of
// the tape was never asked for.
import { join } from "node:path"
import { anthropic } from "./dialects/anthropic.ts"
import { Bindings, difference, exchangeKey, type Exchange, readTape, type Tape } from "./tape.ts"

const TAPES = join(import.meta.dir, "../../../../fixtures/tapes")

/** What a request says, read from the request alone. */
export interface Read {
  /** The first words a person gave this model conversation, which name its lane. */
  readonly opening: string
  /** The number of model replies the request holds, plus one. */
  readonly turn: number
  /** The request's newest message, which the tape's expectation for the turn matches. */
  readonly newest: unknown
  /** The text of every tool result the request holds, where bindings are found. */
  readonly results: ReadonlyArray<string>
}

/** One model wire's shape. */
export interface Dialect {
  readonly route: (request: Request) => boolean
  readonly read: (body: unknown) => Read
  readonly frame: (frames: ReadonlyArray<unknown>) => Response
  /** The answer to a request the tape does not expect, as this wire says a request was bad. */
  readonly refuse: (message: string) => Response
}

const dialects: Readonly<Record<string, Dialect>> = { anthropic }

const shown = (value: unknown) => {
  const text = JSON.stringify(value) ?? "nothing"
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

export class ModelServer {
  readonly tape: Tape
  readonly #dialect: Dialect
  readonly #exchanges: ReadonlyMap<string, Exchange>
  readonly #bindings = new Bindings()
  readonly #used = new Set<string>()
  readonly #gates = new Map<string, PromiseWithResolvers<void>>()
  readonly #asked = new Map<string, PromiseWithResolvers<void>>()
  readonly #told = new Set<string>()
  readonly #server: ReturnType<typeof Bun.serve>
  /** What the server answered a request the tape did not expect. */
  readonly refused: Array<string> = []

  /** Plays the tape of `journey` on `harness`, `fixtures/tapes/<harness>/<journey>.ndjson`. */
  static play(journey: string, harness: string) {
    return new ModelServer(readTape(join(TAPES, harness, `${journey}.ndjson`)))
  }

  constructor(tape: Tape) {
    this.tape = tape
    const dialect = dialects[tape.header.dialect]
    if (!dialect) throw new Error(`${tape.path}: no dialect ${tape.header.dialect}`)
    this.#dialect = dialect
    this.#exchanges = new Map(tape.exchanges.map((each) => [exchangeKey(each.lane, each.turn), each]))
    // Listen on the address the harness dials: Bun.serve's default, every address, leaves 127.0.0.1:port free for
    // another process to bind.
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => this.#answer(request),
    })
  }

  get url() {
    return `http://127.0.0.1:${this.#server.port}`
  }

  /** Lets go the replies held at `gate`. */
  release(gate: string) {
    this.#gate(gate).resolve()
  }

  /** Settles once `lane` has asked for its reply at `turn`, and the tape expected the request. */
  asked(lane: string, turn: number) {
    return this.#signal(this.#asked, exchangeKey(lane, turn)).promise
  }

  /** The reasons this play failed: each refused request, then each exchange nobody asked for. */
  problems(): ReadonlyArray<string> {
    const problems = this.#problems()
    for (const problem of problems) this.#told.add(problem)
    return problems
  }

  /**
   * Stops serving, and fails with the problems nobody read through `problems()`. A test that checks them gets its own
   * failure, which a second one from here would hide: bun prints a SuppressedError without either message.
   */
  async [Symbol.asyncDispose]() {
    await this.#server.stop(true)
    const untold = this.#problems().filter((problem) => !this.#told.has(problem))
    if (untold.length > 0) throw new Error(untold.join("\n"))
  }

  #problems() {
    const unused = this.tape.exchanges
      .filter((each) => !this.#used.has(exchangeKey(each.lane, each.turn)))
      .map((each) => `tape ${this.tape.header.scenario}, lane ${each.lane}, turn ${each.turn}: never asked for`)
    return [...this.refused, ...unused]
  }

  #gate(name: string) {
    return this.#signal(this.#gates, name)
  }

  #signal(signals: Map<string, PromiseWithResolvers<void>>, name: string) {
    if (!signals.has(name)) signals.set(name, Promise.withResolvers<void>())
    return signals.get(name)!
  }

  async #answer(request: Request): Promise<Response> {
    const refuse = (why: string) => {
      const message = `tape ${this.tape.header.scenario}, ${why}`
      this.refused.push(message)
      return this.#dialect.refuse(message)
    }
    // Claude Code's `HEAD /api/hello` is answered 404 and goes on; a request with a body is one the tape must hold.
    if (!this.#dialect.route(request))
      return request.method === "POST"
        ? refuse(`no route ${new URL(request.url).pathname}`)
        : new Response("not on the tape", { status: 404 })
    const body = await request.json().catch(() => undefined)
    if (body === undefined) return refuse("a request whose body is not JSON")
    const read = this.#dialect.read(body)
    const lanes = this.tape.lanes.filter((lane) => read.opening.includes(lane.when))
    if (lanes.length !== 1)
      return refuse(
        `turn ${read.turn}: ${lanes.length === 0 ? "no lane" : `lanes ${lanes.map((lane) => lane.name).join(" and ")}`} for the opening ${shown(read.opening)}`,
      )
    const lane = lanes[0]!.name
    const exchange = this.#exchanges.get(exchangeKey(lane, read.turn))
    if (!exchange) return refuse(`lane ${lane}, turn ${read.turn}: no reply on the tape; got ${shown(read.newest)}`)
    this.#bindings.capture(this.tape.binds, read.results)
    let frames: ReadonlyArray<unknown>
    try {
      const differs = difference(read.newest, this.#bindings.fill(exchange.newest))
      if (differs)
        return refuse(
          `lane ${lane}, turn ${read.turn}: at ${differs.at} expected ${shown(differs.expected)}, got ${shown(differs.actual)}`,
        )
      frames = this.#bindings.fill(exchange.frames)
    } catch (error) {
      return refuse(`lane ${lane}, turn ${read.turn}: ${(error as Error).message}`)
    }
    this.#used.add(exchangeKey(lane, read.turn))
    this.#signal(this.#asked, exchangeKey(lane, read.turn)).resolve()
    if (exchange.gate !== undefined) await this.#gate(exchange.gate).promise
    return this.#dialect.frame(frames)
  }
}
