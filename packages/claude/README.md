# @sigma/claude

Claude Code as a harness of the hosted run (`@sigma/hosted`): the only package that imports the Claude Agent SDK.
`claudeAdapter(settings)` is the adapter, whose runs are `claude.run` tasks; `claudeAccount` is a Claude Code
instance's account.

A conversation's MCP servers (`ProcessConfig.mcp`) are each an in-process server under the server's name, offering
its instructions and tools as the server listed them; each call goes back to sigma, which holds the server's address
and headers and makes the request, so Claude Code never holds them.

Sigma's own tools (`ProcessConfig.own`) are served on the in-process `sigma` MCP server with `alwaysLoad`: a local
conversation's Claude Code gets the worker tools there beside its own tools and the person's settings. Each call,
`mcp__sigma__<name>`, is framed under sigma's name, its permission prompt allowed at once, and handed to `runOwn` of
the conversation that made it, the run's or, by the `agent_id` its PreToolUse named, a subagent's job, which runs it
as a `pi.tool` task. A conversation on a target other than `local` runs with remote hands: Claude Code's own tools,
settings, connectors and MCP servers are off, and it acts only through sigma's tools, on the target, and the
conversation's MCP servers. Its processes run in the target's own working folder, and
their system prompt's `append` is the conversation's prompt sections, rendered through its env (`@sigma/hosted`'s
remote hands).

- `src/process.ts`: one Claude Code process as the hosted run's connection, started through the Claude Agent SDK at a
  resume, a fork or a fresh session. It owns the query, the inbox its messages go through, its session id across
  `/clear`, its usage (`modelUsage` reports running totals of the process's own, so a second run counts only what came
  after the first), and the cache facts of its newest request. It
  translates each message Claude Code sends into the hosted run's frames, in order: `task_started` is a job's start,
  a replay of a message sigma sent is `took`, a subagent's messages carry its job by `parent_tool_use_id`, `task_notification` is a job's end, and
  `session_state_changed` (which `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` turns on) is a turn Claude Code began by
  itself (`running` with nothing it was sent outstanding) or its turn-over (`idle`). A `result` says what the turn spent
  and how it ended. What those frames mean for a run, a job or a wake is `@sigma/hosted`'s. Its calls back reach the
  host: PreToolUse and `canUseTool` become `beforeRun` and `approve`, a subagent's by `agent_id` its job's, and
  PostCompact the host's `compacted`. The conversation's instructions, after the sections of the extensions Claude Code is
  offered, are appended to Claude Code's own system prompt. `processKey` (in
  `@sigma/hosted`) names what a process is spawned with, the tools sigma serves it among them. With remote hands
  it starts with only `ToolSearch` of Claude Code's tools, `strictMcpConfig`, no setting sources,
  `ENABLE_CLAUDEAI_MCP_SERVERS=false`, and `MCP_TOOL_TIMEOUT` past sigma's longest bash timeout, so a tool's own limit
  is the one the model sees. It keeps the server's own Claude folder, so it signs in as the machine's Claude Code does.
- `src/environment.ts`: how every Claude Code process starts, a run's, the account probe's and `claude auth`'s: the
  server's environment without the variables a host Claude Code session sets, then the provider instance's `env`. A
  run's settings also turn tool search on where the person's Claude Code settings leave it at `auto`.
- `src/account.ts`: how a Claude Code instance is signed in and which models it offers, from a probe of Claude Code,
  and signing in and out with its own commands.

The tests in `test/` drive `claude.run` through a Harness with sigma's fake `claude` replaying `fixtures/claude`;
`packages/sigma/test/claude.test.ts` drives it over the wire.
