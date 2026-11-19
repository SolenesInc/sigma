#!/usr/bin/env bun
import { appendFileSync } from "node:fs"
import { FakeOpenAi, matches } from "../../../packages/sigma/test/support/openai.ts"
import shipped from "../../../packages/models/src/chatgpt/models.json" with { type: "json" }

const [port, log, refreshes, ...fixtures] = process.argv.slice(2)
if (!port || !log || !refreshes || fixtures.length === 0) {
  console.error("usage: fake-openai.ts <port> <log.ndjson> <refreshes> <fixture...>")
  process.exit(1)
}

const fake = new FakeOpenAi(Number(port))
// The recordings were made when sigma's tools were capitalized; sigma names them in lower case now.
const TOOL_NAMES = { Bash: "bash" }
const expected = fixtures.flatMap((fixture) => fake.play(fixture, TOOL_NAMES))
// The recordings were made on gpt-5.5, so this ChatGPT lists sigma's shipped models with it first, as the default.
fake.modelList = {
  models: shipped.models.map((model) => (model.slug === "gpt-5.5" ? { ...model, priority: -1 } : model)),
}
for (let refresh = 1; refresh <= Number(refreshes); refresh++) fake.issueTokens(`refresh-${refresh}`, 3600)
let answered = 0
fake.onResponse = (body) => {
  const want = expected[answered]
  const entry =
    want === undefined
      ? { request: answered + 1, verdict: "unscripted", body }
      : { request: answered + 1, verdict: matches(body, want) ? "as recorded" : "differs", body, expected: want }
  answered += 1
  appendFileSync(log, `${JSON.stringify(entry)}\n`)
  console.log(`request ${entry.request}: ${entry.verdict}`)
}
console.log(`fake ChatGPT on ${fake.base}, playing ${fixtures.join(", ")}: ${expected.length} requests`)
