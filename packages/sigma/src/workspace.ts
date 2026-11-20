// Where a conversation works: its directory, the `AGENTS.md` files, the skills and the agent types there, and how a
// ChatGPT conversation is told of them, as a prompt section the harness renders before each request and commits when
// it changes. A local Claude Code conversation reads its own `CLAUDE.md` files and skills, and a script reads nothing,
// so their conversations get none. A remote Claude Code conversation, in member mode, gets the same section in its
// system prompt's `append` (D11).
//
// The project's files are read through the conversation's environment, so a remote conversation is told what its
// target holds, never what the home has at the same path (D11). What is the home's own, its `AGENTS.md`, its skills
// and the Claude Code agent types, is read from the home; a remote conversation gets only the `AGENTS.md`, since its
// tools cannot read a file on the home and it takes nothing of the person's `~/.claude` (Q3).
import { defineExtension } from "@sigma/harness"
import type { ExecutionEnv } from "@sigma/env"
import type { ImageContent, ProviderInstance, TextContent } from "@sigma/models"
import { Effect } from "effect"
import type { AgentTypes } from "./agents.ts"
import type { AttachedSkill, Skill } from "@sigma/protocol"
import { posix } from "node:path"

const { basename, dirname, join } = posix

export const AGENTS_MD_LIMIT = 32 * 1024

export interface AgentsMd {
  readonly path: string
  readonly text: string
}

/**
 * Where a conversation's instructions come from: `env` at `cwd`, a path on its target, and the home's own files
 * through `home`, the home's environment. `local` when the conversation's tools act on the home, so they can read the
 * home's skills too.
 */
export interface Workspace {
  readonly env: ExecutionEnv
  readonly cwd: string
  readonly home: { readonly dir: string; readonly env: ExecutionEnv }
  readonly local: boolean
  /** Fails when the target cannot be reached now, so a file that cannot be read is one that is not there. */
  readonly reachable: Effect.Effect<void, unknown>
}

const all = <A>(effects: Iterable<Effect.Effect<A>>) => Effect.all(effects, { concurrency: "unbounded" })

/** The file's text, or `undefined` when it cannot be read. */
const read = (env: ExecutionEnv, path: string) =>
  env.readTextFile(path).pipe(Effect.orElseSucceed(() => undefined as string | undefined))

const folders = (env: ExecutionEnv, root: string) =>
  env.listDir(root).pipe(
    Effect.map((entries) => entries.map((entry) => join(root, entry.name))),
    Effect.orElseSucceed((): Array<string> => []),
  )

/**
 * The folders from the repository's root down to `cwd`, or just `cwd` outside a repository. Every ancestor is asked at
 * once, so a remote one costs one round trip.
 */
const projectDirs = (env: ExecutionEnv, cwd: string): Effect.Effect<Array<string>> => {
  const ancestors: Array<string> = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    ancestors.push(dir)
    if (dirname(dir) === dir) break
  }
  return Effect.map(
    all(ancestors.map((dir) => env.exists(join(dir, ".git")).pipe(Effect.orElseSucceed(() => false)))),
    (found) => {
      const root = found.indexOf(true)
      return root === -1 ? [cwd] : ancestors.slice(0, root + 1).reverse()
    },
  )
}

/**
 * The instructions file of each project folder: `AGENTS.override.md`, else `AGENTS.md`, else `CLAUDE.md` for a
 * repository that has only that (F23).
 */
const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]

/** The home's `AGENTS.md`, then each project folder's instructions file, within `AGENTS_MD_LIMIT` together. */
export const agentsMd = (workspace: Workspace): Effect.Effect<Array<AgentsMd>> =>
  Effect.gen(function* () {
    const { env, cwd, home } = workspace
    const homePath = join(home.dir, "AGENTS.md")
    const dirs = yield* projectDirs(env, cwd)
    const [homeText, project] = yield* Effect.all(
      [
        read(home.env, homePath),
        all(
          dirs.map((dir) =>
            Effect.map(all(INSTRUCTION_FILES.map((name) => read(env, join(dir, name)))), (texts) => {
              const at = texts.findIndex((text) => text !== undefined)
              return at === -1 ? undefined : { path: join(dir, INSTRUCTION_FILES[at]!), text: texts[at]! }
            }),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    )
    let room = AGENTS_MD_LIMIT
    const files: Array<AgentsMd> = []
    for (const file of [homeText === undefined ? undefined : { path: homePath, text: homeText }, ...project]) {
      if (room === 0) break
      if (file === undefined || file.text.trim() === "") continue
      const kept = Buffer.from(file.text)
        .subarray(0, room)
        .toString("utf8")
        .replace(/\uFFFD$/, "")
      room -= Buffer.byteLength(kept)
      files.push({ path: file.path, text: kept })
    }
    return files
  })

const BLOCK_SCALARS = new Set(["|", ">", "|-", ">-", "|+", ">+"])

const frontmatter = (text: string): Map<string, string> => {
  const fields = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trimEnd() !== "---") return fields
  let last: string | undefined
  for (const line of lines.slice(1)) {
    if (line.trimEnd() === "---") break
    if (/^[ \t]/.test(line)) {
      if (last === undefined) continue
      const value = fields.get(last)!
      const more = line.trim()
      fields.set(last, value !== "" && more !== "" ? `${value} ${more}` : value + more)
      continue
    }
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const raw = line.slice(colon + 1).trim()
    const quoted = raw.length >= 2 && /^(".*"|'.*')$/.test(raw)
    last = line.slice(0, colon).trim()
    fields.set(last, BLOCK_SCALARS.has(raw) ? "" : quoted ? raw.slice(1, -1) : raw)
  }
  return fields
}

const afterFrontmatter = (text: string) => {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trimEnd() !== "---") return text
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---")
  return end < 0 ? "" : lines.slice(end + 1).join("\n")
}

const readSkill = (env: ExecutionEnv, folder: string): Effect.Effect<Skill | undefined> => {
  const path = join(folder, "SKILL.md")
  return Effect.map(read(env, path), (text) => {
    if (text === undefined) return undefined
    const fields = frontmatter(text)
    return { name: fields.get("name") || basename(folder), description: fields.get("description") ?? "", path }
  })
}

/** The skills in each of `roots` through `env`, read at once, in the order of `roots`. */
const skillsIn = (env: ExecutionEnv, roots: ReadonlyArray<string>) =>
  Effect.flatMap(all(roots.map((root) => folders(env, root))), (found) =>
    all(found.flat().map((folder) => readSkill(env, folder))),
  )

/** The skills a conversation can use, nearest first by name: the project's, then the home's for a local one. */
export const skillsFor = (workspace: Workspace): Effect.Effect<Array<Skill>> =>
  Effect.gen(function* () {
    const { env, cwd, home, local } = workspace
    const dirs = (yield* projectDirs(env, cwd)).reverse()
    const [project, own] = yield* Effect.all(
      [
        skillsIn(
          env,
          dirs.flatMap((dir) => [join(dir, ".agents", "skills"), join(dir, ".claude", "skills")]),
        ),
        local ? skillsIn(home.env, [join(home.dir, "skills")]) : Effect.succeed([]),
      ],
      { concurrency: "unbounded" },
    )
    const skills = new Map<string, Skill>()
    for (const skill of [...project, ...own]) if (skill && !skills.has(skill.name)) skills.set(skill.name, skill)
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  })

const skillsHeading = (read: string) => `# Skills

A skill is a folder of instructions for one kind of task, in a \`SKILL.md\` file. When a task matches a skill's description, \`${read}\` its \`SKILL.md\` before you start, and follow it. When a message names a skill with \`/name\` or \`$name\`, the skill's \`SKILL.md\` comes with the message; follow it. Relative paths in a skill are relative to its folder.

`

/** What ChatGPT is told of the `AGENTS.md` files of a conversation: one block each, or `""`. */
const agentsMdInstructions = (files: ReadonlyArray<AgentsMd>) =>
  files.map((file) => `\n# AGENTS.md instructions from ${file.path}\n\n${file.text.trimEnd()}\n`).join("")

/**
 * What ChatGPT is told of the skills a conversation can use, or `""` when it has none. `read` names the tool that reads
 * a file, as the server offers it.
 */
const skillsInstructions = (skills: ReadonlyArray<Skill>, read: string) =>
  skills.length === 0
    ? ""
    : `\n${skillsHeading(read)}${skills.map((skill) => `- ${skill.name}: ${skill.description} (file: ${skill.path})\n`).join("")}`

const skillName = (text: string) => (text.match(/^[\p{L}\p{N}\-_.:]*/u)?.[0] ?? "").replace(/[.:]+$/, "")

/** The names `text` gives as skills: `/name` at its start, and `$name` anywhere. */
export const skillNames = (text: string): Array<string> => {
  const trimmed = text.trimStart()
  return [
    ...(trimmed.startsWith("/") ? [skillName(trimmed.slice(1))] : []),
    ...[...trimmed.matchAll(/\$/g)].map((match) => skillName(trimmed.slice(match.index + 1))),
  ]
}

/** The skills `text` names, each with its `SKILL.md` read through `env` now; `skills` is read only when it names one. */
export const attachedSkills = (
  env: ExecutionEnv,
  text: string,
  skills: Effect.Effect<ReadonlyArray<Skill>>,
): Effect.Effect<Array<AttachedSkill>> =>
  Effect.gen(function* () {
    const names = skillNames(text)
    // Text that names no skill reads nothing, so most input is taken without a look at the workspace.
    if (names.length === 0) return []
    const known = yield* skills
    const named: Array<Skill> = []
    for (const name of names) {
      const skill = known.find((candidate) => candidate.name === name)
      if (skill && !named.includes(skill)) named.push(skill)
    }
    const texts = yield* all(named.map((skill) => read(env, skill.path)))
    return named.flatMap((skill, at) =>
      texts[at] === undefined ? [] : [{ name: skill.name, path: skill.path, text: texts[at]! }],
    )
  })

export interface AgentType {
  readonly name: string
  readonly description: string
  readonly model?: string
  readonly instructions: string
}

const readAgentType = (env: ExecutionEnv, path: string): Effect.Effect<AgentType | undefined> =>
  Effect.map(read(env, path), (text) => {
    if (text === undefined) return undefined
    const fields = frontmatter(text)
    const model = fields.get("model")
    return {
      name: fields.get("name") || basename(path, ".md"),
      description: fields.get("description") ?? "",
      ...(model ? { model } : {}),
      instructions: afterFrontmatter(text).trim(),
    }
  })

const typesIn = (env: ExecutionEnv, roots: ReadonlyArray<string>) =>
  Effect.flatMap(all(roots.map((root) => folders(env, root))), (found) =>
    all(
      found.flatMap((paths) =>
        paths
          .filter((path) => path.endsWith(".md"))
          .sort()
          .map((path) => readAgentType(env, path)),
      ),
    ),
  )

/**
 * The agent types a conversation sigma serves its tools to can spawn, nearest first by name: the project's `.claude/agents`, then a
 * local conversation's in `claudeConfig`, Claude Code's config folder on the home.
 */
export const agentTypes = (workspace: Workspace, claudeConfig: string): Effect.Effect<Array<AgentType>> =>
  Effect.gen(function* () {
    const { env, cwd, home, local } = workspace
    const dirs = (yield* projectDirs(env, cwd)).reverse()
    const [project, own] = yield* Effect.all(
      [
        typesIn(
          env,
          dirs.map((dir) => join(dir, ".claude", "agents")),
        ),
        local ? typesIn(home.env, [join(claudeConfig, "agents")]) : Effect.succeed([]),
      ],
      { concurrency: "unbounded" },
    )
    const types = new Map<string, AgentType>()
    for (const type of [...project, ...own]) if (type && !types.has(type.name)) types.set(type.name, type)
    return [...types.values()].sort((a, b) => a.name.localeCompare(b.name))
  })

/**
 * Whether sigma tells a conversation of its workspace: one whose loop is sigma's (ChatGPT), or one in member mode
 * (Claude Code on a target), whose Claude Code reads nothing of the project itself (D9, D11).
 */
export const toldOfWorkspace = (
  instances: ReadonlyMap<string, ProviderInstance>,
  agent: { readonly model?: { readonly provider: string }; readonly target?: string },
) => {
  const kind = agent.model === undefined ? undefined : instances.get(agent.model.provider)?.kind
  return kind === "openai" || (kind === "claude" && agent.target !== undefined && agent.target !== "local")
}

/** The name a conversation's model calls sigma's tool `name` by: Claude Code reaches it over sigma's MCP server. */
const toolNamer =
  (instances: ReadonlyMap<string, ProviderInstance>, agent: { readonly model?: { readonly provider: string } }) =>
  (name: string) =>
    agent.model !== undefined && instances.get(agent.model.provider)?.kind === "claude" ? `mcp__sigma__${name}` : name

/** What the model is told of the agent types `spawn_agent` takes, or `""` when there are none. */
const agentTypesInstructions = (types: ReadonlyArray<AgentType>, spawn: string) =>
  types.length === 0
    ? ""
    : `\n# Agent types\n\nThe agent types \`${spawn}\` takes as \`agent_type\`:\n${types.map((type) => `- ${type.name}: ${type.description}\n`).join("")}`

/** Where a conversation with this agent state works; `undefined` for one with no environment. */
export type WorkspaceOf = (
  agent: { readonly cwd?: string; readonly target?: string },
  env: ExecutionEnv | undefined,
) => Workspace | undefined

export const workspaceInstructions = (
  instances: ReadonlyMap<string, ProviderInstance>,
  workspaceOf: WorkspaceOf,
  agentTypes: AgentTypes,
) =>
  defineExtension({
    name: "sigma-workspace",
    sections: [
      {
        key: "workspace",
        tag: false,
        render: ({ agent, env, shown }) =>
          Effect.gen(function* () {
            if (!toldOfWorkspace(instances, agent)) return undefined
            const workspace = workspaceOf(agent, env)
            if (workspace === undefined) return undefined
            // With max_threads = 0 no conversation has spawn_agent, so none has use for the types. A code-mode model is
            // offered only codemode, whose scripts call spawn_agent, so the callable tools decide, not the offered ones.
            const offersSpawn = agent.callable.some((tool) => tool.name === "spawn_agent")
            yield* workspace.reachable
            const [files, skills, types] = yield* Effect.all(
              [
                agentsMd(workspace),
                skillsFor(workspace),
                offersSpawn ? agentTypes(agent, env) : Effect.succeed([] as ReadonlyArray<AgentType>),
              ],
              { concurrency: "unbounded" },
            )
            const named = toolNamer(instances, agent)
            const text = `The working directory is ${workspace.cwd}.\n${agentsMdInstructions(files)}${skillsInstructions(skills, named("read"))}${agentTypesInstructions(types, named("spawn_agent"))}`
            return text.trimEnd()
          }).pipe(
            // A target it cannot reach now keeps what the model was told; its tools say what is gone.
            Effect.catch(() => Effect.succeed(shown.workspace)),
          ),
      },
    ],
  })

/** The skills input to a conversation on `agent` can name: those of one sigma tells of its workspace, else none. */
export const skillsOf = (
  instances: ReadonlyMap<string, ProviderInstance>,
  agent: { readonly model?: { readonly provider: string }; readonly target?: string },
  workspace: Workspace,
): Effect.Effect<ReadonlyArray<Skill>> =>
  toldOfWorkspace(instances, agent) ? skillsFor(workspace) : Effect.succeed([])

/**
 * What a person's `text` and `images` give the model: the text, the `SKILL.md` of each skill it names, read now so a
 * later edit of the file changes later messages only, then the images; and the skills it carried, for the transcript.
 */
export const userInput = (text: string, attached: Array<AttachedSkill>, images: ReadonlyArray<ImageContent>) => {
  if (attached.length === 0 && images.length === 0) return { content: text, attached }
  const content: Array<TextContent | ImageContent> = [
    { type: "text", text },
    ...attached.map((skill) => ({
      type: "text" as const,
      text: `<skill>\n<name>${skill.name}</name>\n<path>${skill.path}</path>\n${skill.text.trimEnd()}\n</skill>`,
    })),
    ...images,
  ]
  return { content, attached }
}
