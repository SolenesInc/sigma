# Sheriff: sigma's specifics

Read with `land guide sheriff`. Where they disagree, this file wins.

## CI

One workflow, `ci` (`.github/workflows/ci.yml`), runs `bun run check` on every
push to `main` in two jobs, `check (ubuntu-latest)` and
`check (macos-latest)`, with `fail-fast: false`. Each job fails on its own, so
one red run can hold two failures; record each as its own failure. A fixer
reproduces on the platform that failed: Linux on ai-sandbox, macOS on the Mac.

`bun run check` (`scripts/check.ts`) runs its parts side by side and prints
each part whole when it ends; the failed parts are named at the end of the
log. Read the failed part's output for the test and its error.

## Known failure classes

- `timed out after 20000ms: conversation/watch condition` in a sigma test,
  passing on the next push: a fixed deadline that a loaded runner missed. The
  open seed `sigma-tests-fixed-deadlines-time-out` (`s-crgc13`) collects these.
  Record the failure, add the run to that seed, and dispatch a fixer only when
  the failure has a cause beyond load, such as a wait on the wrong condition.
- A conformance mismatch (`packages/conformance/check.ts`): a test's result
  differs from its row in `expected.json`. A `flaky` row never fails `check`.
  `upstream/` may not be edited, so the repair for an upstream test that
  varies by run is a `flaky` row with a measured receipt, as the existing
  rows cite (failures out of runs, and the load), made through
  `verify-conformance`. One failure is not a receipt: give the fixer the
  measurement first. A sigma test is never marked flaky; fix it.

## Ask a person

Victor.
