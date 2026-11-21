// The journeys that have tapes: the steps a person takes, played against a server in process whose harness is real and
// whose model is the model server playing the journey's tape. `tapes.ts generate` plays one through the recorder to
// write its process fixture; a live test plays one straight.
import { existsSync, watch, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ClaudeProcessSettings } from "@sigma/claude"
import type { EntryRecord } from "@sigma/protocol"
import { DEADLINE, deadline, RawClient } from "./raw.ts"
import { person, runEnds, runningServer, settled, submit, tempHome, type ViewWatch, watchView } from "./server.ts"
import type { ModelServer } from "./model-server.ts"

export const MODEL = "claude-haiku-5-5"

export interface Journey {
  readonly harnesses: ReadonlyArray<"claude">
  readonly ask?: "ask" | "auto"
  readonly play: (session: Session) => Promise<void>
}

/** A conversation on a journey's harness, as the person in the journey drives it. */
export interface Session {
  readonly cwd: string
  readonly view: ViewWatch
  readonly submit: (text: string) => Promise<unknown>
  /** Until every run submitted so far has ended. */
  readonly settle: () => Promise<void>
  readonly until: (predicate: (watch: ViewWatch) => boolean) => Promise<void>
  readonly seen: () => ReadonlyArray<EntryRecord>
  /** Lets go the model's replies held at `gate`. */
  readonly release: (gate: string) => void
  /** Until the model was asked for `lane`'s reply at `turn`. */
  readonly asked: (lane: string, turn: number) => Promise<void>
  /** The first subagent's conversation, once Claude Code started one. */
  readonly subagent: () => Promise<ViewWatch>
  /** Writes a file in the conversation's folder. */
  readonly write: (path: string, text: string) => void
  /** Until a file exists in the conversation's folder. */
  readonly appears: (path: string) => Promise<void>
}

export const STOPPED_AT_END_PROMPT =
  "Use the Agent tool to start a general-purpose subagent, not in the background, and give it this task in its own words: begin a long command in the background and come back at once. Do not run any command yourself. Then reply with exactly what the subagent reported."

export const BACKGROUND_OUTLIVES_PROMPT =
  "Use the Agent tool with run_in_background set to true to start a general-purpose subagent, and give it this task in its own words: begin a long command in the background and come back at once. Do not run any command yourself, and do not wait for the subagent. Reply with exactly: started"

export const journeys: Readonly<Record<string, Journey>> = {
  // A background subagent's command outlives the subagent. Once the journey lets the command end, Claude Code wakes the
  // subagent, and the subagent's second end wakes the parent.
  background_subagent_command_outlives: {
    harnesses: ["claude"],
    ask: "auto",
    play: async (s) => {
      await s.submit(BACKGROUND_OUTLIVES_PROMPT)
      // The parent and the subagent ask at once: the subagent starts once the parent's turn has ended, when sigma has
      // counted what it spent, so the two never stream at once.
      await s.asked("sub", 1)
      await s.until(
        (watch) =>
          Object.keys((watch.view().docs["pi.usage"] as { models?: object } | undefined)?.models ?? {}).length > 0,
      )
      s.release("subagent")
      await s.settle()
      s.write("go", "")
      await s.appears("outlived.txt")
      await s.until(settled(2))
    },
  },
  // A foreground subagent starts a background command and ends while the command still works: Claude Code stops the
  // command as the subagent ends.
  subagent_command_stopped_at_end: {
    harnesses: ["claude"],
    ask: "auto",
    play: async (s) => {
      await s.submit(STOPPED_AT_END_PROMPT)
      await s.settle()
    },
  },
}

/** Opens a conversation of `journey` on a server in process whose Claude Code is `claude`, playing `model`'s tape. */
export const openSession = async (journey: Journey, claude: ClaudeProcessSettings, model: ModelServer) => {
  const home = tempHome()
  const server = await runningServer([], { home, claude })
  const client = await RawClient.connect(home.socket)
  const conversation = (
    await client.call("conversation/start", {
      author: person("ada"),
      cwd: home.dir,
      provider: "claude",
      model: MODEL,
      approvals: journey.ask ?? "ask",
    })
  ).result.conversation as string
  const view = watchView(client, conversation)
  await view.until(() => true)
  let submitted = 0
  const session: Session & AsyncDisposable = {
    cwd: home.dir,
    view,
    submit: (text) => {
      submitted = runEnds(view.seen()).length + 1
      return submit(client, conversation, text, crypto.randomUUID(), person("ada"))
    },
    settle: () => view.until(settled(submitted)),
    until: (predicate) => view.until(predicate),
    seen: () => view.seen(),
    release: (gate) => model.release(gate),
    asked: (lane, turn) => deadline(model.asked(lane, turn), DEADLINE, `lane ${lane} to ask at turn ${turn}`),
    subagent: async () => {
      await view.until((watch) => watch.seen().some((entry) => entry.kind === "sigma.subagent"))
      const entry = view.seen().find((entry) => entry.kind === "sigma.subagent")!
      return watchView(client, String((entry.data as { conversation: number }).conversation))
    },
    write: (path, text) => writeFileSync(join(home.dir, path), text),
    appears: (path) => appears(join(home.dir, path)),
    [Symbol.asyncDispose]: async () => {
      client.close()
      await server[Symbol.asyncDispose]()
    },
  }
  return session
}

/** Until `path` exists. */
const appears = (path: string) => {
  let watcher: ReturnType<typeof watch> | undefined
  return deadline(
    new Promise<void>((resolve) => {
      const check = () => existsSync(path) && resolve()
      watcher = watch(join(path, ".."), check)
      check()
    }),
    DEADLINE,
    `${path} to appear`,
  ).finally(() => watcher?.close())
}
