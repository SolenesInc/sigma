// A conversation's background jobs: the background subagents and commands its harness started in it, as the
// `hosted.jobs` document holds them for cards and the count, and the `hosted.report` entry that says one ended. A report is the job's end told to the parent: the run that reads the
// harness's word for it commits it, an idle conversation gets it as input that starts a wake run (D3), and a job cut
// off with its process gets it from its task.
import type { ConversationId, JsonObject, Tx } from "@sigma/kernel"
import { defineDoc } from "@sigma/kernel"
import { Effect } from "effect"
import type { Job, JobEnd } from "./links.ts"

/** How a job stands: working, ended as the harness said, stopped by a person, or ended with its process (D6). */
export type JobState = "working" | "done" | "failed" | "stopped" | "cut off"

/** One background job as its parent knows it. */
export type JobRecord = {
  /** The harness's task id. */
  task: string
  kind: "agent" | "command"
  /** The Agent call's description, or the command's. */
  title: string
  /** The call that started it. */
  call: string
  /** A subagent's own conversation. */
  conversation?: number
  /** The task that holds it: a subagent's `hosted.job`, a command's `hosted.command`, which an abort stops. */
  taskId: number
  state: JobState
  /** What the harness said of its end. */
  summary?: string
}

export const JOBS_KIND = "hosted.jobs"

/** The parent's jobs by the harness's task id, in the order they started. */
export const JobsDoc = defineDoc<{ jobs: Record<string, JobRecord> }>({
  kind: JOBS_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork starts without its parent's jobs: they work for the parent.
  fork: "initial",
  initial: () => ({ jobs: {} }),
  checkpointWhen: () => true,
})

export const REPORT_KIND = "hosted.report"

/** What a `hosted.report` entry holds besides its text, which is its user message. */
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
export const continuedOnItsOwn = (harness: string): JobReport => ({ text: `${harness} continued on its own.` })

const NOUN = { agent: "agent", command: "command" } as const

const VERB = { done: "completed", failed: "failed", stopped: "was stopped" } as const

/**
 * What the parent is told of a job's end, by the harness `harness`. A command's summary of how it ran to its end says it
 * already, as the harness words it; a subagent's summary is its answer, told after its title.
 */
export const reportOf = (harness: string, job: Omit<JobRecord, "taskId">): JobReport => {
  const status = job.state === "working" ? "done" : job.state
  const named = `The background ${NOUN[job.kind]} "${job.title}"`
  const text =
    status === "cut off"
      ? `${named} was cut off: ${harness} ended before it did.`
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

/** What the parent is told of `end`, the end the harness `harness` said a job it started as `reported` came to. */
export const endReport = (harness: string, job: Job, end: Exclude<JobEnd, { status: "cut off" }>): JobReport => {
  const start = job.start!
  return reportOf(harness, {
    task: job.task,
    kind: start.kind,
    title: start.title,
    call: start.call,
    ...(job.conversation === undefined ? {} : { conversation: job.conversation }),
    state: end.status === "completed" ? "done" : end.status,
    ...(end.summary === undefined ? {} : { summary: end.summary }),
  })
}

/** Appends `report` to the conversation, as the run that read it or a cut-off job's task does. */
export const appendReport = (tx: Tx, conversationId: ConversationId, report: JobReport, now: number) =>
  tx.appendEntry(conversationId, {
    kind: REPORT_KIND,
    ...(report.data === undefined ? {} : { data: report.data as unknown as JsonObject }),
    model: [{ role: "user", content: report.text, timestamp: now } as unknown as JsonObject],
  })

/** Records a job in its parent's document. */
export const recordJob = (tx: Tx, conversationId: ConversationId, job: JobRecord) =>
  Effect.map(tx.doc(JobsDoc, conversationId), (doc) => {
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
  Effect.map(tx.doc(JobsDoc, conversationId), (doc): JobRecord | undefined => {
    const job = doc.jobs[task]
    if (job === undefined) return undefined
    job.state = state
    if (summary !== undefined) job.summary = summary
    return { ...job }
  })
