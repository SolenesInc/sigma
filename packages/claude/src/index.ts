export { claudeAdapter, type ClaudeProcessSettings } from "./process.ts"
export { claudeAccount } from "./account.ts"
// The documents of Claude Code's jobs keep their names, which clients read, under the names they had here.
export {
  JOBS_KIND as CLAUDE_JOBS_KIND,
  JobsDoc as ClaudeJobsDoc,
  REPORT_KIND as CLAUDE_REPORT_KIND,
} from "@sigma/hosted"
