# Extensions

Extensions are switched off for now. Sigma used to load TypeScript files from
`SIGMA_HOME/extensions` to add, change or remove tools, hook calls before and
after they run, shape each OpenAI request, and show a status line and toasts.
Nobody used them yet, so they were removed to stop their upkeep. A home that
still holds files there is told once that sigma loads none of them.

The kernel's hooks stay, in [Hooks](./hooks.md) and
[Extensions and registry](./registry.md), and so does the Claude bridge that
carries an installed extension's tools and hooks to Claude Code
(`hook-claude`). Bringing extensions back means restoring the loader, not
redesigning: revert the commit that removed them,
`Switch Sigma's extensions off for now` (`git log --grep "Switch Sigma's extensions off"`),
which brings back the loader (`packages/sigma/src/extensions`),
`sigma extensions` and `sigma extensions reload`, the `extensions/list` and
`extensions/reload` calls, `sigma.status_lines` and `sigma.toast`, the TUI's
status line, toasts and failed-to-load lines, `[extensions.<name>]` in
`config.toml`, their tests, and this file's recipes.

## Sub-features

- `extensions-off` says, when anything is in `SIGMA_HOME/extensions`,
  `extensions are switched off for now; sigma loads nothing in <home>/extensions`:
  once as the TUI's notice over the prompt when it opens, until the person's
  next action replaces it, and once on the server's stderr (its log, when a
  client started it) after `sigma <version> serving <home>`. Nothing in the
  folder runs, and `[extensions.<name>]` in `config.toml` is ignored.

## How to get to it

### People

- Open the TUI on a home with files in `SIGMA_HOME/extensions`.
- Run `sigma serve` on such a home, or read its `sigma.log`.

### Agents

- Read the server's stderr or `sigma.log`.

## Driving it with drive.ts

Preconditions:

- `r` stands for your run id, in commands and paths alike.

- **TUI.** In a fresh run, `mkdir -p /tmp/sigma-verify/r/home/extensions` and
  `printf 'export default 42\n' > /tmp/sigma-verify/r/home/extensions/guard.ts`,
  before anything starts the run's server. `drive.ts r tui start`, wait for
  `READY`, then `drive.ts r tui screen off`: over the prompt,
  `◆ extensions are switched off for now; sigma loads nothing in /tmp/sigma-verify/r/home/extensions`.
  Type `hi` and `Enter`, wait for `You said: hi` and `READY`: the line is gone.
- **Server.** In the same run, `drive.ts r rpc server/stop`, then
  `drive.ts r serve`: `/tmp/sigma-verify/r/home/sigma.log` ends with
  `sigma <version> serving /tmp/sigma-verify/r/home` and the
  `extensions are switched off ...` line.

## Tests

Screen, `packages/sigma/test/screen.test.ts`:

- extensions-off: a person whose home still holds extensions is told once that they are switched off

Stack, `packages/sigma/test/stack.test.ts`:

- extensions-off: a server whose home still holds extensions says they are switched off

## Gotchas

- `extension-tool-empty-input-fails-every` (seed `s-h84gfx`) waits for
  extensions to return.
- With extensions off, nothing reaches the queue-run race in which a prompt is
  sent while an interrupted run still stops (a tool that delays its abort);
  its wire test left with the loader and returns with the revert.
