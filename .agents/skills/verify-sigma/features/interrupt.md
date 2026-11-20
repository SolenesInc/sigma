# Interrupt

A person stops Sigma mid-answer. The words said so far stay in the transcript,
the run ends interrupted, and Sigma is ready for the next prompt. Any client
can interrupt any conversation's run.

## Sub-features

- `interrupt-tui` stops the run with `Esc`.
- `interrupt-wire` stops it with `conversation/interrupt` from another client.
- `interrupt-idle` stops the work still going on under an idle conversation:
  `Esc` or `conversation/interrupt` with no run stops the run of every
  subagent in its tree, and every background job Claude Code started in any
  of them, each told to stop. Stopping a run leaves that work going.
- `interrupt-withdraw` withdraws the prompts waiting in the queue: each leaves
  the queue without running, and the transcript gets a `sigma.withdrawn` entry
  naming its `requestId`, so a client that lost its watch learns the prompt's
  fate from entries alone. A prompt sent after the interrupt, while the run
  still stops, waits and runs once it stopped.

## How to get to it

### People

- Press `Esc` in the TUI while it shows `WORKING`.

### Agents

- Call `conversation/interrupt` with the conversation's id and `author`.

## Driving it with drive.ts

Preconditions:

- A run whose script is
  `[{"text": "one two three four five six seven eight nine ten", "delayMs": 300}]`.

- **Escape.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type count`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait three`, `drive.ts r tui key Escape`,
  `drive.ts r tui wait interrupted`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen interrupted`. The answer stops before `ten`, followed
  by `◆ interrupted`.
- **Committed.** Run `drive.ts r rpc conversation/list`, then
  `drive.ts r watch <id> --save interrupted`. The view holds a `pi.assistant`
  entry whose text ends before `ten`, with `"stopReason": "aborted"`, then a
  `sigma.run_end` entry with `"outcome": "interrupted"`.
- **Wire.** In a fresh run with the same script, run `drive.ts r serve`, start
  a conversation with `rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit count --until run_end --save wire &` in the
  background. Once its output holds a live word such as `"two "`, run
  `drive.ts r rpc conversation/interrupt '{"author": {"id": "ada", "name": "ada"}, "conversation": "<id>"}'`. The
  watch ends on a `pi.assistant` entry with what was said and
  `"stopReason": "aborted"`, then `sigma.run_end` with
  `{"outcome": "interrupted", "message": "aborted"}`.
- **Withdraw.** In a fresh run with the same script, run `drive.ts r serve`,
  start a conversation, and run
  `drive.ts r watch <id> --submit count --until run_end --save withdraw &`.
  Once its output holds a live word, run
  `drive.ts r rpc conversation/submit '{"conversation": "<id>", "requestId": "waiting-1", "author": {"id": "ada", "name": "ada"}, "text": "then this"}'`,
  then `conversation/interrupt`. The watch shows `pi.inbox` holding the
  prompt, then one change that empties it and adds
  `sigma.withdrawn` with `{"requestId": "waiting-1"}`, before
  `sigma.run_end` `interrupted`.

## Contexts

- **Second client.** Any client can interrupt, and every client sees the run end `interrupted`.
- **Claude.** Stopping a Claude run interrupts Claude Code's turn and keeps its process for the next prompt, in [Claude](./claude.md) `claude-stop`.
- **Subagents.** Stopping a run stops that run only: its subagents keep working, and a second `Esc` on the idle conversation stops them (`interrupt-idle`). `Esc` in a subagent's own conversation stops its run, not its parent.
- **Claude jobs.** Stopping a Claude run leaves the background commands Claude Code started working, and `Esc` on the idle conversation stops them through Claude Code's `stopTask`; Claude Code stops its background subagents with the run. See [Claude](./claude.md) `claude-job-cut-off`.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- interrupt-wire: interrupting keeps what sigma already said and marks the run interrupted
- interrupt-withdraw: interrupting withdraws the prompts that wait, and the transcript names each by its requestId
- worker-interrupt, interrupt-idle: interrupting a conversation's run leaves its workers working, and interrupting it again, idle, stops them, so the tree goes idle

Screen, `packages/sigma/test/screen.test.ts`:

- interrupt-tui: escape stops sigma mid-answer and the answer shows it was interrupted

Provider, `packages/sigma/test/openai.test.ts`:

- interrupt-wire: a ChatGPT answer streams live, and interrupting it closes the request and keeps what was said

Provider, `packages/sigma/test/claude.test.ts`:

- interrupt-idle, claude-job-report: stopping a Claude run leaves its background command working, and stopping the idle conversation stops the command through Claude Code

## Gotchas

- `Esc` while the TUI shows `READY` stops the conversation's background work
  (`interrupt-idle`); with none, it does nothing.
- Where the words stop depends on timing: the committed `pi.assistant` ends after
  some number of words, always before `ten`.
- With the default 30 ms echo, the run ends before you can press anything.
  Interrupt needs a script with `delayMs`.
