# pr-gate

`pr-gate` combines the GitHub Actions check runs for a commit into one stable
required check. It has no runtime dependencies and retries transient GitHub API
failures.

Always pin the action to a full commit SHA.

## Watch mode

Watch mode is event-driven: it republishes a verdict named `gate` whenever a pull
request changes or another workflow finishes. The example publishes a commit
status, which renders as `gate` instead of being grouped under an unrelated
workflow.

Install it in two phases, because GitHub only delivers `workflow_run` events to a
workflow on the default branch. The `pull_request` trigger publishes the initial
verdict either way.

1. Add and merge the workflow. For a new install, keep `gate` optional. If an
   existing `gate` is required, let the sibling jobs finish, then rerun PR Gate
   or use a ruleset bypass to merge the installation pull request.
2. Configure the branch ruleset to require only `gate`.

```yaml
name: PR Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_run:
    types: [in_progress, completed]
    workflows: ['**']

concurrency:
  group: pr-gate-${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha }}
  cancel-in-progress: false

jobs:
  watch:
    name: watch
    runs-on: ubuntu-latest
    timeout-minutes: 5
    if: github.event.workflow_run.path != '.github/workflows/pr-gate.yml'
    permissions:
      contents: read
      checks: read
      statuses: write
      actions: read
    steps:
      - uses: muratkeremozcan/pr-gate@<sha>
        with:
          mode: watch
          publish: status
```

Keep the job name as `watch`. A job named `gate` would collide with the published
verdict.

## Wait mode

Wait mode holds one runner until every sibling check run finishes. Add this job
to a workflow that runs for the commit being gated:

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

`publish` accepts `check-run` or `status`. Both satisfy a ruleset requiring the
same context name, so switching needs no ruleset edit.

`check-run` is the compatibility default. It needs `checks: write` and carries the
full markdown summary, but GitHub may file it under an unrelated workflow as
`<workflow> / gate`, because an API-created check run cannot choose its check
suite.

`status` needs `statuses: write`. It belongs to no workflow and renders as `gate`,
its 140-character description naming the failed jobs and `target_url` linking to
the full summary. Each event writes two of the 1000 rows GitHub allows per commit
and context, so one head SHA supports roughly 500 events.

Change `publish` and its permission across two sequential merges, because a
`workflow_run` event uses the workflow file from the default branch. Grant both
write permissions and set `publish: status`, then drop `checks: write` once that
has landed.

An in-flight pull request may keep the old `gate` check run, and GitHub can report
that abandoned run for the shared context even though the action ignores it as a
sibling. The action warns when it sees this. Push a new commit or conclude the old
check run by hand.

## Re-running a failed job

This section and the next are optional and independent. `in_progress` is a trigger
edit, `wait-for` is an input that defaults to doing nothing, and a caller that
takes neither behaves exactly as before.

Nobody has to re-run the gate: a re-run wakes it and the verdict is recomputed
from the commit. `in_progress` is what makes that visible while the re-run is
still running, where `completed` alone leaves the old red published for its whole
length. It is the only signal available, because GitHub sends no `requested` for
a re-run and `check_run` and `check_suite` never fire for check suites Actions
created.

Wait mode cannot do this. The verdict is the job's own exit code and that job is
over.

## Late and conditional jobs

A job that has not started does not exist, so a gate that concluded before it
registered would publish a pass that checked nothing. That is the failure mode
for anything chained behind something else: e2e waiting on a deployment, a suite
triggered in another repository, a job behind an unevaluated `if:`.

`wait-for` names them up front, in the same rule shape as `skip-list`:

```yaml
with:
  mode: watch
  wait-for: |
    [{ "workflowFile": "pr-e2e.yml", "jobName": "e2e", "jobMatchMode": "prefix" }]
  wait-for-timeout: PT20M
```

An unmatched rule holds the gate pending and names what it is waiting for. Once
it matches it is an ordinary sibling and has to pass like the rest.

`wait-for-timeout` measures how long the commit has been quiet, not how long
since CI started: the clock runs from the newest check suite, so every workflow
that starts pushes the deadline out and a chain of late jobs each get a window.
`wait-for-timeout-conclusion` decides what happens when it does run out, `failure`
by default or `success` for a job that may legitimately never run.

Watch mode holds its runner while every other job has finished and the awaited one
has not started, because nothing is left to fire an event. Give that job more
`timeout-minutes` than `wait-for-timeout`.

## Configuration

`mode` is required and accepts `watch` or `wait`. Inputs and defaults are
documented in [`action.yml`](action.yml). Durations accept ISO 8601 values such
as `PT15S` or plain seconds such as `15`.

`skip-list` ignores a workflow, a job, or matrix job variants. `jobMatchMode`
accepts `exact` or `prefix`, and omitting `jobName` skips a whole workflow:

```yaml
with:
  mode: watch
  skip-list: |
    [{ "workflowFile": "claude-code-review.yaml", "jobName": "review", "jobMatchMode": "prefix" }]
```

`bypass-branch-prefixes` waves a branch through and publishes a passing verdict
whose summary names the branch and the prefix that matched:

```yaml
with:
  mode: watch
  bypass-branch-prefixes: 'hotfix/,emergency/'
```

Use it instead of an `if:` condition in watch mode. A skipped watch job publishes
no verdict and blocks the merge, while a skipped wait job counts as passing. The
branch is resolved from the event payload, so the bypass survives `workflow_run`
events.

## Important behavior

- Watch mode owns its check run through an `external_id` and refuses to update a
  same-named check run created by another tool. A commit status needs no
  equivalent, because posting one supersedes whatever held the context.
- The action reads GitHub check runs. Commit statuses and check suites from
  non-Actions apps must be required separately.
- A commit with no visible sibling check runs passes after `warmup-delay`.
- `concurrency` must use `cancel-in-progress: false`. Cancelling a watch run can
  leave the required check pending.

## Development

```bash
node --test tests/*.test.js
```

Nothing to install. The action runs on the Node 24 Actions runtime, and the
`Test` workflow exercises both modes against the live GitHub API.
