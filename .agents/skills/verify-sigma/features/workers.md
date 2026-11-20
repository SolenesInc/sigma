# Workers

A model on sigma's own loop (ChatGPT, or the script), Claude Code, which
reaches them over sigma's MCP server as `mcp__sigma__<tool>`, and Gemini
through `agy`, which reaches them as `mcp_sigma_<tool>` over sigma's bridge,
can start workers with the worker tools: `start_worker`, `wait_worker`, `message_worker`,
`assign_worker`, `list_workers` and `stop_worker`. A worker is a conversation
of its own, under its parent in a tree, on any ready provider of the home:
its parent's, by default, or the `provider` and `model` its `start_worker`
names, which pass unchanged. It shares its parent's directory and target, is
addressed by a task name such as `/root/scribe`, takes input from people,
asks for its own approvals, and outlives its parent's turn. The parent's
transcript shows a card per worker with what it last did and whether it
works, waits on a person or ended; a call the worker asks about shows on its
card and `^Y` or `^N` answers it from the parent. A worker's last message of
each run reaches its parent: through `wait_worker` when the parent waits,
otherwise as mail; a worker whose job outlives its run mails what it says
when the job wakes it. `Esc` stops the run and every worker's under it. Claude
Code's own subagents are not workers: Claude Code runs them, and sigma
commits each into a conversation of its own the same way (`subagent-claude`).
A local Claude Code keeps its Agent tool beside the worker tools; on a
target, its Agent tool is off and it has only sigma's tools
(`target-member-mode`). What a worker's requests keep of the
prompt cache is in [Prompt cache](./prompt-cache.md).

## Sub-features

- `worker-start` starts a worker from a `start_worker` call, which answers
  `{"task_name": "/root/<name>"}` at once: the TUI draws a `⧉ <name>` card in
  place of the call, and `conversation/list` gains a conversation whose
  `lineage` names its `parent`, `root`, `call`, `task` and `title`.
- `worker-provider` starts a worker on another ready provider named in
  `provider`, Claude Code included. It starts from its brief alone: no fork
  (`fork_turns` `"all"` is refused), none of the parent's instructions, and
  the `model` named, the agent type's model if the destination lists it, or
  that provider's default. An unknown provider, or one
  that is not ready, is refused, naming the ready ones:
  `no provider <p>; the ready providers are ...` or
  `provider <p> is not ready; the ready providers are ...`. The tool's
  description lists the home's providers.
- `worker-section` tells a model that can call `start_worker`, directly or
  from a code mode script, what a worker is and to pass a named provider and
  model unchanged, in a `Workers.` paragraph of its instructions. It names no
  reason to prefer one provider over another. Claude Code gets it in its
  appended system prompt, before the conversation's instructions, naming
  `mcp__sigma__start_worker`; on a target, where Claude Code has no Agent
  tool, it says `For a quick helper inside your own turn, do the work yourself.`
  `agy` gets it as `_meta.antigravity.systemPrompt.append` on `session/new`,
  naming `mcp_sigma_start_worker`. A harness's section also says that every
  worker it starts begins from its message alone.
- `worker-claude-parent` offers a local Claude Code the six worker tools on
  sigma's MCP server `sigma`, beside its own tools and the person's settings,
  each always loaded rather than behind its tool search. Each call is committed
  under sigma's name for the tool (`start_worker`, not
  `mcp__sigma__start_worker`) and run by sigma; Claude Code's own permission
  prompt for it is allowed at once (`"behavior":"allow"` in the fake's log),
  and a tool that asks a person asks once, through sigma, as on a target. A
  call a Claude subagent makes is committed in the subagent's conversation.
- `worker-gemini-parent` offers Gemini the six worker tools over MCP: `agy`
  starts `sigma mcp-bridge <socket>` from the session's `mcpServers`, which
  pipes its stdio to a socket in the home's `bridges/` that the `agy` process
  serves; the socket goes with the process, and a server that starts removes
  any a killed one left. Each `tools/call` is paired with the call `agy`
  announced by name and arguments, committed under sigma's name with the
  arguments `agy` passed over MCP (not the `toolSummary` it adds to the
  announced call), and run by sigma; `agy`'s own permission request for it is
  allowed at once, so a tool that asks a person asks once, through sigma. A
  call from one of `agy`'s own subagents is refused.
- `worker-wake-mail` mails a worker's answer naming its jobs still working,
  as `Still working: "<job title>".` after the answer, and never waits for
  them. When a job's end wakes an idle Claude Code worker, the wake run's
  answer reaches the parent as mail of kind `message`, which `wait_worker`
  returns with `"kind": "message"`.
- `worker-fork` gives a worker on its parent's provider its parent's history up to the start
  (its view's `conversation.parent`), or none with `"fork_turns": "none"`. Only a
  parent on sigma's own loop forks: a Claude Code or Gemini parent's worker,
  on its own provider too, starts a session of its own from its brief, as
  `start_worker`'s description and its workers section say; it does not fork
  with `"fork_turns": "all"` either.
- `worker-model` runs a worker on its parent's model, or on the `model` and
  `effort` its `start_worker` names, unchanged. A provider whose loop sigma
  runs must list the model, or the call fails; Claude Code takes any name.
- `worker-card` shows the card's state: `working`, `waiting on you` with the
  asked call and `allow <Tool(subject)>? · answer below`, `done` with its
  last message, `interrupted` or `failed`; a Claude background subagent's
  card reads `stopped` or `cut off` when its job ended so.
- `worker-approve` answers a worker's asked call with `^Y` or `^N` in the
  parent's TUI, from the `WAITING ON YOU` panel (`approval-panel` in
  [Tool calls and approvals](./tool-calls-and-approvals.md)), or
  `approval/resolve` on the worker's conversation. A call
  asked deeper in the tree shows on the card of the worker above it.
- `worker-message` delivers a parent's `message_worker` to a running worker
  at its next step, as a `sigma.mail` entry of kind `message`
  inside the same run; it starts no run.
- `worker-list` shows the tree with `list_workers`
  (`{"workers": [{"name", "status"}]}`, each `running`, `interrupted`,
  `completed` or `errored`), and stops one worker from its parent with
  `stop_worker`, answering its `previous_status`.
- `worker-root-env` runs a worker's commands with
  `SIGMA_ROOT_CONVERSATION` set to the conversation people started.
- `worker-answer` hands a worker's last message to its parent: a waiting
  `wait_worker` returns it as
  `{"timed_out": false, "received": [{"from": "/root/<name>", "kind": "final_answer", "text": ...}]}`
  and takes it out of the parent's inbox, so it is not also delivered as
  mail; the TUI draws it under a `/root/<name>` author. A parent that is not
  waiting gets it as mail at its next step, and an idle parent as input that
  starts a run.
- `worker-wait` returns `{"timed_out": true, "received": []}` when nothing
  arrives within `timeout_ms` (default 30 s, clamped to 10 s at least, with a
  `message` saying so), and returns early, with nothing received and
  `Wait interrupted by new input.`, when a person steers input in. A parent
  on `agy`, which cuts an MCP call at 180 s, waits at most 150 s per call,
  and a wait cut short says
  `Waited 150000ms, the longest one call can wait here; call wait_worker again to keep waiting.`
- `worker-person` answers a person's input to a worker in the worker's own
  conversation; its parent is told nothing.
- `worker-assign` wakes an idle worker with `assign_worker`, and each of
  its answers reaches the parent.
- `worker-interrupt` stops the parent's run with `Esc` or
  `conversation/interrupt`, and leaves its workers working; a second `Esc`,
  on the idle parent, stops every run under it, and the card shows
  `interrupted` (`interrupt-idle` in [Interrupt](./interrupt.md)), a worker on
  another provider included, whose waiting approval clears. Stopping
  just a worker, from its own conversation, stops its run, not its parent.
  The workers Claude Code starts in the background differ: Claude Code
  stops them with its parent's run.
- `worker-exec` makes `sigma exec` without `--auto` deny the calls its
  workers would ask about, as it does its own; `exec` follows every
  conversation of its tree.
- `worker-limits` takes `[agents] max_threads` (default 6) from
  `SIGMA_HOME/config.toml`: a tree runs at most `max_threads` workers at
  once, and a start past it fails naming `max_threads`. A worker keeps
  `start_worker` and starts workers of its own, as deep as the limit allows.
  `max_threads = 0` turns workers off: no conversation, the root included,
  is offered `start_worker`.
- `worker-types` reads agent types from `.claude/agents/*.md` from the
  directory up to the repository root, then Claude Code's config directory's
  `agents/` (`$CLAUDE_CONFIG_DIR`, else `~/.claude`; a conversation on a target
  reads only the project's). ChatGPT and Claude Code on a target are told
  which types they can pass in `agent_type` under the Agent types heading.
  The caller's types apply when it starts a worker on any provider. Sigma
  looks on the destination if the caller has no type of that name. An
  unknown type fails the call and lists the available types. A worker on
  its parent's provider gets the parent's inherited instructions before its
  task line. A worker on another provider starts with the task line. The
  heading `# You are a <name> agent` and the type's body follow in either case.
  The worker's lineage has `agentType` and its card reads `⧉ <name> (<agent type>)`.
  A ChatGPT worker on its parent's provider uses the type's model when
  ChatGPT lists it and the call omits a model.
- `subagent-claude` gives each subagent Claude Code starts a conversation of
  its own: the parent shows a `⧉ <description> (<agent type>)` card in place
  of the `Agent` call, the subagent's conversation holds its prompt, calls, results and last
  message, and its `lineage` has no `task`. Its own `hosted.job` task writes
  that conversation after the prompt, not its parent's run: those entries'
  `byTaskId` is the job's, and its approvals are keyed `<job task>/<call>`.
  Its calls wait on a person there and on its card. Input to it is refused with `TakesNoInput`, and its TUI
  prompt reads `INPUT GOES THROUGH ITS PARENT`. `Esc` there stops only it;
  stopping the parent ends it `interrupted`, and so does a server crash.

## How to get to it

### People

- Ask an OpenAI conversation for work it hands to subagents, in the TUI.
- Ask a Claude conversation to use its Task tool for a subagent, or to start a
  worker, naming `mcp__sigma__start_worker` or a provider.
- Open a subagent with `sigma --conversation <id>`.
- Set `[agents] max_threads` in `SIGMA_HOME/config.toml` before the server starts.

### Agents

- Run `sigma exec --provider openai` with such a prompt.
- Drive it without a model through `SIGMA_MODEL_SCRIPT`: a step with `"agent": "/root/<name>"` is played by that subagent, the others by the parent.
- Read the tree with `conversation/list` (`lineage`).
- Set `[agents] max_threads` in `SIGMA_HOME/config.toml` before the server starts.

## Driving it with drive.ts

Preconditions:

- A fresh run for each journey, with the script or fixture it names, and
  `drive.ts r down` after it. Write each script to a file and pass it with
  `drive.ts r up --script <file>`.
- Take ids from `drive.ts r rpc conversation/list`: the parent has no
  `lineage`, each subagent has one.

- **Spawn, approve, answer.** With this script:

  ```json
  [
    { "tool": { "name": "start_worker", "input": { "task_name": "scribe", "message": "write it down" } } },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "text": "the scribe is done" },
    { "agent": "/root/scribe", "tool": { "name": "bash", "input": { "command": "echo scribbled" } } },
    { "agent": "/root/scribe", "text": "wrote it" }
  ]
  ```

  `drive.ts r tui start`, wait for `READY`, type `delegate` and `Enter`. Wait
  for `allow bash(echo scribbled)?`: the screen shows
  `⧉ scribe waiting on you` (the card stands in place of the call), `bash(echo scribbled)`,
  `allow bash(echo scribbled)? · answer below`, the panel row
  `⧉ scribe allow bash(echo scribbled)?  ^Y  allow  ^N  deny` and `◆ WAITING`. Press
  `C-y` and wait for `the scribe is done`: the card reads `⧉ scribe done` over
  `wrote it`, `▸ wait_worker` with `/root/scribe` saying `wrote it` under it,
  then `SIGMA` says `the scribe is done`, `■ READY`.
  `drive.ts r rpc conversation/list` lists the subagent with
  `"lineage": {"parent": <the TUI's conversation>, "task": "/root/scribe", "title": "scribe", ...}`.

- **Claude Code as the parent** (`--fake-claude worker_parent`, with this
  script for the worker):

  ```json
  [{ "agent": "/root/helper", "text": "hello from the worker" }]
  ```

  `drive.ts r up --fake-claude worker_parent --script <file>`,
  `drive.ts r tui start --provider claude`, wait for `READY`, type
  `Use the mcp__sigma__start_worker tool with task_name helper, provider script and message: Say hello. Then call mcp__sigma__wait_worker with timeout_ms 60000, and reply with exactly the text the worker sent.`
  and `Enter`, then wait for `READY` again and save the screen: a
  `⧉ helper done` card, `▸ wait_worker` with `/root/helper` saying
  `hello from the worker`, and `SIGMA` saying `hello from the worker`; no
  `allow this call?` was shown. `evidence/fake-claude/log.ndjson`'s
  `initialize` lists `"sdkMcpServers":["sigma"]` with the six tools, and
  `appendSystemPrompt` starts
  `Workers. This session can start workers with the mcp__sigma__start_worker tool.`;
  both `can_use_tool` answers are `"behavior":"allow"`. `conversation/list`
  holds `/root/helper` on `script` with the Claude conversation as `parent`.

- **Wake mail** (`--fake-claude bash_background_wake`). With this script:

  ```json
  [
    {
      "tool": {
        "name": "start_worker",
        "input": { "task_name": "runner", "message": "start it", "provider": "claude" }
      }
    },
    { "text": "started it" },
    { "text": "read one" },
    { "text": "read two" }
  ]
  ```

  `drive.ts r up --fake-claude bash_background_wake --script <file> --auto`,
  `drive.ts r sigma exec --auto delegate`, then
  `drive.ts r watch <parent id> --until sigma.mail --save mail` until it holds two
  `sigma.mail` entries: one `final_answer`, and one `message` whose payload is
  `The background command finished with exit code 0. Its output was \`done\`.`and names no job. The runner's own`watch`holds a`hosted.report` and that
  answer in a second run nobody prompted.

- **Message, list and interrupt.** With this script:

  ```json
  [
    {
      "tool": {
        "name": "start_worker",
        "input": { "task_name": "reader", "message": "read the hostname", "fork_turns": "none" }
      }
    },
    { "tool": { "name": "list_workers", "input": {} } },
    { "tool": { "name": "message_worker", "input": { "target": "reader", "message": "also say it twice" } } },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "text": "reader reported" },
    {
      "agent": "/root/reader",
      "text": "reading it now slowly",
      "delayMs": 600,
      "tool": { "name": "read", "input": { "path": "/etc/hosts" } }
    },
    { "agent": "/root/reader", "text": "read it" }
  ]
  ```

  run `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp", "provider": "script"}'`
  and
  `drive.ts r watch <id> --submit delegate --until run_end --timeout 30000 --save message`:
  `list_workers` returns
  `{"workers":[{"name":"/root","status":"running"},{"name":"/root/reader","status":"running"}]}`,
  `message_worker` returns an empty result, `wait_worker` returns
  `{"timed_out":false,"received":[{"from":"/root/reader","kind":"final_answer","text":"read it"}]}`,
  and `reader reported` ends the run.
  `drive.ts r watch <reader id> --save reader` shows a `sigma.mail`
  `new_task`, the `read` call and its result, then a `sigma.mail` `message`
  `also say it twice`, then `read it` and a `sigma.run_end` `answered`: the
  message joined the run after its call finished.

- **Interrupt one subagent from the parent.** In a fresh run, with this
  script:

  ```json
  [
    {
      "tool": {
        "name": "start_worker",
        "input": { "task_name": "slowpoke", "message": "count slowly", "fork_turns": "none" }
      }
    },
    { "tool": { "name": "stop_worker", "input": { "target": "slowpoke" } } },
    { "tool": { "name": "list_workers", "input": {} } },
    { "text": "stopped it" },
    { "agent": "/root/slowpoke", "text": "one two three four five six seven eight nine ten", "delayMs": 1500 }
  ]
  ```

  start a `script` conversation as above and run
  `drive.ts r watch <id> --submit 'stop the slowpoke' --until run_end --save interrupt-agent`:
  `stop_worker` returns `{"previous_status":"running"}`, `list_workers`
  then lists `/root/slowpoke` as `interrupted`, and the run ends
  `stopped it`. `drive.ts r watch <slowpoke id>` shows the `sigma.mail`
  `new_task` and a `sigma.run_end` `interrupted`.

- **Answered over the wire.** With the `Spawn, approve, answer` script, run
  `drive.ts r serve`, start a `script` conversation, and
  `drive.ts r watch <id> --submit delegate --until pi.tool-result`; take the
  subagent's id from `drive.ts r rpc conversation/list`. Run
  `drive.ts r watch <subagent id> --save scribe-asking` and take the key of
  the request in its `docs.sigma.approvals.requests`, the approval id. Run
  `drive.ts r rpc approval/resolve '{"conversation": "<subagent id>", "approval": "<approval>", "author": {"id": "bo", "name": "bo"}, "allow": true}'`:
  `"accepted": true`; the same call with `"author": {"id": "cy", "name": "cy"}` and
  `"allow": false` answers `"accepted": false`. `drive.ts r watch <subagent id>`
  shows the `sigma.approval` by `bo`, the `pi.tool-result` `scribbled`, then
  `wrote it`, and `drive.ts r watch <id>` ends `the scribe is done`.

- **Asked two levels down.** A subagent starts its own under the default
  config. Use the script

  ```json
  [
    { "tool": { "name": "start_worker", "input": { "task_name": "lead", "message": "get it done" } } },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "text": "the lead is done" },
    {
      "agent": "/root/lead",
      "tool": { "name": "start_worker", "input": { "task_name": "helper", "message": "do the thing" } }
    },
    { "agent": "/root/lead", "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "agent": "/root/lead", "text": "the helper is done" },
    { "agent": "/root/lead/helper", "tool": { "name": "bash", "input": { "command": "echo deep" } } },
    { "agent": "/root/lead/helper", "text": "did it" }
  ]
  ```

  `drive.ts r tui start`, wait for `READY`, type `delegate` and `Enter`, and
  wait for `allow bash(echo deep)?`: on the parent's screen `⧉ lead waiting on you`
  holds `allow bash(echo deep)? · answer below`, though the call is the
  helper's, and the panel names the helper: `⧉ helper allow bash(echo deep)?`. Press `C-y` and wait for `the lead is done` and `READY`: the card
  reads `⧉ lead done` over `the helper is done`.
  `drive.ts r rpc conversation/list` has `"task": "/root/lead/helper"`, and
  `drive.ts r watch <helper id>` shows a `sigma.approval` by `ada` and the
  `pi.tool-result` `deep`.

- **Root conversation in a subagent.** With the script

  ```json
  [
    { "tool": { "name": "start_worker", "input": { "task_name": "envy", "message": "show your root" } } },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "text": "envy answered" },
    { "agent": "/root/envy", "tool": { "name": "bash", "input": { "command": "echo root=$SIGMA_ROOT_CONVERSATION" } } },
    { "agent": "/root/envy", "text": "shown", "delayMs": 1 }
  ]
  ```

  run `drive.ts r sigma exec --auto delegate`: stdout `envy answered`. Take the
  ids from `drive.ts r rpc conversation/list`: the subagent's `lineage` names
  the parent as `root`. `drive.ts r watch <subagent id> --save root-env`
  holds a `pi.tool-result` `root=<the parent's id>`.

- **Exec denies a subagent's call.** With the `Spawn, approve, answer` script, in a fresh run,
  `drive.ts r sigma exec delegate`: exit 0, stdout `the scribe is done`,
  stderr `› start_worker(scribe)`, `› wait_worker` and
  `denied bash(echo scribbled): exec cannot ask, pass --auto to allow calls`:
  `exec` follows every conversation of its tree. `drive.ts r watch <subagent id>`
  shows the denied call's `pi.tool-result`, then `wrote it`. In another fresh run, `drive.ts r sigma exec --auto delegate`
  prints no denial.

- **Interrupt.** With the script

  ```json
  [
    { "tool": { "name": "start_worker", "input": { "task_name": "slowpoke", "message": "count slowly" } } },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "agent": "/root/slowpoke", "text": "one two three four five six seven eight nine ten", "delayMs": 1500 }
  ]
  ```

  `drive.ts r tui start`, wait for `READY`, type `count`, `Enter`, wait for
  `slowpoke`, press `Escape` and wait for `READY`: the card reads
  `⧉ slowpoke interrupted`, then `◆ interrupted`.

- **Interrupt over the wire.** With the script

  ```json
  [
    {
      "tool": { "name": "start_worker", "input": { "task_name": "slow", "message": "make it", "fork_turns": "none" } }
    },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "tool": { "name": "bash", "input": { "command": "touch made" } }, "agent": "/root/slow" }
  ]
  ```

  run `drive.ts r serve`, start a conversation with `conversation/start`, and
  `drive.ts r watch <id> --submit 'start a slow one' --save root-start`; take
  the subagent's id from the `details` of the `start_worker` result.
  `drive.ts r watch <subagent id>` shows its `bash` call in
  `sigma.approvals`. Run
  `drive.ts r rpc conversation/interrupt '{"author": {"id": "ada", "name": "ada"}, "conversation": "<id>"}'` (result
  `null`) on the root only. `drive.ts r watch <id>` and
  `drive.ts r watch <subagent id>` each end with a `sigma.run_end`
  `interrupted`, no `pi.live` run, and the subagent's approval requests are
  empty; `made` was never created.

- **Follow-up.** With the script

  ```json
  [
    { "tool": { "name": "start_worker", "input": { "task_name": "scribe", "message": "note one thing" } } },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "tool": { "name": "assign_worker", "input": { "target": "scribe", "message": "note another" } } },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "text": "both notes in" },
    { "agent": "/root/scribe", "text": "first note", "delayMs": 1000 },
    { "agent": "/root/scribe", "text": "second note", "delayMs": 1000 }
  ]
  ```

  run `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp", "provider": "script"}'`
  and
  `drive.ts r watch <id> --submit 'take notes' --until run_end --save followup`:
  each `wait_worker` returns a `final_answer` from `/root/scribe` in
  `received`, `first note` then `second note`, then `both notes in`; the
  parent's transcript holds no `sigma.mail`, since each wait took its answer.
  `drive.ts r watch <subagent id> --save scribe` shows two runs, started by
  `note one thing` and `note another`, each a `sigma.mail` `new_task` from
  `/root`.

- **Idle parent, no history, another model.** With the script

  ```json
  [
    {
      "tool": {
        "name": "start_worker",
        "input": { "task_name": "loner", "message": "go alone", "fork_turns": "none" }
      }
    },
    {
      "tool": {
        "name": "start_worker",
        "input": { "task_name": "other", "message": "go elsewhere", "model": "gpt-5.5" }
      }
    },
    { "text": "sent off" },
    { "agent": "/root/loner", "text": "back later", "delayMs": 1500 }
  ]
  ```

  start a `script` conversation as above and run
  `drive.ts r watch <id> --submit 'send them' --until run_end --save sent`:
  the second `start_worker` fails with
  `no model gpt-5.5 on script; leave model out to use yours`, and the run ends
  `sent off`. `conversation/list` holds one subagent, `/root/loner`, whose
  view has no `conversation.parent`. Run
  `drive.ts r watch <loner id> --until run_end`, then
  `drive.ts r watch <id> --save idle-parent`: after the parent's
  `sigma.run_end` comes `back later` from `/root/loner` as a `sigma.mail`
  `final_answer`, which starts a new run of the parent.

- **Limits.** Thread limit: write `[agents]` and `max_threads = 1` to
  `/tmp/sigma-verify/r/home/config.toml` after `up` and before anything starts
  the server, and use the script

  ```json
  [
    { "tool": { "name": "start_worker", "input": { "task_name": "first", "message": "go" } } },
    { "tool": { "name": "start_worker", "input": { "task_name": "second", "message": "go too" } } },
    { "tool": { "name": "wait_worker", "input": { "timeout_ms": 600000 } } },
    { "text": "one at a time" },
    { "agent": "/root/first", "text": "first done", "delayMs": 1000 }
  ]
  ```

  `drive.ts r sigma exec spread`: stdout `one at a time`, and
  `drive.ts r watch <parent id> --save threads` shows the second
  `start_worker`'s result starting
  `at most 1 workers work at once (max_threads)`.
  Subagents off: in a fresh run, `drive.ts r up --fake-openai subagent`, write
  `[agents]` and `max_threads = 0` to the same file, and run
  `drive.ts r sigma exec --provider openai 'Send a scout to find the gnome.'`:
  in `evidence/fake-openai.ndjson` the first request's `tools` has no
  `start_worker`. The recording calls it anyway, and the call's result is
  `Tool start_worker is not available`. `conversation/list` holds no
  subagent.

- **OpenAI subagent** (`--fake-openai subagent`). `drive.ts r tui start --provider openai`,
  wait for `READY`, type `Send a scout to find the gnome.` and `Enter`, then
  wait for `The scout says` and `READY`: `⧉ scout done` over `Under the floor.`, `▸ wait_worker` with
  `/root/scout` saying `Under the floor.` under it, then `The scout says: under the floor.`
  `conversation/list` has the subagent with `"task": "/root/scout"`. In
  `evidence/fake-openai.ndjson` all three requests are `as recorded`; the
  second is the subagent's: no `start_worker` tool, and six input items: the
  parent's prompt, the `start_worker` and `wait_worker` calls from the spawning
  response, two placeholder results reading
  `Tool result unavailable: history ends before this call completed.`, then
  `Message Type: NEW_TASK` for `/root/scout`.

- **Agent types, no history** (`--fake-openai subagent_of_a_type`, whose
  `start_worker` names `"agent_type": "reviewer"` and `"fork_turns": "none"`).
  Make a project with an agent type:

  ```sh
  P=/tmp/sigma-verify/r/project
  mkdir -p $P/.git $P/.claude/agents
  printf -- '---\nname: reviewer\ndescription: Reviews diffs\n---\nBe strict about tests.\n' > $P/.claude/agents/reviewer.md
  ```

  Run `drive.ts r serve` with `CLAUDE_CONFIG_DIR` set to an empty folder, so
  your own agent types stay out,
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp/sigma-verify/r/project", "provider": "openai"}'`
  and
  `drive.ts r watch <id> --submit 'Get the diff reviewed.' --until run_end --save typed`:
  the answer is `The reviewer approves.`, and `conversation/list` shows the
  subagent with `"agentType": "reviewer"` in its `lineage` and no
  `forkedAt`. In `evidence/fake-openai.ndjson`, all `as recorded`, the
  parent's instructions list `- reviewer: Reviews diffs` under
  `# Agent types`, and the second request,
  the subagent's, has one input item, instructions holding
  `# You are a reviewer agent`, and no `start_worker` tool.

- **Claude subagent asks** (`--fake-claude subagent_asks`).
  `drive.ts r tui start --provider claude`, wait for `READY`, type
  ``Use the Task tool to start a general-purpose subagent that runs the bash command `touch made.txt` with the Bash tool and reports when it is done. Do not run it yourself. Then reply with exactly: made``
  and `Enter`, then wait for `waiting on you`:
  `⧉ Create made.txt file (general-purpose) waiting on you` over
  `Bash(touch made.txt)` and `allow Bash(touch made.txt)? · answer below`, and the
  `WAITING ON YOU · 1` panel holds its row with `^Y  allow  ^N  deny`.
  Press `C-y` and wait for `READY`: the card reads `done` over
  ``Done. `touch made.txt` ran in <checkout>``, then `made`. `drive.ts r rpc conversation/list`
  lists the subagent with `lineage` `parent`, `root`, `call`,
  `"title": "Create made.txt file"` and
  `"agentType": "general-purpose"`, and no `task`. `drive.ts r tui stop`,
  then `drive.ts r tui start --conversation <subagent id>` and
  `drive.ts r tui wait 'INPUT GOES THROUGH ITS PARENT'`: its prompt, the call
  `✓ allowed by ada`, and its report ``Done. `touch made.txt` ran``.
  `drive.ts r rpc conversation/submit '{"conversation": "<subagent id>", "author": {"id": "ada", "name": "ada"}, "text": "hi", "requestId": "r1"}'`
  fails with `TakesNoInput`.

- **Claude subagent, plain** (`--fake-claude subagent`). Send
  `Use the Task tool to start a general-purpose subagent that reads notes.txt with the Read tool and reports where the gnome lives. Do not read it yourself. Then reply with where the gnome lives, in three words.`
  with `drive.ts r tui start --provider claude`, and wait for
  `The gnome lives under the floor.` and `READY`:
  `⧉ Locate gnome in notes.txt (general-purpose) done` over its last
  message, and the answer. No call waits on you. `conversation/list` lists
  the subagent with `"title": "Locate gnome in notes.txt"` and
  `"agentType": "general-purpose"`. `drive.ts r watch <subagent id> --save plain-sub`
  holds the prompt, a `Read` call that ran without a `sigma.approval`, its
  `pi.tool-result`, the answer and a `sigma.run_end` `answered`. `drive.ts r tui stop`, then
  `drive.ts r tui start --conversation <subagent id>` and
  `drive.ts r tui wait 'INPUT GOES THROUGH ITS PARENT'`: the same transcript.
  The recording's prompt and answer name your checkout, which replaces the
  recording's `<workspace>` paths, and the recorded `notes.txt` text, which
  the fake does not read from your disk.

- **Claude subagent stopped over the wire** (`--fake-claude subagent_stopped`).
  Send the prompt of `Claude subagent, plain` and wait for `(general-purpose) working`. Run
  `drive.ts r rpc conversation/interrupt '{"conversation": "<subagent id>", "author": {"id": "ada", "name": "ada"}}'`,
  then wait for `READY`: the card reads `interrupted`, and the parent goes on
  to `The subagent call was interrupted before it started`, the recorded
  model's own words. `evidence/fake-claude/log.ndjson` holds a
  `stop_task` request.

- **Claude subagent stopped with `Esc` in its own pane**
  (`--fake-claude subagent_stopped`). Send the prompt of
  `Claude subagent, plain` and wait for
  `(general-purpose) working`. `drive.ts r tui stop`; the parent's run goes
  on. `drive.ts r tui start --conversation <subagent id>`,
  `drive.ts r tui wait 'INPUT GOES THROUGH ITS PARENT'`,
  `drive.ts r tui screen sub-working`: `WORKING`, the prompt and
  `▸ Read(<checkout>/notes.txt)`. Press `Escape`, wait for `interrupted`,
  `drive.ts r tui screen sub-stopped`: `◆ interrupted`. The log holds one
  `stop_task` request, and `drive.ts r watch <parent id> --save parent` ends
  with the answer `The subagent call was interrupted before it started, ...`
  and a `sigma.run_end`
  `answered`: only the subagent stopped.

## Contexts

- **Ids.** `conversation/list` lists each subagent after its parent, with
  `lineage` naming `parent`, `root`, `call` (the `start_worker` call's id),
  `title` and `task`, and with the model its `start_worker` named. Ids are
  numbers, or the id a client chose at `conversation/start`.
- **Provider.** Claude Code and `agy` keep their own subagents, which take input only through their parent; `agy`'s are not shown as conversations. OpenAI uses the worker tools alone.
- **Every pair of providers.** A parent on any of Claude Code, ChatGPT and Gemini starts a worker on either of the other two with the same tools, and reads its answer the same way. The real-account round trips below drive all six.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- child-tools, worker-answer: the model starts a worker, and the wait returns its final answer, which is not also delivered as a message
- worker-types: starting an agent of a type sigma doesn't know is refused, naming it
- worker-limits, child-tools: start_worker calls in one response start at most maxThreads workers
- worker-limits, child-tools: a follow-up task does not wake an idle worker while maxThreads workers work
- child-tools, worker-message, worker-assign: a worker takes messages and follow-up tasks
- child-tools, worker-list: interrupting a worker stops its turn and reports what it was doing
- worker-root-env, tool-root-env: a worker's command knows the conversation people started
- worker-limits: a tree runs at most as many workers at once as config.toml allows
- worker-limits: with max_threads 0 in config.toml the root conversation is not offered start_worker
- worker-limits, child-tools: under the default config a worker starts a worker of its own, told only its own task
- worker-interrupt, interrupt-idle: interrupting a conversation's run leaves its workers working, and interrupting it again, idle, stops them, so the tree goes idle
- worker-start, worker-model: conversation/list shows each worker with its lineage, on its parent's model or the one its start_worker names, and an unlisted model fails the call
- worker-answer: a worker's answer reaches its idle parent as input that starts a run, so the parent acts on it
- worker-provider: start_worker refuses a provider the home does not have and one that is not ready, naming the ready ones, and a fork onto another provider
- worker-wait: a wait that nothing reaches in time returns timed out, with the minimum it was clamped to, and the worker keeps working
- worker-wait: two waits at once never both return the same answer: one returns it, the other times out
- worker-person: a person's message to a worker is answered in the worker's conversation, and its parent is told nothing

Screen, `packages/sigma/test/screen.test.ts`:

- worker-card: a worker shows as a card under its parent, and ctrl+y answers the call it asks about
- worker-card, codemode-nested-policy: a worker a script started shows as a card under the script, and ctrl+y answers the call it asks about
- worker-approve: a call a worker's worker asks about shows on the card above it, and ctrl+y answers it
- subagent-claude: a Claude subagent shows as a card in place of its call's result, and its own screen sends input to its parent

Stack, `packages/sigma/test/stack.test.ts`:

- worker-exec: sigma exec without --auto denies the calls its workers would ask about too
- worker-exec: sigma exec continuing a worker denies the calls of the workers it starts

Provider, `packages/sigma/test/openai.test.ts`:

- worker-fork: a started agent's last answer reaches the parent
- worker-types, cache-fork-worker: an agent of a type gets its parent's instructions, its notice, its type's instructions and its model, and fork_turns none leaves the parent's history out
- worker-types, code-mode-models: a code-mode model that can start workers is told the agent types, and so is its worker
- worker-provider, worker-types, worker-section, codemode-tool: ChatGPT starts a Claude worker of an advertised type from a script, uses its model only if Claude lists it, and reads the worker's answer from the wait

Provider, `packages/sigma/test/claude.test.ts`:

- worker-provider, worker-model: a scripted agent starts a worker on Claude Code with the model it names, which starts from its brief alone, and the agent's wait returns the worker's answer
- worker-interrupt, worker-approve: a Claude Code worker asks its own approval, and stopping its idle parent ends the worker's run and clears the approval
- worker-claude-parent, worker-answer: a Claude Code parent starts a scripted worker with sigma's worker tools and reads its answer from wait_worker
- worker-claude-parent, subagent-claude: a Claude subagent that calls sigma's worker tools is refused in its own conversation, so it neither starts workers its tree cannot see nor answers as /root
- target-member-mode, worker-claude-parent: a local conversation's Claude Code keeps its own tools, settings and folder, and is offered sigma's worker tools beside them
- target-member-mode, worker-section: a remote conversation's Claude Code has only sigma's tools, acting on the target, in the target's own folders, told the target's platform, AGENTS.md, skills and agent types
- claude-system-prompt, worker-section: Claude Code keeps its own system prompt, adds sigma's workers section and the conversation's instructions, and its commands know the conversation
- worker-claude-parent, worker-fork: a Claude Code parent's worker on Claude Code starts a session of its own from its brief, not a fork of the parent's

Provider, `packages/sigma/test/agy.test.ts`:

- gemini-answer, provider-agy, worker-section: Gemini's answer through agy is committed as sigma's message, with what the turn spent
- worker-gemini-parent, worker-answer: Gemini starts a worker through sigma's MCP bridge and reads its answer with wait_worker; agy's own asks for sigma's tools are allowed at once and nobody is asked
- worker-gemini-parent, worker-wait: a Gemini parent's wait returns timed out within 150 s, before agy would cut the call, saying to wait again
- worker-wake-mail: a Claude Code worker whose run ends with a job working mails its answer naming the job, and the parent never waits for the job
- worker-wake-mail: a Claude Code worker's wake run, after its job ends, mails its answer to the parent as a message naming no job left
- subagent-claude: a Claude subagent works in a conversation of its own under the one that started it
- subagent-claude: a call a Claude subagent wants to make waits for a person in the subagent's conversation
- subagent-claude: stopping a Claude subagent stops only it, and its parent's run carries on
- subagent-claude: stopping a run ends the Claude subagents working under it
- subagent-claude, claude-job-report: stopping a Claude run stops the background subagent Claude Code started, whose job ends stopped, and its report joins the transcript when the idle process closes
- claude-job-report, subagent-claude: a background subagent's approval waits in its own conversation after its parent's turn ended, and once answered its report and Claude's follow-up end the parent's run
- subagent-claude: a Claude subagent is listed under its parent with the call that started it, and takes no input of its own
- subagent-claude: a Claude subagent that hands back its report answers with the report, not Claude Code's placeholder
- subagent-claude: a Claude subagent's approval waits and is answered in its own job, which writes its conversation instead of its parent's run

## Gotchas

- Steps play in order per author: the parent's steps and each
  `/root/<name>`'s steps are separate queues in the one script.
- A scripted subagent answers as soon as it starts. Give its step a `delayMs`
  when the parent should be waiting in `wait_worker` by then: a message that
  arrives before the wait is steered into the parent's run, and the wait then
  sits until its timeout.
- A subagent's run is its own: wait for its end with `watch` on its
  conversation, not the parent's.
- The fake `agy` plays a recording's `mcp_inbound` lines into the real
  `sigma mcp-bridge` it starts from the session's `mcpServers`, and logs the
  bridge's answers as `mcp` lines. `record-agy` records them by running the
  bridge under `record-agy-mcp.ts`.
- `[agents]` is read when the server starts: write `config.toml` before the
  first `exec`, `serve` or TUI start, or `rpc server/stop` after it.
- A recording proves sigma's side only; the fake Claude does not run the
  subagent's calls, so no `made.txt` appears.
- No recording has an OpenAI `start_worker` that names a `model`; the scripted
  step shows the refusal only, and the real account shows a subagent on
  another model.
- Stopping a subagent from its own conversation sends its parent no report:
  a parent waiting in `wait_worker` waits on until its timeout.

## With a real account

Proves that a real model chooses to start subagents and that Claude Code's
real subagents ask, and that each harness starts workers on the other two. Follow the skill's [Real accounts](../SKILL.md#real-accounts),
and start each run with its first check. No step needs a person. Give every
`tui wait` `--timeout 180000`, and save `evidence/` and the screens.

ChatGPT, in a run made with `drive.ts r up --openai-kept`:

- **Spawn and answer.** `drive.ts r tui start --provider openai`, send
  `Start a subagent named scout that replies with exactly: found it. Wait for it, then tell me what it said.`,
  wait for `READY` and save the screen: `⧉ scout done` and an answer naming `found it`.
- **Another model.** Pick a model from `drive.ts r rpc models/list '{}'` other
  than the conversation's whose entry in `/tmp/sigma-verify/r/home/cache/openai-models.json`
  has no `"tool_mode":"code_mode_only"`; if every other model has it, the
  subagent answers through the `codemode` tool, as
  [Code mode](./code-mode.md) says. Then send
  `Start a subagent named ranger on the model <that id> that replies with exactly: found it. Wait for it, then tell me what it said.`
  (a new name: `scout` exists from the step before, and a name is never reused):
  `/root/ranger`'s conversation in `conversation/list` has
  `"model": {"provider": "openai", "model": "<that id>", ...}`.
- **Follow-up.** Then send
  `Give scout a follow-up task: reply with exactly: found again. Wait for it, then tell me what it said.`:
  `▸ assign_worker`, the card's last message `found again`, and the same
  subagent conversation, no new one.
- **Message and list.** Then send
  `Send scout the message "stay put", then list your agents and tell me each one's status.`:
  `▸ message_worker`, `▸ list_workers` with `/root/scout` in its result, and a
  `sigma.mail` `message` `stay put` in the subagent's conversation.

Claude, in a run made with `drive.ts r up --real-claude`:

- **Spawn and answer.** `drive.ts r tui start --provider claude`, send
  `Use the Task tool to start a general-purpose subagent that replies with exactly: found it. Then tell me what it said.`:
  a `⧉ ... done` card over `found it`, and `conversation/list` holds the
  subagent, whose last message is `found it`. Claude Code 2.1.312 has the
  subagent hand its report back through a `SubagentHandback` call, and
  reports only a placeholder (`This agent's report was delivered to you as a
message...`) as its summary; neither the card nor the subagent shows that
  placeholder.
- **Workers from Claude Code.** In a run made with
  `drive.ts r up --real-claude --openai-kept`, `drive.ts r tui start --provider claude --auto`, send
  `Start a worker on provider openai with the message: reply with exactly: found it. Wait for it with wait_worker, then tell me what it said.`:
  `▸ start_worker` with `"provider":"openai"`, a `⧉ ... done` card under the
  Claude conversation, `▸ wait_worker` with the worker saying `found it`, and
  Claude's answer naming it. `conversation/list` holds the worker on
  `openai` with the Claude conversation as `parent`.
- **A subagent asks.** Send
  `Use the Task tool to start a general-purpose subagent that runs exactly: touch /tmp/sigma-verify/r/sub-made with the Bash tool. Then reply with one word: done`,
  wait for `waiting on you`: the card shows `allow Bash(touch /tmp/sigma-verify/r/sub-made)?`.
  Press `C-y` and wait for `READY`: the card reads `done`, and
  `/tmp/sigma-verify/r/sub-made` exists.

Round trips between any two, in one run made with
`drive.ts r up --real-claude --real-agy --openai-kept`, after its first
check names all three `ready`. For each parent `<p>` of `claude`, `openai`
and `agy`, and each other provider `<w>`, start the parent with
`drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp/sigma-verify/r", "provider": "<p>", "approvals": "auto"}'`
(add `"model": "gemini-4-hydrogen", "effort": "low"` for `agy`), then
`drive.ts r watch <id> --submit 'Start a worker on the provider <w> with the message: reply with exactly: found it. Wait for it with wait_worker, then tell me what it said.' --until run_end --timeout 300000 --save <p>-<w>`:
one `start_worker` with `"provider": "<w>"`, a `wait_worker` whose result
holds `found it` from `/root/...`, and the parent's answer naming it;
`conversation/list` holds the worker on `<w>` with the parent as `parent`.

- **A Gemini worker that wakes.** From a Claude parent, send
  `Start a worker on the provider agy with the message: run the shell command "sleep 30; echo woke-marker" in the background, reply with exactly: started, and when it finishes tell me what it printed. Wait for it with wait_worker until you have its second message, then tell me what it printed.`:
  the first `wait_worker` returns `final_answer` `started` with
  `Still working: "..."`, a later one returns a `message` naming
  `woke-marker`, and the worker's conversation shows a `hosted.report` and a
  second `sigma.run_end`.
- **The worker-choice eval.** `bun .agents/skills/verify-sigma/evals/worker-choice/run.ts`
  runs the requests in that folder's `cases.json` on the three providers,
  three runs a cell, and prints a table of case by harness; its README says
  what each case counts as right and when to rerun it.
