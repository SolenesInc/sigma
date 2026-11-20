# @sigma/claude

Claude Code as a harness of the hosted run (`@sigma/hosted`): the only package that imports the Claude Agent SDK.
`claudeAdapter(settings)` is the adapter, whose runs are `claude.run` tasks; `claudeAccount` is a Claude Code
instance's account.

A conversation on a target other than `local` runs in member mode: Claude Code's own tools, settings, connectors and
MCP servers are off, and it acts only through sigma's tools, served on the in-process `sigma` MCP server with
`alwaysLoad`. Each call, `mcp__sigma__<name>`, is framed under sigma's name and handed to the run's `runOwn`, which
runs it as a `pi.tool` task of the run, on the target. Its processes use the target's own Claude Code folders, and
their system prompt's `append` is the conversation's prompt sections, rendered through its env (`@sigma/hosted`'s
member mode).

- `src/process.ts`: one Claude Code process, started through the Claude Agent SDK at a resume, a fork or a fresh
  session. It owns the query, the inbox its messages go through, the reader, the callbacks Claude Code makes, its
  session id across `/clear`, its usage (`modelUsage` reports running totals of the process's own, so a second run
  counts only what came after the first), and the tasks Claude Code started and has not ended. Its reader observes
  every message as it arrives, routes it and turns it into the hosted run's frames: a subagent's messages, by
  `parent_tool_use_id`, and its end go to its job, and its callbacks, by `agent_id`, to its job's task; a background
  command the main loop started is a job too, which only its end reaches. The rest go to the run `serve` serves, or
  wait for the next run while it serves none. A `result` says what the turn spent and how it ended, and Claude Code's
  idle signal (`session_state_changed`, which `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` turns on) ends the run, unless a
  message the process was sent has not come back yet. A background job's end is its parent's report, handed to the run
  served or held for the next one; a turn Claude Code begins while no run serves wakes the conversation. PreToolUse and `canUseTool` become the run's `beforeRun` and `approve`, and
  PostCompact its `compacted`. The conversation's instructions, after the sections of the extensions Claude Code is
  offered, are appended to Claude Code's own system prompt. `processKey` (in
  `@sigma/hosted`) names what a process is spawned with, in member mode the tools sigma serves it too. In member mode
  it starts with only `ToolSearch` of Claude Code's tools, `strictMcpConfig`, no setting sources,
  `ENABLE_CLAUDEAI_MCP_SERVERS=false`, and `MCP_TOOL_TIMEOUT` past sigma's longest bash timeout, so a tool's own limit
  is the one the model sees; a run it fails signed out is told how a target signs in.
- `src/environment.ts`: how every Claude Code process starts, a run's, the account probe's and `claude auth`'s: the
  server's environment without the variables a host Claude Code session sets, then the provider instance's `env`. A
  run's settings also turn tool search on where the person's Claude Code settings leave it at `auto`.
- `src/account.ts`: how a Claude Code instance is signed in and which models it offers, from a probe of Claude Code,
  and signing in and out with its own commands.

The tests in `test/` drive `claude.run` through a Harness with sigma's fake `claude` replaying `fixtures/claude`;
`packages/sigma/test/claude.test.ts` drives it over the wire.
