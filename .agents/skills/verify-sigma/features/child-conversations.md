# Child conversations

Delegated work runs in a child conversation owned by the task or conversation that started it, foreground or background. [Subagents](./workers.md) drives it.

## Sub-features

- `child-conversation` [kernel] Child conversation under a parent (R725-770): Delegated work has its own transcript
- `child-foreground` [kernel] Foreground: the parent's turn waits on the child through a task (R725-770): A delegation behaves as one tool call, also across a restart
- `child-background` [kernel] Background: a reporter delivers the result (R725-770, §7.3): Work continues while the parent does other things
- `child-abort-cascade` [kernel] Abort cascades to children (R725-770, §5.5): Stop means everything stops
- `child-abort-background` [kernel] `abort({ background: true })` (R725-770): plain `abort()` leaves background work running, and `{ background: true }` aborts it too
- `child-tools` [kernel] Subagent tools for the model: spawn, send, follow up, wait, list, interrupt: The model manages helpers

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area Q: spec §5.5, §7.3; README Abort and Subagents; examples 21-subagent-foreground, 22-subagent-background.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

Wire, `packages/sigma/test/wire.test.ts`:

- server-idle-exit, child-tools: a subagent's work keeps the server up after its client leaves, past the idle grace
- server-stop, child-tools: stopping the server lets a working subagent finish and report first
- child-tools, worker-answer: the model starts a worker, and the wait returns its final answer, which is not also delivered as a message
- child-tools: a prompt queued while the model waits on a subagent does not end the wait, and runs after it
- child-tools, approval-auto: a subagent of a conversation that runs calls without asking does not ask either
- worker-limits, child-tools: start_worker calls in one response start at most maxThreads workers
- worker-limits, child-tools: a follow-up task does not wake an idle worker while maxThreads workers work
- child-tools: a subagent's answer that waits in its parent's queue still reaches it when the person stops the parent
- child-tools: a follow-up task reaches a working subagent at its next step, in the same run
- child-tools, worker-message, worker-assign: a worker takes messages and follow-up tasks
- child-tools, worker-list: interrupting a worker stops its turn and reports what it was doing
