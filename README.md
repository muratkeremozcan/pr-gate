# pr-gate

`pr-gate` watches every other job on a commit and publishes one verdict, `gate`.
Require that one check in the branch ruleset and adding, renaming or removing a
CI job never needs a branch-protection edit again.

It has no runtime dependencies and retries transient GitHub API failures. Always
pin the action to a full commit SHA.

Pick a mode: **watch** costs seconds per event, **wait** is one job that blocks.

## Watch mode

Watch mode reacts to events. Every time a workflow finishes it recomputes the
verdict and republishes `gate`, so it costs a few seconds per event instead of
holding a runner for the length of your slowest job.

```yaml
name: PR Gate

on:
  # First verdict on a new commit. A commit with no other jobs at all passes
  # once warmup-delay is up.
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_run:
    # completed recomputes when a workflow finishes. in_progress clears a stale
    # red the moment someone re-runs a failed job.
    types: [in_progress, completed]
    # Every workflow, so adding one never means editing this file. Covers Actions
    # only, so require Vercel, GitGuardian and the like separately. Fires only
    # once this file is on the default branch, so merge it before requiring `gate`.
    workflows: ["**"]

# One run at a time per commit, so two events cannot race the same verdict. The
# two event types keep the SHA in different places, hence the fallback. Keep
# cancel-in-progress false: a cancelled run leaves `gate` pending forever.
concurrency:
  group: pr-gate-${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha }}
  cancel-in-progress: false

jobs:
  watch:
    # Not `gate`. That name belongs to the verdict this job publishes.
    name: watch
    runs-on: ubuntu-latest
    # Above wait-for-timeout (30m) and above attempt-limits x minimum-interval (180 x 15s = 45m).
    # Watch mode holds its runner while a wait-for job has not started, and a job killed mid-wait publishes nothing.
    # Ordinary runs finish in seconds.
    timeout-minutes: 60
    # workflow_run fires for this workflow too, so without this it triggers itself.
    if: github.event.workflow_run.path != '.github/workflows/pr-gate.yml'
    # No other `if:` on this job.
    # A skipped job publishes no verdict, so a guard that used to wave a branch through now blocks it.
    # Use bypass-branch-prefixes.
    permissions:
      contents: read
      checks: read
      # For publish: status. Use checks: write instead for publish: check-run.
      statuses: write
      actions: read
    steps:
      - uses: muratkeremozcan/pr-gate@<sha>
        with:
          mode: watch
          # Publishes a check named `gate`. Nothing else may write that name.
          publish: status
```

Require only `gate` in the branch ruleset.

## Wait mode

Wait mode is one job that sits there until every other job on the commit
finishes, then passes or fails with them. Nothing to merge first and nothing to
publish, at the cost of a runner for as long as your slowest job.

Add it to a workflow that already runs for the commit being gated:

```yaml
jobs:
  gate:
    name: gate
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: read
      checks: read
      actions: read
    steps:
      - uses: muratkeremozcan/pr-gate@<sha>
        with:
          mode: wait
```

## Watch publishing

Use `publish: status`, as the example does. Your required check then shows up on
the pull request as plain `gate`.

The `check-run` default exists for older installs. It shows up as
`<some other workflow> / gate`, so a failing gate reads as a failure of a
workflow that passed.

Switching from `check-run` takes two merges. Add `statuses: write` next to
`checks: write` and set `publish: status`, then drop `checks: write` once that
has landed. The old `gate` check run can keep a pull request blocked until you
push a new commit to it.

## How conclusions count

| Check run conclusion | Gate |
| --- | --- |
| `success`, `skipped`, `neutral` | passes |
| `action_required` | pending |
| `failure`, `cancelled`, `timed_out`, `stale`, `startup_failure`, anything new | fails |

`action_required` means a person has to approve the run, as for a first-time contributor.
The gate holds the merge until they do, and approving fires a `workflow_run` event that recomputes the verdict.
An unapproved run, such as one from an abandoned fork pull request, keeps the gate pending until someone approves it or a new commit is pushed.
A conclusion GitHub adds later fails, so it cannot pass a commit by accident.

## What the gate does not see

Check suites from GitHub Apps other than Actions, such as Vercel and GitGuardian, carry no workflow run.
The gate cannot wait on or judge them, and the verdict summary lists each by name.
Require them in the ruleset.

CI that reports only commit statuses, with no check run, is invisible to the gate and cannot be named.
Require its status context in the ruleset too.

## When the gate itself breaks

If watch mode throws while reading or writing a verdict, it publishes a failure titled "Gate could not compute a verdict" with the error, and the job fails.
The next workflow event recomputes the verdict, and re-running the failed PR Gate job does it now.
If the head SHA cannot be read from the event payload, nothing is published and the missing `gate` context blocks the merge.

With `publish: status` the action warns once a commit reaches 800 of the 1000 status rows GitHub allows per context.
Past 1000 the gate cannot publish, so push a new commit before then.

## Re-running a failed job is not needed

Nobody has to re-run the gate; it recomputes by itself. `in_progress` in the
trigger list is what clears the red while the re-run is still going, instead of
when it finishes. Watch mode only.

## Late and conditional jobs

`wait-for` holds the gate open for a job that has not registered yet, so a suite
chained behind a deployment or another repository cannot be missed:

```yaml
with:
  mode: watch
  wait-for: |
    [{ "workflowFile": "pr-e2e.yml", "jobName": "e2e", "jobMatchMode": "prefix" }]
  wait-for-timeout: 20m
```

Rules take the same shape as `skip-list`. Once a rule matches, that job is an
ordinary sibling and has to pass.

`wait-for-timeout` counts quiet time, so every workflow that starts pushes it out
and a chain of late jobs each get a window. When it does run out,
`wait-for-timeout-conclusion` decides the verdict: `failure` by default, or
`success` for a job that may legitimately never run.

Give that job more `timeout-minutes` than `wait-for-timeout` and than `attempt-limits` times `minimum-interval`, as the example does.
A job killed mid-wait publishes nothing and leaves the gate pending until the next event.

While no check suite has registered on the commit, watch mode keeps polling for `attempt-limits` and does not conclude "never started" a few seconds after a push.

## Configuration

`mode` is required and accepts `watch` or `wait`. Inputs and defaults are
documented in [`action.yml`](action.yml). Durations take `20m`, `2h`, `30s`, plain
seconds such as `1200`, or ISO 8601 such as `PT20M`.

`skip-list` ignores a workflow, a job, or matrix job variants. `jobMatchMode`
accepts `exact` or `prefix`, and omitting `jobName` skips a whole workflow:

```yaml
with:
  mode: watch
  skip-list: |
    [{ "workflowFile": "claude-code-review.yaml", "jobName": "review", "jobMatchMode": "prefix" }]
```

`bypass-branch-prefixes` waves a branch through and publishes a pass whose
summary names the branch and the prefix that matched:

```yaml
with:
  mode: watch
  bypass-branch-prefixes: "hotfix/,emergency/"
```

Use it instead of an `if:` condition in watch mode, where a skipped job publishes
no verdict and blocks the merge.

## Development

```bash
node --test tests/*.test.js
```

Nothing to install. The action runs on the Node 24 Actions runtime, and the
`Test` workflow exercises both modes against the live GitHub API.
