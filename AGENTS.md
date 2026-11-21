# Sigma

Sigma is a coding agent designed to be durable, to integrate with agent SDKs,
and to serve many clients on one conversation, with every change attributed.
One server owns every conversation and commits each step to SQLite before
anyone sees it. Clients draw what it commits; the first is a terminal UI.
Models run through the Claude Agent SDK, which drives Claude Code, through
Antigravity's `agy` over the Agent Client Protocol, which serves Gemini, or
through a ChatGPT sign-in, where sigma runs the loop and the tools itself.

## Where we are

Sigma is still being built and nobody depends on it yet. Choose the right
design over compatibility with what exists.

The binary runs on a durable kernel written on Effect, following pi-durable's
model: `packages/kernel` stores state and runs tasks, `packages/harness` runs
conversations on it, and `packages/sigma` serves them over `packages/protocol`.
A conversation whose model a harness such as Claude Code serves runs as a
hosted run (`packages/hosted`), through that harness's adapter
(`packages/claude`, `packages/agy`).
The kernel's features with no client path are marked `[kernel]` in the feature
map, and are proven by package tests or pi-durable's own suite.

## Domain language

Always read [docs/glossary.md](docs/glossary.md) before writing code, tests,
docs, or questions. It is Sigma's domain vocabulary — the ubiquitous language
people and agents share. Use its terms, and never write a legacy name listed
under its Tech debt section.

## Rules that keep it what it is

- Only committed state is observable. Every change goes through one store
  commit, published after it is stored. Never show a client anything else.
- The server owns state and execution; clients only render.
- Sigma orders and records what clients do. It does not decide who a client is
  or what it may do; whatever runs sigma owns identity and permissions.
- A client never slows the server: each watch has a bounded queue and ends
  with `FellBehind` when it falls behind; the client watches again and pages
  what it missed.
- Draw only on change. No CPU while idle.
- Before adding a layer, option, cache or guard, name the requirement it serves
  today.

## Where to look

| To learn                                                     | Read                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| Sigma's domain vocabulary (ubiquitous language)              | `docs/glossary.md`                                        |
| What sigma does, feature by feature, and how to drive each   | `.agents/skills/verify-sigma/features/README.md`          |
| The commands and flags                                       | `bun packages/sigma/src/main.ts --help`                   |
| What clients can call                                        | `schema/sigma.schema.json`, made from `packages/protocol` |
| What a package owns                                          | its `README.md`, or the exports in its `package.json`     |
| Which package may import which                               | `scripts/boundaries.ts`                                   |
| How the kernel is measured against pi-durable's suite        | `packages/conformance/README.md`                          |
| Which use cases have tests, and which wait on a rebuild step | `bun run coverage`                                        |

## Landing

Changes land directly on `main` with `land`. Before you land a change, run
`land guide` and follow it. `land` runs `bun run check` as its gate, and CI
runs the same check on `main`.

Contributors from a fork open a pull request instead.

## Checks

```sh
bun run check   # the gate, and what CI runs
```

- A change that adds, changes or deletes tests goes through the `verify-tests`
  skill.
- A change to a kernel package or `packages/conformance` goes through
  `verify-conformance`.
- Before reporting a change done, drive it with the `verify-sigma` skill and
  show its evidence. A change to a user-facing behavior updates that skill's
  feature map in the same landing.
- After a protocol change run `bun run schema` and commit the result.

The skills are in `.agents/skills`.

## Testing

Every test defends one promise that a person, a client or a later
version relies on, and its name says what they would see if it broke. Tests
enter where those consumers enter:

| Kind     | Enters through                                                                                                                          | Lives in                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Wire     | a real server in process, driven as a raw JSON-RPC client over its socket                                                               | `packages/sigma/test/wire.test.ts`                                    |
| Screen   | the real TUI in a PTY on an `@xterm/headless` screen, typed into, against a real server                                                 | `packages/sigma/test/screen.test.ts`                                  |
| Stack    | the `sigma` binary over its socket: kill, restart, reconnect                                                                            | `packages/sigma/test/stack.test.ts`                                   |
| Provider | a wire test whose provider is a fake server replaying a recorded exchange from `fixtures/`                                              | `packages/sigma/test/openai.test.ts`, `claude.test.ts`, `agy.test.ts` |
| Live     | a journey played on the real Claude Code, whose model is the model server playing the journey's tape                                    | `packages/sigma/test/live.test.ts`                                    |
| Package  | a package's public API, only for specified logic with a large input space (as tables or properties) or a promise no wire test can reach | `packages/<name>/test`                                                |

- The model is the seam. Tests script it (the `script` provider,
  `SIGMA_MODEL_SCRIPT`), replay a provider's recorded exchange, or play a tape
  to the real harness; nothing else is faked.
- Judge the TUI by its screen.
- A test's title starts with the feature-map use case it covers:
  `test("queue-show: ...")`. `bun run coverage` fails on a test that names no
  use case or an unknown one. A new feature adds its id and its test in the
  same change; see the feature map's README.
- Wait on events with a deadline, never sleep. To hold a scripted answer
  mid-run, give its step a `hold` (`hold()` in `test/support/server.ts`) and
  release it when the test is ready. `scripts/clock-free-tests.ts`, part of the
  check, refuses a test line that sleeps, polls or paces itself unless a
  `// clock:` comment says why. The shared deadline and test limit
  (`DEADLINE`, `TEST_TIMEOUT` in `test/support/raw.ts`) are tripwires set past
  the slowest wait measured under `scripts/under-load.ts`; raise one only with
  a new measurement. A flaky test is a bug: fix it, never retry it.
- Each test gets its own `SIGMA_HOME` under `/tmp` (a socket path must stay
  under 108 bytes) and stops any server it started.
- Don't test what the compiler guarantees, don't assert on your own fakes, and
  don't read source files in tests.

Provider tests replay recorded exchanges from `fixtures/`:

- The fake OpenAI server serves each `emit_inbound` frame, and the test checks
  every request against its `expect_outbound` frame, where `"<any>"` matches
  anything. A `hold_open` line leaves that reply's stream open until the test
  ends.
- The fake `claude` executable (`packages/sigma/test/support/fake-claude`)
  plays one recorded Claude Code process per spawn, and one recorded probe per
  probe (a spawn with `--no-session-persistence` and tools; an ephemeral run's
  has none, and plays as a spawn). It logs what sigma sent it,
  and tests judge Claude by that log.
- The fake `agy` (`packages/sigma/test/support/fake-agy`) plays one recorded
  `agy acp` process per spawn, and `fixtures/agy/models.ndjson` for each
  probe. It runs the Stop hook sigma gave the session where the recording
  did, and gives sigma what agy said before it only once the hook has run or
  sigma asks something, so every test meets a Stop read ahead of what agy said
  before it. It logs what sigma sent it.
- A tape, `fixtures/tapes/<harness>/<journey>.ndjson`, is the model wire of
  one journey in `packages/sigma/test/support/journeys.ts`: each lane's reply
  at each turn, what the lane's newest message must match, bindings for ids
  the harness chooses, and gates the journey releases. The model server
  answers each request by its lane and turn, a request the tape does not
  expect gets a 400 naming them, and a play fails when an exchange went
  unasked. `bun packages/sigma/test/support/tapes.ts generate <journey>` plays
  a tape to the real Claude Code with no account and writes the journey's
  process fixture; regenerate a generated fixture, never edit it.
- Screen and stack tests point `SIGMA_CLAUDE` and `SIGMA_AGY` at the fakes, so
  no test reaches a real Claude or agy. A stack test that needs ChatGPT points
  `SIGMA_OPENAI_URL` at the fake OpenAI server.
