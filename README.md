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
