// A conversation's background jobs: the background subagents and commands Claude Code started in it, as the
// `claude.jobs` document holds them for cards and the count, and the `claude.report` entry that says one ended. A
// report is the job's end told to the parent: the run that reads Claude Code's notification commits it, an idle
// conversation gets it as input that starts a wake run (D3), and a job cut off with its process gets it from its task.
import type { ConversationId, JsonObject, Tx } from "@sigma/kernel"
import { defineDoc } from "@sigma/kernel"
import { Effect } from "effect"

/** How a job stands: working, ended as Claude Code said, stopped by a person, or ended with its process (D6). */
export type JobState = "working" | "done" | "failed" | "stopped" | "cut off"

/** One background job as its parent knows it. */
export type JobRecord = {
  /** Claude Code's task id. */
  task: string
  kind: "agent" | "command"
  /** The Agent call's description, or the command's. */
  title: string
  /** The call that started it. */
  call: string
  /** A subagent's own conversation. */
  conversation?: number
  /** The task that holds it: a subagent's `claude.job`, a command's `claude.command`, which an abort stops. */
  taskId: number
  state: JobState
  /** What Claude Code said of its end. */
  summary?: string
}

export const CLAUDE_JOBS_KIND = "claude.jobs"

/** The parent's jobs by Claude Code's task id, in the order they started. */
export const ClaudeJobsDoc = defineDoc<{ jobs: Record<string, JobRecord> }>({
  kind: CLAUDE_JOBS_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork starts without its parent's jobs: they work for the parent.
  fork: "initial",
  initial: () => ({ jobs: {} }),
  checkpointWhen: () => true,
})

/** How a job ended, from Claude Code's word for it. */
export const ENDINGS = { completed: "done", failed: "failed", stopped: "stopped", killed: "stopped" } as const

/** What a `task_notification` says a job ended with: a handed-back report, which the SDK does not type yet, or its summary. */
export const summaryOf = (frame: { summary?: string }) =>
  (frame as { handback_report?: { text?: string } }).handback_report?.text || frame.summary

export const CLAUDE_REPORT_KIND = "claude.report"

/** What a `claude.report` entry holds besides its text, which is its user message. */
export type ReportData = {
  job: string
  kind: JobRecord["kind"]
  title: string
  call: string
  conversation?: number
  status: Exclude<JobState, "working">
}

/** One job's end, as a run commits it or a wake submits it; one with no data stands for no job. */
export type JobReport = { readonly text: string; readonly data?: ReportData }

/** The report of a wake turn no job's end came before, as a scheduled wakeup starts (D4). */
export const CONTINUED_ON_ITS_OWN: JobReport = { text: "Claude Code continued on its own." }

const NOUN = { agent: "agent", command: "command" } as const

const VERB = { done: "completed", failed: "failed", stopped: "was stopped" } as const

/**
 * What the parent is told of a job's end. A command's summary of how it ran to its end says it already, as Claude Code
 * words it; a subagent's summary is its answer, told after its title.
 */
export const reportOf = (job: Omit<JobRecord, "taskId">): JobReport => {
  const status = job.state === "working" ? "done" : job.state
  const named = `The background ${NOUN[job.kind]} "${job.title}"`
  const text =
    status === "cut off"
      ? `${named} was cut off: Claude Code ended before it did.`
      : job.kind === "command"
        ? status !== "stopped" && job.summary
          ? job.summary
          : `${named} ${VERB[status]}.`
        : `${named} ${VERB[status]}${job.summary ? `: ${job.summary}` : "."}`
  return {
    text,
    data: {
      job: job.task,
      kind: job.kind,
      title: job.title,
      call: job.call,
      ...(job.conversation === undefined ? {} : { conversation: job.conversation }),
      status,
    },
  }
}

/** Appends `report` to the conversation, as the run that read it or a cut-off job's task does. */
export const appendReport = (tx: Tx, conversationId: ConversationId, report: JobReport, now: number) =>
  tx.appendEntry(conversationId, {
    kind: CLAUDE_REPORT_KIND,
    ...(report.data === undefined ? {} : { data: report.data as unknown as JsonObject }),
    model: [{ role: "user", content: report.text, timestamp: now } as unknown as JsonObject],
  })

/** Records a job in its parent's document. */
export const recordJob = (tx: Tx, conversationId: ConversationId, job: JobRecord) =>
  Effect.map(tx.doc(ClaudeJobsDoc, conversationId), (doc) => {
    doc.jobs[job.task] = job
  })

/** Ends a job in its parent's document; returns the job as it ended, or `undefined` for one it does not hold. */
export const endJob = (
  tx: Tx,
  conversationId: ConversationId,
  task: string,
  state: Exclude<JobState, "working">,
  summary: string | undefined,
) =>
  Effect.map(tx.doc(ClaudeJobsDoc, conversationId), (doc): JobRecord | undefined => {
    const job = doc.jobs[task]
    if (job === undefined) return undefined
    job.state = state
    if (summary !== undefined) job.summary = summary
    return { ...job }
  })
