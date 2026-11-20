# Review: sigma's specifics

Read with `land guide review`. Where they disagree, this file wins.

## The bar

`AGENTS.md` (`CLAUDE.md` links to it) is the design bar: the domain language,
the rules under "Rules that keep it what it is" and the test strategy under
"Testing". A change that breaks one of those rules with an effect on behavior
or design is P1. "Where we are" says nobody depends on sigma yet, so a missing
compatibility path is not a finding.

## Files not to review

- `packages/conformance/upstream/`: pi-durable's suite, vendored by `port.ts`.
  Review a change to `port.ts`, `patches.json` or the rows instead.
- `schema/sigma.schema.json`: made by `bun run schema` from
  `packages/protocol`. Review the protocol change; a schema that does not
  match it fails `bun run check`.
- `fixtures/`: recorded provider exchanges. Review the test that replays one,
  not the recording.
- `bun.lock`.

## Skills a reviewer uses

The skills are in `.agents/skills`. A reviewer reads the one that fits the
unit, and runs it when a claim needs proof:

- `verify-tests` for a unit that adds, changes or deletes tests.
- `verify-conformance` for a unit that touches a kernel package (kernel,
  harness, models, env, tools, codemode, hosted, claude, delta, schema) or
  `packages/conformance`. A row moved to `flaky` without a measured receipt is
  a finding.
- `verify-sigma` to reproduce a behavior on the real TUI, CLI and socket, in a
  throwaway home. A unit that changes a user-facing behavior and leaves its
  feature map (`.agents/skills/verify-sigma/features/`) behind is a finding.

The gate is `bun run check`; CI runs it on Ubuntu and macOS. Anything it
checks is not a finding.

## Ask a person

Victor.
