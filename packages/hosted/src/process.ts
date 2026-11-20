// The hosted process: one harness process, from the connection its adapter opens. It reads every frame the harness
// says, whether or not a run is served, and owns each decision that depends on whether one is (D3): a job's frames and
// end go to the job, a job's end becomes its parent's report, which the served run commits or the process holds, a
// turn the harness begins by itself while no run serves wakes the conversation with the held reports, and the rest go
// to the served run or wait for the next one. A run ends when the harness's turn is over (`idle`), when it fails, or
// when the process ends (D1). An adapter only translates its harness: none of this is its to decide.
import { Cause, Deferred, type Duration, Effect, Exit, Option, Semaphore } from "effect"
import {
  type Adapter,
  type Callbacks,
  type Frame,
  type Host,
  type HostedProcess,
  type ProcessConfig,
  selectionOf,
  type Start,
} from "./adapter.ts"
import { endReport, type JobReport } from "./jobs.ts"
import { ENDED_WITH_PROCESS, Job, type JobEnd } from "./links.ts"
import type { Said } from "./retell.ts"
import { type Ended, failure, makeServing, type RunContext, type Serving, type ServingProcess } from "./serving.ts"

/**
 * What takes the frames that are not a job's: whether a frame was its last, what the process's end does to it, and,
 * for a run, the reports of the jobs that end while it serves.
 */
type Taker = {
  readonly frame: (frame: Frame) => Effect.Effect<boolean>
  readonly exit: (error: unknown) => void
  readonly report?: (report: JobReport) => Effect.Effect<void>
}

/**
 * Opens `adapter`'s harness at `start` as a hosted process; it is closed with the scope. `wake` is called with the
 * reports the process held when the harness begins a turn by itself while no run serves (D3); it takes them, so no run
 * that attaches meanwhile takes them too.
 */
export const openHostedProcess = <S>(
  adapter: Adapter<S>,
  config: ProcessConfig<S>,
  start: Start,
  wake: (reports: ReadonlyArray<JobReport>) => void,
) =>
  Effect.gen(function* () {
    const serial = yield* Semaphore.make(1)
    /** The run the process serves now, which the main loop's callbacks wait for (F10). */
    let serving = Deferred.makeUnsafe<Serving>()
    /** The jobs the harness started and has not said ended, by its id of each. */
    const jobs = new Map<string, Job>()
    /**
     * The job each start made, by the call that started it, until the conversation that hosts it takes it: a job can end
     * before it is hosted, as one started while no run served.
     */
    const starts = new Map<string, Job>()
    /** Completes when `jobs` empties, and is made anew when one starts. */
    let quiet = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(quiet, Exit.void)
    /** The harness began a turn by itself, and no run took it yet. */
    let waking = false
    /** The reports of the jobs that ended while no run served. */
    let reports: JobReport[] = []
    /** What takes the frames that are not a job's: the run served, or a stop. While none does, they wait in `held`. */
    let taker: Taker | undefined
    const held: Frame[] = []
    /** What the turns a stop cut off spent, which the next run counts before what it holds. */
    const unspent: Frame[] = []
    /** How the process ended, once the reader read its end: the error its end raised, if it raised one. */
    let ended: { readonly error: unknown } | undefined
    const exit = Deferred.makeUnsafe<void>()
    /**
     * The ids of what the process sent the harness and the harness has not said it took, in the order of its frames: it
     * answers them before its turn is over.
     */
    const sent = new Set<string>()

    const until = <A>(effect: Effect.Effect<A>, signal: AbortSignal | undefined) =>
      Effect.runPromise(effect, signal === undefined ? undefined : { signal })

    /** The job `id`, made when its start or one of its calls first names it. */
    const jobOf = (id: string) => {
      let job = jobs.get(id)
      if (job === undefined) {
        if (jobs.size === 0) quiet = Deferred.makeUnsafe<void>()
        jobs.set(id, (job = new Job(id, () => opened.stopJob(id))))
      }
      return job
    }

    const host: Host = {
      callbacks: (job, signal): Promise<Callbacks> =>
        job === undefined
          ? until(Deferred.await(serving), signal)
          : until(Deferred.await(jobOf(job).callbacks), signal),
      compacted: async (summary, manual, signal) =>
        (await until(Deferred.await(serving), signal)).compacted(summary, manual, signal),
    }

    /** Ends the jobs left working: a job lives in its process, and is cut off with it (D6). */
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const job of jobs.values()) job.inbox.push({ end: ENDED_WITH_PROCESS })
        jobs.clear()
      }),
    )
    const opened = yield* adapter.open(config, start, host)

    const takeReports = () => {
      const taken = reports
      reports = []
      return taken
    }

    /** Hands a frame to the taker, or holds it for the next one. */
    const take = (frame: Frame) => {
      const now = taker
      if (now === undefined) {
        held.push(frame)
        return Effect.void
      }
      return Effect.map(now.frame(frame), (done) => {
        if (done && taker === now) taker = undefined
      })
    }

    /** The harness said a job ended: the job ends, and one of the run's background jobs reports to its parent (D3). */
    const jobEnded = (frame: Extract<Frame, { type: "job-ended" }>) => {
      const job = jobs.get(frame.id)
      if (job === undefined) return Effect.void
      jobs.delete(frame.id)
      if (jobs.size === 0) Deferred.doneUnsafe(quiet, Exit.void)
      const end: Exclude<JobEnd, { status: "cut off" }> = {
        status: frame.status,
        ...(frame.summary === undefined ? {} : { summary: frame.summary }),
      }
      job.inbox.push({ end })
      if (job.start?.reported !== true) return Effect.void
      const made = endReport(adapter.name, job, end)
      if (taker?.report !== undefined) return taker.report(made)
      reports.push(made)
      return Effect.void
    }

    /** Where one frame goes: its job, the job's end, a wake, or the served run (F7). */
    const route = (frame: Frame) => {
      if (frame.type === "job") {
        const job = jobOf(frame.id)
        const top = frame.job === undefined
        job.start = { kind: frame.kind, title: frame.title, call: frame.call, reported: top && frame.background }
        // A conversation hosts each subagent, and the run each of its background commands; the rest are jobs only to
        // keep the process live. A job can end before it is hosted, as one started while no run served.
        if (frame.kind === "agent" || job.start.reported) starts.set(frame.call, job)
      }
      if (frame.job !== undefined) {
        jobs.get(frame.job)?.inbox.push({ frame })
        return Effect.void
      }
      if (frame.type === "job-ended") return jobEnded(frame)
      if (frame.type === "took") {
        sent.delete(frame.id)
        return Effect.void
      }
      if (frame.type === "woke") {
        // A turn nothing sigma sent asked for, while no run serves: the harness woke by itself (F2).
        if (taker === undefined && sent.size === 0) {
          // The reports held so far are the ones this turn is for: taken here, under the lock, so a run that attaches
          // before the wake is handed over cannot take them, and none means no job's end came before it.
          waking = true
          wake(takeReports())
        }
        return Effect.void
      }
      return take(frame)
    }

    /** Makes `next` the taker: it takes the held reports and frames first, then the end, if the process has ended. */
    const attach = (next: Taker) =>
      serial.withPermits(1)(
        Effect.gen(function* () {
          taker = next
          waking = false
          // A run takes what a stop held back first: the usage of the turn it cut off, then the reports.
          if (next.report !== undefined) {
            held.unshift(...unspent.splice(0))
            for (const report of takeReports()) yield* next.report(report)
          }
          while (taker === next && held.length > 0) yield* take(held.shift()!)
          if (taker === next && ended !== undefined) {
            taker = undefined
            next.exit(ended.error)
          }
        }),
      )
    const detach = (gone: Taker) =>
      Effect.sync(() => {
        if (taker === gone) taker = undefined
      })

    /** The process ended: the taker learns how. */
    const end = (error: unknown) =>
      Effect.sync(() => {
        if (ended !== undefined) return
        ended = { error }
        const now = taker
        taker = undefined
        now?.exit(error)
      })

    const iterator = opened.frames[Symbol.asyncIterator]()
    /** The next frame, or how the process ended: `done`, with the error its end raised if it raised one. */
    const read = () =>
      iterator.next().then(
        (result) => (result.done ? { done: true as const, value: undefined } : result),
        (error: unknown) => ({ done: true as const, value: error }),
      )
    const reader = Effect.gen(function* () {
      for (;;) {
        const next = yield* Effect.promise(read)
        if (next.done) {
          yield* serial.withPermits(1)(end(next.value))
          return yield* Deferred.succeed(exit, undefined)
        }
        yield* serial.withPermits(1)(Effect.suspend(() => route(next.value)))
      }
    })
    /** However the reader ends, the process has: a reader that died ends the run it served instead of stalling it. */
    const readerEnded = (done: Exit.Exit<void>) =>
      Effect.andThen(
        end(Exit.isFailure(done) ? Cause.squash(done.cause) : undefined),
        Deferred.succeed(exit, undefined),
      )
    yield* Effect.forkScoped(Effect.onExit(reader, readerEnded))

    const view: ServingProcess = {
      get session() {
        return opened.session
      },
      get holdsPosition() {
        return sent.size === 0 && opened.holdsPosition
      },
      send: (said, priority) => void sent.add(opened.send(said, priority)),
      serially: (effect) => serial.withPermits(1)(effect),
      started: (call) => {
        const job = starts.get(call)!
        starts.delete(call)
        return job
      },
    }

    const serve = (run: RunContext, said: ReadonlyArray<Said>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const now = makeServing(run, view)
          const done = Deferred.makeUnsafe<Ended, unknown>()
          let opening: string | undefined
          const served: Taker = {
            frame: (frame) =>
              // A turn-over before the harness took what it was sent is not the run's end: it answers that next.
              frame.type === "idle" && sent.size > 0
                ? Effect.succeed(false)
                : Effect.map(Effect.exit(now.handle(frame)), (handled) => {
                    if (Exit.isSuccess(handled) && handled.value === undefined) return false
                    Deferred.doneUnsafe(done, handled as Exit.Exit<Ended, unknown>)
                    return true
                  }),
            // A report the run cannot commit fails it, as a frame it cannot does.
            report: (made) =>
              Effect.catchCause(now.report(made), (cause) =>
                Effect.sync(() => Deferred.doneUnsafe(done, Exit.failCause(cause))),
              ),
            exit: (error) => {
              const message =
                error === undefined
                  ? `${adapter.name} exited before the turn finished`
                  : `${adapter.name} stopped: ${error instanceof Error ? error.message : String(error)}`
              // The harness never took the opening, so nothing of the run reached it.
              const lost = opening !== undefined && sent.has(opening)
              // A turn that ended before the process did ended the run as its result said.
              const ended = now.ended ?? (lost ? ({ _tag: "exited", message } as const) : failure(message))
              Deferred.doneUnsafe(done, Exit.succeed(ended))
            },
          }
          Deferred.doneUnsafe(serving, Exit.succeed(now))
          yield* Effect.addFinalizer(() =>
            Effect.andThen(
              detach(served),
              Effect.sync(() => {
                serving = Deferred.makeUnsafe<Serving>()
              }),
            ),
          )
          const switched = yield* Effect.result(opened.select(selectionOf(run.agent)))
          // Nothing of the run reached the harness yet, so a process that cannot switch costs a cold start.
          if (switched._tag === "Failure") {
            return {
              _tag: "exited",
              message: `${adapter.name} did not switch its model or effort: ${String(switched.failure)}`,
            } as const
          }
          if (said.length > 0) sent.add((opening = opened.send(said)))
          yield* attach(served)
          return yield* Deferred.await(done)
        }),
      )

    const stop = (within: Duration.Input) =>
      Effect.gen(function* () {
        // A person stopped the run, not its jobs, which keep working (D7).
        yield* Effect.promise(() => opened.interrupt().catch(() => undefined))
        const done = Deferred.makeUnsafe<boolean>()
        const stopping: Taker = {
          frame: (frame) =>
            Effect.sync(() => {
              // What the stopped turn spent is the next run's to count: this one commits nothing more.
              if (frame.type === "spent") unspent.push(frame)
              if (frame.type !== "idle") return false
              Deferred.doneUnsafe(done, Exit.succeed(sent.size === 0))
              return true
            }),
          exit: () => Deferred.doneUnsafe(done, Exit.succeed(false)),
        }
        return yield* Effect.andThen(attach(stopping), Deferred.await(done)).pipe(Effect.ensuring(detach(stopping)))
      }).pipe(Effect.timeoutOption(within), Effect.map(Option.getOrElse(() => false)))

    return {
      serve,
      canSelect: opened.canSelect,
      stop,
      get busy() {
        return jobs.size > 0
      },
      quiet: Effect.suspend(() => Deferred.await(quiet)),
      get waking() {
        return waking
      },
      takeReports,
      exited: Deferred.await(exit),
      get lastRequest() {
        return opened.lastRequest
      },
    } satisfies HostedProcess
  })
