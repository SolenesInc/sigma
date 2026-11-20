// The computers a home's conversations act on. A conversation's target is fixed at start; `local` is the server's own
// machine, and any other is reached through the connector whatever runs sigma sets as `target_connector` in
// `config.toml` (D1): sigma runs `<target_connector...> <target> -- sigma-env` and speaks the env protocol to sigma-env
// on the target's current instance. Each target has one channel, shared by its conversations (`@sigma/env/remote`).
import { createHash } from "node:crypto"
import { hostname } from "node:os"
import { join } from "node:path"
import type { ExecutionEnv } from "@sigma/env"
import type { AgentHello } from "@sigma/env/protocol"
import { type Channel, spawnChannel, TargetPool, type TargetUnreachable } from "@sigma/env/remote"
import { defineExtension, type Harness } from "@sigma/harness"
import { type ConversationId, defineDoc, type Tx } from "@sigma/kernel"
import { LOCAL_TARGET, TARGET_CHANGED_KIND } from "@sigma/protocol"
import { Effect } from "effect"
import type { Home } from "./home.ts"

/** The command sigma asks the connector to run on the target. */
export const SIGMA_ENV = ["sigma-env"] as const

/** Whether `target` names the server's own machine: absent, or `local`. */
export const isLocal = (target: string | undefined): target is undefined | typeof LOCAL_TARGET =>
  target === undefined || target === LOCAL_TARGET

/**
 * Whose commands this home's sigma-env agents run: a hash of the home's hostname and directory, so two homes sharing a
 * target do not kill each other's commands at the sweep (D7).
 */
export const ownerOf = (home: Home) =>
  createHash("sha256").update(`${hostname()}\n${home.dir}`).digest("hex").slice(0, 16)

/** A channel that is gone before it opens, for a home with no connector. */
const refused = (reason: string): Channel => ({
  send: () => {},
  end: () => {},
  kill: () => {},
  onLine: () => {},
  onClose: (listener) => listener(reason),
})

/** The home's targets: `connector` from `config.toml`, absent when whatever runs sigma set none. */
export const openTargets = (home: Home, connector: ReadonlyArray<string> | undefined) =>
  new TargetPool({
    owner: ownerOf(home),
    connect: (target) =>
      connector === undefined
        ? refused(
            `this home has no target_connector in ${join(home.dir, "config.toml")}; whatever runs sigma sets it to the command that reaches a target`,
          )
        : spawnChannel([...connector, target, "--", ...SIGMA_ENV]),
  })

/** The instance and files a conversation's target had when sigma last reached it (D6). */
export type TargetPair = { readonly instance: string; readonly files: string }

/** The conversation's last pair, and the change the model was last told of. */
export const TargetDoc = defineDoc<{
  last?: TargetPair
  changed?: { readonly to: TargetPair; readonly filesKept: boolean }
}>({
  kind: "sigma.target",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  // A fork knows the instance its parent knew at the fork point, so a change since is announced to it too.
  fork: "asOf",
  initial: () => ({}),
  checkpointWhen: () => true,
})

const pairOf = (hello: AgentHello): TargetPair => ({ instance: hello.instance, files: hello.files })

/**
 * Records the pair `hello` names for the conversation, in `tx`. The first pair is only recorded; a different one later
 * also appends `sigma.target_changed`. The same pair again changes nothing.
 */
export const recordTarget = (tx: Tx, conversation: ConversationId, target: string, hello: AgentHello) =>
  Effect.gen(function* () {
    const doc = yield* tx.doc(TargetDoc, conversation)
    const to = pairOf(hello)
    const from = doc.last
    if (from?.instance === to.instance && from.files === to.files) return
    doc.last = to
    if (from === undefined) return
    const filesKept = from.files === to.files
    doc.changed = { to, filesKept }
    yield* tx.appendEntry(conversation, { kind: TARGET_CHANGED_KIND, data: { target, from, to, filesKept } })
  })

/** What the model reads of the last change behind its target (D6). */
const changeText = ({ to, filesKept }: { readonly to: TargetPair; readonly filesKept: boolean }) =>
  filesKept
    ? `The computer behind this conversation restarted (now instance ${to.instance}). Your files are as you left them; processes you started are gone.`
    : `The computer behind this conversation was replaced (now instance ${to.instance}). Files, processes and changes from before are gone.`

/**
 * Before each request of a remote conversation, reaches its target and records the instance behind it. A changed one
 * is committed as `sigma.target_changed` for clients, and the model is told of it in this section, before the request.
 * A target it cannot reach keeps what the model was told; the tool calls say what is gone (D5).
 */
export const targetSection = (targets: TargetPool, harness: () => Harness) =>
  defineExtension({
    name: "sigma-target",
    sections: [
      {
        key: "target",
        tag: false,
        render: ({ conversationId, agent, shown }) =>
          Effect.gen(function* () {
            const target = agent.target
            if (isLocal(target)) return undefined
            const hello = yield* targets.connect(target)
            const conversation = yield* harness().conversation(conversationId)
            if (conversation === undefined) return shown.target
            yield* conversation.commit((tx) => recordTarget(tx, conversationId, target, hello))
            const doc = yield* harness().session.snapshot(TargetDoc, conversationId)
            return doc?.changed === undefined ? undefined : changeText(doc.changed)
          }).pipe(Effect.catch(() => Effect.succeed(shown.target))),
      },
    ],
  })

/** The environment of a conversation with this agent state, on its target. */
export const envOn = (
  targets: TargetPool,
  local: (cwd: string) => ExecutionEnv,
  home: Home,
  agent: { readonly cwd?: string; readonly target?: string },
): ExecutionEnv => (isLocal(agent.target) ? local(agent.cwd ?? home.dir) : targets.env(agent.target, agent.cwd ?? "/"))

export type { TargetUnreachable }
