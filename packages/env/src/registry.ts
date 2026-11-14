// The process groups a server's commands run in, kept on disk so the next server can kill what a crash left running.
import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A folder holding one empty file per running process group, named by its id; the file's mtime is when it started.
 * A command records its group when it starts and removes it when it ends, so after a crash the folder lists exactly the
 * groups still running. The local env keeps one under `$SIGMA_HOME/processes`; `sigma-env` keeps one per owner.
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

  /**
   * Kills every recorded group still running and forgets them all. A group id the OS has since given to another process,
   * one that started after the record, as after a reboot, is left alone. Run it before anything records again.
   */
  sweep(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return // never recorded anything
    }
    const recorded = new Map<number, number>()
    for (const name of names) {
      const group = Number(name)
      const path = join(this.dir, name)
      if (Number.isInteger(group) && group > 1) recorded.set(group, statSync(path).mtimeMs)
      rmSync(path, { force: true })
    }
    if (recorded.size === 0) return
    for (const [group, startedMs] of leaderStarts([...recorded.keys()])) {
      // `ps` gives whole seconds of age, so its start is up to a second late.
      if (startedMs > recorded.get(group)! + 1000) continue
      try {
        process.kill(-group, "SIGKILL")
      } catch {
        // Gone since `ps` looked.
      }
    }
  }
}

/** When each live process among `pids` started, by `ps`'s elapsed time; a pid that is gone is left out. */
function leaderStarts(pids: readonly number[]): Map<number, number> {
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
