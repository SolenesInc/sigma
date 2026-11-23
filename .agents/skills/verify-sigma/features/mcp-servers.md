# MCP servers

A connected client registers an MCP server with the running server: a name, a
Streamable HTTP URL and the headers to send. Sigma holds the registration in
memory while that client's `mcp/register` stream lasts, and never stores,
logs or shows a header value. A conversation names the servers it uses when
it starts, and sigma lists each one's instructions and tools then, fixed for
the conversation's life; its forks and subagents use them too. A server that
does not list then offers the conversation nothing, and the transcript says
why. Each tool is `mcp__<name>__<tool>`. A Claude conversation's Claude Code
calls them through sigma. On ChatGPT, sigma's own loop offers a tool the
server marks `anthropic/alwaysLoad` from the first request, and finds the
others with `tool_search`, or, in code mode, scripts call every tool, get the
result its `outputSchema` types, and read the server under its namespace.
Sigma sends the registered headers and `Sigma-Root-Conversation`, the root
conversation's id, on every request. A server no client registers now refuses
each call with a message that names it. agy is offered no tools yet.

## Sub-features

- `mcp-register` registers a server as `{name, url, headers}` until the
  stream ends or its client disconnects; a later registration of a name
  answers while it lasts. `sigma`, a name with other than letters, digits,
  `-` and `_`, and a URL that is not http or https are refused by name.
- `mcp-start` keeps the servers `conversation/start` (or `--mcp-server`)
  names, each `{name, description}`, and what each listed then, fixed for the
  conversation's life; `conversation/list` shows them, and a fork, worker
  (forked or fresh), or hosted subagent has them too. Each request carries
  `Sigma-Root-Conversation` naming its tree's root: the conversation people
  started for it and its hosted subagents, and the worker itself for a worker
  and its hosted subagents. No header value reaches the home's files, the
  list or a transcript.
- `mcp-unlisted` adds a `sigma.mcp_unlisted` entry `{server, reason}` for each
  server that did not list when the conversation started: no client registers
  it, it did not answer, or it refused, such as attn refusing a conversation no
  session holds; a refusal's reason ends with what the server answered. The TUI shows
  `◆ the MCP server <name> offers this conversation no tools: <reason>`, and
  the conversation is offered none of its tools.
- `mcp-openai` offers a ChatGPT conversation each server's tools as
  `mcp__<name>__<tool>`: a tool marked `anthropic/alwaysLoad` with sigma's own
  from the first request, every other one deferred. A model that takes tools
  directly finds a deferred one with `tool_search`, which the prompt names
  with each server's description; in code mode the `codemode` section lists
  each server as the namespace `mcp__<name>` with its description, and its
  always-loaded tools' declarations.
- `mcp-typed` resolves a code mode script's call of a tool with an
  `outputSchema` to the server's structured result, typed in its declaration,
  and `describeNamespace("mcp__<name>")` answers with the server's
  instructions.
- `mcp-cancel` cancels a call the run no longer waits for, such as after an
  interrupt, with `notifications/cancelled`.
- `mcp-reconnect` reaches a server again after it restarts on its address:
  the first call after the restart succeeds.
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
- `conversation/start` with `mcpServers: [{name, description}]`; it answers
  once each server listed or failed to.
- `conversation/list` shows each conversation's `mcpServers`; the `pi.agent`
  document of a view holds what each listed.

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

On ChatGPT, through sigma's own loop:

- `drive.ts o up --fake-openai mcp_code_mode,text_answer`, then
  `drive.ts o serve` and `drive.ts o fake-mcp fake`.
- **Start with it.** `drive.ts o tui start --conversation talk --provider openai --model gpt-6.1-sol --auto --mcp-server 'fake=Echoes text'`,
  `drive.ts o tui wait READY`, type `what does echo say?` and `Enter`. The TUI
  draws the `codemode` call and `Echo says hi.`; `evidence/fake-mcp-fake.ndjson`
  holds a `tools/call` of `echo` with `sigma-root-conversation: talk`.
- **Prompt.** `evidence/fake-openai.ndjson`'s first request's `instructions`
  hold `## mcp__fake (some tools not listed)` over `Echoes text` and
  `mcp__fake__echo`'s declaration; type `hello` and `Enter`, and the next
  request's `instructions` and `tools` are the same. That request is marked
  `differs`: `text_answer` was recorded without the history before it.
- **Unlisted.** `drive.ts o tui start --conversation lone --provider openai --mcp-server 'ghost=Never registered'`
  draws `◆ the MCP server ghost offers this conversation no tools: no client connected to sigma registers it`.

## Contexts

- **Subagents and workers.** A hosted Claude Code subagent's call names its
  tree's root (its parent or worker). A worker's call names the worker itself,
  over its own MCP client connection.
- **Server restart.** Registrations live in the server's memory: a new server
  has none until its clients register again.
- **Provider.** Claude and ChatGPT conversations are offered the tools; agy
  ones keep their list and are offered none.
- **Models.** A ChatGPT model that takes only code mode reaches them through
  scripts; any other through its tools and `tool_search`.
- **Targets.** A remote conversation is offered them too: sigma, on the
  server's machine, makes every request. Claude Code with remote hands gets
  them under each server's name, not among sigma's tools.

## Tests

Provider, `packages/sigma/test/claude.test.ts`:

- mcp-claude, mcp-register, mcp-start: Claude Code and its subagent call a registered server's tool through sigma, with its headers and the conversation's id
- mcp-claude: two conversations on one server each name themselves to the MCP server
- mcp-gone: once the client that registered a server disconnects, each call of its tools is refused with a message naming it
- worker-provider, mcp-claude, worker-root-env: a Claude Code worker and its hosted subagent call a registered MCP server with the worker's id as root

Provider, `packages/sigma/test/openai.test.ts`:

- mcp-openai, cache-mcp: ChatGPT is told of a server's namespace and its always-loaded tool from the first request, and every request keeps the instructions and tools it started with

Wire, `packages/sigma/test/wire.test.ts`:

- mcp-register: a name or address sigma cannot register is refused by name, as is a conversation that names sigma's own tools
- mcp-start: a conversation keeps the MCP servers it started with, and a fork of it uses them too
- mcp-openai, mcp-typed: a code mode script calls a server's tool by its namespaced name and gets the result its outputSchema types, and describeNamespace() answers with the server's instructions
- mcp-openai: a model that takes tools directly is offered an always-loaded tool, and calls a deferred one only once tool_search loaded it, over a stream the server holds open
- mcp-openai, mcp-start: a forked and a fresh worker each call their parent's server, naming themselves as root
- worker-root-env, tool-root-env, mcp-start: a worker's bash and MCP calls name the worker as root, while its parent's name the parent by the id its client chose
- mcp-cancel: interrupting a run cancels the server's call it waits on
- mcp-reconnect: after the server restarts on its address, the next call reaches it
- mcp-unlisted: a server no client registers, or one that does not answer, offers no tools, and the conversation says why
- mcp-unlisted: a server that refuses the conversation's root offers no tools, and the conversation's reason carries the server's answer

## Gotchas

- A server is listed once per conversation, when it starts; its forks and
  subagents keep that listing. One that did not answer then offers that
  conversation no tools for its life; a new conversation lists it again.
- `conversation/start` waits for the listing: each request has pi-mcp's 30 s
  limit, and a server on loopback answers in milliseconds.
- A tool `tool_search` loads joins the next request's `tools`, which costs
  that request the cached front: the deferred tools are the price of a short
  first prompt.
- Replayed recordings: the transcript shows the result Claude Code reported in
  the recording; what sigma answered is in the fake claude's log
  (`mcp_response`).

## With a real account

- `drive.ts o up --openai-kept`, `drive.ts o serve`, `drive.ts o fake-mcp fake`,
  then the **Start with it** step above without `--fake-openai`, prompting
  `Use the fake echo tool to echo "hi", then tell me what it said.` The answer
  says `hi`, and the fake's log holds the `echo` call naming `talk`.
