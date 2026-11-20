#!/usr/bin/env -S BUN_GC_TIMER_DISABLE=1 bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { LOCAL_TARGET } from "@sigma/protocol"
import { Client, clientLayer, REFUSAL_FILE, ServerFailed, serverAnswers, type StartOptions } from "./client.ts"
import { exec } from "./exec.ts"
import { claimHome, defaultHome, HOME_TAKEN_EXIT, type Home, type HomeTaken, replaceServer } from "./home.ts"
import { openAiOptions, type ProviderOptions, readScript } from "./providers.ts"
import { readHomeConfig } from "./config.ts"
import { login, logout } from "./login.ts"
import { protocolSchema } from "./schema.ts"
import { serve } from "./server.ts"
import { VERSION } from "./version.ts"

const IDLE_GRACE = "30 seconds"

const conversationFlag = Flag.String("conversation").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Open this conversation, starting it with this id if there is none"),
  Flag.optional,
)

const autoFlag = Flag.Boolean("auto").pipe(
  Flag.withDescription("Start the conversation without asking before calls that change things"),
  Flag.withDefault(false),
)

const providerFlag = Flag.String("provider").pipe(
  Flag.withDescription("Start the conversation with this provider, such as openai"),
  Flag.optional,
)

const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("Start the conversation with this model, instead of the default one"),
  Flag.optional,
)

const effortFlag = Flag.String("effort").pipe(
  Flag.withDescription("Start the conversation with this reasoning effort, such as low or high"),
  Flag.optional,
)

const instructionsFlag = Flag.String("instructions").pipe(
  Flag.withDescription("Start the conversation with these instructions for the model, beside its own"),
  Flag.optional,
)

const mcpServerFlag = Flag.String("mcp-server").pipe(
  Flag.withDescription(
    "Start the conversation with this MCP server, as <name>=<description>; a connected client registers its address. Repeat for each",
  ),
  Flag.atLeast(0),
)

const targetFlag = Flag.String("target").pipe(
  Flag.withDescription(
    "Start the conversation on this target, as the home's target_connector names it: its tools act on that computer",
  ),
  Flag.optional,
)

const cwdFlag = Flag.String("cwd").pipe(
  Flag.withDescription("Start the conversation in this folder, a path on its target; default the current folder"),
  Flag.optional,
)

const startFlags = {
  target: targetFlag,
  cwd: cwdFlag,
  auto: autoFlag,
  provider: providerFlag,
  model: modelFlag,
  effort: effortFlag,
  instructions: instructionsFlag,
  mcpServers: mcpServerFlag,
}

/** `--mcp-server <name>=<description>` as the server it names. */
const mcpServerOf = (value: string) => {
  const at = value.indexOf("=")
  return at === -1 ? { name: value, description: "" } : { name: value.slice(0, at), description: value.slice(at + 1) }
}

const startWith = (flags: {
  readonly target: Option.Option<string>
  readonly cwd: Option.Option<string>
  readonly auto: boolean
  readonly provider: Option.Option<string>
  readonly model: Option.Option<string>
  readonly effort: Option.Option<string>
  readonly instructions: Option.Option<string>
  readonly mcpServers: ReadonlyArray<string>
}): StartOptions => ({
  ...Option.match(flags.target, { onNone: () => ({}), onSome: (target) => ({ target }) }),
  // A local folder is the one the person means from here; a path on another computer is taken as given.
  ...Option.match(flags.cwd, {
    onNone: () => ({}),
    onSome: (cwd) => ({ cwd: Option.isNone(flags.target) || flags.target.value === LOCAL_TARGET ? resolve(cwd) : cwd }),
  }),
  ...(flags.auto ? { approvals: "auto" as const } : {}),
  ...Option.match(flags.provider, { onNone: () => ({}), onSome: (provider) => ({ provider }) }),
  ...Option.match(flags.model, { onNone: () => ({}), onSome: (model) => ({ model }) }),
  ...Option.match(flags.effort, { onNone: () => ({}), onSome: (effort) => ({ effort }) }),
  ...Option.match(flags.instructions, { onNone: () => ({}), onSome: (instructions) => ({ instructions }) }),
  ...(flags.mcpServers.length === 0 ? {} : { mcpServers: flags.mcpServers.map(mcpServerOf) }),
})

/** Why these flags cannot start a conversation, if they cannot: a folder here means nothing on another computer. */
const startRefusal = (flags: { readonly target: Option.Option<string>; readonly cwd: Option.Option<string> }) =>
  Option.isSome(flags.target) && flags.target.value !== LOCAL_TARGET && Option.isNone(flags.cwd)
    ? `--target ${flags.target.value} needs --cwd, the folder on that computer to work in`
    : undefined

const refuseFailedServer = <A, E, R>(effect: Effect.Effect<A, E | ServerFailed, R>) =>
  Effect.catchIf(
    effect,
    (error): error is ServerFailed => error instanceof ServerFailed,
    (error) => refuse(error.output),
  )

const withClient =
  (home: Home) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    refuseFailedServer(Effect.provide(effect, clientLayer(home)))

/** Uses the home's server, starting it when none runs. */
const withServer = <A, E, R>(home: Home, use: (client: Client["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* use(yield* Client)
  }).pipe(withClient(home), Effect.scoped)

const refuse = (reason: string, exitCode = 1) =>
  Effect.andThen(
    Console.error(reason),
    Effect.sync(() => {
      process.exitCode = exitCode
    }),
  )

const homeTaken = (home: Home) => refuse(`another server already serves ${home.dir}`, HOME_TAKEN_EXIT)

/**
 * Stops the home's server when one answers, and says whether one did; it starts none, since a server started now would
 * give way to this one.
 */
const stopRunningServer = (home: Home) =>
  Effect.flatMap(serverAnswers(home), (answers) =>
    answers
      ? Effect.as(Effect.ignore(withServer(home, (client) => client["server/stop"]())), true)
      : Effect.succeed(false),
  )

const serveCommand = Command.make(
  "serve",
  {
    restart: Flag.Boolean("restart").pipe(
      Flag.withDescription("Replace the running server once its runs settle"),
      Flag.withDefault(false),
    ),
    readOnly: Flag.Boolean("read-only").pipe(
      Flag.withDescription("Show the home's conversations and change nothing: no run resumes, and no input is taken"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ restart, readOnly }) {
    const home = defaultHome()
    // Read once and dropped, so nothing this server runs writes to it.
    const refusalFile = process.env[REFUSAL_FILE]
    delete process.env[REFUSAL_FILE]
    yield* serveHome(
      home,
      restart ? replaceServer(home, stopRunningServer(home)) : claimHome(home),
      readOnly,
      refusalFile,
    )
  }),
).pipe(Command.withDescription("Run this home's server in the foreground"))

/**
 * The home's providers as its `config.toml` and the environment name them: `SIGMA_MODEL_SCRIPT` adds `script` and
 * prefers it, `SIGMA_CLAUDE` names the `claude` every Claude provider without a `binary` runs, and `SIGMA_AGY` the
 * `agy` every agy provider without one runs.
 */
const providerOptions = (home: Home) =>
  Effect.gen(function* () {
    const config = yield* readHomeConfig(home.dir)
    const scriptPath = process.env.SIGMA_MODEL_SCRIPT
    return {
      ...(scriptPath === undefined ? {} : { script: yield* readScript(scriptPath || undefined) }),
      openai: openAiOptions(home),
      claude: process.env.SIGMA_CLAUDE ? { executable: process.env.SIGMA_CLAUDE } : {},
      agy: process.env.SIGMA_AGY ? { executable: process.env.SIGMA_AGY } : {},
      preferred: scriptPath === undefined ? "claude" : "script",
      config,
    } satisfies ProviderOptions
  })

// A stuck code-mode worker survives terminate() and keeps the process alive (F19), so the end of the server's lifetime
// ends the process.
const serveHome = <A, R>(
  home: Home,
  claimed: Effect.Effect<A, HomeTaken, R>,
  readOnly: boolean,
  refusalFile: string | undefined,
) =>
  Effect.gen(function* () {
    const served = yield* Effect.scoped(
      Effect.andThen(
        claimed,
        Effect.flatMap(providerOptions(home), (providers) =>
          serve(home, { idleGrace: IDLE_GRACE, providers, readOnly }),
        ),
      ),
    ).pipe(
      Effect.as(true),
      Effect.catchTag("HomeTaken", () => Effect.as(homeTaken(home), false)),
      Effect.catchTag("ConfigError", (error) => {
        const reason = `${error.path}: ${error.message}`
        if (refusalFile !== undefined) writeFileSync(refusalFile, reason)
        return Effect.as(refuse(reason), false)
      }),
    )
    if (served) process.exit(0)
  })

const execCommand = Command.make(
  "exec",
  {
    prompt: Argument.String("prompt"),
    conversation: conversationFlag,
    json: Flag.Boolean("json").pipe(
      Flag.withDescription(
        "Print the conversation's view as JSON lines instead of the answer: the view, then each commit's changes to it, until the run ends",
      ),
      Flag.withDefault(false),
    ),
    ...startFlags,
  },
  Effect.fn(function* ({ prompt, conversation, json, ...flags }) {
    const refusal = startRefusal(flags)
    if (refusal !== undefined) return yield* refuse(refusal)
    const home = defaultHome()
    const id = Option.getOrUndefined(conversation)
    const ok = yield* exec(prompt, id, startWith(flags), json).pipe(
      withClient(home),
      Effect.scoped,
      Effect.catchTags({
        UnknownProvider: (error) => refuse(error.message),
        UnknownEffort: (error) => refuse(error.message),
        InvalidConversationId: (error) => refuse(error.message),
        UnreadableImage: (error) => refuse(error.message),
        ReadOnlyServer: (error) => refuse(error.message),
        TargetUnavailable: (error) => refuse(error.message),
      }),
    )
    if (ok === false) process.exitCode = 1
  }),
).pipe(Command.withDescription("Send one prompt, print the answer, and exit"))

/** Reads the prompt `-` names from stdin, as attn passes a long one. */
const promptOf = (prompt: string) =>
  prompt === "-" ? Effect.promise(() => new Response(Bun.stdin.stream()).text()) : Effect.succeed(prompt)

const ephemeralCommand = Command.make(
  "ephemeral",
  {
    prompt: Argument.String("prompt").pipe(Argument.withDescription("The prompt, or - to read it from stdin")),
    system: Flag.String("system").pipe(
      Flag.withDescription("The whole system prompt, in place of the provider's own"),
      Flag.optional,
    ),
    schema: Flag.String("schema").pipe(
      Flag.withDescription("A JSON Schema, as JSON, the answer must match; the answer is then that JSON"),
      Flag.optional,
    ),
    maxTurns: Flag.Int("max-turns").pipe(
      Flag.withDescription("The most turns the provider may take; a ChatGPT answer is always one"),
      Flag.optional,
    ),
    provider: Flag.String("provider").pipe(
      Flag.withDescription("Answer with this provider, such as openai or claude"),
      Flag.optional,
    ),
    model: Flag.String("model").pipe(Flag.withDescription("Answer with this model"), Flag.optional),
    effort: Flag.String("effort").pipe(Flag.withDescription("Answer with this reasoning effort"), Flag.optional),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the answer as one JSON object: text, output, provider, model, turns and usage"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ prompt, system, schema, maxTurns, provider, model, effort, json }) {
    let parsed: unknown
    if (Option.isSome(schema)) {
      try {
        parsed = JSON.parse(schema.value)
      } catch {
        return yield* refuse("--schema is not JSON")
      }
    }
    if (Option.isSome(maxTurns) && maxTurns.value < 1) return yield* refuse("--max-turns takes 1 or more")
    const text = yield* promptOf(prompt)
    const given = <K extends string, V>(key: K, value: Option.Option<V>) =>
      Option.match(value, { onNone: () => ({}), onSome: (v) => ({ [key]: v }) as { [P in K]: V } })
    yield* withServer(defaultHome(), (client) =>
      client["ephemeral/run"]({
        prompt: text,
        ...given("system", system),
        ...(parsed === undefined ? {} : { schema: parsed }),
        ...given("maxTurns", maxTurns),
        ...given("provider", provider),
        ...given("model", model),
        ...given("effort", effort),
      }).pipe(
        Effect.flatMap((answer) =>
          Effect.sync(() => process.stdout.write(`${json ? JSON.stringify(answer) : answer.text.trimEnd()}\n`)),
        ),
        Effect.catchTags({
          UnknownProvider: (error) => refuse(error.message),
          UnknownEffort: (error) => refuse(error.message),
          EphemeralFailed: (error) => refuse(error.message),
          ReadOnlyServer: (error) => refuse(error.message),
        }),
      ),
    )
  }),
).pipe(Command.withDescription("Answer one prompt with no tools, and keep nothing: no conversation, no usage"))

const providerArgument = Argument.String("provider").pipe(
  Argument.withDescription("The provider, such as claude, openai or agy, or one config.toml names"),
)

const loginCommand = Command.make(
  "login",
  {
    provider: providerArgument,
    deviceCode: Flag.Boolean("device-code").pipe(
      Flag.withDescription("Sign in with a code entered on any device, instead of a browser on this one"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ provider, deviceCode }) {
    const ok = yield* withServer(defaultHome(), (client) => login(client, provider, deviceCode))
    if (!ok) process.exitCode = 1
  }),
).pipe(Command.withDescription("Sign in to a provider"))

const logoutCommand = Command.make(
  "logout",
  { provider: providerArgument },
  Effect.fn(function* ({ provider }) {
    const ok = yield* withServer(defaultHome(), (client) => logout(client, provider))
    if (!ok) process.exitCode = 1
  }),
).pipe(Command.withDescription("Sign out of a provider"))

const schemaCommand = Command.make(
  "schema",
  {},
  Effect.fn(function* () {
    yield* Console.log(JSON.stringify(protocolSchema(), null, 2))
  }),
).pipe(Command.withDescription("Print the protocol's JSON Schema"))

/**
 * Pipes stdio to a bridge socket: `agy` starts it as the MCP server of sigma's own tools, which the server serves on
 * that socket (D14). It ends when either side does.
 */
const mcpBridgeCommand = Command.make(
  "mcp-bridge",
  { socket: Argument.String("socket").pipe(Argument.withDescription("The bridge socket the server made")) },
  Effect.fn(function* ({ socket }) {
    yield* Effect.promise(async () => {
      const { promise: ended, resolve: end } = Promise.withResolvers<void>()
      const connection = await Bun.connect({
        unix: socket,
        socket: {
          data: (_socket, chunk) => void process.stdout.write(chunk),
          close: () => end(),
          error: () => end(),
        },
      })
      void (async () => {
        for await (const chunk of Bun.stdin.stream()) connection.write(chunk)
        connection.end()
        end()
      })()
      await ended
      // Reading stdin would keep the process alive after the server closed the socket.
      process.exit(0)
    })
  }),
).pipe(Command.withDescription("Serve sigma's tools to agy over stdio (started by agy, not by people)"))

const sigma = Command.make(
  "sigma",
  {
    prompt: Argument.String("prompt").pipe(
      Argument.withDescription("Send this prompt once it opens"),
      Argument.optional,
    ),
    conversation: conversationFlag,
    ...startFlags,
  },
  Effect.fn(function* ({ prompt, conversation, ...flags }) {
    const refusal = startRefusal(flags)
    if (refusal !== undefined) return yield* refuse(refusal)
    const home = defaultHome()
    const { tui } = yield* Effect.promise(async () => {
      await import("@opentui/solid/preload")
      return import("./tui/main.tsx")
    })
    yield* tui(Option.getOrUndefined(conversation), startWith(flags), Option.getOrUndefined(prompt)).pipe(
      withClient(home),
      Effect.scoped,
      Effect.catchTags({
        UnknownProvider: (error) => refuse(error.message),
        UnreadableImage: (error) => refuse(error.message),
        ReadOnlyServer: (error) => refuse(error.message),
        TargetUnavailable: (error) => refuse(error.message),
      }),
    )
  }),
).pipe(
  Command.withDescription("A durable coding agent that many clients share"),
  Command.withSubcommands([
    serveCommand,
    execCommand,
    ephemeralCommand,
    loginCommand,
    logoutCommand,
    schemaCommand,
    mcpBridgeCommand,
  ]),
)

sigma.pipe(
  Command.run({ version: VERSION }),
  Effect.provide(Layer.mergeAll(BunServices.layer)),
  BunRuntime.runMain({ disableErrorReporting: false }),
)
