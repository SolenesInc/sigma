# @sigma/hosted

The hosted run: a run of a conversation whose model a harness serves, on `@sigma/harness`. A harness is a program
that owns its own model loop, tools and session, which sigma drives as a process; an adapter speaks one harness's
protocol and turns what it says into this package's frames. The hosted run starts or reuses the harness's process,
tells it what it missed, commits what it does and answers what it asks. The harness keeps its own session and runs its
own tools; sigma's transcript stays the truth, and every frame becomes a commit. Claude Code (`@sigma/claude`) is the
first adapter.

`hostedRunTasks(options)` returns the task definitions (each adapter's run task, as `claude.run`, then `hosted.job`,
`hosted.job-anchor` and `hosted.command`), to install in the registry, and the `RunTasks` to open the harness with, which choose an
adapter's run task for a model whose provider its `settings` knows. `options.processes` is the server's
`makeHostedProcesses`, opened with the idle period and the hold that keeps the server up while a process is live.
`options.offered` names the extensions whose tools a harness is offered as its own: their prompt sections go to its
system prompt before the agent's instructions (none today).

- `src/adapter.ts`: the seam. `Adapter` (its task kind, its name in texts, the `api` its responses carry, its settings
  per provider, and `open`), the `HostedProcess` it opens, where a process starts (`Start`), the `Frame`s it hands a
  run or a job, and the `Callbacks` it reaches the run through for a call about to run or one that needs a person. An
  adapter never commits: it reaches the run only through `makeServing`. It does decide what the harness's protocol
  says: the usage each turn added (`spent`), how a turn ended (`answered`, `failed`, and whether a failure means the
  session is `gone`), and when the turn is over (`idle`), which it holds back while a message it sent has not come
  back. It routes each job's frames and end to the job, builds the report of a background job's end (`endReport`),
  hands it to the run it serves or holds it, and calls `wake` for a turn the harness began by itself.
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
- `src/jobs.ts`: the `claude.jobs` document, each background job of a conversation as its parent knows it, and the
  `claude.report` entry that tells the parent a job ended. Both keep the names clients already read.
- `src/links.ts`: a job as its process and its task share it in memory: its frames in order, its callbacks, how it
  ended and how to stop it.
- `src/session.ts`: `hosted.session`, where the conversation stands in the harness's session: the provider, the
  session, the newest entry the harness was shown, and the message a resume continues from. Rewindable, so a fork
  sees it as of its fork.
- `src/retell.ts`: what a session is told of the conversation: the entries a resumed one missed, or, for a fresh one,
  the conversation so far within about 64,000 characters.

The tests that drive the hosted run use a real adapter: `packages/claude/test` drives it through a Harness with
sigma's fake `claude`, and `packages/sigma/test/claude.test.ts` over the wire.
