// The ephemeral run (`ephemeral/run`): one prompt answered by a provider with no tools, outside any conversation. It
// commits nothing, so the home keeps no trace of it: no conversation, no entry, no usage. The answer and what it spent
// go only to the caller. A schema's answer is checked here, the same way for every provider.
import { compile } from "@sigma/schema"
import { EphemeralFailed, type RunEphemeral } from "@sigma/protocol"
import { Effect } from "effect"
import { agentModel, type Providers } from "./providers.ts"

type Payload = (typeof RunEphemeral)["payloadSchema"]["Type"]

/** The schema compiled, or why it is not one. */
const checkerOf = (schema: unknown) =>
  Effect.try({
    try: () => compile(schema as never),
    catch: (error) => new EphemeralFailed({ message: `the schema is not a JSON Schema: ${String(error)}` }),
  })

export const runEphemeral = (providers: Providers["Service"], payload: Payload) =>
  Effect.gen(function* () {
    const { selection, instance } = yield* providers.choose(
      undefined,
      {
        ...(payload.provider === undefined ? {} : { provider: payload.provider }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
        ...(payload.effort === undefined ? {} : { effort: payload.effort }),
      },
      undefined,
    )
    const { model, thinkingLevel } = yield* agentModel(selection, instance)
    if (instance.once === undefined)
      return yield* new EphemeralFailed({ message: `${selection.provider} cannot answer an ephemeral run` })
    const checker = payload.schema === undefined ? undefined : yield* checkerOf(payload.schema)
    const answer = yield* instance
      .once({
        prompt: payload.prompt,
        ...(payload.system === undefined ? {} : { system: payload.system }),
        ...(payload.schema === undefined ? {} : { schema: payload.schema as Record<string, unknown> }),
        // An empty id is the provider's own choice.
        ...(model.modelId === "" ? {} : { model: model.modelId }),
        ...(thinkingLevel === undefined ? {} : { effort: thinkingLevel }),
        ...(payload.maxTurns === undefined ? {} : { maxTurns: payload.maxTurns }),
      })
      .pipe(Effect.mapError((error) => new EphemeralFailed({ message: error.message })))
    let value = answer.output
    if (checker !== undefined && value === undefined) {
      try {
        value = JSON.parse(answer.text)
      } catch {
        return yield* new EphemeralFailed({ message: `the answer is not JSON: ${answer.text}` })
      }
    }
    if (checker !== undefined) {
      const checked = checker.validate(value)
      if (!checked.ok) {
        const [first] = checked.errors
        const where = first === undefined ? "" : ` (${first.path || "/"}: ${first.message})`
        return yield* new EphemeralFailed({
          message: `the answer does not match the schema${where}: ${JSON.stringify(value)}`,
        })
      }
    }
    const { cost, input, output, cacheRead, cacheWrite, totalTokens } = answer.usage
    return {
      text: answer.text,
      ...(checker === undefined ? {} : { output: value }),
      provider: selection.provider,
      model: answer.model,
      turns: answer.turns,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost: {
          input: cost.input,
          output: cost.output,
          cacheRead: cost.cacheRead,
          cacheWrite: cost.cacheWrite,
          total: cost.total,
        },
      },
    }
  })
