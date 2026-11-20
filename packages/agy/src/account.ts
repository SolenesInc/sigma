// An `agy` instance's account: ready when `agy` answers `initialize` and opens a session, with the models and thinking
// levels that session lists (D16). Signing in is `agy`'s own: a person runs `agy` in a terminal; sigma does not sign in
// to Google.
import { type Health, type ModelInfo, nothingToSignIn, type ProviderAccount } from "@sigma/models"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Semaphore } from "effect"
import { INITIALIZE, type Json, SIGN_IN, signedOut, startAcp } from "./acp.ts"
import { type AgySettings, commandOf } from "./process.ts"

/**
 * How long a probe waits for `agy`. Measured on 1.5.13: `initialize` answers in 0.1 to 1.2 s and `session/new` in 1.3
 * to 2.2 s after it; a tripwire well past both.
 */
const PATIENCE_MS = 30_000

interface Probed {
  readonly health: Health
  readonly models: ReadonlyArray<ModelInfo>
}

/** The values and names of one of a session's `configOptions`. */
const optionsOf = (configOptions: ReadonlyArray<Json>, id: string) =>
  (configOptions.find((option) => option.id === id)?.options ?? []) as ReadonlyArray<{ value: string; name?: string }>

/** The models a new session lists, each with the thinking levels it lists (F20). */
const modelsOf = (session: Json): ReadonlyArray<ModelInfo> => {
  const configOptions = (session.configOptions ?? []) as ReadonlyArray<Json>
  const levels = optionsOf(configOptions, "thought_level").map((level) => level.value)
  return optionsOf(configOptions, "model").map((model) => ({
    id: model.value,
    name: model.name || model.value,
    efforts: levels,
  }))
}

const probe = (settings: AgySettings): Promise<Probed> => {
  const cwd = mkdtempSync(join(tmpdir(), "sigma-agy-probe-"))
  const acp = startAcp(commandOf(settings, cwd))
  const asked = (async (): Promise<Probed> => {
    const initialized = await acp.call("initialize", INITIALIZE)
    if (initialized.error) throw new Error(initialized.error.message)
    const version = initialized.result?.agentInfo?.version as string | undefined
    const known = version === undefined ? {} : { version }
    const made = await acp.call("session/new", { cwd, mcpServers: [] })
    if (signedOut(made)) {
      return { health: { status: "signed_out", message: `not signed in to agy: ${SIGN_IN}`, ...known }, models: [] }
    }
    if (made.error) throw new Error(made.error.message)
    void acp.call("session/close", { sessionId: made.result?.sessionId })
    return { health: { status: "ready", ...known }, models: modelsOf(made.result ?? {}) }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`agy did not answer within ${PATIENCE_MS / 1000} seconds`)), PATIENCE_MS)
  })
  return Promise.race([asked, late])
    .catch(
      (error): Probed => ({
        health: {
          status: "unavailable",
          message: `${error instanceof Error ? error.message : String(error)}; install agy or set its binary`,
        },
        models: [],
      }),
    )
    .finally(() => {
      clearTimeout(timer)
      acp.kill()
      rmSync(cwd, { recursive: true, force: true })
    })
}

/** The account of the `agy` `settings` start; the probe's answer is kept until a refresh. */
export const agyAccount = (settings: AgySettings): ProviderAccount => {
  const probing = Semaphore.makeUnsafe(1)
  let probed: Probed | undefined
  const probedNow = (refresh: boolean) =>
    probing.withPermits(1)(
      Effect.suspend(() =>
        probed && !refresh
          ? Effect.succeed(probed)
          : Effect.tap(
              Effect.promise(() => probe(settings)),
              (found) => Effect.sync(() => (probed = found)),
            ),
      ),
    )
  return {
    kind: "agy",
    health: (refresh) => Effect.map(probedNow(refresh), (found) => found.health),
    models: (refresh) => Effect.map(probedNow(refresh), (found) => found.models),
    ...nothingToSignIn,
  }
}
