import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { AgySettings } from "@sigma/agy"
import { deadline } from "./raw.ts"

const FIXTURES = join(import.meta.dir, "../../../../fixtures/agy")
const EXECUTABLE = join(import.meta.dir, "fake-agy")

/**
 * The agy a test's server has unless the test brings its own: the fake `agy`, probing as signed in with its models. No
 * test reaches a real agy.
 */
export const defaultAgy = (home: string): AgySettings => ({
  executable: EXECUTABLE,
  env: { FAKE_AGY_FIXTURE: join(FIXTURES, "models.ndjson"), FAKE_AGY_DIR: join(home, "fake-agy") },
})

/** The fake `agy` playing one `fixtures/agy` journey, one recorded process per spawn, and what sigma sent it. */
export class FakeAgy {
  readonly dir = mkdtempSync("/tmp/sigma-agy-")
  readonly #waiters = new Set<() => void>()
  /** The fake pings this socket after each line it logs, and its connection closes when it exits. */
  readonly #pings = Bun.listen({
    unix: join(this.dir, "log.sock"),
    socket: { data: () => this.#wake(), close: () => this.#wake() },
  })

  /** `probe` is the journey each account probe plays. */
  constructor(
    readonly journey: string,
    readonly probe = "models",
  ) {}

  get options(): AgySettings {
    return {
      executable: EXECUTABLE,
      env: {
        FAKE_AGY_FIXTURE: join(FIXTURES, `${this.journey}.ndjson`),
        FAKE_AGY_PROBE: join(FIXTURES, `${this.probe}.ndjson`),
        FAKE_AGY_DIR: this.dir,
      },
    }
  }

  log(): Array<any> {
    try {
      return readFileSync(join(this.dir, "log.ndjson"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  /** What sigma sent the conversation's processes (not the account's probes), in order. */
  received(method?: string): Array<any> {
    return this.log()
      .filter((entry) => entry.received !== undefined && entry.probe === undefined)
      .map((entry) => ({ spawn: entry.spawn, ...entry.received }))
      .filter((frame) => method === undefined || frame.method === method)
  }

  /** What sigma's MCP server, its bridge, answered agy, in order. */
  mcpAnswers(): Array<any> {
    return this.log()
      .filter((entry) => entry.mcp !== undefined)
      .map((entry) => entry.mcp)
  }

  /** The texts of each prompt sigma sent, in order. */
  prompts(): Array<string> {
    return this.received("session/prompt").map((frame) =>
      frame.params.prompt.map((part: { text?: string }) => part.text ?? "").join(""),
    )
  }

  spawns() {
    return this.log().filter((entry) => entry.argv && entry.probe === undefined).length
  }

  #wake() {
    for (const waiter of this.#waiters) waiter()
  }

  logged(predicate: (fake: FakeAgy) => boolean, ms = 10_000) {
    let check = () => {}
    return deadline(
      new Promise<void>((resolve) => {
        check = () => predicate(this) && resolve()
        this.#waiters.add(check)
        check()
      }),
      ms,
      "fake agy log condition",
    ).finally(() => this.#waiters.delete(check))
  }

  [Symbol.dispose]() {
    this.#pings.stop(true)
    rmSync(this.dir, { recursive: true, force: true })
  }
}
