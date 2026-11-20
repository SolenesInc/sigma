# Queue

A prompt sent while Sigma works does not interrupt it. It waits in a queue
that every client sees, and runs as its own run when the current one ends, in
the order sent.

## Sub-features

- `queue-show` shows a waiting prompt as `queued · <text>`, sent while the
  prompt panel is titled `QUEUE · tab`: `Tab` switches it there from
  `STEER · tab`, where Enter steers.
- `queue-run` runs it after the current run ends, answered or failed, and
  removes it from the queue. A run whose task faults on a bug withdraws the
  prompts queued behind it instead, each marked `sigma.withdrawn`.
- `queue-shared` shows the queue to a second client.
- `queue-idempotent` queues a submission once however often its `requestId`
  is sent.
- `queue-update` changes a waiting prompt's text, its mode (steering or
  queueing) or both in place: it keeps its id, its `requestId` and its place in
  the queue, and the `sigma.user` entry it runs as names who changed it as
  `editedBy`. A prompt the run already took in answers `already_placed`, one
  whose run ended `settled`, and neither changes.
- `queue-edit` edits your own waiting prompts in the TUI. `Up` on an empty
  prompt opens your newest one, its panel titled `EDIT STEER · tab` or
  `EDIT QUEUED · tab`; `Up` again opens the next older, `Down` the next newer,
  and `Down` past the newest closes the edit. `Up` (on the first line) and
  `Down` (at the end of the text) move between prompts only while the one
  opened is unchanged in text and mode. `Tab` flips it between
  steering and queueing, Enter saves it in place with `submission/update`,
  Enter on an emptied prompt withdraws it, and `Esc` closes the edit unsaved,
  stopping nothing. An edit saved after the prompt reached Sigma stays in the
  composer with `◆ too late to edit: <text> already ran` (or `already reached
sigma`), and Enter sends it as a new prompt.

## How to get to it

### People

- Press `Tab` in the TUI while it shows `WORKING`, so the panel reads `QUEUE · tab`, type, and press Enter.
- Press `Up` on an empty prompt to edit your own waiting prompts.

### Agents

- Call `conversation/submit` while a run works.
- Call `submission/update` with `conversation`, `author`, `submission` (an id
  from the view's `pi.inbox` items) and `text`, `steer` or both, while it waits.

## Driving it with drive.ts

Preconditions:

- A run whose script is
  `[{"text": "slow one two three four five six seven eight", "delayMs": 1000}, {"text": "fast reply"}]`.

- **Queue a prompt.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type first`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'STEER · tab'`, `drive.ts r tui key Tab`,
  `drive.ts r tui wait 'QUEUE · tab'`, `drive.ts r tui type second`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'queued · second'`,
  `drive.ts r tui screen queued`. `WORKING`, the slow answer streaming, and
  `queued · second` above the `QUEUE · tab` panel.
- **Shared.** While it is queued, run `drive.ts r rpc conversation/list` for
  the conversation's `<id>`, then `drive.ts r watch <id> --save queued`. The
  view's `docs.pi.inbox.items` holds `second` with `"mode": "followUp"`, and
  `docs.pi.live.run` is set while the run works. `conversation/list` does not
  show the queue.
- **Runs in order.** Run `drive.ts r tui wait --timeout 20000 'fast reply'`,
  `drive.ts r tui wait --gone 'queued · second'`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen drained`. On the screen
  `slow one two three four five six seven eight` answers `first`,
  `fast reply` answers `second`, and the queue is empty. A second `watch <id> --save after` shows the `sigma.run_end` of `first` before the
  `sigma.user` entry of `second`, and `conversation/list` shows the
  conversation's `ended` as `answered` with `said` `fast reply`.
- **Wire.** In a fresh run with the same script, run `drive.ts r serve`, start
  a conversation with `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp"}'`,
  and run
  `drive.ts r watch <id> --submit first --until run_end --timeout 25000 --save wire &`.
  While `first` streams, send `second` twice with the same `requestId` and
  `third` once, each as
  `drive.ts r rpc conversation/submit '{"conversation": "<id>", "requestId": "q-1", "author": {"id": "bo", "name": "bo"}, "text": "second"}'`
  (`q-2` and `third` for the last). The two `q-1` calls answer with the same
  `submission`. A `drive.ts r watch <id>` while `first` still streams has
  `docs.pi.inbox.items` of `second` then `third`, both `"mode": "followUp"`,
  each carrying a `sigma.user` entry with `{"author": {"id": "bo", "name": "bo"}}`. Once the runs
  settle, a fresh `watch <id>` shows `sigma.user` `first`, `pi.assistant`
  `slow one two three four five six seven eight`, `sigma.run_end`, `sigma.user`
  `second`, `pi.assistant` `fast reply`, `sigma.run_end`, `sigma.user` `third`,
  `pi.assistant` `You said: third` (the script has run out, so Sigma echoes)
  and `sigma.run_end`: `second` once, and an empty inbox.

- **Update.** In a fresh run with the same script, run `drive.ts r serve`,
  start a conversation as in **Wire**, and run
  `drive.ts r watch <id> --submit first --until run_end --timeout 25000 --save update &`.
  While `first` streams, send `second` and `third` with `conversation/submit`
  (`requestId` `q-1` and `q-2`, author `bo`), then change `second` with
  `drive.ts r rpc submission/update '{"conversation": "<id>", "submission": <n>, "author": {"id": "cy", "name": "cy"}, "text": "second, edited", "steer": true}'`.
  It answers `{"result": "updated"}`, and `drive.ts r watch <id>` shows
  `docs.pi.inbox.items` of `second` then `third` under their own ids, `second`
  with `"mode": "steer"`, its text `second, edited` and `requestId` `q-1`.
  Updating `first`, which runs (its id is in `docs.pi.live.run.inputs`),
  answers `already_placed`. Once the runs
  settle, the `sigma.user` entry of `second, edited` has `author` `bo` and
  `editedBy` `cy`, and the transcript holds no `sigma.withdrawn` entry; updating
  `first` now answers `settled`.
- **Edit in the TUI.** In a fresh run whose script is
  `[{"tool": {"name": "bash", "input": {"command": "echo hi"}}}, {"text": "all done"}]`,
  run `drive.ts r tui start`, wait for `READY`, type `first` and `Enter`, and
  wait for `allow this call?`: the run holds there. Type `second`, `Enter`,
  `third`, `Enter`, and wait for `steering · third`. Press `Up`: the panel
  reads `EDIT STEER · tab` over `❯ third` and
  `enter  save · empty withdraws · esc  cancel`
  (`drive.ts r tui screen edit-open`). `Up` again opens `second`; type
  ` please`, press `Tab` (`EDIT QUEUED · tab`, screen `edit-flipped`) and
  `Enter`: the transcript shows `queued · second please` above
  `steering · third`, and the prompt is empty (screen `edit-saved`). `Up`
  opens `third`; delete it with `BSpace` and press `Enter`:
  `◆ withdrew: third`, and its row is gone (screen `edit-withdrawn`). `C-y`:
  `all done`, then `You said: second please`. To see an edit come too late,
  open a queued prompt with `Up`, change it, press `C-y`, wait for its
  `You said:` and `READY`, then `Enter`: `◆ too late to edit: <text> already
ran; enter sends your edit as a new prompt`, with the edit still in the
  prompt (screen `edit-late`).
- **After a failure.** In a fresh run whose script is
  `[{"text": "one two three four five six seven eight", "delayMs": 1000, "fail": "provider went away"}, {"text": "fast reply"}]`,
  queue `second` behind `first` in the TUI as in **Queue a prompt**, then run
  `drive.ts r tui wait --timeout 20000 'fast reply'`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen after-failure`. The screen shows the failed run's
  `provider went away`, then `fast reply` answering `second`, and the queue is
  empty.

## Contexts

- **Second client.** The queue shows to every client.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- queue-idempotent: submitting again with the same request id is answered once
- queue-run: prompts sent while sigma is working wait and run in order, each to its own end
- queue-update: a queued prompt changes its text and its mode in place, keeping its place, and one already run cannot change
- queue-run: a prompt sent while sigma works runs after the run fails, instead of waiting for another prompt
- submit-author, queue-shared: every client sees who wrote each prompt, while it waits and once it runs

Screen, `packages/sigma/test/screen.test.ts`:

- queue-show: a prompt sent while sigma works waits in the queue, then runs
- queue-edit: up on an empty prompt opens your newest pending prompt, up again an older one, and enter saves the edit in place, tab flipping it between steering and queueing
- queue-edit: emptying the prompt you opened withdraws it, esc closes an edit unsaved, and an edit saved after the prompt went stays in the composer to send anew

Package, `packages/harness/test/harness.test.ts` (no wire test can make a run task fault):

- queue-run: an input queued behind a run whose task faults is withdrawn, unless afterFailedRun keeps it

Provider, `packages/sigma/test/claude.test.ts`:

- queue-run: a prompt sent while Claude works runs once Claude answers, resuming the same session

## Gotchas

- Replace `r` in the commands with your run id.
- A scripted run needs no account: Claude is a fake that is signed in, so the
  splash and `providers/list` show it ready.
- The prompt panel reads `PROMPT` while Sigma is ready and, while it works,
  `STEER · tab`, or `QUEUE · tab` if `Tab` switched this TUI to queueing
  earlier: the switch lasts across runs until `Tab` is pressed again. Wait for
  `QUEUE · tab` before typing the second prompt. Steering is a different
  feature. No committed test covers the switch lasting across runs.
- `Up` opens only prompts you wrote, by your author id; another client's stay
  out of reach, though `/withdraw` still takes back the newest of anyone's.
- `Up` on a prompt with text in it moves the cursor, as before: clear it first.
- Each `drive.ts` call takes a few hundred milliseconds, so the first answer
  has to take seconds for the queued state to still be there when you look.
