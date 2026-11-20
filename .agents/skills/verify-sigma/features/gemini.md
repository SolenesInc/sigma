# Gemini

A conversation started with `--provider agy` is answered by Antigravity's CLI,
`agy`, over the Agent Client Protocol (`agy acp`), with `agy`'s own tools and
session and the person's own `agy` sign-in. Its models are the ones `agy`
lists, Gemini's and others, with the thinking levels `agy` lists. Sigma shows
`agy`'s calls under `SIGMA`, asks a person before every call `agy` asks
about, with the command on the card, records a denial as the call's result
and ends the run there, takes a steer into the running turn, stops a turn on
`Esc`, and counts what each turn spent. A conversation's `agy` process stays
for its next run; a new one, as after a server restart, loads `agy`'s session
and is told only what it missed. A command `agy` runs on after its turn ends
is a job: the run ends with Gemini's holding message, and the command's end
shows as a report that wakes the conversation into a run nobody prompted, in
which Gemini answers about it. Sigma never changes `agy`'s permission mode,
offers it none of sigma's own tools, and does not sign in to Google.

## Sub-features

- `provider-agy` the built-in provider `agy`, and `driver = "agy"` instances in `config.toml` with their own `binary`, `env` and `args`.
- `gemini-answer` streams Gemini's answer through `agy` and commits it, with the turn's tokens in `pi.usage`.
- `gemini-approval` turns `agy`'s permission request into `allow this call?` showing the command; `^Y` lets it run.
- `gemini-deny` `^N` records the denial, by whom, as the call's result, and the run ends with no answer.
- `gemini-steer` a steer sent while Gemini works reaches `agy` in the same turn and run.
- `gemini-interrupt` `Esc` cancels `agy`'s turn; the same process takes the next prompt.
- `gemini-resume` a new `agy` process, as after a server restart, loads the session and sets the model and level again.
- `gemini-job` a command still running when `agy`'s turn ends is a job; its end is a report and Gemini's answer comes in a wake run.
- `gemini-wake` `agy` continuing on its own, as for its own subagent's answer, wakes the conversation with "agy continued on its own".
- `gemini-health` `providers/list` says whether `agy` is signed in, its version, and its models and levels, asking Gemini nothing.
- `gemini-remote` a conversation on a target other than `local` is refused on `agy`, saying why.

## How to get to it

### People

- Run `sigma --provider agy`, with `--model` and `--effort` to choose the model and thinking level.
- Switch a conversation to `agy`, or to another of its models, with `/model`.

### Agents

- Run `sigma exec --provider agy '<prompt>'`, with `--auto` to allow calls.
- Call `conversation/start` with `"provider": "agy"`.
- Switch a conversation with `conversation/select_model`.

### Triggers

- A command `agy` ran in the background that ends while the conversation is
  idle starts a wake run (`gemini-job`); so does `agy` speaking on its own,
  as when its own subagent answers (`gemini-wake`).

## Driving it with drive.ts

Preconditions:

- Each journey is its own fresh run, `drive.ts r up --fake-agy <fixture>`
  with the fixture it names, and `drive.ts r down` after it. The fake plays
  one recorded `agy` process per spawn. Without `--fake-agy` or `--real-agy`,
  `agy` is the fake answering only the probe (`models`).
- Every conversation names `--provider agy --model gemini-4-hydrogen --effort low`.
  Type the prompts exactly as written: they are what the recording's user typed.
- What sigma sent `agy` is in `evidence/fake-agy/log.ndjson`.

Steps:

- **Answer** (`gemini-answer`), fixture `text`:
  `drive.ts r sigma exec --provider agy --model gemini-4-hydrogen --effort low 'Reply with exactly: fixture text ok'`:
  stdout `fixture text ok`. `drive.ts r rpc conversation/list` names the
  conversation; `drive.ts r watch <id> --since 0` shows `pi.usage` with
  `agy/gemini-4-hydrogen` `input` 9601.
- **Allow** (`gemini-approval`), fixture `approval_allowed`:
  `drive.ts r tui start --provider agy --model gemini-4-hydrogen --effort low`,
  `drive.ts r tui wait READY`,
  ``drive.ts r tui type 'Run the shell command `touch allowed.txt`, then reply with exactly: touched'``,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'allow this call?'`,
  `drive.ts r tui screen asking`: `▸ run_command(touch allowed.txt)`.
  `drive.ts r tui key C-y`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen allowed`: `✓ allowed by ada` and `touched`.
- **Deny** (`gemini-deny`), fixture `approval_denied`: as Allow with
  `denied.txt`, then `drive.ts r tui key C-n`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen denied`: `✗ denied by ada` and no answer after it.
- **Steer** (`gemini-steer`), fixture `steer`: as Allow with
  ``'Run the shell command `touch steered.txt`, then reply with exactly: done'``;
  at `allow this call?`, type `Also end your reply with the word BANANA.` and
  `Tab`, then `C-y`: one run ends with `done BANANA`.
- **Interrupt** (`gemini-interrupt`), fixture `interrupt`: send
  `Write a 600-word essay about rivers.`, `Esc` once text streams, then
  `Reply with exactly: after the stop`: the first run ends `interrupted`, the
  second answers `after the stop`, and the log shows one spawn and a
  `session/cancel`.
- **Resume** (`gemini-resume`), fixture `restart`:
  `drive.ts r sigma exec --provider agy --model gemini-4-hydrogen --effort low 'Remember the word PLUM. Reply with exactly: noted'`,
  `drive.ts r rpc server/stop`, then
  `drive.ts r sigma exec --conversation <id> 'Which word did I ask you to remember? Reply with that word only.'`:
  stdout `PLUM`; the log's second spawn sent `session/load` with the first
  session's id.
- **Job and wake** (`gemini-job`), fixture `background_wake`, `--auto`:
  ``'Run the shell command `sleep 30; echo bg-marker` and tell me what it printed.'``
  `drive.ts r watch <id> --until sigma.run_end` twice: the first run ends
  with Gemini's holding message, then a `hosted.report` for the command and
  an answer naming `bg-marker` in a second run.
- **Continued on its own** (`gemini-wake`), fixture `subagent_wake`, `--auto`:
  the prompt in `subagent_wake.ndjson`; a second run starts from the report
  `agy continued on its own`.
- **Health** (`gemini-health`): `drive.ts r serve`,
  `drive.ts r rpc providers/list '{}' --timeout 60000`: `agy` is `ready`,
  version `1.5.13`, its models with levels `low` to `xhigh`.
- **Remote** (`gemini-remote`): with a `target_connector` (see
  [Targets](./targets.md)), `conversation/start` with `"provider": "agy"` and
  a `target`, then a prompt: the run ends failed, saying agy runs only on the
  server's machine.

## Contexts

- **Server restart.** A new process loads `agy`'s session (`gemini-resume`).
- **Provider.** `agy` runs its own tools and session, like Claude Code; sigma
  answers its permission requests and reads its Stop hook from a directory
  of its own.
- **Idle.** A job's end while idle wakes the conversation (`gemini-job`).

## Tests

- Provider: `packages/sigma/test/agy.test.ts`, every use case above, over
  `fixtures/agy`.
- Screen: `packages/sigma/test/screen.test.ts`, `gemini-approval` (the card
  shows the command) and `gemini-health` (a signed-out agy says how to sign
  in).
- Record new fixtures with `bun packages/sigma/test/support/record-agy-fixtures.ts [journey...]`.

## Gotchas

- `agy` 1.5.13 fires its Stop hook at the end of a turn it began by itself and
  of an ordinary one, but not of a turn ended by a denial or `session/cancel`:
  sigma ends a prompted turn at the prompt's result, and a wake at the hook.
- `usage_update` says only the context's size; a wake turn has no prompt result,
  so what it spent is not counted.
- An idle `Esc` on a job runs `session/cancel`, which in a turn would also
  cancel the turn.
- `agy`'s own subagents show as plain calls; their late answer is a wake with no
  report. They are not jobs, so a process closed while one works (a server stop,
  the idle release) ends it without a report.
- A turn ended by `Esc`, a denial or an error fires no Stop and no result for
  what agy had in flight; sigma drops what agy says after stopping a wake
  until it is next prompted or a job ends.
- Each health probe opens and closes one `agy` session.

## With a real account

Proves what `agy` does today. Follow the skill's
[Real accounts](../SKILL.md#real-accounts): one run, `drive.ts r up --real-agy`,
which runs the `agy` on your PATH with your own sign-in and settings, in its
default permission mode (a mode your agy settings set would skip
`allow this call?`): never `--dangerously-skip-permissions`, never mode `auto` or
`accept-edits`. First `drive.ts r serve` and
`drive.ts r rpc providers/list '{}' --timeout 60000`: `agy` is `ready` with a
version; otherwise stop and report what it shows. Give every wait
`--timeout 120000`.

- **Answer, approval, denial, usage.** `drive.ts r tui start --provider agy --model gemini-4-hydrogen --effort low`;
  send ``Run the shell command `touch /tmp/sigma-verify/r/touched`, then reply with exactly: touched``,
  wait for `allow this call?` showing the command, `C-y`, wait `READY`:
  `✓ allowed by ada`, `touched`, and the file exists. Send the same with
  `denied`, `C-n`: `✗ denied by ada` and the run ends with no answer.
  `drive.ts r watch <id> --since 0`: `pi.usage` under `agy/gemini-4-hydrogen`.
- **Steer and interrupt.** As in the fake recipes, with real Gemini.
- **Restart.** `drive.ts r kill-server`, then
  `drive.ts r sigma exec --conversation <id> 'Which file did you touch first? Reply with the path only.'`:
  the path; the new `agy` loaded the session.
- **Job and wake.** `--auto`, ``Run the shell command `sleep 30; echo bg-marker` and tell me what it printed.``:
  the first run ends with a holding message; a report and an answer with
  `bg-marker` follow in a second run nobody prompted.
