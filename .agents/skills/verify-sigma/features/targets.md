# Targets

A conversation can act on another computer. Started with a target, every
tool it runs, its subagents' and its forks' too, acts on that target's
computer through `sigma-env`, which the home's connector starts there. A
person sees the target beside the folder in the TUI's header, and is told,
as the model is, when the computer behind the target restarted or was
replaced. A target that cannot be reached at start starts nothing, and one
lost later fails its calls with the connector's reason while the run goes
on. attn will use targets to run a member's work in a sandbox.

## Sub-features

- `target-start` starts a conversation on a target with `target` and a `cwd`
  on it: its tools act there, `conversation/list` shows its `target`
  (`local` for one started without), a start with an id that names a
  conversation keeps that one's target, and a ChatGPT conversation is told
  the `AGENTS.md` files and skills the target has at its folder, never what
  the home has at the same path.
- `target-unavailable` refuses a start whose target the connector cannot
  reach, or a home with no `target_connector`, with `TargetUnavailable`
  carrying the connector's reason, and creates nothing.
- `target-restarted` commits `sigma.target_changed` with `filesKept: true`
  when the target's instance changed and its files did not, and tells the
  model before its next request that its files are kept and its processes
  gone. The TUI draws it, and `sigma exec` prints it on stderr, as
  `◆ <t> restarted as <instance>: files kept, processes gone`.
- `target-replaced` commits `sigma.target_changed` with `filesKept: false`
  when the instance and its files changed, and tells the model what is gone.
- `target-lost` fails a call on a target that is gone with
  `target <t> unavailable: <reason>` from the connector, and the run goes on
  to the model's next step. A connector that brings no hello within 60 s
  fails every call at once for the next 60 s, saying how long ago it hung,
  so a hung target costs one wait, not one per section and call. Input that
  names a skill (`/name`, `$name`) while the target cannot be reached is
  refused with `TargetUnavailable` and placed nowhere; the TUI shows the
  reason as a notice. A prompt containing literal `$(...)` and no skill
  reference can still be submitted. A call reaches for the target once: with remote hands,
  what the model is told after the call does not connect again to a target
  the call found unreachable.
- `target-reaching` commits `sigma.reaching` `{ wait: { target, since } }`
  in a conversation whose run waits for its target's hello, from a section,
  a tool call or remote hands' notice, and clears it at the hello or the
  failure; a server start clears what a stopped server left. The TUI's
  status bar shows `◆ reaching <t> <elapsed>` meanwhile, and `sigma exec`
  prints `reaching <t>…` on stderr once per connect.
- `target-remote-hands` runs a Claude conversation on a target with
  remote hands, at start or after a model switch: Claude Code's own tools, the
  person's settings, connectors and other MCP servers are off, and it acts
  only through sigma's tools, served to it as `mcp__sigma__<name>` and kept
  out of tool search. Its calls are committed under sigma's names and run on
  the target. Its Claude Code processes use the target's own folders,
  `$SIGMA_HOME/targets/<16 hex of sha256(target)>/claude` as
  `CLAUDE_CONFIG_DIR` and `.../loop` as their working folder, so its
  resumes and forks find their session there and nothing lands in the
  person's `~/.claude`. Its system prompt's `append` holds the
  conversation's instructions, then the target's `AGENTS.md` files and
  skills, then which computer its tools act on: the target, by name and the
  platform its sigma-env reports, over the computer Claude Code's own
  environment block describes. A restarted or replaced instance is told at the start of its next
  run, or in the result of the call it happened under; a run that fails before
  Claude Code reads it leaves it to the next run, which is told it among what
  its session missed. Claude Code waits for
  a sigma call as long as sigma's bash may run, so bash's own timeout is the
  limit the model sees.
- `target-worker-fork` runs a subagent's calls and a fork's calls on their
  parent's target.
- `target-server-restart` kills a remote command cut off by a crashed server
  before the restarted run calls again, and commits the call as interrupted.
- `target-cli` starts a conversation on a target from `sigma --target <t>
--cwd <path>`, and the TUI shows `on <t>` before the folder, also when the
  conversation is opened again. `--target` without `--cwd` is refused, and
  an unreachable target prints its reason on one line.

## How to get to it

### People

- `sigma --target <t> --cwd <path on t>` and `sigma exec --target <t> --cwd
<path>`; `--cwd` alone sets a local conversation's folder. A remote
  `--target` needs `--cwd`.
- The TUI's header shows `on <t>  <path>` for a conversation on a target,
  and the transcript shows `◆ <t> restarted as <instance>: files kept,
processes gone` or `◆ <t> was replaced by <instance>: ...`.

### Agents

- `conversation/start` with `target`; `TargetUnavailable { target, reason }`
  when it cannot be reached.
- `conversation/list` reports each conversation's `target`.
- `sigma.target_changed { target, from, to, filesKept }` entries in a watch.
- `target_connector` in `$SIGMA_HOME/config.toml`, set by whatever runs
  sigma: sigma runs `<target_connector...> <target> -- sigma-env` and speaks
  to sigma-env over its stdin and stdout.

### Triggers

- The first request after the connector reaches a different instance
  commits `sigma.target_changed`.

## Driving it with drive.ts

Preconditions:

- A fresh run, here `t`, with `--script` steps
  `[{"tool": {"name": "bash", "input": {"command": "echo on $SIGMA_TARGET_INSTANCE; pwd"}}}, {"text": "looked"}, {"tool": {"name": "bash", "input": {"command": "echo box-2 > ../instance; kill -9 $(cat ../pid)"}}}, {"text": "noted"}]`.
- A target folder for the test connector, and the home's connector pointing
  at it (the connector is `packages/sigma/test/support/connector.ts`; it runs
  `sigma-env` on this machine with the ids in the folder):

  ```sh
  mkdir -p /tmp/sigma-verify/t/targets/box/work
  echo box-1 > /tmp/sigma-verify/t/targets/box/instance
  echo vol-1 > /tmp/sigma-verify/t/targets/box/files
  printf 'target_connector = ["bun", "%s/packages/sigma/test/support/connector.ts", "/tmp/sigma-verify/t/targets"]\n' "$PWD" > /tmp/sigma-verify/t/home/config.toml
  ```

- **Start on a target.** `drive.ts t tui start --target box --cwd /tmp/sigma-verify/t/targets/box/work --auto`,
  then `drive.ts t tui wait READY`: the header shows
  `on box  /tmp/sigma-verify/t/targets/box/work`. Save it with `tui screen start`.
- **A tool acts there.** `tui type look`, `tui key Enter`, `tui wait looked`:
  the bash call printed `on box-1` and the target's folder. `drive.ts t rpc conversation/list`
  shows `"target":"box"`.
- **Restarted.** `tui type again`, `tui key Enter`, `tui wait noted`: the
  transcript shows `◆ box restarted as box-2: files kept, processes gone`, and
  `drive.ts t watch <id> --save changed` holds the `sigma.target_changed` entry
  with `"filesKept":true`.
- **Unavailable.** `drive.ts t rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/w", "target": "nope"}'`
  answers `TargetUnavailable` with `connector exited 3: no target named nope`, and
  `conversation/list` has no new conversation.

## Contexts

- **Server restart.** A remote command running when the server is killed is
  gone before the restarted run's next call; the call is committed as
  interrupted (`target-server-restart`).
- **Subagents.** A subagent and a fork act on their parent's target.
- **Provider.** On ChatGPT the tools and the workspace's `AGENTS.md` and
  skills come through the target. Claude Code on a target runs with
  remote hands (`target-remote-hands`): the same tools and workspace text, through
  sigma's MCP server and its system prompt's `append`.
- **Sign-in.** A remote-hands Claude Code is signed in as the provider's
  Claude Code is, except where Claude Code keeps the sign-in in its config
  folder: on Linux, `.credentials.json`. There the target's fresh folder is
  signed out, and the sign-in must come through the environment
  (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`). macOS keeps it in
  the keychain, which a fresh folder reaches.
- **Read-only server.** It reaches no target: a hello would sweep what an
  earlier server left running there.

## Tests

- Wire: `target-start: ...`, `target-unavailable: ...`, `target-restarted: ...`,
  `target-replaced: ...`, `target-lost: ...`, `target-worker-fork: ...`,
  `target-remote-hands: ...` in `packages/sigma/test/wire.test.ts`.
- Provider: `target-start, agents-md, skills-found: ...` in
  `packages/sigma/test/openai.test.ts`; `target-remote-hands: ...`,
  `target-remote-hands, claude-resume: ...`,
  `target-remote-hands, target-worker-fork: ...`,
  `target-remote-hands, claude-sign-in-error: ...`,
  `target-remote-hands, target-server-restart: ...`,
  `target-remote-hands, skills-list, skills-attach: ...`,
  `target-remote-hands, approval-wire: ...`,
  `target-remote-hands, claude-compact, target-restarted: ...`,
  `target-lost, target-remote-hands: ...` and
  `target-restarted, target-remote-hands: ...` in
  `packages/sigma/test/claude.test.ts`, on the fake `claude`'s
  `remote_hands_bash`, `remote_hands_restart` and `remote_hands_sleep`, which
  `derive-claude-fixtures.ts` derives from `bash_allowed`, and
  `remote_hands_bash_exit` and `remote_hands_sleep_exit`, which it cuts from them where
  the process exits.
- Provider: `target-lost, skills-attach: ...` in
  `packages/sigma/test/openai.test.ts`.
- Package: `env-remote: a target whose connector brings no hello ...` in
  `packages/env/test/remote.test.ts`.
- Stack: `target-server-restart: ...`, `target-cli, target-unavailable: ...`
  and `target-restarted, target-cli: ...` in
  `packages/sigma/test/stack.test.ts`.
- Screen: `target-cli: ...`, `target-restarted, target-replaced: ...` and
  `target-reaching: ...` in
  `packages/sigma/test/screen.test.ts`.

## Gotchas

- The test connector appends the time of each connect to the target's
  `connects` file, so a test can tell when sigma reached for it.
- The test connector's `map` file makes one path mean another folder on the
  target, so a test can give the home and the target different files at the
  same path on one machine.
- A remote conversation gets the home's `AGENTS.md`, but not the home's
  skills, the person's `~/.agents/skills` or the Claude Code agent types: its
  tools cannot read a file on the home, and it takes nothing of the person's
  `~/.claude`. agy never runs on a target.
- Images a person attaches are read on their own machine, from the TUI's or `sigma exec`'s
  folder when the conversation is on a target.
- The instance is announced through a `target` prompt section, rendered
  before each request, on ChatGPT. Claude Code runs its own loop, so member
  mode tells it at the start of a run and in a sigma call's result instead;
  a change found between those points waits for the next one.
- A change a remote-hands run found but Claude Code never read is retold to
  the next run's session, except when that run is a compaction: its
  `/compact` must stay the whole prompt, and the compaction moves the
  session past the change, so the model is not told of it.
- With remote hands Claude Code reads `AGENTS.md` and skills only as they were
  when its process started; an edit reaches it with its next process.
- Claude Code 2.1.312 still tells a remote-hands model the home's working
  folder, platform, shell and OS version, in an `environment` attachment of
  its session file. No option drops or replaces it except `--bare`, which
  refuses OAuth sign-in, so the `append` says that block is not where the
  tools run. The test connector's `platform` file makes a target report
  another platform, so the two differ on one machine.
- `$SIGMA_HOME/targets/<key>` holds the target's Claude Code sessions for the
  life of the home; sigma does not remove it. Deleting it while no conversation
  on that target runs costs their Claude Code sessions: their next runs start
  fresh sessions, told the conversation.
