# @sigma/hosted

The hosted run: a run of a conversation whose model a harness serves, on `@sigma/harness`. A harness is a program
that owns its own model loop, tools and session, which sigma drives as a process; an adapter speaks one harness's
protocol and turns what it says into this package's frames. The hosted run starts or reuses the harness's process,
tells it what it missed, commits what it does and answers what it asks. The harness keeps its own session and runs its
own tools; sigma's transcript stays the truth, and every frame becomes a commit. Claude Code (`@sigma/claude`) and
`agy` (`@sigma/agy`) are its adapters. An adapter whose harness cuts a call of sigma's tools sooner than the tool
returns says so in `ownToolLimit` (agy: 150 s), which the server passes to `wait_worker`.

`hostedRunTasks(options)` returns the task definitions (each adapter's run task, as `claude.run`, then `hosted.job`,
`hosted.job-anchor` and `hosted.command`), to install in the registry, and the `RunTasks` to open the harness with, which choose an
adapter's run task for a model whose provider its `settings` knows. `options.processes` is the server's
`makeHostedProcesses`, opened with the idle period and the hold that keeps the server up while a process is live.
`options.offered` names the extensions whose tools a local conversation's harness is offered beside its own (sigma's
server: the worker tools), and whose prompt sections go to its system prompt before the agent's instructions. The
harness calls sigma's tools (`ownTools`, `ProcessConfig.own`) each through `Host.runOwn`: `Callbacks.recordOwn` of the
run or the job that made it commits it with a `pi.tool` task, even when the harness gives up on it, and
`Callbacks.runOwn` answers with that task's result.
`options.mcp` gives a run the conversation's MCP servers (`ProcessConfig.mcp`, `McpOffer`): each one's listing and
a call that reaches it, which an adapter that `takesMcp` offers its harness. The listing is part of the process key.
`options.remoteHands` is how a remote conversation's runs reach sigma with remote hands (D9): the harness's own tools are off
and every tool of the conversation but code mode is its own, each call's answer followed by `remoteHands.notice`. Its process starts in the target's working folder
(`remoteHands.cwd`), with the conversation's sections as its system prompt's addition, and `remoteHands.retell` says what a
session is told of entries sigma recorded with no model content, such as a change behind its target.

- `src/adapter.ts`: the seam. `Adapter` (its task kind, its name in texts, the `api` its responses carry, its settings
  per provider, and `open`), the `Connection` it opens on one harness process, the `Host` the harness's calls back
  reach, where a process starts (`Start`), the `Frame`s it says, and the `Callbacks` a run or a job answers those calls
  with. An adapter only translates: it says what its harness did, in frames, and never decides when a run ends, where a
  job's report goes or whether its process stays live. Beside a turn's content it says four things, all required (D4):
  a job started (`job`), a job ended (`job-ended`), the harness began a turn by itself (`woke`), and its turn is over
  (`idle`), and when it took a message it was sent (`took`). It also says the usage each turn added
  (`spent`), how a turn ended (`answered`, `failed`, and whether a failure means the session is `gone`), and marks a
  job's own frames with its id. A harness that cannot say a job started or ended has no jobs: its later news arrives as
  a wake with no report. One that cannot say turn-over for a wake is not hosted: nothing guesses an end.
- `src/process.ts`: the hosted process, `openHostedProcess`: one connection's frames, read whether or not a run is
  served, and the rule for what a harness does outside a run (D1 to D3). A job's frames and end go to the job. A job's
  end becomes its parent's report, which the run serving commits, or the process holds. A turn the harness begins by
  itself while no run serves wakes the conversation with the held reports, or with one saying the harness
  `continued on its own` when none came before it; that wake run sends the harness nothing. The rest go to the run
  served, or wait for the next one. A run ends at `idle`, at `failed`, or when the process ends; an `idle` before the harness took what the process sent it ends nothing, since the harness answers that next. A main-loop call made
  before a run serves the turn waits for that run (F10). A stopped run's turn is the stop's: its frames reach no run,
  but what it spent is counted by the next.
- `src/run.ts`: the run task. An invocation starts by recording, as interrupted, the calls a previous process left
  without results, which only a crash or a stop leaves; a stop is not counted as a restart. It then leases the
  conversation's live process, told only the entries after the newest one it has seen, when the process key matches
  and those entries are continuable. Otherwise it starts a process (a cold start) where the harness's session starts:
  a resume at the conversation's position, a fork of it when the position belongs to the conversation this one forked
  from, or a fresh session when there is none, another provider's harness held it, or a reset, a compaction or another
  model's answer came after it. A fresh session is named with the conversation's title, which `HostedRunOptions.title`
  gives, so the harness does not ask a model for one. A live process that exited while it waited costs a cold start. A
  session the harness no longer has, or no longer holds the position of, is dropped and the run starts over in a fresh
  one, once. A run ends when the harness goes idle, and one that answers leaves its process live, kept while its jobs
  work; one that fails or hits the turn limit closes it, cutting its jobs off. A run woken by the harness's own turn
  sends it nothing and serves that turn. A stopped run interrupts the harness's turn and leaves the process live once the harness ends that
  turn, within `STOP_TIMEOUT` (5 s), with nothing left queued or running; otherwise it closes it.
- `src/processes.ts`: the server's live processes, at most one per conversation: the lease, the idle release after
  `IDLE_RELEASE` (30 minutes), the idle compaction of a long context before its prompt cache expires, the release of a
  process that exited while it waited, the wake of a conversation whose process began a turn by itself, and closing
  them all when the server stops. A process with a job working is held until the job ends, and its idle release counts
  from then; the reports it still holds as it closes are committed to its conversation. Nothing about them is durable: a
  restart cold starts every conversation from `hosted.session`.
- `src/serving.ts`: what one run does with the frames of its own conversation. Steers placed at a round of results are
  sent with priority `next`; a job's report is committed, not sent, since the harness read the job's end itself. The
  harness's compaction is kept as a compaction entry holding its summary, a reset as a
  reset.
- `src/transcript.ts`: how a conversation the process writes to is committed, through its own task: the run's, or a
  job's. A call the harness makes is committed as an assistant entry and a live slot before `beforeRun` returns; a
  call it would ask about waits on `sigma.approvals`, keyed `<task>/<call>`, where the first answer counts. Each
  subagent the harness starts is hosted as a conversation of its own: a run's are owned by a background
  `hosted.job-anchor` in its conversation, so the run can end while they work, and a subagent's own by its job, so
  stopping it stops them too. A background command the run's harness starts is a `hosted.command` task.
- `src/job.ts`: `hosted.job`, the run of a hosted subagent's conversation. It commits its subagent's frames and
  answers its callbacks through itself, not through the run that started it, until the harness says the subagent
  ended or its process ends; and `hosted.command`, a background command's task in its parent. A job its process
  outlived ends `cut off` and appends that report to its parent; an abort stops a live job through the job's `stop`.
- `src/jobs.ts`: the `hosted.jobs` document, each background job of a conversation as its parent knows it, and the
  `hosted.report` entry that tells the parent a job ended.
- `src/links.ts`: a job as its process and its task share it in memory: its frames in order, its callbacks, how it
  ended and how to stop it.
- `src/session.ts`: `hosted.session`, where the conversation stands in the harness's session: the provider, the
  session, the newest entry the harness was shown, and the message a resume continues from. Rewindable, so a fork
  sees it as of its fork.
- `src/retell.ts`: what a session is told of the conversation: the entries a resumed one missed, or, for a fresh one,
  the conversation so far within about 64,000 characters.

`test/outside-a-run.test.ts` holds the rule for work outside a run with no harness: a scripted adapter whose connection
the test speaks for, over a Harness. The tests of a real adapter drive the rest: `packages/claude/test` through a
Harness with sigma's fake `claude`, and `packages/sigma/test/claude.test.ts` over the wire.
