# System prompt and sections

Extensions contribute named prompt sections, and what the model was told is recorded in place so later changes keep the provider's cache, in [Prompt cache](./prompt-cache.md).

## Sub-features

- `section-contributed` [kernel] Named sections contributed by extensions (R370-378, §7.1): An extension adds durable instructions
- `section-positional` [kernel] System prompt stored as positional `pi.system` entries (§7.4): Records what the model was told and when, and later changes land where they happen
- `section-deltas` Deltas after a baseline keep the prompt cache intact (§7.4): Changing a section does not rebuild the whole cache; a ChatGPT request sends each later system message as a `developer` item at its place, in [Prompt cache](./prompt-cache.md) (`cache-instructions-change`)
- `section-new-baseline` [kernel] New baseline after a head (§7.4): A summary starts with fresh instructions
- `section-order` [kernel] Section ordering rules (§7.4): Stable, predictable prompts across extensions
- `section-wrap` [kernel] `wrapSection` (§7.1): An extension edits another's section
- `section-base` [kernel] Harness base instructions (R370-378): The host sets the foundation prompt

## How to get to it

### People

- Change a conversation's instructions, or an `AGENTS.md` file, between two
  prompts to a ChatGPT conversation (`section-deltas`).

### Agents

- `conversation/configure` with `instructions` between two
  `conversation/submit`s (`section-deltas`). Driving it is
  **Instructions changed** in [Prompt cache](./prompt-cache.md).

The other use cases here are kernel use cases, with no client path of their
own and no `drive.ts` steps.

## Sources

Feature ledger area I: spec §7.1, §7.4; README System Prompt; example 14-system-prompt.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

Provider, `packages/sigma/test/openai.test.ts`:

- cache-instructions-change, section-deltas: instructions changed between two prompts reach ChatGPT after the history, and the request keeps the instructions it started with

## Gotchas

None recorded yet.
