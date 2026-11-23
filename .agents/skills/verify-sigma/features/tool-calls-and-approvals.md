# Tool calls and approvals

Sigma works with tools: `read`, `grep` and `glob` run at once, while `write`,
`edit`, `apply_patch` and `bash` change things and wait for a person to allow
them. The TUI shows each call under `SIGMA` as `▸ tool(subject)`, asks `allow this call?`
and takes `^Y` or `^N`; any client can answer over the wire, and the first
answer counts. `sigma exec` cannot ask, so it denies those calls unless the
conversation was started with `--auto`, which runs every call without asking.

## Sub-features

- `tool-grep-lines` `grep` reports only the lines a file has, whatever its line endings.
- `tool-read-only` runs a read-only call without asking and shows its output.
- `approval-ask` shows `allow this call?` and `◆ WAITING` while a call waits.
- `approval-panel` lists every call of the tree waiting on a person in the
  `WAITING ON YOU · <n>` panel above the prompt, in rows of its own: the
  conversation's own asks first (`SIGMA allow <call>?`), then its subagents'
  (`⧉ <subagent> allow <call>?`), oldest first. `^Y` and `^N` answer the
  first row, the only one that shows them. The first row stays above the
  scrolling list. The other rows read `· next`; scroll over them to see the
  rest when the panel runs out of room. Each call and card in the
  transcript reads `· answer below`. The status bar
  reads `◆ WAITING · <n> asks` when more than one waits, also while the
  conversation itself is idle.
- `approval-allow-tui` allows with `^Y`: `✓ allowed by ada`, then the call's
  output.
- `approval-deny-tui` denies with `^N`: `✗ denied by ada` and the denial as
  the call's result; the run goes on. The screen draws the harness's notes on
  a result, such as the denial, as plain lines, without the `<harness>` tags
  the model gets them in.
- `approval-wire` answers with `approval/resolve`; a second answer is not
  accepted.
- `approval-exec-deny` makes `exec` deny the call and say how to allow it.
- `approval-auto` runs calls without asking in a conversation started with
  `--auto`, from the TUI or `exec`.
- `approval-interrupt` expires a waiting approval when the run is
  interrupted.
- `approval-restart` keeps a call waiting for approval across a restart, and
  asks again after it; an answer then runs the call.
- `tool-output-live` shows a command's output as it prints, under its call
  while the status reads `WORKING`, then commits it whole with the result.
- `tool-root-env` runs every command with `SIGMA_ROOT_CONVERSATION` set to the
  id of its tree's root: the conversation people started (as its client chose
  it at `conversation/start`, or its number) for that conversation and its
  hosted subagents, and the worker's own id for a worker and its hosted
  subagents.

## How to get to it

### People

- In the TUI, wait for `allow this call?` and press `^Y` or `^N`.
- Start with `sigma --auto`.

### Agents

- Run `sigma exec '<prompt>'` without `--auto`, or `sigma exec --auto '<prompt>'`.
- Watch for a request in the view's `sigma.approvals` document, then call `approval/resolve` with its id; or `conversation/start` with `"approvals": "auto"`.

## Driving it with drive.ts

Preconditions:

- Every run here is `drive.ts r up --script <file>` and nothing else: Claude
  is the signed-in fake that plays `models`, and the model is the script.
- A run whose script is
  `[{"text": "checking", "tool": {"name": "bash", "input": {"command": "echo approved"}}}, {"text": "all done"}]`;
  for `tool-read-only`, a run whose script is
  `[{"text": "reading", "tool": {"name": "read", "input": {"path": "/etc/hosts"}}}, {"text": "read it"}]`.
  Start a fresh run for each journey: the script's steps are used up in
  order.

- **Ask.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'check it'`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'allow this call?'`, `drive.ts r tui screen asking`.
  Under `SIGMA`: `checking`, `▸ bash(echo approved)`,
  `allow this call? · answer below`, the `WAITING ON YOU · 1` panel above the
  prompt holds `SIGMA allow bash(echo approved)?  ^Y  allow  ^N  deny`, the
  status bar reads `◆ WAITING 0s`, and the prompt panel is titled `STEER · tab`. `drive.ts r watch <id> --save asking` shows
  the request in `docs.sigma.approvals.requests`, keyed by its approval id,
  with `"tool": "bash"`.
- **Allow.** Run `drive.ts r tui key C-y`, `drive.ts r tui wait 'all done'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen allowed`. The call shows
  `✓ allowed by ada` and `approved`, then `all done`.
- **Deny.** In a fresh run, ask as above, then `drive.ts r tui key C-n`,
  `drive.ts r tui wait 'all done'`, `drive.ts r tui screen denied`. The call
  shows `✗ denied by ada` over
  `denied by ada: the person did not allow this call`, with no `<harness>`
  line, then `all done`. `watch <id>` shows a
  `sigma.approval` entry with `"allow": false`, and a `pi.tool-result`
  whose text is
  `<harness>\n[error] denied by ada: the person did not allow this call\n</harness>`
  with `"isError": true`.
- **Read-only.** In the `read` run, run `drive.ts r sigma exec 'read it'`.
  Exit 0, stdout `reading` and `read it`, stderr `› read(/etc/hosts)` and
  no denial.
- **Exec denies.** Run `drive.ts r sigma exec 'check it'`. Exit 0, stdout
  `checking` and `all done`, stderr `› bash(echo approved)` and
  `denied bash(echo approved): exec cannot ask, pass --auto to allow calls`.
- **Auto.** In a fresh run, run `drive.ts r sigma exec --auto 'check it'`:
  stderr `› bash(echo approved)` with no denial, and `watch <id>` shows a
  `pi.tool-result` with `approved` and no `sigma.approval` entry;
  `rpc conversation/list` shows `"approvals": "auto"`. In another fresh run,
  `drive.ts r tui start --auto`, send `check it`, and
  `drive.ts r tui wait 'all done'`: the call shows `approved` and the screen
  never asks.
- **Root conversation.** In a fresh run whose script is
  `[{"tool": {"name": "bash", "input": {"command": "echo root=$SIGMA_ROOT_CONVERSATION"}}}, {"text": "all done"}]`,
  run `drive.ts r sigma exec --auto --conversation 1e647688-9113-4df0-8e6c-b3d89966c4ed 'which conversation?'`,
  then `drive.ts r watch 1e647688-9113-4df0-8e6c-b3d89966c4ed --save root-env`:
  the `pi.tool-result` is `root=1e647688-9113-4df0-8e6c-b3d89966c4ed`, the id
  the client chose, not the `number` `rpc conversation/list` shows. Without
  `--conversation`, it is that number. A hosted subagent's commands get its tree
  root's id; a worker starts its own tree and gets its own id, in
  [Workers](./workers.md).
- **Output streams live.** In a fresh run whose script is

  ```json
  [
    {
      "text": "counting",
      "tool": { "name": "bash", "input": { "command": "for i in 1 2 3; do echo tick $i; sleep 1; done" } }
    },
    { "text": "counted" }
  ]
  ```

  run `drive.ts r tui start --auto`, `drive.ts r tui wait READY`,
  `drive.ts r tui type count`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'tick 2'`, `drive.ts r tui screen streaming`: under
  `▸ bash(for i in 1 2 3; do echo tick $i; sleep 1; done)` the lines
  `tick 1` and `tick 2` show while the status bar reads `WORKING` and
  `counted` is not there yet. `drive.ts r tui wait READY`,
  `drive.ts r tui screen streamed`: `tick 1`, `tick 2` and `tick 3`, then
  `counted`. Over the wire, in a fresh run,
  `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp", "approvals": "auto"}'` and
  `drive.ts r watch <id> --submit count --until run_end --save stream`:
  changes about a second apart grow the running call's `output` in
  `docs.pi.live.tools` by `tick 1\n`, `tick 2\n` and `tick 3\n`, before the
  `pi.tool-result` `tick 1\ntick 2\ntick 3\n`.

- **Wire.** In a fresh run, run `drive.ts r serve`, start a conversation with
  `rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit 'check it' --until run_end --timeout 30000 --save wire &`.
  Once its output shows a request in `docs.sigma.approvals.requests`, take
  its key, the approval id, and run
  `drive.ts r rpc approval/resolve '{"conversation": "<id>", "approval": "<approval>", "author": {"id": "bo", "name": "bo"}, "allow": true}'`:
  `"accepted": true`. The same call again with `"author": {"id": "cy", "name": "cy"}` and
  `"allow": false` answers `"accepted": false`; sent at the same moment, one
  of the two is accepted. The watch shows one `sigma.approval` entry with
  `"allow": true`, a `pi.tool-result` with `approved`, and a `sigma.run_end`
  `answered`.
- **Several ask** (`approval-panel`). A run whose script is
  `[{"tools": [{"name": "start_worker", "input": {"task_name": "docs", "message": "update the docs", "fork_turns": "none"}}, {"name": "start_worker", "input": {"task_name": "deps", "message": "bump the dependencies", "fork_turns": "none"}}]}, {"agent": "/root/docs", "tool": {"name": "bash", "input": {"command": "echo docs"}}}, {"agent": "/root/deps", "tool": {"name": "bash", "input": {"command": "echo deps"}}}, {"tool": {"name": "bash", "input": {"command": "echo parent"}}}, {"text": "the parent is done"}, {"agent": "/root/docs", "text": "docs updated"}, {"agent": "/root/deps", "text": "deps bumped"}]`.
  `drive.ts r tui start`, type `delegate` and `Enter`, wait for
  `WAITING ON YOU · 3`: the panel above the prompt holds
  `SIGMA allow bash(echo parent)?  ^Y  allow  ^N  deny`, then each
  subagent's ask, oldest first, as `⧉ docs allow bash(echo docs)? · next`;
  the call and both cards read `· answer below`; the status bar reads
  `◆ WAITING · 3 asks`. Each `C-y` answers the first row, and the next moves
  up: `WAITING ON YOU · 2`, then `· 1`, then the panel is gone.
- **Resize with several asks** (`approval-panel`). Use four workers and a
  parent that each call `bash` with a long `git diff --` command. At five
  asks, shrink the pane to 65×19. The first approval and its keys, the
  transcript, the prompt, and the status bar are still visible. Scroll
  down over the later rows to see the last worker without moving the first
  approval. Enlarge the pane to 100×30 to see all five. `C-n` still denies
  the parent's call and puts the oldest worker's request first.
- **Interrupt while asking.** In a fresh run, ask as above, then
  `drive.ts r tui key Escape`, `drive.ts r tui wait interrupted`.
  `allow this call?` is gone, `◆ interrupted` shows, and the command never
  ran. `approval/resolve` on that approval afterwards answers
  `"accepted": false`.

## Contexts

- **Second client.** Any client can answer, and the first answer counts.
- **Provider.** On Claude, Sigma asks before the calls Claude Code would ask about.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- approval-wire: two clients answer one approval at once and the first answer counts
- approval-wire: a denied call is reported to the model as denied and does not run, and an unknown approval is refused by name
- tool-read-only, approval-auto: reading calls and conversations started with auto approvals run without asking
- child-tools, approval-auto: a subagent of a conversation that runs calls without asking does not ask either
- worker-root-env, tool-root-env, mcp-start: a worker's bash and MCP calls name the worker as root, while its parent's name the parent by the id its client chose
- approval-restart, status-snapshot: a call waiting for approval across a restart asks again after it, and runs once allowed
- approval-ask: a call that changes things waits for a person, and every client sees what it asks and that the tree waits
- tool-output-live: a running command's output streams live and ends as its result
- tool-output-live: a command's output keeps characters split across reads and between streams whole
- tool-output-live: a verbose command's live output stays a bounded tail
- tool-output-live: output a background process writes after its call ends never reaches the conversation
- tool-grep-lines: grep reports only the lines a file has, whatever its line endings
- approval-interrupt: interrupting while sigma waits for an answer withdraws the question

Screen, `packages/sigma/test/screen.test.ts`:

- approval-ask, approval-allow-tui: sigma asks before a command runs, ctrl+y allows it and its output shows under the call
- approval-ask, codemode-nested-policy: a script's call that waits for a person shows its command under the script before ctrl+y allows it
- approval-deny-tui: ctrl+n denies a call, the denial shows as its result and the run goes on
- approval-panel: with the conversation and two subagents asking, the panel lists every ask in its own rows, its own first, and ctrl+y answers them in that order

Stack, `packages/sigma/test/stack.test.ts`:

- approval-exec-deny: sigma exec shows its calls and, without --auto, denies the ones that would change things

## Gotchas

- The TUI's working directory is the checkout, so its calls run there. Script
  only calls that change nothing, such as `echo`, or start the conversation
  over the wire with another `cwd`.
- A script step with a `tool` calls it and the same run goes on to the next
  step; a step without one ends the run.
- `^Y` and `^N` answer this conversation's oldest waiting call, or else the
  oldest in the first subagent that has one.
