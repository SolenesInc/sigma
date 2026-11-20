const SUMMARY_WIDTH = 120

const field = (input: unknown, name: string) => {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[name] : undefined
  return typeof value === "string" ? value : undefined
}

const firstLine = (text: string) => {
  const line = text.split("\n", 1)[0]!
  return line.length > SUMMARY_WIDTH ? `${line.slice(0, SUMMARY_WIDTH - 1)}…` : line
}

export const describeCall = (tool: string, input: unknown) => {
  const subject =
    field(input, "command") ??
    field(input, "file_path") ??
    field(input, "pattern") ??
    field(input, "path") ??
    field(input, "cell_id") ??
    field(input, "task_name") ??
    field(input, "target")
  return subject === undefined ? tool : `${tool}(${firstLine(subject)})`
}

/** A `sigma.target_changed` entry in one line, as the TUI draws it and `sigma exec` prints it. */
export const describeTargetChange = (data: {
  readonly target: string
  readonly to: { readonly instance: string }
  readonly filesKept: boolean
}) =>
  data.filesKept
    ? `◆ ${data.target} restarted as ${data.to.instance}: files kept, processes gone`
    : `◆ ${data.target} was replaced by ${data.to.instance}: files, processes and changes from before are gone`
