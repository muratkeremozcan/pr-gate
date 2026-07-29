# pr-gate

`pr-gate` combines the GitHub Actions check runs for a commit into one stable
required check. It has no runtime dependencies and retries transient GitHub API
failures.

Always pin the action to a full commit SHA.

## Installation

Install watch mode in two phases. GitHub only delivers `workflow_run` events to
a workflow that already exists on the default branch.

1. Add the workflow below and merge it while `gate` is not yet required.
2. After the workflow reaches the default branch, configure the branch ruleset
   to require only `gate`.

Repositories migrating an existing required `gate` need a one-time bootstrap.
After the sibling jobs finish, rerun the PR Gate workflow or use a ruleset
bypass to merge the installation PR. Routine pull requests need no manual
rerun after installation.

## Watch mode

Watch mode is event-driven. It publishes a check run named `gate` whenever a
pull request changes or another workflow finishes.

```yaml
name: PR Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_run:
    types: [completed]
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
      checks: write
      actions: read
    steps:
      - uses: muratkeremozcan/pr-gate@<sha>
        with:
          mode: watch
```

Require only `gate` in the branch ruleset. Keep the job name as `watch` because
a job named `gate` would collide with the published check run.

The `pull_request` trigger publishes the initial verdict. The `workflow_run`
trigger starts working after this workflow exists on the default branch.

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

## Important behavior

- Watch mode owns its check run through an `external_id`. It refuses to update
  a same-named check run created by another tool.
- The action reads GitHub check runs. Commit statuses and check suites from
  non-Actions apps must be required separately when needed.
- A commit with no visible sibling check runs passes after `warmup-delay`.
- `concurrency` must use `cancel-in-progress: false`. Cancelling a watch run can
  leave the required check pending.

## Development

```bash
node --test tests/*.test.js
```

The suite contains 146 tests and requires no dependency installation. The
action uses the Node 24 GitHub Actions runtime. The `Test` workflow also
exercises both modes against the live GitHub API and publishes a temporary
`gate-smoke` check run.
