// Where a conversation stands in its harness's own session (F7, F44): the provider and session, the newest entry the
// harness has been shown, and the position a resume continues from, written in the commit of each entry a run records.
// Sigma's transcript is the truth; a run resumes the harness's session at this position, which drops whatever the
// harness went on to write, and retells what came after it.
import { defineDoc } from "@sigma/kernel"

export type HostedSession = {
  /** The conversation that wrote it; a fork sees its parent's until its first run forks the session. */
  conversation: number
  /** The provider instance whose harness holds the session: another one starts its own. */
  provider: string
  /** The harness's session id. */
  session: string
  /** The newest entry the harness has been shown. */
  seen: number
  /** The harness's id of the newest message of the session this conversation committed, the point a resume continues from. */
  at: string
}

export const HOSTED_SESSION_KIND = "hosted.session"

/** Rewindable, so a fork finds the position as of its fork entry. */
export const HostedSessionDoc = defineDoc<{ current?: HostedSession }>({
  kind: HOSTED_SESSION_KIND,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
  checkpointWhen: () => true,
})
