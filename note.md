# Workers start trees of their own

Implements `s-093ee6` (part of `s-w2ttan`, D1, D2, D9).

## What changed

- **Tree root boundary (`packages/sigma/src/conversations.ts`, `status.ts`)**: `rootOf` and `lineageOf` now stop at worker boundaries (conversations with `SubagentOriginDoc.task`). Workers are tree roots alongside person-started conversations, driving `status/watch` trees (live and after server restart via `readOnLine`), `lineage.root`, `SIGMA_ROOT_CONVERSATION`, `Sigma-Root-Conversation`, and per-root MCP clients. Hosted subagents still roll up into their nearest worker or person-started root.
- **Interrupt boundary (`packages/sigma/src/agents.ts`, `tui/main.tsx`)**: Per D9, `conversation/interrupt` stops only the named conversation's run (when busy) or its own hosted background jobs (when idle) and never crosses worker boundaries. `stop_worker` or interrupting the worker's own conversation stops a worker.
- **`sigma exec` (`packages/sigma/src/exec.ts`)**: Watches all non-`shown` status updates so `exec` without `--auto` still discovers and denies approvals on workers now that they report on their own trees.
- **Protocol, glossary, and feature map**: Updated `Lineage`, `TreeStatus`, and `Interrupt` descriptions without bumping `PROTOCOL_VERSION` (D2), regenerated `schema/sigma.schema.json`, and updated `docs/glossary.md` and `.agents/skills/verify-sigma/features/`.

## Verification & review

- Two independent reviews (correctness/tests and surface/machinery) ran over the diff; all P0/P1 findings were fixed (`exec.ts` filter simplification, stale feature-map recipes/README/glossary/protocol text, unused `Subagent.task` removal, `wire.test.ts` typing + `wait_worker` race removal, and `claude.test.ts` fiber-order race fix).
- Full `bun run check` passed: `static` ok, `conformance` ok, `packages` 404 pass, `sigma` 259 pass, `stack` 55 pass, `screen` 59 pass, `coverage` 573/573 use cases, 0 problems.
