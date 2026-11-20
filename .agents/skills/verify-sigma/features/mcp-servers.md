# MCP servers

A connected client registers an MCP server with the running server: a name, a
Streamable HTTP URL and the headers to send. Sigma holds the registration in
memory while that client's `mcp/register` stream lasts, and never stores,
logs or shows a header value. A conversation names the servers it uses when
it starts; its forks and subagents use them too. A Claude conversation's
Claude Code is offered each server's tools as `mcp__<name>__<tool>` and calls
them through sigma, which sends the registered headers and
`Sigma-Root-Conversation`, the root conversation's id, on every request. A
server no client registers now refuses each call with a message that names it.
On ChatGPT and agy a conversation keeps its list but is offered no tools yet.

## Sub-features

- `mcp-register` registers a server as `{name, url, headers}` until the
  stream ends or its client disconnects; a later registration of a name
  answers while it lasts. `sigma`, a name with other than letters, digits,
  `-` and `_`, and a URL that is not http or https are refused by name.
- `mcp-start` keeps the servers `conversation/start` (or `--mcp-server`)
  names, each `{name, description}`, fixed for the conversation's life;
  `conversation/list` shows them, and a fork or subagent has them too. No
  header value reaches the home's files, the list or a transcript.
- `mcp-claude` offers a Claude conversation's Claude Code each server's
  instructions and tools as the server listed them, and passes each call,
  from the main loop or a Claude Code subagent, to the server with the
  registered headers and `Sigma-Root-Conversation`; the result reaches
  Claude Code as the server gave it. Each conversation names itself.
- `mcp-gone` answers each call of a server no client registers now, which a
  conversation was offered while one did, with
  `The MCP server <name> is not available: no client connected to sigma registers it now.`
  as an error result; sigma ends its session with the server when the
  registration ends.

## How to get to it

### People

- `sigma --mcp-server <name>=<description>` (repeatable), with `--conversation`,
  starts the conversation with those servers. A person cannot register one:
  the program that launched sigma does.

### Agents

- `mcp/register` with `name`, `url` and `headers`: a stream that answers
  `{name}` once and lasts while the registration does.
- `conversation/start` with `mcpServers: [{name, description}]`.
- `conversation/list` shows each conversation's `mcpServers`.

## Driving it with drive.ts

Preconditions:

- `drive.ts m up --fake-claude mcp_tool`, then `drive.ts m serve`.

- **Register.** `drive.ts m fake-mcp fake 'Authorization=Bearer drive-s3cret'`
  prints `fake MCP server fake registered`. Its window logs each request the
  fake receives; `evidence/fake-mcp-fake.ndjson` holds them with headers.
- **Start with it.** `drive.ts m tui start --conversation talk --provider claude --auto --mcp-server 'fake=Echoes text'`,
  `drive.ts m tui wait READY`, type `echo root, then have a subagent echo sub`
  and `Enter`, then `drive.ts m watch talk --until run_end`. The TUI draws
  `▸ mcp__fake__echo` with `{"echoed":"root"}`, and the subagent's row ends
  `done` with `sub`.
- **What the server got.** `evidence/fake-mcp-fake.ndjson` holds `initialize`,
  `tools/list` and two `tools/call` requests (`{"text": "root"}`, then
  `{"text": "sub"}`), each with `authorization: Bearer drive-s3cret` and
  `sigma-root-conversation` naming the conversation.
- **Nothing kept.** `drive.ts m rpc conversation/list` lists `talk` with
  `"mcpServers": [{"name": "fake", "description": "Echoes text"}]`, and
  `grep -rl drive-s3cret /tmp/sigma-verify/m/home` finds nothing.
- **Gone.** `drive.ts m fake-mcp-stop fake` ends the registration; the fake's
  log ends with a `DELETE`.

## Contexts

- **Subagents.** A Claude Code subagent's call names its root conversation.
- **Server restart.** Registrations live in the server's memory: a new server
  has none until its clients register again.
- **Provider.** Only Claude conversations are offered the tools so far; sigma
  does not list a server for an agy or ChatGPT conversation.
- **Targets.** A remote Claude conversation with remote hands is offered them too:
  sigma, on the server's machine, makes every request.

## Tests

Provider, `packages/sigma/test/claude.test.ts`:

- mcp-claude, mcp-register, mcp-start: Claude Code and its subagent call a registered server's tool through sigma, with its headers and the conversation's id
- mcp-claude: two conversations on one server each name themselves to the MCP server
- mcp-gone: once the client that registered a server disconnects, each call of its tools is refused with a message naming it

Wire, `packages/sigma/test/wire.test.ts`:

- mcp-register: a name or address sigma cannot register is refused by name, as is a conversation that names sigma's own tools
- mcp-start: a conversation keeps the MCP servers it started with, and a fork of it uses them too

## Gotchas

- A server is listed once per registration, through the first conversation
  that offers it; one that did not answer then offers no tools until it is
  registered again, and the server's log says why. A tool list that changes between registrations gives the
  next run a new Claude Code process, never a change mid-process.
- A name no client has registered since the server started offers no tools,
  and nothing tells the person or the model: sigma has never seen its list.
- Replayed recordings: the transcript shows the result Claude Code reported in
  the recording; what sigma answered is in the fake claude's log
  (`mcp_response`).
