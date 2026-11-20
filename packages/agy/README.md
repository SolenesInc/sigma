# @sigma/agy

Antigravity's `agy` as a harness of the hosted run (`@sigma/hosted`), over the Agent Client Protocol (`agy acp`):
JSON-RPC on the process's stdio. `agyAdapter(settings)` is the adapter, whose runs are `agy.run` tasks; `agyAccount` is
an `agy` instance's account. Measured against `agy` 1.5.13.

- `src/acp.ts`: one `agy acp` process: requests, answers, notifications and agy's own requests, in order, and the
  process's exit with the tail of its stderr. Sigma tells `agy` it has no file system and no terminal, so `agy` uses
  its own.
- `src/hook.ts`: the Stop hook sigma gives every session, a folder of its own passed as `additionalDirectories`, whose
  `.agents/hooks.json` runs a script that writes the session id of each Stop to a FIFO the adapter reads. `agy` fires
  Stop at the end of an ordinary turn and of one it began by itself, but not of a turn ended by a denial or
  `session/cancel`, and its own subagents' Stops carry their own session ids.
- `src/process.ts`: one `agy` process as the hosted run's connection. It opens a fresh session (`session/new`, with
  the conversation's instructions as `_meta.antigravity.systemPrompt.append`) or loads one (`session/load`, dropping
  the updates the load replays), then sets `model` and `thought_level` after every open. It never changes `agy`'s
  mode and offers it no MCP servers. Its translation: message chunks are what was said, a tool call is a sighted call
  (`beforeRun`), a permission request is `approve` (`allow_once` or `reject_once`; a denial is committed as the call's
  result), and a prompt's result is the turn-over with what it spent. A call still running at the turn-over is a job,
  whose `completed` or `failed` is its end; anything `agy` says while no turn is open is a turn it began by itself,
  which the Stop hook ends. An idle stop cancels the session; closing sends `session/close`. A conversation on a
  target other than `local` is refused, since `agy`'s tools act where `agy` runs.
- `src/account.ts`: whether `agy` is signed in and which models and thinking levels it offers, from a probe that
  initializes and opens one session; signing in is `agy`'s own, in a terminal.

`packages/sigma/test/agy.test.ts` drives it over the wire with sigma's fake `agy` replaying `fixtures/agy`, recorded by
`packages/sigma/test/support/record-agy-fixtures.ts`.
