// The environment a harness plays a tape in: it reaches the model server and no account. This is the only place that
// environment is built.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"

/**
 * Claude Code on the model server at `url`: a fresh configuration folder holding no sign-in, a fake API key, the
 * sign-in tokens blanked over any the server's own environment has, and the base URL on the model server. Its
 * telemetry, error reports and update checks are off: they reach the internet, and the live test's journey took 4 to
 * 7 s without them against 8 to 9 s with them. Its memory folder is in the configuration folder: by default Claude Code
 * names it after the git repository above the working folder, so whatever another program left in `/tmp` changed it.
 */
export const claudePlayEnv = (url: string) => {
  const config = mkdtempSync("/tmp/sigma-tape-claude-")
  writeFileSync(`${config}/settings.json`, JSON.stringify({ autoMemoryDirectory: `${config}/memory` }))
  return {
    env: {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "sk-ant-tape",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // Each of these sends Claude Code past the base URL, to a cloud the server's environment may hold credentials for.
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_USE_FOUNDRY: "",
      ANTHROPIC_CUSTOM_HEADERS: "",
    } as Readonly<Record<string, string>>,
    [Symbol.dispose]: () => rmSync(config, { recursive: true, force: true }),
  }
}
