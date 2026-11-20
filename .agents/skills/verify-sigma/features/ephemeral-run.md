# Ephemeral run

One prompt answered by a model with no tools, outside any conversation, for a
caller that wants one answer: a title, a classification, a verdict. `sigma
ephemeral` prints the answer, or with `--json` one object with the answer, the
value a schema asked for, the provider, the model, its turns and what it spent.
The home keeps nothing of it: no conversation in `conversation/list`, no entry
and no usage in `usage/get`. The caller's system prompt replaces the provider's
own. ChatGPT, Claude Code and the scripted model answer one; `agy` does not.

## Sub-features

- `ephemeral-answer` answers one prompt with the caller's system prompt alone and no tools, and leaves no conversation and no usage
- `ephemeral-schema` with a JSON Schema, answers a value that matches it, or fails saying where it does not
- `ephemeral-turn-limit` a turn limit ends a Claude Code run that reaches it, saying so
- `ephemeral-concurrent` runs at once each answer their own prompt, beside a conversation's working run
- `ephemeral-cli` `sigma ephemeral` starts a server when none runs, prints the answer or `--json`, reads `-` from stdin, and exits 1 saying why it failed

## How to get to it

### People

- `sigma ephemeral [--system text] [--schema json] [--max-turns n] [--provider p] [--model m] [--effort e] [--json] <prompt | ->`.

### Agents

- Call `ephemeral/run` with `{"prompt", "system"?, "schema"?, "provider"?, "model"?, "effort"?, "maxTurns"?}`;
  it answers `{"text", "output"?, "provider", "model", "turns", "usage"}` or fails
  `EphemeralFailed`, `UnknownProvider`, `UnknownEffort` or `ReadOnlyServer`.
- Run `sigma ephemeral` as a subprocess, as attn's one-shot model calls do:
  the prompt on stdin with `-`, `--json` on stdout, the reason on stderr with
  exit 1.

## Driving it with drive.ts

Preconditions:

- A fresh run with a fake ChatGPT replaying the recordings,
  `drive.ts r up --fake-openai ephemeral_text,ephemeral_schema,text_answer`.
  Its server starts on the first command.

- **The answer.** `drive.ts r sigma ephemeral --provider openai --model gpt-6.1-terra --effort low --system 'You answer in one word.' 'Is the sky blue on a clear day?'`:
  stdout `Yes.`, exit 0.
- **A schema.** `drive.ts r sigma ephemeral --json --provider openai --model gpt-6.1-terra --effort low --system 'You classify questions.' --schema '{"type":"object","properties":{"answer":{"type":"string","enum":["yes","no"]}},"required":["answer"],"additionalProperties":false}' 'Is the sky blue on a clear day?'`:
  one JSON line with `"output":{"answer":"yes"}` and `"turns":1`.
- **Nothing kept.** `drive.ts r rpc conversation/list` answers `[]`, and
  `drive.ts r rpc usage/get '{}'` answers `{"models":{},"tools":{}}`.
- **Beside a conversation.** `drive.ts r sigma exec --provider openai --model gpt-5.5 hello`:
  stdout `Hello there`; `drive.ts r rpc conversation/list` now lists that one
  conversation and no other.
- **A failure.** `drive.ts r sigma ephemeral --schema '{nope' go`: stderr
  `--schema is not JSON`, exit 1. With the fake's replies used up,
  `drive.ts r sigma ephemeral --provider openai --model gpt-6.1-terra go`
  exits 1 and stderr says what ChatGPT answered.

## Contexts

- **Provider.** ChatGPT gets one request with the system prompt as its whole
  `instructions`, `tools: []`, and a schema as strict structured output
  (`text.format` `json_schema`, `strict: true`), so a schema must be strict:
  every property required, `additionalProperties: false`. One request is one
  turn, so a turn limit never binds there. Claude Code runs with no tools, no
  setting sources, no MCP servers, hooks off and no session kept
  (`--tools= --setting-sources= --strict-mcp-config --no-session-persistence`),
  the system prompt in place of its own; it answers a schema through its
  StructuredOutput tool, which it counts as a second turn, and a turn limit it
  reaches ends the run. The scripted model answers with its next step, or
  `You said: <prompt>`. `agy` fails `EphemeralFailed`.
- **Idle.** A run holds the server like a watch, so an idle server outlives
  it.

## Tests

Provider, `packages/sigma/test/openai.test.ts`:

- ephemeral-answer: an ephemeral run on ChatGPT answers with its system prompt alone and no tools, and the home keeps no conversation and no usage
- ephemeral-schema: an ephemeral run on ChatGPT asks for strict structured output and answers the value its schema matches
- ephemeral-schema: an ephemeral run whose answer does not match its schema fails saying where
- ephemeral-concurrent: ephemeral runs on ChatGPT at once each answer their own prompt, while a conversation's run works beside them

Provider, `packages/sigma/test/claude.test.ts`:

- ephemeral-answer: an ephemeral run on Claude Code answers with its system prompt alone, no tools, no settings and no session kept, and the home keeps no conversation and no usage
- ephemeral-schema: an ephemeral run on Claude Code hands it the schema and answers the value Claude Code gave for it
- ephemeral-turn-limit: an ephemeral run that reaches its turn limit on Claude Code fails saying so
- ephemeral-concurrent: ephemeral runs on Claude Code at once each answer their own prompt, while a conversation's run works beside them

Stack, `packages/sigma/test/stack.test.ts`:

- ephemeral-cli, server-on-demand: sigma ephemeral starts a server, prints the answer, and leaves no conversation
- ephemeral-cli, ephemeral-schema: sigma ephemeral --json reads a prompt from stdin and prints the answer and the value its schema matches
- ephemeral-cli, ephemeral-schema: sigma ephemeral exits 1 saying why, for a schema that is not JSON and an answer that is not

## Gotchas

- `server/stop` does not wait for an ephemeral run: a run in flight when the
  server stops fails its caller, and nothing of it needs recovering.
- A read-only server refuses it with `ReadOnlyServer`, since it spends on the
  person's account.
- `fixtures/claude/ephemeral_turn_limit.ndjson` is hand-built from the schema
  recording: a real Claude Code with no tools answers within one or two turns.

## With a real account

ChatGPT, signed in (`drive.ts r up --openai-kept`):

- `drive.ts r sigma ephemeral --json --provider openai --effort low --system 'You answer in one word.' 'Is the sky blue on a clear day?'`:
  a short answer, `"turns":1`, `usage` with tokens, and the account's first
  listed model as `model`.
- The same with the schema above: `"output":{"answer":"yes"}`.

Claude Code (`drive.ts r up --real-claude`):

- `drive.ts r sigma ephemeral --json --provider claude --model claude-haiku-5-5 --max-turns 1 --system 'You answer in one word.' 'Is the sky blue on a clear day?'`:
  `"turns":1`, a `usage.cost.total` above 0.
- The same with the schema and `--max-turns 2`: `"output":{"answer":"yes"}`,
  `"turns":2`.
- `drive.ts r rpc conversation/list` answers `[]` after both.
