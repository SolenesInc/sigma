// Builds the `fixtures/claude` journeys a real Claude Code does not play on its own from recorded ones
// (`record-claude-fixtures.ts`). Run it after recording their sources:
//
//   bun packages/sigma/test/support/derive-claude-fixtures.ts
//
// subagent_working: `subagent` until its subagent's Read returns, then the process goes quiet, as if it never answered
// the interrupt, and the next spawn is `resume_after_kill`'s resumed one, told that the Agent call was cut off.
//
// member_bash: `bash_allowed` as Claude Code plays it in member mode, where its own tools are off: its Bash call is a
// call of sigma's `bash` over sigma's MCP server, which Claude Code makes as an `mcp_message` once the call is allowed,
// and whose answer is the result it reads. member_restart is the same with a command that restarts the target's
// instance under the call.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const FIXTURES = join(import.meta.dir, "../../../../fixtures/claude")

type Line = { type: string; frame?: any; metadata?: Record<string, unknown>; provider?: string; scenario?: string }

const read = (name: string): Array<Line> =>
  readFileSync(join(FIXTURES, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))

const write = (name: string, lines: ReadonlyArray<Line>) =>
  writeFileSync(join(FIXTURES, `${name}.ndjson`), lines.map((line) => `${JSON.stringify(line)}\n`).join(""))

/** The recording's processes: each spawn's lines, its argv first. */
const spawns = (lines: ReadonlyArray<Line>) => {
  const out: Array<Array<Line>> = []
  for (const line of lines) {
    if (line.type === "transcript_start") continue
    if (line.type === "expect_outbound" && line.frame.argv) out.push([])
    out.at(-1)!.push(line)
  }
  return out
}

const header = (scenario: string, from: Line, derived: string): Line => ({
  metadata: { ...from.metadata, derived },
  provider: "claude",
  scenario,
  type: "transcript_start",
})

const subagentWorking = () => {
  const subagent = read("subagent")
  const [first] = spawns(subagent)
  const agentCall = first!
    .find(
      (line) =>
        line.type === "emit_inbound" &&
        line.frame.type === "assistant" &&
        line.frame.parent_tool_use_id == null &&
        line.frame.message.content.some((block: any) => block.type === "tool_use" && block.name === "Agent"),
    )!
    .frame.message.content.find((block: any) => block.name === "Agent").id as string
  const childResult = first!.findIndex(
    (line) =>
      line.type === "emit_inbound" &&
      line.frame.type === "user" &&
      line.frame.parent_tool_use_id === agentCall &&
      line.frame.message.content.some((block: any) => block.type === "tool_result"),
  )
  if (childResult < 0) throw new Error("subagent: no result of the subagent's call")

  const resumed = read("resume_after_kill")
  const second = spawns(resumed)[1]
  if (!second) throw new Error("resume_after_kill: no resumed spawn")
  const told = second.find((line) => line.type === "expect_outbound" && line.frame.type === "user")!.frame.message
    .content[0].text as string
  const cutOff = /^Your Bash call (\S+) was cut off/.exec(told)
  if (!cutOff) throw new Error(`resume_after_kill: its resumed spawn is told ${JSON.stringify(told)}`)
  const asAgent = JSON.parse(
    JSON.stringify(second).replaceAll(`Your Bash call ${cutOff[1]}`, `Your Agent call ${agentCall}`),
  )

  write("subagent_working", [
    header(
      "subagent_working",
      subagent[0]!,
      "subagent until its subagent's Read returns, then resume_after_kill's resumed spawn, told of the Agent call",
    ),
    ...first!.slice(0, childResult + 1),
    ...asAgent,
  ])
}

/** member_bash's command says where it ran and on which instance; member_restart's restarts the test target's. */
const memberBash = (name: string, command: string) => {
  const source = read("bash_allowed")
  const call = source
    .find(
      (line) =>
        line.type === "emit_inbound" &&
        line.frame.type === "assistant" &&
        line.frame.message.content.some((block: any) => block.type === "tool_use"),
    )!
    .frame.message.content.find((block: any) => block.type === "tool_use").id as string
  const asMember = (line: Line): Line => {
    const text = JSON.stringify(line)
      .replaceAll('"name":"Bash"', '"name":"mcp__sigma__bash"')
      .replaceAll('"tool_name":"Bash"', '"tool_name":"mcp__sigma__bash"')
      .replaceAll('"display_name":"Bash"', '"display_name":"bash"')
    const member = JSON.parse(text)
    // The call's input, wherever Claude Code repeats it, is the member command.
    const visit = (value: any) => {
      if (value === null || typeof value !== "object") return
      if (typeof value.command === "string" && value.command.includes("touch made.txt")) {
        for (const key of Object.keys(value)) delete value[key]
        value.command = command
      }
      for (const child of Object.values(value)) visit(child)
    }
    visit(member.frame)
    // Its process starts as member mode starts one: Claude Code's own tools, settings and other MCP servers off.
    if (member.frame.argv) {
      member.frame.argv = member.frame.argv.flatMap((arg: string) =>
        arg.startsWith("--setting-sources=")
          ? ["--setting-sources=", "--tools=ToolSearch", "--strict-mcp-config"]
          : [arg],
      )
    }
    return member
  }
  const lines = source.slice(1).map(asMember)
  const result = lines.findIndex(
    (line) =>
      line.type === "emit_inbound" &&
      line.frame.type === "user" &&
      Array.isArray(line.frame.message.content) &&
      line.frame.message.content.some((block: any) => block.type === "tool_result" && block.tool_use_id === call),
  )
  const answer = { content: [{ type: "text", text: "<the target's folder>" }], isError: false }
  lines[result]!.frame.message.content = [{ tool_use_id: call, type: "tool_result", content: answer.content }]
  // A fixed id, so deriving again writes the same fixture.
  const id = "6f1c0a52-3b7e-4d2a-9c41-0d5e8a7b2f13"
  const mcp = { jsonrpc: "2.0", id: 2 }
  lines.splice(
    result,
    0,
    {
      type: "emit_inbound",
      frame: {
        type: "control_request",
        request_id: id,
        request: {
          subtype: "mcp_message",
          server_name: "sigma",
          message: {
            method: "tools/call",
            params: {
              name: "bash",
              arguments: { command },
              _meta: { "claudecode/toolUseId": call, progressToken: 2 },
            },
            ...mcp,
          },
        },
      },
    },
    {
      type: "expect_outbound",
      frame: {
        type: "control_response",
        response: { subtype: "success", request_id: id, response: { mcp_response: { result: answer, ...mcp } } },
      },
    },
  )
  write(name, [
    header(name, source[0]!, `bash_allowed, its Bash call made over sigma's MCP server: ${command}`),
    ...lines,
  ])
}

subagentWorking()
memberBash("member_bash", 'echo "$SIGMA_TARGET_INSTANCE" > made; pwd')
memberBash("member_restart", "echo box-2 > ../instance; kill -9 $(cat ../pid)")
memberBash("member_sleep", "sleep 600")
