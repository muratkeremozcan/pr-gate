# pr-gate

`pr-gate` combines the GitHub Actions check runs for a commit into one stable
required check. It has no runtime dependencies and retries transient GitHub API
failures.

Always pin the action to a full commit SHA.

## Watch mode

Watch mode is event-driven. It publishes a verdict named `gate` whenever a pull
request changes or another workflow finishes. The example selects a commit
status because it renders as `gate` without being grouped under another workflow.

Install it in two phases because GitHub only delivers `workflow_run` events to
a workflow on the default branch:

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

Require only `gate` in the branch ruleset. Keep the job name as `watch` because
a job named `gate` would collide with the published verdict.

The `pull_request` trigger publishes the initial verdict. The `workflow_run`
trigger starts working after this workflow exists on the default branch.

## Re-running a failed job

This section and the next describe two independent, optional features. Neither is
required and neither needs the other. `in_progress` is a trigger edit in your own
workflow; `wait-for` is an action input that defaults to doing nothing. An
existing caller that adopts neither behaves exactly as it did before.


Nobody has to re-run the gate. A re-run of any workflow on the commit wakes it
by itself, and the verdict is recomputed from the state of the commit rather
than remembered from the last one.

`in_progress` is what makes that visible while the re-run is still going.
`completed` alone leaves the old red published for the whole length of the
re-run, which reads as a gate that has not noticed, and the usual reaction to
that is to go and re-run the gate too, or to push an empty commit.

There is no alternative to `in_progress` here. GitHub does not send
`workflow_run` `requested` for a re-run, and `check_run` and `check_suite` never
fire for check suites GitHub Actions created. Measured against the API: clicking
"re-run failed jobs" produced `in_progress` with `run_attempt: 2` six seconds
later, then `completed` when it finished, and no `requested` at all.

The cost is roughly one more gate run per workflow per commit, a few seconds
each. In exchange, the moment a re-run starts the gate publishes
`Waiting on ...: re-running` and the pull request stops showing a failure that is
already being fixed.

Wait mode cannot do this. There the verdict is the job's own exit code, and that
job is over, so the only way to move it is to run it again. That is the reason to
prefer watch mode on a repo where people re-run failed jobs.

## Late and conditional jobs

The gate reasons about check runs that exist. A job that has not started yet does
not exist, so a gate that concluded before it registered would publish a pass
that nothing checked. That is the failure mode for anything chained behind
something else: e2e that waits for a deployment, a suite triggered in another
repository, a job behind an `if:` that has not been evaluated yet.

`wait-for` names them up front:

```yaml
with:
  mode: watch
  wait-for: |
    [
      { "workflowFile": "pr-e2e-vercel-preview.yml", "jobName": "e2e", "jobMatchMode": "prefix" },
      { "workflowFile": "contract-testing.yml" }
    ]
  wait-for-timeout: PT20M
```

Rules take the same shape as `skip-list`. A rule with no match holds the gate
pending and says which one it is waiting for. Once it matches, it is an ordinary
sibling and has to pass like the rest. Naming a job in both `wait-for` and
`skip-list` is a contradiction, and the action warns rather than waiting for a
check run it is throwing away on every poll.

`wait-for-timeout` measures how long the commit has been **quiet**, not how long
since CI started. The clock runs from the newest check suite on the commit, so
every workflow that starts pushes the deadline out, and it only arrives once
nothing new has appeared for the whole duration:

```
wait-for: [contract-tests, e2e]      wait-for-timeout: PT20M

10:00  first workflow starts    deadline 10:20
10:02  contract-tests starts    deadline 10:22
10:15  deploy starts            deadline 10:35
10:33  e2e starts               deadline 10:53   e2e is waited for
```

Measuring from the first suite instead would cut off the job this input exists to
wait for, because a suite chained behind a deployment has to fit inside a budget
that started before it could register. It would also hand a commit that already
carried CI a deadline that is already in the past, and a caller who chose to let
a missing job through would get that decision applied without any waiting at all.

`wait-for-timeout-conclusion` decides what happens when the clock does run out:
`failure` by default, or `success` when the job is genuinely conditional and may
never run. A pass granted that way names what it let through, in the summary and
as a warning in the log, because it is the one path here that publishes green for
a job that never ran.

One caller-side change comes with this. When every other job has finished and the
awaited one has not started, there is nothing left to fire an event, so watch
mode holds its runner until the job appears or the deadline passes. Give the job
more `timeout-minutes` than `wait-for-timeout`, or the runner is killed first and
the gate stays pending:

```yaml
    timeout-minutes: 25 # must exceed wait-for-timeout
```

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

```yaml
    permissions:
      contents: read
      checks: write
      actions: read
    steps:
      - uses: muratkeremozcan/pr-gate@<sha>
        with:
          mode: watch
```

`check-run` is the compatibility default. It needs `checks: write` and carries
the full markdown summary. GitHub may group it under an unrelated workflow as
`<workflow> / gate` because an API-created check run cannot select its check
suite.

`status` needs `statuses: write`. It belongs to no workflow and renders as
`gate`. Its 140-character description names failed jobs, while `target_url`
links to the full job summary. A normal event writes a pending status and a
final status. GitHub's limit of 1000 statuses per commit and context allows
roughly 500 normal events.

Change `publish` and its permission together. A `workflow_run` event uses the
workflow file from the default branch, so migrate in two sequential merges.
First grant both write permissions and set `publish: status`. After that
workflow reaches the default branch, remove `checks: write` in a follow-up.

An in-flight pull request may retain the old `gate` check run. GitHub can report
the abandoned check run for the shared context even though the action ignores
it as a sibling. The action warns when it sees this. Push a new commit or
conclude the old check run by hand.

## Configuration

`mode` is required and accepts `watch` or `wait`. Inputs and defaults are
documented in [`action.yml`](action.yml). Durations accept ISO 8601 values such
as `PT15S` or plain seconds such as `15`.

Use `skip-list` to ignore a workflow, a job, or matrix job variants:

```yaml
with:
  mode: watch
  skip-list: |
    [
      {
        "workflowFile": "claude-code-review.yaml",
        "jobName": "review",
        "jobMatchMode": "prefix"
      }
    ]
```

`jobMatchMode` accepts `exact` or `prefix`. Omit `jobName` to skip an entire
workflow.

Use `bypass-branch-prefixes` to wave a branch through without checking anything:

```yaml
with:
  mode: watch
  bypass-branch-prefixes: 'hotfix/,emergency/'
```

The gate publishes a passing verdict whose summary names the branch and the
prefix that matched. In watch mode, use this instead of an `if:` condition. A
skipped watch job publishes no verdict and blocks the merge, while a skipped
wait job counts as passing. The action resolves the branch from the event
payload so bypasses keep working on `workflow_run` events.

## Important behavior

- Watch mode owns its check run through an `external_id`. It refuses to update
  a same-named check run created by another tool. A commit status has no
  equivalent, because posting one supersedes whatever held the context before.
- The action reads GitHub check runs. Commit statuses and check suites from
  non-Actions apps must be required separately when needed.
- A commit with no visible sibling check runs passes after `warmup-delay`.
- `concurrency` must use `cancel-in-progress: false`. Cancelling a watch run can
  leave the required check pending.

## Development

```bash
node --test tests/*.test.js
```

The suite requires no dependency installation. The action uses the Node 24
GitHub Actions runtime. The `Test` workflow exercises both modes against the
live GitHub API.
