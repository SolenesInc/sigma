// A server, in process or as the `sigma` binary, and a raw client's view of a conversation over the wire: the first
// view with every later change applied, as a client keeps it.
import { applyImmutable, type Op } from "@sigma/delta"
import type { ScriptStep } from "@sigma/models"
import {
  type EntryRecord,
  RUN_END_KIND,
  WITHDRAWN_KIND,
  USER_KIND,
  type RunEnd,
  type View,
  type ViewItem,
  type Window,
} from "@sigma/protocol"
import type { AgySettings } from "@sigma/agy"
import type { ClaudeProcessSettings } from "@sigma/claude"
import { REPORT_KIND } from "@sigma/hosted"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Clock, Console, type Duration, Effect, Exit, Layer, Logger, Scope } from "effect"
import type { HomeConfig } from "../../src/config.ts"
import { homeAt, type Home } from "../../src/home.ts"
import { openAiOptions, type OpenAiOptions, type ProviderOptions } from "../../src/providers.ts"
import { serverLayer } from "../../src/server.ts"
import { Lifetime } from "../../src/lifetime.ts"
import { defaultAgy } from "./agy.ts"
import { defaultClaude } from "./claude.ts"
import { DEADLINE, deadline, RawClient, type Reply } from "./raw.ts"
import { sigma, sigmaEnv } from "./terminal.ts"

export { homeAt }

// The real path: on macOS /tmp is a link, and a process's working directory is never reported through it.
export const tempHome = () => homeAt(realpathSync(mkdtempSync("/tmp/sigma-")))

/** What a server logs, kept beside the console it still prints to. */
export const logRecorder = () => {
  const logged: Array<{ readonly level: string; readonly message: unknown }> = []
  const recorder = Logger.make(({ logLevel, message }) => {
    logged.push({ level: logLevel, message })
  })
  return { logged, recorder: Logger.layer([recorder], { mergeWithExisting: true }) }
}

/**
 * What an in-process server prints to stderr, kept beside the stderr it still prints to, as a test watching the
 * `sigma serve` process reads it: `printed` resolves once a line includes `text`.
 */
export const stderrRecorder = () => {
  const lines: Array<string> = []
  const waiters = new Set<() => void>()
  const recording: Console.Console = Object.assign(Object.create(console), {
    error: (...args: ReadonlyArray<unknown>) => {
      console.error(...args)
      lines.push(args.map(String).join(" "))
      for (const waiter of waiters) waiter()
    },
  })
  const printed = (text: string) =>
    deadline(
      new Promise<void>((resolve) => {
        const check = () => {
          if (!lines.some((line) => line.includes(text))) return
          waiters.delete(check)
          resolve()
        }
        waiters.add(check)
        check()
      }),
      DEADLINE,
      `the server printed ${JSON.stringify(text)}`,
    )
  return { printed, layer: Layer.succeed(Console.Console, recording) }
}

export interface ServerOptions {
  readonly home?: Home
  readonly openai?: (home: Home) => (id: string) => OpenAiOptions
  readonly claude?: ClaudeProcessSettings
  readonly agy?: AgySettings
  readonly config?: HomeConfig
  /** How long a Claude Code process stays live after its run; 0 closes it when the run ends. */
  readonly claudeIdle?: Duration.Input
  readonly claudeStop?: Duration.Input
  /** The clock the live Claude Code processes and `wait_worker` keep time by, which the test advances. */
  readonly clock?: Clock.Clock
  /** Seconds `bash` lets a command run when its call gives no `timeout`. */
  readonly bashTimeout?: number
}

/** The providers a test's server has: `script` playing `script` and preferred, then those `options` configure. */
const testProviders = (
  home: Home,
  script: ReadonlyArray<ScriptStep>,
  options: ServerOptions = {},
): ProviderOptions => ({
  script,
  openai: (options.openai ?? openAiOptions)(home),
  claude: options.claude ?? defaultClaude(home.dir),
  agy: options.agy ?? defaultAgy(home.dir),
  preferred: "script",
  config: options.config ?? {},
})

export const runningServer = async (
  script: ReadonlyArray<ScriptStep> = [],
  options: ServerOptions & { readonly connectionQueue?: number; readonly readOnly?: boolean } = {},
) => {
  const home = options.home ?? tempHome()
  const scope = Effect.runSync(Scope.make())
  const { logged, recorder } = logRecorder()
  const stderr = stderrRecorder()
  await Effect.runPromise(
    Layer.buildWithScope(
      serverLayer(home, {
        idleGrace: "1 hour",
        providers: testProviders(home, script, options),
        ...(options.connectionQueue === undefined ? {} : { connectionQueue: options.connectionQueue }),
        ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
        ...(options.claudeIdle === undefined ? {} : { claudeIdle: options.claudeIdle }),
        ...(options.claudeStop === undefined ? {} : { claudeStop: options.claudeStop }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.bashTimeout === undefined ? {} : { bashTimeout: options.bashTimeout }),
      }).pipe(Layer.provide(recorder), Layer.provide(stderr.layer)),
      scope,
    ),
  )
  const stop = () => Effect.runPromise(Scope.close(scope, Exit.void))
  return {
    home,
    logged,
    printed: stderr.printed,
    stop,
    [Symbol.asyncDispose]: async () => {
      await stop()
      if (!options.home) rmSync(home.dir, { recursive: true, force: true })
    },
  }
}

/** A server serving `home` until its lifetime ends; `exited` resolves when it has. */
export const servingUntilIdle = async (
  home: Home,
  idleGrace: Duration.Input,
  script: ReadonlyArray<ScriptStep> = [],
  options: ServerOptions & { readonly idleClock?: Clock.Clock } = {},
) => {
  const listening = Promise.withResolvers<void>()
  const stderr = stderrRecorder()
  const exited = Effect.runPromise(
    Effect.gen(function* () {
      const lifetime = yield* Lifetime
      listening.resolve()
      yield* options.idleClock === undefined
        ? lifetime.ended
        : Effect.provideService(lifetime.ended, Clock.Clock, options.idleClock)
    }).pipe(
      Effect.provide(
        serverLayer(home, {
          idleGrace,
          providers: testProviders(home, script, options),
          ...(options.claudeIdle === undefined ? {} : { claudeIdle: options.claudeIdle }),
          ...(options.claudeStop === undefined ? {} : { claudeStop: options.claudeStop }),
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        }).pipe(Layer.provide(stderr.layer)),
      ),
      Effect.scoped,
    ),
  )
  await Promise.race([listening.promise, exited])
  return { exited, printed: stderr.printed }
}

/**
 * A clock for the server's idle wait under which no grace passes until the test calls `pass`, and every grace passes
 * at once after it: the test, not the machine's speed, decides when the server would go idle.
 */
export const idleGrace = () => {
  const passed = Promise.withResolvers<void>()
  const clock: Clock.Clock = new Proxy(Clock.Clock.defaultValue(), {
    get: (target, key) => {
      if (key === "sleep") return () => Effect.promise(() => passed.promise)
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { clock, pass: () => passed.resolve() }
}

/**
 * A file a script step's `hold` waits on: the step's answer stops after its first word until `release` makes the file,
 * so a run stays live for as long as the test needs it, however slow the machine. `using` removes it.
 */
export const hold = () => {
  const dir = mkdtempSync("/tmp/sigma-hold-")
  const path = join(dir, "go")
  return {
    path,
    release: () => writeFileSync(path, ""),
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * Answers once from a server still serving `home`: a server that took a passed idle grace for idle has begun to stop
 * before this round trip ends.
 */
export const stillServing = async (home: Home) => {
  const client = await RawClient.connect(home.socket)
  const reply = await client.call("conversation/list")
  client.close()
  if (reply.error !== undefined) throw new Error(`the server stopped serving: ${JSON.stringify(reply.error)}`)
}

/** Reads `stream` until what it printed includes `text`; returns all it printed. */
export const untilPrinted = async (stream: ReadableStream<Uint8Array>, text: string, what: string) => {
  const reader = stream.getReader()
  let printed = ""
  const read = async () => {
    while (!printed.includes(text)) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`${what}: the stream ended first: ${JSON.stringify(printed)}`)
      printed += new TextDecoder().decode(value)
    }
  }
  try {
    await deadline(read(), DEADLINE, what)
  } finally {
    reader.releaseLock()
  }
  return printed
}

/** The environment of a `sigma` binary answering from `script`. */
export const scriptEnv = async (home: Home, script: ReadonlyArray<ScriptStep> = []) => {
  const path = `${home.dir}/script.json`
  await Bun.write(path, JSON.stringify(script))
  return sigmaEnv(home, { SIGMA_MODEL_SCRIPT: path })
}

/** `sigma serve`, or the command `args` name, run in `cwd`, once it listens. */
export const serving = async (env: Record<string, string | undefined>, cwd?: string, args = ["serve"]) => {
  const server = sigma(args, env, cwd)
  const log = server.stderr.getReader()
  let printed = ""
  const listening = async () => {
    while (!printed.includes("serving")) {
      const { value, done } = await log.read()
      if (done) throw new Error(`server exited: ${printed}`)
      printed += new TextDecoder().decode(value)
    }
  }
  // A tripwire for a server that never listens: a start, `--restart` included, took 0.3 s idle, 0.9 s at load ~50
  // and 2.4 s at load ~69 on 10 cores.
  await deadline(listening(), 20_000, "server listening").catch((error) => {
    throw new Error(`${error.message}; sigma ${args.join(" ")} printed: ${JSON.stringify(printed)}`)
  })
  log.releaseLock()
  return server
}

export interface ViewWatch {
  readonly id: number
  readonly items: ReadonlyArray<ViewItem>
  readonly ended: Promise<Reply>
  /** The view as the client holds it: the first view with every change since applied. */
  readonly view: () => View
  /** Every entry the view has held, by id: a window lets old entries go, a client keeps what it saw. */
  readonly seen: () => ReadonlyArray<EntryRecord>
  readonly until: (predicate: (watch: ViewWatch) => boolean, ms?: number) => Promise<void>
}

export const watchView = (client: RawClient, conversation: string, window?: Window): ViewWatch => {
  const watch = client.watch<ViewItem>("conversation/watch", { conversation, ...(window ? { window } : {}) })
  let view: View | undefined
  let applied = 0
  const seen = new Map<number, EntryRecord>()
  const current = () => {
    for (; applied < watch.items.length; applied++) {
      const item = watch.items[applied]!
      view = item._tag === "view" ? item.view : applyImmutable(view, item.ops as ReadonlyArray<Op>)
      for (const entry of view!.entries) seen.set(entry.id, entry)
    }
    return view
  }
  const self: ViewWatch = {
    id: watch.id,
    items: watch.items,
    ended: watch.ended,
    view: () =>
      current() ??
      (() => {
        throw new Error("no view yet")
      })(),
    seen: () => {
      current()
      return [...seen.values()].sort((a, b) => a.id - b.id)
    },
    until: (predicate, ms) => watch.until(() => current() !== undefined && predicate(self), ms),
  }
  return self
}

export const runEnds = (entries: ReadonlyArray<EntryRecord>): ReadonlyArray<RunEnd> =>
  entries.filter((entry) => entry.kind === RUN_END_KIND).map((entry) => entry.data as RunEnd)

/** Until `count` runs have ended and the conversation has no run in flight. */
export const settled = (count: number) => (watch: ViewWatch) =>
  runEnds(watch.seen()).length >= count &&
  (watch.view().docs["pi.live"] as { run?: unknown } | undefined)?.run === undefined

/** What the entries say, in order: the user's text, the model's text, Claude Code's job reports, and how each run ended. */
export const transcript = (entries: ReadonlyArray<EntryRecord>) =>
  entries.flatMap((entry): Array<string> => {
    const message = entry.model?.[0] as { content?: unknown; stopReason?: string } | undefined
    const text = (content: unknown) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
          : ""
    if (entry.kind === "pi.user" || entry.kind === USER_KIND) return [`user: ${text(message?.content)}`]
    if (entry.kind === "pi.assistant") {
      const cut = message?.stopReason === "stop" || message?.stopReason === "toolUse" ? "" : ` [${message?.stopReason}]`
      return [`assistant: ${text(message?.content)}${cut}`]
    }
    if (entry.kind === RUN_END_KIND) {
      const end = entry.data as RunEnd
      return [`run_end: ${end.outcome}${end.message ? ` (${end.message})` : ""}`]
    }
    if (entry.kind === WITHDRAWN_KIND) return [`withdrawn: ${(entry.data as { requestId: string }).requestId}`]
    if (entry.kind === REPORT_KIND) return [`report: ${text(message?.content)}`]
    return []
  })

/** A person as a client names them to sigma. */
export const person = (name: string) => ({ id: `person:${name}`, name })

export const start = async (client: RawClient, cwd = "/work") =>
  (await client.call("conversation/start", { cwd, author: person("ada") })).result.conversation as string

export const submit = (
  client: RawClient,
  conversation: string,
  text: string,
  requestId: string = crypto.randomUUID(),
  author = person("ada"),
  steer = false,
) => client.call("conversation/submit", { conversation, requestId, author, text, ...(steer ? { steer } : {}) })
