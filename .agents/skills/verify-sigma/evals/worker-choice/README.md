# Worker choice

Measures whether each harness passes a person's choice of worker through
`start_worker` exactly (D11 of the plot `s-5r0qqa`): a request that names a
provider and a model reaches the tool with exactly those, two named models
start two workers, a worker with nothing named leaves the provider out, a
request for a subagent uses the harness's own, and requests that ask for no
helper start none. It does not measure which provider a model would pick on
its own: that choice is the person's.

```sh
bun .agents/skills/verify-sigma/evals/worker-choice/run.ts                 # 3 runs a cell, all cases, all harnesses
bun .agents/skills/verify-sigma/evals/worker-choice/run.ts --runs 1 --harnesses agy --cases names-model
bun .agents/skills/verify-sigma/evals/worker-choice/score.ts /tmp/sigma-verify/wc/evidence   # score saved watches again
```

`run.ts` makes one `drive.ts` run (`wc`, or `--run <id>`) with Claude Code
and `agy` on your own sign-ins and the machine's kept ChatGPT sign-in, so it
follows SKILL.md's Real accounts: it fails while another run holds the
ChatGPT sign-in. Each case starts one conversation per harness and run, all
of one run at once, in a folder holding `a.txt`, `b.txt`, `c.txt` and
`sum.py`, with calls allowed. It saves each watch as
`<harness>-<case>-<n>.ndjson` under the run's `evidence/`, writes
`plan.json` beside them, prints the table, keeps it as `table.txt`, and
ends the run. The workers a parent starts run for real too.

Parents: Claude Code on `sonnet`, ChatGPT on its default model, Gemini 4
Hydrogen through `agy`, each at low effort. Requests name the other two
providers: Claude names `openai` then `agy`, ChatGPT `agy` then `claude`,
Gemini `claude` then `openai`, with the models `haiku`, ChatGPT's default and
`gemini-4-hydrogen`.

## Cases

`cases.json` holds each request and what counts as right (`expect`):

| expect       | right when the parent's committed calls hold                                                        |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `exact`      | one `start_worker`, with exactly the named `provider` and `model`, and no subagent                  |
| `two`        | two `start_worker`s, one with each named pair, and no subagent                                      |
| `unnamed`    | at least one `start_worker`, none naming a `provider` or `model`, and no subagent                   |
| `native`     | the harness's own subagent (`Agent`, `invoke_subagent`) and no worker; ChatGPT: a worker of its own |
| `no-worker`  | no `start_worker`; the harness's own subagent is allowed                                            |
| `no-handoff` | neither a worker nor a subagent                                                                     |

The scorer reads only the parent's calls, by sigma's names for them, so a
harness's prefix (`mcp__sigma__`, `mcp_sigma_`) does not count.

## When to rerun

Rerun it, three runs a cell, when the worker tools' descriptions or the
`workers` section change (`packages/sigma/src/agents.ts`), when a harness
gets a new version or a parent a new model, and put the table on the seed
that made the change. A cell that misses is fixed in the description or the
section, never in the scorer.
