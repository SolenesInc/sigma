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
- `background-count` shows `⧉ <n> in background` in the status bar while work
  goes on under the conversation beside its runs: its own subagents that
  work, and the jobs Claude Code runs in the background. The prompt's bottom
  border says what `Esc` stops now: `esc  stop the run` during a run, and
  `esc  stop <n> background jobs` while the conversation is idle with such
  work.
- `interrupt-withdraw` withdraws the prompts waiting in the queue: each leaves
  the queue without running, and the transcript gets a `sigma.withdrawn` entry
  naming its `requestId`, so a client that lost its watch learns the prompt's
  fate from entries alone. A prompt sent after the interrupt, while the run
  still stops, waits and runs once it stopped. `conversation/interrupt`
  answers `{"withdrawn": [...]}`: each person's prompt it withdrew from this
  conversation's queue, oldest first, as `{submission, requestId, author, text}`,
  taken in the commit that withdrew them, so a steer a run took in at a boundary
  is never listed.
- `interrupt-restore` puts the text of your own withdrawn prompts back in the
  TUI's prompt when `Esc` stops the run, oldest first, a blank line between
  each, before whatever you had typed, so Enter sends them again as one. Only
  prompts you wrote come back: the TUI gives back the ones of yours that
  `conversation/interrupt` says it withdrew, so none comes back that also ran.

## How to get to it

### People

- Press `Esc` in the TUI while it shows `WORKING`, or while it shows `READY`
  with `⧉ <n> in background`; the prompt's bottom border says which.

### Agents

- Call `conversation/interrupt` with the conversation's id and `author`; it
  answers the prompts it withdrew (`interrupt-withdraw`).

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
- **Give it back** (`interrupt-restore`). In a fresh run with the same script,
  `drive.ts r tui start`, send `count`, and wait for `one`. Type `go left` and
  `Enter` (`steering · go left`), `Tab`, `then right` and `Enter`
  (`queued · then right`), then type `half typed` without `Enter`. `Escape`,
  wait for `READY`, and `drive.ts r tui screen restored`: `◆ interrupted`, no
  `steering ·` or `queued ·` rows, and the prompt holds `go left`, a blank
  line, `then right`, a blank line, `half typed`.
- **Run, then background jobs** (`--fake-claude bash_background_stopped`).
  `drive.ts r tui start --provider claude --auto`, send
  `Use the Bash tool with run_in_background set to true to run: sleep 600. Do not wait for it. Reply with exactly: started`,
  wait for `in background · running` and `READY`, then send
  `Use the Bash tool to run: sleep 30. Then reply with exactly: slept` and
  wait for `esc  stop the run`: the status bar reads
  `WORKING <n>s   ⧉ 1 in background`. `Escape`, wait for
  `esc  stop 1 background job`: `◆ interrupted`, `READY`, and the call still
  reads `in background · running`. `Escape` again, wait for
  `in background · stopped`: the count and the hint are gone.
- **Withdraw.** In a fresh run with the same script, run `drive.ts r serve`,
  start a conversation, and run
  `drive.ts r watch <id> --submit count --until run_end --save withdraw &`.
  Once its output holds a live word, run
  `drive.ts r rpc conversation/submit '{"conversation": "<id>", "requestId": "waiting-1", "author": {"id": "ada", "name": "ada"}, "text": "then this"}'`,
  then `conversation/interrupt`. The watch shows `pi.inbox` holding the
  prompt, then one change that empties it and adds
  `sigma.withdrawn` with `{"requestId": "waiting-1"}`, before
  `sigma.run_end` `interrupted`. The `conversation/interrupt` reply lists
  `{"submission": <id>, "requestId": "waiting-1", "author": {"id": "ada", "name": "ada"}, "text": "then this"}`.

## Contexts

- **Second client.** Any client can interrupt, and every client sees the run end `interrupted`.
- **Claude.** Stopping a Claude run interrupts Claude Code's turn and keeps its process for the next prompt, in [Claude](./claude.md) `claude-stop`.
- **Subagents.** Stopping a run stops that run only: its subagents keep working, and a second `Esc` on the idle conversation stops them (`interrupt-idle`). `Esc` in a subagent's own conversation stops its run, not its parent.
- **Claude jobs.** Stopping a Claude run leaves the background commands Claude Code started working, and `Esc` on the idle conversation stops them through Claude Code's `stopTask`; Claude Code stops its background subagents with the run. See [Claude](./claude.md) `claude-job-cut-off`.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- interrupt-wire: interrupting keeps what sigma already said and marks the run interrupted
- interrupt-withdraw: interrupting withdraws the prompts that wait, and the transcript names each by its requestId
- interrupt-withdraw: the interrupt answers which prompts it withdrew, each with its id, requestId, author and text, oldest first
- worker-interrupt, interrupt-idle: interrupting a conversation's run leaves its workers working, and interrupting it again, idle, stops them, so the tree goes idle

Screen, `packages/sigma/test/screen.test.ts`:

- interrupt-tui: escape stops sigma mid-answer and the answer shows it was interrupted
- interrupt-restore: escape mid-run gives the text of your pending prompts back to the composer, oldest first, before what you were typing
- claude-job-card, background-count: a background command's card reads running while it works and done after, the status bar counts it, and its report shows under its name before Sigma's follow-up

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
