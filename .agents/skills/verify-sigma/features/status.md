# Status and chosen ids

A client can follow every conversation people started and every worker without
reading its transcript: `status/watch` lists the trees that are busy (one tree
per conversation people started, and one per worker, each together with its
hosted subagents), then reports each commit that changes a tree's status or
ends its root's run, with how that run ended and what the model said last. A
client that was not watching when a run ended reads the same from the
conversation's `ended`. A client can also choose a new conversation's id, and
starting with an id that exists answers with that conversation. attn uses these
to run Sigma sessions.

## Sub-features

- `status-snapshot` opens with every tree that is not idle; the rest are idle.
- `status-follow` reports `working`, `waiting` and `idle` for each tree, in
  `seq` order. Each worker is the root of a tree of its own, so a worker's
  status and run end report on the worker's tree, not its parent's.
- `status-subagent` shows a hosted subagent waiting on a person as its parent's
  tree `waiting`.
- `status-ended` carries the outcome of the root's run and its last message.
- `conversation-ended` shows how a conversation's last run ended, as `ended`
  on it in `conversation/list`, also after a restart; a conversation that
  never ran has none.
- `start-with-id` starts a conversation with a chosen id, and answers a second
  start with that id with the first conversation.
- `status-shown` reports each conversation a client says it shows with
  `client/shows`, under that client's author, and the snapshot lists what
  clients show now. The TUI says it once it opens a conversation, such as the
  fork `/fork` moved it to, and again after each reconnect; a fork it never
  opened is never reported.

## How to get to it

### People

- Opening a conversation in the TUI, or moving to a fork with `/fork`, says
  it shows that conversation (`status-shown`).

### Agents

- Call `status/watch`, a stream.
- Call `client/shows`, a stream that lasts while the client shows the conversation.
- Call `conversation/start` with `id`.
- Call `conversation/list`.

## Driving it with drive.ts

Preconditions:

- A fresh run, here `r`, with `--script` steps that spawn a subagent which writes a file (put your run id where the path says `<run>`):
  `[{"tool": {"name": "start_worker", "input": {"task_name": "writer", "message": "go"}}}, {"tool": {"name": "wait_worker", "input": {"timeout_ms": 600000}}}, {"agent": "/root/writer", "tool": {"name": "write", "input": {"path": "/tmp/sigma-verify/<run>/note.txt", "content": "hi"}}}]`.

- **Chosen id.** Run
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "id": "11111111-1111-4111-8111-111111111111", "cwd": "/tmp"}'`,
  then the same call with `"cwd": "/elsewhere"`. Both answer
  `"conversation": "11111111-1111-4111-8111-111111111111"`, and
  `conversation/list` shows it once, with `cwd` `/tmp`. After
  `drive.ts r kill-server` and `drive.ts r serve` the same call answers the
  same conversation. An all-digit id such as `"42"` is refused by name.
- **Follow.** In one shell run `drive.ts r watch-status --save status`.
  In another, run
  `drive.ts r rpc conversation/submit '{"conversation": "11111111-1111-4111-8111-111111111111", "requestId": "s1", "author": {"id": "ada", "name": "ada"}, "text": "write a note"}'`.
  The watch opens with the trees that are busy, none here, then prints the
  parent's tree `working`, and the worker's own tree `working`, then `waiting`
  once the worker asks.
- **Shown.** With the server up, run
  `drive.ts r watch-status --save shown` in one shell. In another, run
  `SIGMA_AUTHOR_ID=attn-terminal:t-1 drive.ts r tui start --conversation 11111111-1111-4111-8111-111111111111`,
  type a prompt, wait for its answer, then type `/fork`. The watch prints
  `{"_tag":"shown","author":{"id":"attn-terminal:t-1",...},"conversation":"11111111-1111-4111-8111-111111111111"}`
  once the TUI draws it, then the same with the fork's number once the fork's
  screen opens. A new `drive.ts r watch-status` lists the fork under `shown`
  in its first line.
- **Snapshot.** While it waits, run `drive.ts r watch-status`: its first line
  lists the parent's tree as `working` and the worker's tree as `waiting`. It
  returns after a second with no change.
- **Ended.** Run
  `drive.ts r rpc conversation/interrupt '{"author": {"id": "ada", "name": "ada"}, "conversation": "11111111-1111-4111-8111-111111111111"}'`
  while `drive.ts r watch-status 11111111-1111-4111-8111-111111111111 --until idle`
  runs. Interrupting stops only the parent (the worker stays `waiting` on its
  own tree), and the parent's last line is `idle` with
  `"ended":{"outcome":"interrupted","message":"aborted"}`. Interrupting the
  worker's own conversation ends the worker's tree `idle` with the same `ended`.
- **Ended, read later.** Then run `drive.ts r rpc conversation/list`: the
  conversation carries `"ended":{"outcome":"interrupted","message":"aborted"}`,
  with `said` when the model wrote a message.

## Contexts

- **Hosted subagents.** A hosted subagent waiting on a person shows its parent's
  tree as waiting.
- **Workers.** A worker starts a tree of its own: its status and run ends report
  under its own id, while its parent's tree reports only the parent's own run
  and hosted subagents.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- start-with-id: starting a conversation with an id it already has answers with that conversation, and an all-digit id is refused by name
- start-with-id: a chosen id that names an object property, such as toString, opens its own conversation
- approval-restart, status-snapshot: a call waiting for approval across a restart asks again after it, and runs once allowed
- status-follow, status-ended: watching status follows each run of a tree and says how it ended
- status-follow, status-snapshot, status-ended: a worker waiting on a person reports its own tree waiting while its parent reports only its own run, and the worker's own tree survives a server restart
- conversation-ended: conversation/list tells a client that was not watching how a conversation's last run ended, also after a restart
- status-shown: what a client says it shows reaches every status watcher under its author, by the id other calls use, and later watchers find it in the snapshot

Provider, `packages/sigma/test/claude.test.ts`:

- status-subagent, status-snapshot, subagent-claude: a hosted Claude subagent waiting on a person shows its parent's tree waiting, to watchers then and later

Screen, `packages/sigma/test/screen.test.ts`:

- start-with-id: a launcher opens sigma on an id it chose with a first prompt, and that id reopens the conversation
- status-shown: the TUI says which conversation it shows once it opens it, then the fork /fork opened, and says it again to a server that replaced its own
- status-shown: of two /fork typed at once, the TUI reports only the fork it opened, never the one it left behind

Stack, `packages/sigma/test/stack.test.ts`:

- crash-limit, conversation-ended: a run that keeps crashing the server stops after three tries instead of looping, and the conversation list says why
- start-with-id: a conversation opened on a client's id survives a restart, and a second start with it is answered

## Gotchas

- Replace `r` in the commands with your run id. `watch` and `watch-status`
  wait for their `--until`, so start the first of two in the background or a
  second shell, and run `drive.ts r serve` before either.

- A tree's status changes only when the commit changes it; a subagent that
  starts working inside a working tree reports nothing.
- An interrupted tree can report `working` after `waiting` and before
  `idle`. That is the committed state while its runs wind down, not a stale
  status.
- `shown` is what a client said, not a commit: it carries no `seq`, a
  server restart forgets it until each TUI says it again, and nothing is
  sent when a client stops showing a conversation. Read the snapshot for
  what clients show now; the last entry for an author is the newest.
- In `status/watch`, `ended` belongs to the root's own run. A subagent's run
  ending never carries it there.
