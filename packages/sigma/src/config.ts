import type { ExecutionEnv } from "@sigma/env"
import { ModelSelection } from "@sigma/protocol"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, posix } from "node:path"
import { Effect, Schema } from "effect"

const Instance = Schema.Struct({
  driver: Schema.Literals(["claude", "openai"]),
  config_dir: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Instance = typeof Instance.Type

const AgentsConfig = Schema.Struct({
  max_threads: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})

const HomeConfig = Schema.Struct({
  default_model: Schema.optionalKey(ModelSelection),
  agents: Schema.optionalKey(AgentsConfig),
  providers: Schema.optionalKey(Schema.Record(Schema.String, Instance)),
  /** `false` keeps an idle Claude conversation from compacting before its prompt cache expires. */
  claude_idle_compaction: Schema.optionalKey(Schema.Boolean),
  /**
   * The command that opens a pipe to a target's current instance, set by whatever runs sigma: sigma runs
   * `<target_connector...> <target> -- sigma-env`, and talks to sigma-env over its stdin and stdout.
   */
  target_connector: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
})
export type HomeConfig = typeof HomeConfig.Type

const ProjectConfig = Schema.Struct({ default_model: Schema.optionalKey(ModelSelection) })

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const parseText = <S extends Schema.Top>(schema: S, path: string, text: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema as never)(Bun.TOML.parse(text)) as S["Type"],
    catch: (error) => new ConfigError({ path, message: error instanceof Error ? error.message : String(error) }),
  })

const parse = <S extends Schema.Top>(schema: S, path: string) =>
  Effect.flatMap(
    Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (error) => new ConfigError({ path, message: error instanceof Error ? error.message : String(error) }),
    }),
    (text) => parseText(schema, path, text),
  )

export const readHomeConfig = (dir: string): Effect.Effect<HomeConfig, ConfigError> => {
  const path = join(dir, "config.toml")
  return existsSync(path) ? parse(HomeConfig, path) : Effect.succeed({})
}

/**
 * The `default_model` of the nearest `.sigma/config.toml` at or above `cwd`, read through `env`, so a remote
 * conversation's comes from its target (D11). Every folder is asked at once; one that does not parse names none.
 */
export const projectDefaultModel = (env: ExecutionEnv, cwd: string): Effect.Effect<ModelSelection | undefined> => {
  const paths: Array<string> = []
  for (let dir = cwd; ; dir = posix.dirname(dir)) {
    paths.push(posix.join(dir, ".sigma", "config.toml"))
    if (posix.dirname(dir) === dir) break
  }
  return Effect.map(
    Effect.all(
      paths.map((path) => env.readTextFile(path).pipe(Effect.orElseSucceed(() => undefined))),
      { concurrency: "unbounded" },
    ),
    (texts) => {
      const at = texts.findIndex((text) => text !== undefined)
      if (at === -1) return undefined
      return Effect.runSync(
        parseText(ProjectConfig, paths[at]!, texts[at]!).pipe(
          Effect.map((config) => config.default_model),
          Effect.orElseSucceed(() => undefined),
        ),
      )
    },
  )
}

/** What a new conversation asks for; each part it leaves out comes from the defaults. */
export interface ModelAsk {
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
}

export interface ModelDefaults {
  /** The project's `default_model`, from `projectDefaultModel`. */
  readonly project?: ModelSelection
  /** The home's `default_model`. */
  readonly home?: ModelSelection
  /** The model chosen last in this home, by a start or a switch. */
  readonly last?: ModelSelection
  /** The provider when no default names one this home has. */
  readonly preferred: string
  readonly has: (provider: string) => boolean
}

/**
 * The model a new conversation starts with: the provider it names, else the first of the project's `default_model`,
 * the home's and the one chosen last whose provider this home has, else `preferred`. A model named without a
 * provider goes to that default's provider, and drops the default's effort unless one is named.
 */
export const chooseModel = (ask: ModelAsk, defaults: ModelDefaults): ModelSelection => {
  const given = {
    ...(ask.model === undefined ? {} : { model: ask.model }),
    ...(ask.effort === undefined ? {} : { effort: ask.effort }),
  }
  if (ask.provider !== undefined) return { provider: ask.provider, ...given }
  const fallback = [defaults.project, defaults.home, defaults.last].find(
    (candidate) => candidate !== undefined && defaults.has(candidate.provider),
  ) ?? { provider: defaults.preferred }
  if (ask.model === undefined) return { ...fallback, ...given }
  return { provider: fallback.provider, ...given }
}

export const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
