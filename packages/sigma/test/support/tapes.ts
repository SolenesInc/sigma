// The tapes command. `generate` plays each journey's tape to the real Claude Code through the recorder, with no account
// (harness-env.ts), and writes the process fixture `fake-claude` replays.
//
//   bun packages/sigma/test/support/tapes.ts generate <journey...>
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { claudePlayEnv } from "./harness-env.ts"
import { journeys, MODEL, openSession } from "./journeys.ts"
import { ModelServer } from "./model-server.ts"

const FIXTURES = join(import.meta.dir, "../../../../fixtures/claude")
const RECORDER = join(import.meta.dir, "record-claude")
const FAKE = join(import.meta.dir, "fake-claude")

/**
 * The Claude executable a generating server runs: a probe goes to the fake `claude`, answering signed in with its
 * models as in the provider tests, and each conversation's process is the real Claude Code through the recorder.
 */
const executable = (dir: string) => {
  const path = join(dir, "claude")
  writeFileSync(
    path,
    `#!/bin/sh
case " $* " in *" --no-session-persistence "*)
  FAKE_CLAUDE_FIXTURE='${join(FIXTURES, "models.ndjson")}' FAKE_CLAUDE_DIR='${join(dir, "probes")}' exec '${FAKE}' "$@";;
esac
exec '${RECORDER}' "$@"
`,
  )
  chmodSync(path, 0o755)
  return path
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
/** Fields that say when, or how long: they change on every run. */
const TIMING = /(_ms|Ms|_time|^timestamp)$/

/**
 * `text` with every value that changes from run to run made the same on every run: the ids Claude Code chose become
 * ids of the same shape numbered in the order they appear, timings become 0, timestamps one instant, and the paths of
 * the run's own folders fixed ones. So a second generate writes the same bytes.
 */
const steady = (text: string, folders: { readonly workspace: string; readonly config: string }) => {
  const renamed = new Map<string, string>()
  const rename = (id: string, make: (n: number) => string) => {
    if (!renamed.has(id)) renamed.set(id, make(renamed.size + 1))
    return renamed.get(id)!
  }
  const hex = (n: number, width: number) => n.toString(16).padStart(width, "0")
  for (const [, id] of text.matchAll(/"(?:task_id|agent_id)":"([a-z0-9]+)"/g))
    rename(id!, (n) => `${id![0]}${hex(n, id!.length - 1)}`)
  for (const [, id] of text.matchAll(/"run_id":"([a-z0-9-]+)"/g)) rename(id!, (n) => `run-${hex(n, 8)}`)
  let out = text.replace(UUID, (id) => rename(id, (n) => `00000000-0000-4000-8000-${hex(n, 12)}`))
  for (const [id, steadyId] of renamed) out = out.split(id).join(steadyId)
  out = out
    .split(folders.config)
    .join("/tmp/sigma-tape-claude")
    .split(folders.workspace.replace(/[^a-zA-Z0-9]/g, "-"))
    .join("-workspace")
    .replace(/\/tmp\/claude-\d+\//g, "/tmp/claude-person/")
    .replace(/\/run\/user\/\d+\/cc-socks\/\d+\.sock/g, "/run/user/person/cc-socks/claude.sock")
    .replace(/(duration_ms|totalDurationMs): \d+/g, "$1: 0")
  const zeroed = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(zeroed)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              TIMING.test(key) && typeof item === "number"
                ? 0
                : TIMING.test(key) && typeof item === "string"
                  ? "2026-01-01T00:00:00.000Z"
                  : zeroed(item),
            ]),
          )
        : value
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `${JSON.stringify(zeroed(JSON.parse(line)))}\n`)
    .join("")
}

/** The recording as a process fixture: a header naming the tape, then each spawn's lines as one segment. */
const processFixture = (journey: string, recording: string, tape: ModelServer["tape"]) => {
  const lines = readFileSync(recording, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
  const version = lines.find((line) => line.frame?.subtype === "init")?.frame.claude_code_version
  const segments = new Map<number, Array<Record<string, unknown>>>()
  const states = new Map<number, string>()
  for (const { process: pid, ...line } of lines) {
    if (!segments.has(pid)) segments.set(pid, [])
    const segment = segments.get(pid)!
    // A state report that repeats the state Claude Code last reported says nothing, and whether Claude Code sends one
    // races its own background work: a background subagent's command that ends while the session is idle wakes the
    // subagent before or after a second `idle`. Sigma meets both alike: the provider test passed on a fixture kept with
    // the second one.
    if (line.type === "emit_inbound" && line.frame.subtype === "session_state_changed") {
      if (states.get(pid) === line.frame.state) continue
      states.set(pid, line.frame.state)
    }
    // Sigma's answer to a control request races everything Claude Code writes after the request, so it goes right after
    // the request, and what raced it follows: every run places it alike. The fake waits there for the answer by its
    // request id, then plays on.
    let at = segment.length
    if (line.type === "expect_outbound" && line.frame.type === "control_response") {
      const answering = line.frame.response.request_id
      at =
        segment.findIndex(
          (earlier) =>
            earlier.type === "emit_inbound" &&
            (earlier.frame as { type: string; request_id?: string }).type === "control_request" &&
            (earlier.frame as { request_id?: string }).request_id === answering,
        ) + 1 || segment.length
    }
    segment.splice(at, 0, line)
  }
  const header = {
    metadata: {
      model: MODEL,
      generated: `Claude Code ${version} by tapes.ts generate from fixtures/tapes/claude/${journey}.ndjson`,
      tape: tape.header.metadata.source,
    },
    provider: "claude",
    scenario: journey,
    type: "transcript_start",
  }
  return [header, ...[...segments.values()].flat()].map((line) => `${JSON.stringify(line)}\n`).join("")
}

/** Plays `name` through the recorder and writes its process fixture, or fails, keeping its recording, and writes nothing. */
const generate = async (name: string) => {
  const journey = journeys[name]
  if (!journey) throw new Error(`no journey ${name}; journeys: ${Object.keys(journeys).join(", ")}`)
  const work = mkdtempSync("/tmp/sigma-generate-")
  const recording = join(work, "recording.ndjson")
  const model = ModelServer.play(name, "claude")
  using play = claudePlayEnv(model.url)
  let workspace = ""
  try {
    await using session = await openSession(
      journey,
      { executable: executable(work), env: { ...play.env, RECORD_CLAUDE_TO: recording } },
      model,
    )
    workspace = session.cwd
    await journey.play(session)
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}\n${model.problems().join("\n")}\nrecording kept in ${work}`)
  }
  await model[Symbol.asyncDispose]().catch((error) => {
    throw new Error(`${name}: ${error.message}\nrecording kept in ${work}`)
  })
  const out = join(FIXTURES, `${name}.ndjson`)
  writeFileSync(
    `${out}.tmp`,
    steady(processFixture(name, recording, model.tape), { workspace, config: play.env.CLAUDE_CONFIG_DIR! }),
  )
  renameSync(`${out}.tmp`, out)
  rmSync(work, { recursive: true, force: true })
  console.error(`${name}: wrote ${out}`)
}

const [command, ...names] = process.argv.slice(2)
if (command !== "generate" || names.length === 0) {
  console.error("usage: tapes.ts generate <journey...>")
  process.exit(2)
}
for (const name of names) await generate(name)
process.exit(0)
