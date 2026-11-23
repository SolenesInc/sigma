// The tools a conversation works with: the tools package's set, where the calls that change things ask
// a person first (D13), and code mode, which models that take only code mode are offered instead of them.
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@sigma/codemode"
import type { CodemodeSandbox } from "@sigma/codemode/sandbox"
import { defineExtension, type Extension, type Harness, type ToolRegistration } from "@sigma/harness"
import {
  createApplyPatchTool,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  type ImageProcessor,
} from "@sigma/tools"
import { Effect } from "effect"
import { rootName } from "../conversations.ts"
import { mcpNamespaces } from "./mcp.ts"

const asking = <T extends ToolRegistration>(tool: T): T => ({ ...tool, asks: true })

/**
 * Sigma's tools, where `read` prepares images with `images`, as attached ones are, and `bash` stops a command after
 * `bashTimeout` seconds unless its call says otherwise. Every command runs with `SIGMA_ROOT_CONVERSATION` set to the
 * id clients name the root of its tree by (the conversation people started, or the worker itself).
 */
export const sigmaTools = (harness: () => Harness, images: ImageProcessor, bashTimeout?: number) =>
  defineExtension({
    name: "sigma-tools",
    tools: [
      createReadTool({ images }),
      createGrepTool(),
      createGlobTool(),
      asking(createWriteTool()),
      asking(createEditTool()),
      asking(createApplyPatchTool()),
      asking(
        createBashTool({
          prepare: (execution, api) =>
            Effect.map(rootName(harness(), api.conversationId), (root) => {
              execution.env.SIGMA_ROOT_CONVERSATION = root
            }),
          ...(bashTimeout === undefined ? {} : { defaultTimeout: bashTimeout }),
        }),
      ),
    ],
  })

/**
 * The `codemode` extension, whose `codemode` tool is offered to the models that take only code mode (F10) and to no
 * other; its scripts call the conversation's other tools, each a nested call that asks like a direct one.
 */
export const codeModeTools = (sandbox: CodemodeSandbox): Extension => {
  const extension = createCodemodeExtension({ sandbox, namespaces: mcpNamespaces })
  return {
    ...extension,
    tools: extension.tools!.map((tool) => (tool.name === CODEMODE_TOOL_NAME ? { ...tool, codeMode: true } : tool)),
  }
}
