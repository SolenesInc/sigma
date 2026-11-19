// Builds the `fixtures/claude` journeys a real Claude Code does not play on its own from recorded ones
// (`record-claude-fixtures.ts`). Run it after recording their sources:
//
//   bun packages/sigma/test/support/derive-claude-fixtures.ts
//
// subagent_working: `subagent` until its subagent's Read returns, then the process goes quiet, as if it never answered
// the interrupt, and the next spawn is `resume_after_kill`'s resumed one, told that the Agent call was cut off.
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

subagentWorking()
