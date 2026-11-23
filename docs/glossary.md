# Glossary

The glossary is Sigma's domain model, in the sense of domain-driven design.
Use these terms with these meanings in code, tests, docs, and conversation.

```text
home                    one directory of state, SIGMA_HOME; like a tenant
│                       (`Home`, packages/sigma/src/home.ts)
├─ server (at most 1)   the process that owns the home's store, runs its work,
│  │                    and serves its socket (`serve`,
│  │                    packages/sigma/src/server.ts)
│  ├─ engine (1)        the layer over the kernel that runs conversations,
│  │                    tools, compaction, inbox, and views (packages/harness)
│  └─ client (0..n)     a program connected to the server's socket that draws
│                       committed state and sends input; the TUI is one
│                       (`Client`, packages/sigma/src/client.ts)
├─ tree (0..n)          one root conversation (a conversation people started,
│  │                    or a worker) and every subagent owned under it
│  │                    (`TreeStatus`, packages/protocol/src/index.ts)
│  ├─ root conversation (1)
│  │                    a conversation people started or a worker, at the top of
│  │                    a tree (`Lineage.root`, packages/protocol/src/index.ts;
│  │                    `rootOf`, packages/sigma/src/conversations.ts)
│  ├─ status (1)        the tree's live state (`TreeStatus.status`,
│  │  │                 packages/sigma/src/status.ts)
│  │  ├─ idle           no conversation in the tree has a run working, and no
│  │  │                 approval waits
│  │  ├─ working        at least one conversation in the tree has a run
│  │  │                 working, and no approval waits
│  │  └─ waiting        at least one approval in the tree awaits a person's
│  │                    answer (distinct from `idle`, and from a kernel task
│  │                    waiting on child tasks)
│  └─ subagent (0..n)   a child conversation a harness owns and runs, such as
│                       Claude Code's Agent; sigma shows it as a conversation,
│                       but it takes no direct input (`TakesNoInput`,
│                       packages/protocol/src/index.ts; `hosted.job`,
│                       packages/hosted/src/job.ts)
├─ worker (0..n)        a child conversation sigma starts (`start_worker`), on
│  │                    any provider; it starts a tree of its own, takes input
│  │                    from people, and outlives its parent's run
│  │                    (packages/sigma/src/agents.ts)
│  └─ worker path (1)   a worker's slash address across its parent
│                       conversation's workers, such as `/root/scout`
│                       (`TaskPathDoc`, packages/sigma/src/agents.ts)
└─ provider (1..n)      a named configuration in the home that reaches models,
   │                    with its own sign-in and health, and whether it
   │                    answers an ephemeral run (`ProviderSnapshot`,
   │                    packages/protocol/src/index.ts)
   └─ driver (1)        the backend kind behind a provider: `claude`, `openai`,
                        `agy`, or `script` (`ProviderSnapshot.driver`,
                        packages/sigma/src/config.ts)
ephemeral run           one prompt a provider answers with no tools, outside
                        any conversation: no conversation, no entries, no
                        run_end, and no usage are committed (`RunEphemeral`,
                        packages/protocol/src/index.ts; `runEphemeral`,
                        packages/sigma/src/ephemeral.ts)
```

```text
conversation            one transcript and the work done in it; like one chat
│                       (`ConversationRecord`, packages/kernel/src/records.ts;
│                       `ConversationInfo`, packages/protocol/src/index.ts)
├─ entry (0..n)         one immutable record in the transcript: a message,
│  │                    tool call, result, approval, reset, compaction, or
│  │                    run_end (`EntryRecord`, packages/protocol/src/index.ts)
│  └─ author (at most 1)
│                       who made a change: `{ id, name }` chosen by the client;
│                       sigma stores both on the change's entry, shows `name`,
│                       and interprets neither (`Author`,
│                       packages/protocol/src/index.ts)
├─ context (1)          the model messages derived from the transcript since
│                       the last reset or compaction (`ContextView`,
│                       packages/harness/src/context.ts; `ReadContext`,
│                       packages/protocol/src/index.ts)
├─ submission (0..n)    an input, passive write, or continue admitted to the
│                       conversation (`SubmissionRecord`,
│                       packages/kernel/src/records.ts; `Submit`,
│                       packages/protocol/src/index.ts)
├─ inbox (1)            the conversation's durable list of waiting submissions
│  │                    (`InboxDoc`, `pi.inbox`, packages/harness/src/inbox.ts)
│  ├─ steer (0..n)      input submitted to enter the working run at its next
│  │                    step (`Submit.steer`, packages/protocol/src/index.ts;
│  │                    `InboxItem.mode: "steer"`)
│  └─ follow-up (0..n)  input submitted to wait until the working run ends,
│                       then start its own run (`InboxItem.mode: "followUp"`,
│                       packages/harness/src/inbox.ts)
├─ run (0..n, 1 at a time)
│  │                    one stretch of work from an input to its run_end
│  │                    (`LiveRun`, `pi.live`, packages/harness/src/live.ts)
│  ├─ turn (1..n)       one model response and its tool calls (`LiveRun.turns`,
│  │                    `Configure.maxTurns`, packages/protocol/src/index.ts)
│  ├─ approval (0..n)   a tool call waiting for a person to allow or deny it;
│  │                    the first answer counts (`ApprovalsDoc`,
│  │                    `sigma.approvals`, packages/harness/src/approvals.ts;
│  │                    `ResolveApproval`, packages/protocol/src/index.ts)
│  └─ run_end (1)       the final entry (`sigma.run_end`) of a run, naming its
│                       outcome: `answered`, `interrupted`, `failed`, or
│                       `restart_limit` (`RunEnd`,
│                       packages/protocol/src/index.ts)
└─ model (1)            the provider, optional model id, and optional effort
   │                    the conversation answers with (`ModelSelection`,
   │                    packages/protocol/src/index.ts)
   └─ effort (at most 1)
                        how much reasoning the model uses
                        (`ModelSelection.effort`)
fork                    a conversation created from an earlier entry of another
                        conversation, inheriting its transcript up to that entry
                        (`ConversationRecord.parent`,
                        packages/kernel/src/records.ts; `Fork`,
                        `ConversationInfo.fork`, packages/protocol/src/index.ts).
                        `conversation/fork` creates an ownerless root
                        conversation; `start_worker` can create a forked worker
reset                   an entry (`pi.reset`) that starts an empty context with
                        an optional handoff, keeping the raw transcript
                        (`Reset`, packages/protocol/src/index.ts; `ResetEntry`,
                        packages/harness/src/entries.ts)
compaction              replacing an older prefix of context with a summary
                        entry (`pi.compaction`), keeping the raw transcript
                        (`CompactionTask`, packages/harness/src/compaction.ts;
                        `Compact`, packages/protocol/src/index.ts)
```

```text
harness                 a program that runs its own model loop, tools, and
│                       session, which sigma drives as a process: Claude Code
│                       or agy (`Adapter`, packages/hosted/src/adapter.ts)
└─ hosted run (0..n)    a run of a conversation served by a harness
   │                    (`claude.run`, `agy.run`) rather than sigma's own loop
   │                    (`pi.generation`), committing every step to sigma's
   │                    transcript (`hostedRunTasks`, packages/hosted/src/run.ts)
   ├─ job (0..n)        work a harness started that can outlive the run that
   │  │                 started it, such as a background command or subagent
   │  │                 (`JobRecord`, `hosted.jobs`, packages/hosted/src/jobs.ts)
   │  └─ job report (at most 1)
   │                    the entry (`hosted.report`) telling the conversation a
   │                    job ended, under the job's name, as input by no person
   │                    (`JobReport`, packages/hosted/src/jobs.ts)
   └─ wake run (0..n)   a hosted run started when a harness acts on its own;
                        held job reports are its input, and sigma sends the
                        harness nothing (`wakeHosted`,
                        packages/sigma/src/server.ts)
```

```text
target                  the computer a conversation's tools act on, named by an
│                       opaque id fixed at start; `local` is the server's own
│                       machine, the default (`StartConversation.target`,
│                       `LOCAL_TARGET`, packages/protocol/src/index.ts)
├─ instance (1 at a time)
│                       the machine or container behind the target now; it can
│                       restart or be replaced (`TargetPair.instance`,
│                       packages/sigma/src/targets.ts; `AgentHello.instance`,
│                       packages/env/src/protocol.ts)
├─ files (1 at a time)  the storage behind the conversation's working folder;
│                       a restart keeps it, a replacement does not
│                       (`TargetPair.files`, `AgentHello.files`)
└─ sigma-env (1 per instance)
                        sigma's program on the instance; it runs the
                        conversation's file and shell calls
                        (packages/env/src/agent.ts)
connector               the command, set by whatever runs sigma
                        (`target_connector` in `config.toml`), that opens a
                        pipe from the server to a target's current instance
                        (`openTargets`, packages/sigma/src/targets.ts)
remote conversation     a conversation whose target is not `local` (`!isLocal`,
                        packages/sigma/src/targets.ts)
remote hands            how a remote conversation runs Claude Code: its own
                        tools off, acting only through sigma's tools
                        (`usesRemoteHands`, packages/hosted/src/adapter.ts)
```

A conversation's workers, subagents, and forks share its target. Sigma does not
name who provides a target, or what kind of host it is.

```text
store (1 per home)      the SQLite database (`kernel.sqlite`) holding all
│                       durable state (`Storage`,
│                       packages/kernel/src/storage.ts)
├─ commit (0..n)        one atomic write to the store; the only way state
│                       changes, and what clients are shown (`Session.commit`,
│                       packages/kernel/src/session/session.ts)
├─ task (0..n)          durable work the kernel runs in phases, each safe to
│                       rerun from its top: a run, tool call, compaction,
│                       worker, or hosted job (`TaskRecord`,
│                       packages/kernel/src/records.ts; `WatchTasks`,
│                       packages/protocol/src/index.ts)
└─ document (0..n)      mutable JSON state the kernel keeps beside the
                        transcript, scoped to the home, a conversation, or a
                        task, such as `pi.inbox`, `pi.live`, or
                        `sigma.approvals` (`DocumentRecord`,
                        packages/kernel/src/records.ts; `defineDoc`,
                        packages/kernel/src/documents/definition.ts)
view                    what a client watches of a conversation: its entries
                        through a window and its documents, then the changes
                        each commit makes to them (`View`, `Watch`,
                        packages/protocol/src/index.ts; `ConversationView`,
                        packages/harness/src/view.ts)
```

## Tech debt

### Legacy names

Temporary debt. Read the old name as the new term. Never write the old name.

- feedback → steer or follow-up (not in Sigma's protocol; hides whether input
  enters the working run or waits until it ends)
- task (for a worker's execution or brief) → run (or submission; `task` names
  a kernel `TaskRecord`)
- task, task_name (for `/root/<name>`) → worker path (`task` names a kernel
  `TaskRecord`)
- turn (for a whole run or a harness's active stretch) → run (`turn` is one
  model response and its tool calls)
- harness (for `packages/harness`, `Harness`) → engine (`harness` names an
  external program Sigma drives: Claude Code or `agy`)
- subagent (for a worker Sigma started) → worker (`subagent` names a child a
  harness owns)
- subagent (for both workers and subagents) → workers and subagents, or child
  conversation (keeps `worker` and `subagent` distinct)
- queue (for `pi.inbox`) → inbox (avoids colliding with the TUI's `QUEUE`
  label for follow-ups)
- queued, QUEUE (in the TUI for `mode: "followUp"`) → follow-up (steers also
  wait in the inbox; `follow-up` names the post-run mode)
- thinkingLevel, thought_level → effort (`effort` is the wire and CLI term)
- provider instance, instance (for a configured provider) → provider
  (`instance` names the machine or container behind a `target`)
- session (for a conversation) → conversation (`session` names the kernel's
  home-wide commit line or a harness's own session)
- ask (in the TUI for a waiting approval) → approval (`approval` is the wire
  term; avoids colliding with attn's `ask`)

### Changes to make

- Rename `packages/harness` (`Harness`) to `engine`.
- Rename `Lineage.task`, `TaskPathDoc`, and `start_worker.task_name` to
  `worker path`, and replace `new_task` / "follow-up task" wording in
  `packages/sigma/src/agents.ts`.
- Rename `SubagentOriginDoc` and update `Lineage`, `ListConversations`, and
  `TreeStatus` annotations in `packages/protocol/src/index.ts` so `subagent`
  never names a `worker`.
- Update `stop_worker` (`packages/sigma/src/agents.ts`) and `packages/hosted`
  comments that say `turn` when they mean `run`.
- Update TUI `QUEUE · tab` / `queued` labels (`packages/sigma/src/tui/`) to
  align with `inbox` and `follow-up`.
