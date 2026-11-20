// The `script` provider: answers from a list of steps, the format of `SIGMA_MODEL_SCRIPT`. Each request takes the
// next unused step for its agent; with none left, it answers `You said: <the last user text>`. It streams word by
// word, with `delayMs` before each word, and a step with `hold` stops after its first word until a file exists at that
// path.
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { existsSync, watch } from "node:fs"
import { dirname } from "node:path"
import { nothingToSignIn, type OnceAnswer, type OnceRequest, ProviderError, type ProviderInstance } from "./kind.ts"
import type { Provider } from "./models.ts"
import { failure, replay } from "./replay.ts"
import { contentText } from "./text.ts"
import { normalizeContext } from "./transcript.ts"
import type { AssistantMessage, JsonObject, Model, TranscriptContext, Usage } from "./types.ts"
import { uuidv7 } from "./uuid.ts"

export const ScriptStep = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.Struct({ name: Schema.String, input: Schema.Unknown })),
  /** Several calls in one response, after `tool`'s. */
  tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, input: Schema.Unknown }))),
  fail: Schema.optionalKey(Schema.String),
  /** A pace for a person watching live text; a test orders by `hold` instead. */
  delayMs: Schema.optionalKey(Schema.Int),
  /**
   * An absolute path in a directory that exists: after its first word the answer waits until a file exists there,
   * however long that takes. A test makes the file when it is done with the live run, or never, when an interrupt or a
   * restart ends the run.
   */
  hold: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  /** The tokens the answer reports it used; none by default. `input` is the part not read from the prompt cache. */
  usage: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Int,
      output: Schema.Int,
      cacheRead: Schema.optionalKey(Schema.Int),
      cacheWrite: Schema.optionalKey(Schema.Int),
    }),
  ),
})
export type ScriptStep = typeof ScriptStep.Type

/** The agent a request is for when its `metadata.agent` names none: sigma's root conversation. */
export const ROOT_AGENT = "/root"

const ZERO: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

// A script has no context window or output limit; the largest safe integer keeps estimates from ever reaching one.
export const SCRIPT_MODEL: Model<"script"> = {
  id: "script",
  name: "Script",
  api: "script",
  provider: "script",
  baseUrl: "",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number.MAX_SAFE_INTEGER,
  maxTokens: Number.MAX_SAFE_INTEGER,
}

/** The script's model that takes only code mode, as ChatGPT's code-mode models do. */
export const SCRIPT_CODE_MODE_MODEL: Model<"script"> = {
  ...SCRIPT_MODEL,
  id: "script-code-mode",
  name: "Script in code mode",
  toolMode: "code_mode_only",
}

const SCRIPT_MODELS = [SCRIPT_MODEL, SCRIPT_CODE_MODE_MODEL]

const usageOf = (reported: NonNullable<ScriptStep["usage"]>): Usage => {
  const usage = { ...ZERO, ...reported }
  return { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite }
}

const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? []

/** Waits until a file exists at `path`, woken by the directory's changes. */
const fileAt = (path: string) =>
  Effect.callback<void>((resume) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return
      watcher.close()
      resume(Effect.void)
    })
    if (existsSync(path)) {
      watcher.close()
      resume(Effect.void)
    }
    return Effect.sync(() => watcher.close())
  })

const lastUserText = (context: TranscriptContext) => {
  const message = context.messages.findLast((candidate) => candidate.role === "user")
  return message?.role === "user" ? contentText(message.content) : ""
}

const answer = (step: ScriptStep, model: Model<string>): AssistantMessage => {
  const text = step.text ?? ""
  const base: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: step.usage === undefined ? ZERO : usageOf(step.usage),
    stopReason: "stop",
    timestamp: Date.now(),
  }
  if (step.fail !== undefined) {
    return { ...failure(base, step.fail), content: text === "" ? [] : [{ type: "text", text }] }
  }
  const calls = [...(step.tool === undefined ? [] : [step.tool]), ...(step.tools ?? [])]
  if (calls.length === 0) return { ...base, content: [{ type: "text", text }] }
  return {
    ...base,
    content: [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ...calls.map((call) => ({
        type: "toolCall" as const,
        id: `call_${uuidv7()}`,
        name: call.name,
        arguments: call.input as JsonObject,
      })),
    ],
    stopReason: "toolUse",
  }
}

/**
 * `agentOf` names the agent of a request whose `metadata.agent` names none, from its context; without it, or when it
 * names none, the request is the root's.
 */
export function scriptProvider(
  steps: readonly ScriptStep[],
  agentOf?: (context: TranscriptContext) => string | undefined,
): Provider {
  const taken = new Set<number>()
  const nextFor = (agent: string) => {
    const index = steps.findIndex((step, at) => !taken.has(at) && (step.agent ?? ROOT_AGENT) === agent)
    if (index < 0) return undefined
    taken.add(index)
    return steps[index]
  }
  return {
    id: "script",
    models: SCRIPT_MODELS,
    streamSimple: (model, context, options) =>
      Stream.suspend(() => {
        const agent = options.metadata?.agent
        const named = typeof agent === "string" ? agent : (agentOf?.(context) ?? ROOT_AGENT)
        const step = nextFor(named) ?? {
          text: `You said: ${lastUserText(context)}`,
          delayMs: 30,
        }
        if (step.hold !== undefined && words(step.text ?? "").length < 2) {
          return Stream.die(new Error(`a script step's hold needs a text of two words or more: ${step.hold}`))
        }
        const delay = step.delayMs ?? 0
        let sent = 0
        return replay(answer(step, model), {
          split: words,
          pause: () =>
            Effect.gen(function* () {
              if (step.hold !== undefined && sent++ === 1) yield* fileAt(step.hold)
              if (delay > 0) yield* Effect.sleep(Duration.millis(delay))
            }),
        })
      }),
  }
}

/** An ephemeral run on the script: the root's next step answers the prompt, in one turn. */
const scriptOnce =
  (stream: NonNullable<Provider["streamSimple"]>) =>
  (request: OnceRequest): Effect.Effect<OnceAnswer, ProviderError> =>
    Effect.gen(function* () {
      const model = SCRIPT_MODELS.find((each) => each.id === request.model) ?? SCRIPT_MODEL
      const context = normalizeContext({ messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] })
      const last = yield* Stream.runLast(stream(model, context, { metadata: { agent: ROOT_AGENT } }))
      const event = Option.getOrUndefined(last)
      const message = event?.type === "done" ? event.message : event?.type === "error" ? event.error : undefined
      if (message === undefined || message.stopReason === "error")
        return yield* new ProviderError({ message: message?.errorMessage ?? "the script ended without an answer" })
      return { text: contentText(message.content), model: model.id, turns: 1, usage: message.usage }
    })

/** The `script` provider as a home's instance: always ready, its two models, nothing to sign in to. */
export const scriptInstance = (
  steps: readonly ScriptStep[],
  agentOf?: (context: TranscriptContext) => string | undefined,
): ProviderInstance => {
  const provider = scriptProvider(steps, agentOf)
  return {
    id: "script",
    kind: "script",
    health: () => Effect.succeed({ status: "ready" }),
    models: () => Effect.succeed(SCRIPT_MODELS.map((model) => ({ id: model.id, name: model.name, efforts: [] }))),
    ...nothingToSignIn,
    provider,
    once: scriptOnce(provider.streamSimple!),
  }
}
