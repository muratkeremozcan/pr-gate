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

### Publishing as a commit status instead

`publish: status` writes the verdict as a commit status rather than a check run.
Both satisfy a ruleset requiring the same context name, so switching needs no
ruleset edit.

```yaml
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

Use it when the label on the pull request page matters. A check run created
through the Checks API with `GITHUB_TOKEN` belongs to the github-actions app, and
so does every workflow run on the commit, each with its own check suite. An
API-created check run cannot choose its suite, so GitHub files it in the first
suite that app opened on the commit, which is whichever unrelated workflow
started first. The pull request page then labels the required check
`<that workflow> / gate`, and a failing gate reads as a failure of a workflow
that passed. The suite it lands in varies per commit, so the label cannot be
relied on at all.

A commit status belongs to no suite and no workflow. It renders as `gate` alone,
and its description names the jobs that failed, for example
`1 job(s) did not pass: Playwright e2e / pw-e2e (2, 2): failure`.

Two costs:

- A status description holds 140 characters, so the markdown summary goes to the
  job summary and `target_url` links to it.
- The commit accumulates one status row per event. Statuses supersede rather than
  update, and only the latest for a context is read or displayed.

Migrating an in-flight pull request leaves its existing `gate` check run behind.
The status is the live verdict and the stale check run is ignored as a sibling,
but both claim the same required context, so GitHub can still report the
abandoned one. The action warns when it sees this. Push a new commit, or conclude
that check run by hand.

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

Use `bypass-branch-prefixes` to wave a branch through without checking anything:

```yaml
with:
  mode: watch
  bypass-branch-prefixes: 'hotfix/,emergency/'
```

The gate publishes a passing check run whose summary names the branch and the
prefix that matched. In watch mode this is the only workable escape hatch. The
required check is the published check run, so a job skipped by an `if:` condition
publishes nothing, the required check never appears, and the merge blocks instead
of proceeding. The branch is resolved from the event payload, because
`github.head_ref` is empty on `workflow_run` events and an expression on the
caller's side would stop matching after the initial `pull_request` event.

## Important behavior

- Watch mode owns its check run through an `external_id`. It refuses to update
  a same-named check run created by another tool. A commit status has no
  equivalent, because posting one supersedes whatever held the context before.
- In watch mode a job skipped by an `if:` condition publishes no verdict, so the
  required check never appears and the merge blocks. Wait mode is the opposite,
  because there the required check is the job and a skipped job counts as passing.
  Use `bypass-branch-prefixes` for an escape hatch that works in both modes.
- The action reads GitHub check runs. Commit statuses and check suites from
  non-Actions apps must be required separately when needed.
- A commit with no visible sibling check runs passes after `warmup-delay`.
- `concurrency` must use `cancel-in-progress: false`. Cancelling a watch run can
  leave the required check pending.

## Development

```bash
node --test tests/*.test.js
```

The suite contains 187 tests and requires no dependency installation. The
action uses the Node 24 GitHub Actions runtime. The `Test` workflow also
exercises both modes against the live GitHub API, publishing a temporary
`gate-smoke` check run and a `gate-smoke-status` commit status.
