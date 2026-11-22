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
- `ephemeral-listed` `providers/list` says of each provider whether it answers one, in `ephemeral`: false for `agy`. A client still reads a server from before `ephemeral`, which leaves it out
- `ephemeral-refused` is refused saying why on `agy`, which cannot run one, on an unknown provider, and on a read-only server
- `ephemeral-stop` a server asked to stop, or replaced by `serve --restart`, answers the runs in flight first
- `ephemeral-cli` `sigma ephemeral` starts a server when none runs, prints the answer or `--json`, reads `-` from stdin, and exits 1 saying why it failed

## How to get to it

### People

- `sigma ephemeral [--system text] [--schema json] [--max-turns n] [--provider p] [--model m] [--effort e] [--json] <prompt | ->`.

### Agents

- Call `ephemeral/run` with `{"prompt", "system"?, "schema"?, "provider"?, "model"?, "effort"?, "maxTurns"?}`;
  it answers `{"text", "output"?, "provider", "model", "turns", "usage"}` or fails
  `EphemeralFailed`, `UnknownProvider`, `UnknownEffort` or `ReadOnlyServer`.
- Call `providers/list`: each provider's `ephemeral` says whether it answers
  one, so a caller offers only those.
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
  `drive.ts r rpc ephemeral/run '{"prompt": "hi", "provider": "agy"}'` fails
  `EphemeralFailed`, `agy cannot answer an ephemeral run`.
- **Who answers one.** `drive.ts r rpc providers/list`: `"ephemeral": true`
  on `script`, `claude` and `openai`, `"ephemeral": false` on `agy`.

Claude Code, each journey in a run of its own with a fake Claude Code
replaying its recording, then `down`:

- **The answer.** `drive.ts c1 up --fake-claude ephemeral_text`, then
  `drive.ts c1 sigma ephemeral --json --provider claude --model claude-haiku-5-5 --max-turns 1 --system 'You answer in one word.' 'Is the sky blue on a clear day?'`:
  `"text":"Yes."`, `"turns":1`. `evidence/fake-claude/log.ndjson` shows the
  spawn's argv with `--tools=`, `--setting-sources=` and
  `--no-session-persistence`, and `initialize` with that `systemPrompt`.
- **A schema.** `drive.ts c2 up --fake-claude ephemeral_schema`, then the same
  command with `--max-turns 2 --system 'You classify questions.'` and the
  schema above: `"output":{"answer":"yes"}`, `"turns":2`.
- **The turn limit.** `drive.ts c3 up --fake-claude ephemeral_turn_limit`, then
  the schema command again: stderr
  `Claude Code ended the run at its turn limit of 2`, exit 1.

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
- **Server restart.** `server/stop` and `serve --restart` wait for the runs
  in flight, as they wait for a conversation's.

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

Provider, `packages/sigma/test/providers.test.ts`:

- provider-config, signin-status, model-list, ephemeral-listed: two instances of one provider each list, report their health and their models
- ephemeral-listed: a client reads the providers of a server from before ephemeral was listed

Wire, `packages/sigma/test/wire.test.ts`:

- ephemeral-refused: an ephemeral run is refused saying why on agy, which cannot run one, and on a read-only server

Stack, `packages/sigma/test/stack.test.ts`:

- ephemeral-stop, ephemeral-cli: sigma ephemeral answers when the server is asked to stop mid-run, since a stop waits for it

- ephemeral-cli, server-on-demand: sigma ephemeral starts a server, prints the answer, and leaves no conversation
- ephemeral-cli, ephemeral-schema: sigma ephemeral --json reads a prompt from stdin and prints the answer and the value its schema matches
- ephemeral-cli, ephemeral-schema: sigma ephemeral exits 1 saying why, for a schema that is not JSON, no turns and an answer that is not

## Gotchas

- A run cut off by a crash is not resumed: nothing of it was committed, and
  its caller sees the error.
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
