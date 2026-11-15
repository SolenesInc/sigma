// Agent limits (D13): how many subagents work at once in one tree of conversations. Sigma's own
// subagent tools and Claude Code's hosted subagents both check them, so they live here.
import { type ConversationId, defineDoc, type Tx } from "@sigma/kernel"
import { Effect } from "effect"

export type AgentLimits = {
  /** Subagents of one tree with a run in flight at once; 0 turns subagents off. */
  readonly maxThreads: number
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxThreads: 6 }

/** The canonical task path of the conversation people started. */
export const ROOT_TASK = "/root"

/** Why a subagent may not start, or an idle one take a task, while `working` subagents of its tree work, or `undefined`. */
export const refusedWork = (limits: AgentLimits, working: number): string | undefined =>
  working >= limits.maxThreads
    ? `at most ${limits.maxThreads} subagents work at once (max_threads); ${working} are working, so wait for one to finish`
    : undefined

/**
 * The call a subagent came from: the parent's call, the subagent's title, and, for one sigma's own tools started, its
 * canonical task path. Its parent is its owner's conversation. Written in the commit that creates it.
 */
export type SubagentOrigin = {
  readonly call: string
  readonly title: string
  readonly task?: string
  readonly agentType?: string
}

export const SubagentOriginDoc = defineDoc<SubagentOrigin>({
  kind: "sigma.subagent_origin",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork of a subagent is a conversation of its own, started by no call.
  fork: "initial",
  initial: () => ({ call: "", title: "" }),
  checkpointWhen: () => true,
})

/** Records where the subagent `child` came from, in the commit that creates it. */
export const recordOrigin = (tx: Tx, child: ConversationId, origin: SubagentOrigin) =>
  Effect.map(tx.doc(SubagentOriginDoc, child), (doc) => {
    Object.assign(doc, origin)
  })
