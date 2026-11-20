#!/usr/bin/env bun
// score.ts <dir>: scores the saved watches run.ts left in <dir> against plan.json, and prints a table of case by
// harness with each miss named. It reads only the parent's committed tool calls, by sigma's names for them, so a
// harness's own prefix (mcp__sigma__, mcp_sigma_) does not matter, and a code mode script's calls from its result.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type Planned = {
  readonly file: string
  readonly harness: string
  readonly case: string
  readonly run: number
  readonly expect: "exact" | "two" | "unnamed" | "native" | "no-worker" | "no-handoff"
  /** The provider and model each worker must get, for `exact` and `two`. */
  readonly wanted: ReadonlyArray<{ readonly provider: string; readonly model: string }>
}

type Call = { readonly name: string; readonly arguments: Record<string, unknown> }

/** The subagent tools of each harness: Claude Code's Agent, agy's invoke_subagent. */
const NATIVE = new Set(["Agent", "Task", "invoke_subagent"])

/**
 * A script call's arguments, from the JSON its result records. That JSON is cut short when it is long, so then only
 * the keys the scorer reads, `provider` and `model`, read from the script's source, which the call committed whole.
 */
export const argumentsOf = (args: string, code: string): Record<string, unknown> => {
  try {
    return JSON.parse(args || "{}")
  } catch {
    const found: Record<string, unknown> = {}
    for (const key of ["provider", "model"]) {
      const value = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]*)`).exec(code)?.[1]
      if (value !== undefined) found[key] = value
    }
    return found
  }
}

/** The parent's tool calls, each once, from a saved watch. */
const callsOf = (path: string): Call[] => {
  const seen = new Set<string>()
  const calls: Call[] = []
  /** The source of each code mode script, by its call. */
  const scripts = new Map<string, string>()
  const walk = (value: any): void => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (value === null || typeof value !== "object") return
    if (value.kind === "pi.assistant" && Array.isArray(value.model))
      for (const message of value.model)
        for (const part of Array.isArray(message.content) ? message.content : [])
          if (part.type === "toolCall" && part.name === "codemode") {
            // A watch holds the script's partial source while it streams, then the whole of it.
            const code = String(part.arguments?.code ?? "")
            if (code.length > (scripts.get(part.id)?.length ?? -1)) scripts.set(part.id, code)
          } else if (part.type === "toolCall" && !seen.has(part.id)) {
            seen.add(part.id)
            calls.push({ name: part.name, arguments: part.arguments ?? {} })
          }
    // A code mode script's calls are in its result's details, each with its arguments as JSON.
    if (value.kind === "pi.tool-result" && Array.isArray(value.model))
      for (const message of value.model)
        for (const call of message.details?.calls ?? [])
          if (!seen.has(`${message.toolCallId}/${call.id}`)) {
            seen.add(`${message.toolCallId}/${call.id}`)
            calls.push({
              name: call.name,
              arguments: argumentsOf(String(call.args ?? ""), scripts.get(message.toolCallId) ?? ""),
            })
          }
    Object.values(value).forEach(walk)
  }
  for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim() !== "") walk(JSON.parse(line))
  return calls
}

/** Whether a run did what its case asks, and if not, why. */
export const judge = (planned: Planned, calls: ReadonlyArray<Call>): string | undefined => {
  const starts = calls.filter((call) => call.name === "start_worker")
  const native = calls.filter((call) => NATIVE.has(call.name))
  const named = starts.map((call) => `${call.arguments.provider ?? "-"}/${call.arguments.model ?? "-"}`)
  const shown = `starts [${named.join(", ")}]${native.length > 0 ? `, ${native.length} subagent` : ""}`
  const pair = (want: { provider: string; model: string }) => `${want.provider}/${want.model}`
  switch (planned.expect) {
    case "exact":
    case "two": {
      const wanted = planned.wanted.map(pair).sort()
      return JSON.stringify([...named].sort()) === JSON.stringify(wanted) && native.length === 0
        ? undefined
        : `wanted [${wanted.join(", ")}]; ${shown}`
    }
    case "unnamed":
      return starts.length >= 1 &&
        starts.every((call) => call.arguments.provider === undefined && call.arguments.model === undefined) &&
        native.length === 0
        ? undefined
        : `wanted a worker naming no provider or model; ${shown}`
    case "native":
      // ChatGPT runs on sigma's own loop, whose only helpers are workers: one on its own provider is its own.
      if (planned.harness === "openai")
        return starts.length >= 1 && starts.every((call) => call.arguments.provider === undefined)
          ? undefined
          : `wanted a worker on its own provider; ${shown}`
      return native.length >= 1 && starts.length === 0 ? undefined : `wanted the harness's own subagent; ${shown}`
    case "no-worker":
      return starts.length === 0 ? undefined : `wanted no worker; ${shown}`
    case "no-handoff":
      return starts.length === 0 && native.length === 0 ? undefined : `wanted no helper; ${shown}`
  }
}

export const score = (dir: string) => {
  const plan: Planned[] = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"))
  const harnesses = [...new Set(plan.map((each) => each.harness))]
  const cases = [...new Set(plan.map((each) => each.case))]
  const misses: string[] = []
  const rows = cases.map((id) => {
    const cells = harnesses.map((harness) => {
      const mine = plan.filter((each) => each.case === id && each.harness === harness)
      let ok = 0
      for (const planned of mine) {
        const path = join(dir, planned.file)
        const why = existsSync(path) ? judge(planned, callsOf(path)) : "no watch saved"
        if (why === undefined) ok++
        else misses.push(`${id} ${harness} run ${planned.run}: ${why} (${planned.file})`)
      }
      return `${ok}/${mine.length}`
    })
    return [id, ...cells]
  })
  const table = [["case", ...harnesses], ...rows]
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)))
  const lines = table.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  "))
  return [...lines, "", misses.length === 0 ? "no misses" : "misses:", ...misses].join("\n")
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (dir === undefined) {
    console.error("usage: score.ts <dir>")
    process.exit(2)
  }
  console.log(score(dir))
}
