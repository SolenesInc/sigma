// The process groups a server's commands run in, kept on disk so the next server can kill what a crash left running.
import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A folder holding one empty file per running process group, named by its id, and one per process that is no group
 * leader, named `<pid>.process`; the file's mtime is when it started. A command records its group when it starts and
 * removes it when it ends, so after a crash the folder lists exactly the groups still running. The local env keeps one
 * under `$SIGMA_HOME/processes`. `sigma-env` keeps one per owner, where each agent also records itself (D7).
 */
export class ProcessRegistry {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  record(group: number): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, String(group)), "")
  }

  remove(group: number): void {
    rmSync(join(this.dir, String(group)), { force: true })
  }

  /** Records one process, which the sweep kills alone, before the groups. */
  recordProcess(pid: number): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, `${pid}.process`), "")
  }

  removeProcess(pid: number): void {
    rmSync(join(this.dir, `${pid}.process`), { force: true })
  }

  /**
   * Kills every recorded process and group still running and forgets them all, processes first, so a recorded agent
   * starts no command while its groups die. An id the OS has since given to another process, one that started after the
   * record, as after a reboot, is left alone. Run it before anything records again.
   */
  sweep(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return // never recorded anything
    }
    const recorded = new Map<number, { startedMs: number; group: boolean }>()
    for (const name of names) {
      const group = !name.endsWith(".process")
      const id = Number(group ? name : name.slice(0, -".process".length))
      const path = join(this.dir, name)
      if (Number.isInteger(id) && id > 1) recorded.set(id, { startedMs: statSync(path).mtimeMs, group })
      rmSync(path, { force: true })
    }
    if (recorded.size === 0) return
    const live = [...starts([...recorded.keys()])].filter(([id, startedMs]) => {
      // Starts are read in whole seconds, or ticks, so a start is up to a second late.
      return startedMs <= recorded.get(id)!.startedMs + 1000
    })
    const targets = [
      ...live.filter(([id]) => !recorded.get(id)!.group),
      ...live.filter(([id]) => recorded.get(id)!.group),
    ]
    const signals = targets.map(([id]) => (recorded.get(id)!.group ? -id : id))
    for (const target of signals) {
      try {
        process.kill(target, "SIGKILL")
      } catch {
        // Gone since its start was read.
      }
    }
    // A kill is delivered, not done, when `kill` returns; the sweep ends once they are gone, so nothing it killed is
    // still running when its caller goes on.
    const deadline = Date.now() + DEATH_MS
    let left = signals
    while ((left = left.filter(exists)).length > 0 && Date.now() < deadline) Atomics.wait(PAUSE, 0, 0, 5)
  }
}

/**
 * How long the sweep waits for what it killed to be gone. A SIGKILLed group was gone within 1.2 ms in 20 of 20 runs
 * on macOS; a process that outlives 5 s is stuck in the kernel, and the sweep goes on without it.
 */
const DEATH_MS = 5_000
const PAUSE = new Int32Array(new SharedArrayBuffer(4))

/** Whether a process, or for a negative id any process of the group, still exists; a zombie has exited. */
function exists(target: number): boolean {
  try {
    process.kill(target, 0)
  } catch {
    return false
  }
  if (process.platform !== "linux" || target < 0) return true
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${target}/status`, "utf8"))
  } catch {
    return false
  }
}

/** When each live process among `pids` started; a pid that is gone is left out. */
function starts(pids: readonly number[]): Map<number, number> {
  return process.platform === "linux" ? procStarts(pids) : psStarts(pids)
}

/**
 * Starts from `/proc`, which every Linux has, where `ps` may be missing, as in slim container images. A process's
 * start is in clock ticks after boot, and Linux reports ticks at 100 a second to user space on every architecture.
 */
function procStarts(pids: readonly number[]): Map<number, number> {
  const bootSeconds = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1])
  const found = new Map<number, number>()
  for (const pid of pids) {
    let stat: string
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    } catch {
      continue // gone
    }
    // The command name in parentheses may hold spaces; the fields after it are fixed. starttime is field 22.
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19])
    found.set(pid, bootSeconds * 1000 + ticks * 10)
  }
  return found
}

/** Starts by `ps`'s elapsed time. */
function psStarts(pids: readonly number[]): Map<number, number> {
  const now = Date.now()
  const out = spawnSync("ps", ["-o", "pid=,etime=", "-p", pids.join(",")], { encoding: "utf8" }).stdout ?? ""
  const starts = new Map<number, number>()
  for (const line of out.split("\n")) {
    const [pid, etime] = line.trim().split(/\s+/)
    if (pid === undefined || etime === undefined) continue
    starts.set(Number(pid), now - elapsedSeconds(etime) * 1000)
  }
  return starts
}

/** `ps`'s `etime`, `[[dd-]hh:]mm:ss`, in seconds. */
function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime]
  const seconds = clock!.split(":").reduce((total, part) => total * 60 + Number(part), 0)
  return Number(days) * 86_400 + seconds
}
