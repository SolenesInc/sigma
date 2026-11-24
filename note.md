Stops `sigma exec` from rescanning the entire home (`conversation/list`) when unrelated conversations run in the same Sigma home (SolenesInc/sigma#157, regression from `e69ff71`).

`sigma exec` no longer subscribes to `status/watch` at all. Instead, once its `conversation/watch` holds the initial view, it adopts pre-existing descendants from the initial `conversation/list`, and only re-lists when a followed conversation commits a child (`sigma.subagent` or `start_worker`/`codemode` `pi.tool-result`), finishes a nested `start_worker` slot in `pi.live.nestedTools`, opens a truncated child window, or reconnects after a drop or restart.

In the live RPC probe (one held `sigma exec` while a peer `sigma exec` runs and finishes in the same home), `observed` dropped from 10 total `conversation/list` calls (2 during the peer run) and 1 `status/watch` down to 1 `conversation/list` total (0 during the peer run) and 0 `status/watch`.
