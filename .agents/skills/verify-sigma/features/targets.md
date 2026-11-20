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
  the home has at the same path. A start or a model switch that would run
  Claude Code on a target is refused with `UnknownProvider`: its own tools
  would act on the server's machine.
- `target-unavailable` refuses a start whose target the connector cannot
  reach, or a home with no `target_connector`, with `TargetUnavailable`
  carrying the connector's reason, and creates nothing.
- `target-restarted` commits `sigma.target_changed` with `filesKept: true`
  when the target's instance changed and its files did not, and tells the
  model before its next request that its files are kept and its processes
  gone.
- `target-replaced` commits `sigma.target_changed` with `filesKept: false`
  when the instance and its files changed, and tells the model what is gone.
- `target-lost` fails a call on a target that is gone with
  `target <t> unavailable: <reason>` from the connector, and the run goes on
  to the model's next step.
- `target-subagent-fork` runs a subagent's calls and a fork's calls on their
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
  skills come through the target. Claude Code on a target (member mode) is
  not built yet, so it is refused there: its own tools would act on the home.
- **Read-only server.** It reaches no target: a hello would sweep what an
  earlier server left running there.

## Tests

- Wire: `target-start: ...`, `target-unavailable: ...`, `target-restarted: ...`,
  `target-replaced: ...`, `target-lost: ...`, `target-subagent-fork: ...` in
  `packages/sigma/test/wire.test.ts`.
- Provider: `target-start, agents-md, skills-found: ...` in
  `packages/sigma/test/openai.test.ts`.
- Stack: `target-server-restart: ...` and `target-cli, target-unavailable: ...`
  in `packages/sigma/test/stack.test.ts`.
- Screen: `target-cli: ...` and `target-restarted, target-replaced: ...` in
  `packages/sigma/test/screen.test.ts`.

## Gotchas

- The test connector's `map` file makes one path mean another folder on the
  target, so a test can give the home and the target different files at the
  same path on one machine.
- A remote conversation gets the home's `AGENTS.md`, but not the home's
  skills or the Claude Code agent types: its tools cannot read a file on the
  home, and it takes nothing of the person's `~/.claude`.
- Images a person attaches are read on their own machine, from the TUI's
  folder when the conversation is on a target.
- The instance is announced through a `target` prompt section, rendered
  before each request; a conversation on the Claude Code path does not
  render it yet.
