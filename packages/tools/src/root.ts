// The conversation people started, found from any conversation under it.
import type { ToolExecutionApi } from "@sigma/harness"
import type { ConversationId } from "@sigma/kernel"
import { Effect } from "effect"

/**
 * The conversation people started that `api`'s call runs under: its own, or, for a conversation a task owns (a
 * subagent), the root of its owner's conversation. A commit that only reads, so nothing is stored.
 */
export const rootConversation = (api: Pick<ToolExecutionApi, "conversationId" | "commit">) =>
  api.commit((tx) =>
    Effect.gen(function* () {
      let id: ConversationId = api.conversationId
      for (;;) {
        const owner = (yield* tx.conversation(id))?.owner
        if (owner === undefined) return id
        id = owner.conversationId
      }
    }),
  )
