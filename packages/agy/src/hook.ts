// `agy`'s Stop hook, which says a turn is over (D12): sigma loads it from a directory of its own that each process is
// given as `additionalDirectories`, so nothing is written to the person's workspace or to `~/.gemini` (s-7bmc8w F5).
// The hook writes the id of the session whose turn ended to a FIFO in that directory, which the process reads. Hooks
// also fire for `agy`'s own subagents, under their own ids, so the reader names the session (s-7bmc8w F6).
import { closeSync, constants, mkdtempSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

/**
 * The hook: the payload `agy` gives it on stdin is one line of JSON (about 1 KB on 1.5.13, with no trailing newline),
 * of which it passes on only the session id, so a write to the FIFO stays one short atomic line.
 */
const script = (fifo: string) => `#!/bin/sh
# Sigma's Stop hook: tells the sigma server whose agy process loaded it that a turn is over.
printf '%s\\n' "$(sed -n 's/.*"conversationId":"\\([^"]*\\)".*/\\1/p')" > '${fifo}'
echo '{}'
`

/** The directory a process loads sigma's Stop hook from, and the ids of the sessions whose turn ended, in order. */
export type StopHook = {
  readonly dir: string
  readonly stops: AsyncIterable<string>
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
    writeFileSync(hook, script(fifo), { mode: 0o755 })
    writeFileSync(join(agents, "hooks.json"), JSON.stringify({ sigma: { Stop: [{ type: "command", command: hook }] } }))
    // Read and write, so the FIFO never reads as ended between two hooks.
    const fd = openSync(fifo, constants.O_RDWR)
    const reader = Bun.file(fd).stream().getReader()
    async function* stops(): AsyncGenerator<string> {
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        buffer += decoder.decode(next.value, { stream: true })
        for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
          const id = buffer.slice(0, at).trim()
          buffer = buffer.slice(at + 1)
          if (id !== "") yield id
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
