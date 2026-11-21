// Live: a journey played on the real Claude Code, the one `bun install` brings, whose model is the model server playing
// the journey's tape. No account is reached (harness-env.ts). The run fails when Claude Code asked something the tape
// did not expect, or left an exchange of the tape unasked.
import { TEST_TIMEOUT } from "./support/raw.ts"
import { expect, setDefaultTimeout, test } from "bun:test"
import { claudePlayEnv } from "./support/harness-env.ts"
import { journeys, openSession, STOPPED_AT_END_PROMPT } from "./support/journeys.ts"
import { ModelServer } from "./support/model-server.ts"
import { runEnds, transcript, type ViewWatch } from "./support/server.ts"

setDefaultTimeout(TEST_TIMEOUT)

const jobs = (watch: ViewWatch) => (watch.view().docs["hosted.jobs"] as { jobs?: object } | undefined)?.jobs ?? {}

test("claude-subagent-command, subagent-claude: the real Claude Code ends a foreground subagent's background command with the subagent, so neither conversation has a job", async () => {
  const journey = journeys.subagent_command_stopped_at_end!
  await using model = ModelServer.play("subagent_command_stopped_at_end", "claude")
  using play = claudePlayEnv(model.url)
  await using session = await openSession(journey, { env: play.env }, model)
  await journey.play(session)
  const subagent = await session.subagent()
  await subagent.until((watch) => runEnds(watch.seen()).length > 0)
  // First, so a request the tape did not expect is the failure shown, with its lane, turn and content.
  expect(model.problems()).toEqual([])

  expect(transcript(session.seen())).toEqual([
    `user: ${STOPPED_AT_END_PROMPT}`,
    "assistant: ",
    "assistant: started",
    "run_end: answered",
  ])
  expect(transcript(subagent.seen()).slice(-2)).toEqual(["assistant: started", "run_end: answered"])
  expect(jobs(session.view)).toEqual({})
  expect(jobs(subagent)).toEqual({})
  // A tripwire: the file ran in 8 to 12 s alone, ten runs in a row, and the journey in 7 s after the wire tests.
})
