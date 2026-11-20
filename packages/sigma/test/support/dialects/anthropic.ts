// The `anthropic` dialect: Claude Code's model wire, a streamed `POST /v1/messages?beta=true` per turn. A reply's
// frames are the Messages API's stream events, each sent as the SSE event its `type` names.
import type { Dialect } from "../model-server.ts"

type Block = { type: string; text?: string; content?: unknown }
type Message = { role: string; content: string | ReadonlyArray<Block> }

const blocks = (message: Message): ReadonlyArray<Block> =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content

/** A block Claude Code adds to a user message for itself, not as the person's words. */
const reminder = (block: Block) => block.type === "text" && block.text!.startsWith("<system-reminder>")

const resultText = (block: Block): string =>
  typeof block.content === "string"
    ? block.content
    : Array.isArray(block.content)
      ? block.content.map((part: Block) => part.text ?? "").join("")
      : ""

export const anthropic: Dialect = {
  route: (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/v1/messages"),
  read: (body) => {
    // Claude Code 2.1.312 puts `role: "system"` entries inside `messages`: only user and assistant ones are the turns.
    const messages = (body as { messages: ReadonlyArray<Message> }).messages.filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    const users = messages.filter((message) => message.role === "user")
    const opening = users.flatMap(blocks).find((block) => block.type === "text" && !reminder(block))?.text ?? ""
    const newest = messages.at(-1)
    return {
      opening,
      turn: messages.filter((message) => message.role === "assistant").length + 1,
      newest: newest ? blocks(newest).filter((block) => !reminder(block)) : [],
      results: users.flatMap(blocks).flatMap((block) => (block.type === "tool_result" ? [resultText(block)] : [])),
    }
  },
  frame: (frames) =>
    new Response(
      frames.map((frame) => `event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ),
  refuse: (message) =>
    Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 }),
}
