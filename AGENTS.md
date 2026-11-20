# Sigma

Sigma is a coding agent designed to be durable, to integrate with agent SDKs,
and to serve many clients on one conversation, with every change attributed.
One server owns every conversation and commits each step to SQLite before
anyone sees it. Clients draw what it commits; the first is a terminal UI.
Models run through the Claude Agent SDK, which drives Claude Code, or through
a ChatGPT sign-in, where sigma runs the loop and the tools itself.

## Where we are

Sigma is still being built and nobody depends on it yet. Choose the right
design over compatibility with what exists.

The binary runs on a durable kernel written on Effect, following pi-durable's
model: `packages/kernel` stores state and runs tasks, `packages/harness` runs
conversations on it, and `packages/sigma` serves them over `packages/protocol`.
A conversation whose model a harness such as Claude Code serves runs as a
hosted run (`packages/hosted`), through that harness's adapter
(`packages/claude`).
The kernel's features with no client path are marked `[kernel]` in the feature
map, and are proven by package tests or pi-durable's own suite.

## Domain language

These terms are sigma's domain model. Use them with these meanings in code,
tests, docs and conversation.

```text
home                    one directory of state, SIGMA_HOME; like a tenant
├─ server (at most 1)   the process that owns the home's state and runs its work
├─ conversation (0..n)
└─ provider (1..n)      a way to reach models: Claude Code or a ChatGPT sign-in
```

```text
conversation            one transcript and the work done in it; like one chat
├─ entry (0..n)         one immutable record in the transcript: a message, a
│                       tool call, a result, an approval, a run_end
├─ submission (0..n)    input handed to the conversation; it starts a run, or
│                       waits in the queue while a run works
├─ run (0..n)           the work from one input to its run_end; 1 at a time
│  ├─ turn (1..n)       one model response and its tool calls
│  └─ run_end (1)       the entry that says how the run ended
├─ model (1)            a provider, a model and a reasoning effort
└─ worker (0..n)        a conversation sigma starts for this one, on any
                        provider, under it in a tree; it takes input from
                        people and outlives its parent's turn
```

```text
harness                 a program that runs its own model loop, tools and
                        session, which sigma drives as a process: Claude Code
subagent                a child a harness owns and runs inside one of its
                        turns, as Claude Code's Agent; sigma shows each as a
                        conversation, but it is not a worker
fork                    a worker that starts with its parent's history; only
                        one on its parent's provider can fork
```

```text
job                     work a harness started that can outlive the run that
                        started it, such as a background command or subagent
job report              the entry that tells the conversation a job ended,
                        under the job's name, as input by no person
wake run                a run the harness's own turn starts: held job reports
                        are its input, and it sends the harness nothing
```

```text
target                  the computer a conversation's tools act on, named by
│                       an opaque id fixed at start; `local` is the server's
│                       own machine, the default
├─ instance (1 at a time) the machine or container behind the target now; it
│                       can restart or be replaced
├─ files                the storage behind the conversation's working folder;
│                       a restart keeps it, a replacement does not
└─ sigma-env            sigma's program on the instance; it runs the
                        conversation's file and shell calls
```

```text
connector               the command, set by whatever runs sigma, that opens a
                        pipe from the server to a target's current instance
remote conversation     a conversation whose target is not `local`
member mode             how a remote conversation runs Claude Code: its own
                        tools off, acting only through sigma's tools
```

A conversation's workers and forks share its target. Sigma does not name who
provides a target, or what kind of host it is.

```text
commit                  one atomic write to the store; the only way state
                        changes, and what clients are shown
task                    durable work the kernel runs in phases, each safe to
                        rerun from its top; a run, a tool call and a worker
                        are tasks, so a restart resumes them
document                state the kernel keeps beside the transcript, such as
                        a conversation's queue or its waiting approvals
view                    what a client watches of a conversation: its entries
                        through a window and its documents, then the changes
                        each commit makes to them
client                  a program connected to the server's socket that draws
                        committed state and sends input; the TUI is one
approval                a tool call waiting for a person to allow or deny it;
                        the first answer counts
```

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

| Kind     | Enters through                                                                                                                          | Lives in                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Wire     | a real server in process, driven as a raw JSON-RPC client over its socket                                                               | `packages/sigma/test/wire.test.ts`                     |
| Screen   | the real TUI in a PTY on an `@xterm/headless` screen, typed into, against a real server                                                 | `packages/sigma/test/screen.test.ts`                   |
| Stack    | the `sigma` binary over its socket: kill, restart, reconnect                                                                            | `packages/sigma/test/stack.test.ts`                    |
| Provider | a wire test whose provider is a fake server replaying a recorded exchange from `fixtures/`                                              | `packages/sigma/test/openai.test.ts`, `claude.test.ts` |
| Package  | a package's public API, only for specified logic with a large input space (as tables or properties) or a promise no wire test can reach | `packages/<name>/test`                                 |

- The model is the seam. Tests script it (the `script` provider,
  `SIGMA_MODEL_SCRIPT`) or replay a provider's recorded exchange; nothing else
  is faked.
- Judge the TUI by its screen.
- A test's title starts with the feature-map use case it covers:
  `test("queue-show: ...")`. `bun run coverage` fails on a test that names no
  use case or an unknown one. A new feature adds its id and its test in the
  same change; see the feature map's README.
- Wait on events with a deadline, never sleep. A flaky test is a bug: fix it,
  never retry it.
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
  probe (a spawn with `--no-session-persistence`). It logs what sigma sent it,
  and tests judge Claude by that log.
- Screen and stack tests point `SIGMA_CLAUDE` at the fake `claude`, so no test
  reaches a real Claude. A stack test that needs ChatGPT points
  `SIGMA_OPENAI_URL` at the fake OpenAI server.
