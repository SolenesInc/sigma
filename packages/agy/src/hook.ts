// `agy`'s Stop hook, which says a turn is over (D12): sigma loads it from a directory of its own that each process is
// given as `additionalDirectories`, so nothing is written to the person's workspace or to `~/.gemini` (s-7bmc8w F5).
// The hook writes the id of the session whose turn ended to a FIFO in that directory, which the process reads. Hooks
// also fire for `agy`'s own subagents, under their own ids, so the reader names the session (s-7bmc8w F6).
//
// The FIFO is not `agy`'s stdout, so the process can read a Stop before the updates `agy` wrote ahead of it. The process
// places the Stop among them with a request whose answer follows them (`process.ts`). The hook holds `agy` until the
// process is done with the Stop, so nothing `agy` says after the Stop, such as a prompt's result or the next wake's
// updates, comes before that answer and is taken for the turn that ended. Measured on 1.5.13: `agy` says nothing more
// of the session until its Stop hook exits (a prompt's result came only once it had), answers requests meanwhile
// (`session/close` too), and ends a hook still waiting when it exits.
import { closeSync, constants, mkdtempSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

/**
 * The hook: the payload `agy` gives it on stdin is one line of JSON (about 1 KB on 1.5.13, with no trailing newline),
 * of which it passes on only the session id, with the name of a FIFO of its own, so a write to the stops FIFO stays one
 * short atomic line. It then waits for a line on its own FIFO, which it holds open for reading and writing so the
 * process's write never waits for it.
 */
const script = (dir: string, fifo: string) => `#!/bin/sh
# Sigma's Stop hook: tells the sigma server whose agy process loaded it that a turn is over, and holds agy until the
# server has read everything agy said before it.
id="$(sed -n 's/.*"conversationId":"\\([^"]*\\)".*/\\1/p')"
done='${dir}/done.'$$
mkfifo "$done"
exec 3<>"$done"
printf '%s %s\\n' "$id" "done.$$" > '${fifo}'
read -r _ <&3
rm -f "$done"
echo '{}'
`

/** A Stop `agy` waits on: the session whose turn ended, and what tells the hook the process is done with it. */
export type Stop = {
  readonly session: string
  readonly done: () => void
}

/** The directory a process loads sigma's Stop hook from, and the Stops of its sessions, in the order they came. */
export type StopHook = {
  readonly dir: string
  readonly stops: AsyncIterable<Stop>
}

/** Makes the hook's directory and starts reading its FIFO; both go with the scope. */
export const openStopHook = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = mkdtempSync(join(tmpdir(), "sigma-agy-"))
    const agents = join(dir, ".agents")
    mkdirSync(agents)
    const fifo = join(dir, "stops")
    const made = Bun.spawnSync(["mkfifo", fifo])
    if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString().trim()}`)
    const hook = join(agents, "stop.sh")
    writeFileSync(hook, script(dir, fifo), { mode: 0o755 })
    writeFileSync(join(agents, "hooks.json"), JSON.stringify({ sigma: { Stop: [{ type: "command", command: hook }] } }))
    // Read and write, so the FIFO never reads as ended between two hooks.
    const fd = openSync(fifo, constants.O_RDWR)
    const reader = Bun.file(fd).stream().getReader()
    /** Tells the hook waiting on `name` to let `agy` go on; one that is gone, as with its process, needs nothing. */
    const release = (name: string) => () =>
      void open(join(dir, name), constants.O_WRONLY | constants.O_NONBLOCK)
        .then(async (handle) => {
          await handle.write("\n")
          await handle.close()
        })
        .catch(() => undefined)
    async function* stops(): AsyncGenerator<Stop> {
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        buffer += decoder.decode(next.value, { stream: true })
        for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
          // "<session> <fifo>"; the session is empty when the payload named none, and its hook waits all the same.
          const [session = "", name = ""] = buffer.slice(0, at).split(" ")
          buffer = buffer.slice(at + 1)
          if (name !== "") yield { session, done: release(name) }
        }
      }
    }
    return { dir, stops: stops(), reader, fd }
  }),
  ({ dir, reader, fd }) =>
    Effect.promise(async () => {
      await reader.cancel().catch(() => undefined)
      try {
        closeSync(fd)
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    }),
).pipe(Effect.map(({ dir, stops }): StopHook => ({ dir, stops })))
