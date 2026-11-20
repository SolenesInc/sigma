#!/usr/bin/env bun
// run.ts [--runs N] [--harnesses claude,openai,agy] [--cases id,...] [--run ID]: runs the worker-choice eval on the
// real providers and prints its table. One drive.ts run (default `wc`) holds Claude Code and agy with your own
// sign-ins and the kept ChatGPT sign-in; each case starts one conversation per harness and run, all of a run at once,
// and its watch is saved to /tmp/sigma-verify/<run>/evidence/<harness>-<case>-<n>.ndjson. score.ts then reads them.
// The workers a parent starts run for real too.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { type Planned, score } from "./score.ts"

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    harnesses: { type: "string", default: "claude,openai,agy" },
    cases: { type: "string" },
    run: { type: "string", default: "wc" },
  },
})
const ROOT = join(import.meta.dir, "../../../../..")
const DRIVE = join(ROOT, ".agents/skills/verify-sigma/drive.ts")
const RUN = values.run!
const DIR = `/tmp/sigma-verify/${RUN}`
const EVIDENCE = join(DIR, "evidence")
const PROJECT = join(DIR, "project")
/** A parent's turn, with a worker's round trip in it, takes a minute or two; only a stuck one reaches this. */
const TURN_MS = 400_000

/** Each harness as a parent: the model it runs on, and the provider and model a request names for its worker. */
const HARNESSES: Record<string, { model: string; effort: string }> = {
  claude: { model: "sonnet", effort: "low" },
  openai: { model: "", effort: "low" },
  agy: { model: "gemini-4-hydrogen", effort: "low" },
}
/** Whom each harness's requests name: the other two, in this order. */
const OTHERS: Record<string, [string, string]> = {
  claude: ["openai", "agy"],
  openai: ["agy", "claude"],
  agy: ["claude", "openai"],
}

const drive = async (...args: string[]) => {
  const out = await Bun.$`bun ${DRIVE} ${RUN} ${args}`.cwd(ROOT).nothrow().quiet()
  if (out.exitCode !== 0) throw new Error(`drive.ts ${args.join(" ")}: ${out.stderr.toString()}${out.stdout}`)
  return out.stdout.toString()
}
const rpc = async (method: string, params: object, timeout = "60000") =>
  JSON.parse(await drive("rpc", method, JSON.stringify(params), "--timeout", timeout)).result

const cases: Array<{ id: string; expect: Planned["expect"]; prompt: string }> = JSON.parse(
  readFileSync(join(import.meta.dir, "cases.json"), "utf8"),
).filter((each: { id: string }) => values.cases === undefined || values.cases.split(",").includes(each.id))
const harnesses = values.harnesses!.split(",")

await drive("up", "--real-claude", "--real-agy", "--openai-kept")
try {
  await drive("serve")
  const providers: Array<{ id: string; health: { status: string } }> = await rpc("providers/list", {})
  for (const id of ["claude", "openai", "agy"]) {
    const health = providers.find((each) => each.id === id)?.health.status
    if (health !== "ready") throw new Error(`${id} is ${health ?? "missing"}, not ready`)
  }
  const models: Array<{ provider: string; defaultModel?: string; models: Array<{ id: string }> }> = await rpc(
    "models/list",
    {},
  )
  const openai = models.find((each) => each.provider === "openai")
  HARNESSES.openai!.model = openai?.defaultModel ?? openai?.models[0]?.id ?? ""
  /** The model a request names for a worker on each provider. */
  const workerModel: Record<string, string> = {
    claude: "haiku",
    openai: HARNESSES.openai!.model,
    agy: "gemini-4-hydrogen",
  }

  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(join(PROJECT, "a.txt"), "one\ntwo\n")
  writeFileSync(join(PROJECT, "b.txt"), "one\ntwo\nthree\n")
  writeFileSync(join(PROJECT, "c.txt"), "one\n")
  writeFileSync(join(PROJECT, "sum.py"), "def total(xs):\n    return sum(xs)\n")

  const plan: Planned[] = []
  for (let run = 1; run <= Number(values.runs); run++) {
    const jobs = harnesses.flatMap((harness) =>
      cases.map(async (each) => {
        const [other, third] = OTHERS[harness]!
        const prompt = each.prompt
          .replaceAll("{other}", other)
          .replaceAll("{other_model}", workerModel[other]!)
          .replaceAll("{third}", third)
          .replaceAll("{third_model}", workerModel[third]!)
        const wanted =
          each.expect === "exact"
            ? [{ provider: other, model: workerModel[other]! }]
            : each.expect === "two"
              ? [
                  { provider: other, model: workerModel[other]! },
                  { provider: third, model: workerModel[third]! },
                ]
              : []
        const file = `${harness}-${each.id}-${run}`
        plan.push({ file: `${file}.ndjson`, harness, case: each.id, run, expect: each.expect, wanted })
        const { model, effort } = HARNESSES[harness]!
        const started = await rpc("conversation/start", {
          author: { id: "ada", name: "ada" },
          cwd: PROJECT,
          provider: harness,
          ...(model === "" ? {} : { model }),
          effort,
          approvals: "auto",
        })
        await drive(
          "watch",
          started.conversation,
          "--submit",
          prompt,
          "--until",
          "run_end",
          "--timeout",
          String(TURN_MS),
          "--save",
          file,
        ).catch((error) => console.error(`${file}: ${error.message.split("\n")[0]}`))
      }),
    )
    await Promise.all(jobs)
    console.error(`run ${run} done`)
  }
  writeFileSync(join(EVIDENCE, "plan.json"), JSON.stringify(plan, null, 1))
  const table = score(EVIDENCE)
  writeFileSync(join(EVIDENCE, "table.txt"), `${table}\n`)
  console.log(table)
  console.log(`\nwatches and plan.json in ${EVIDENCE}`)
} finally {
  await drive("down").catch((error) => console.error(error.message))
}
