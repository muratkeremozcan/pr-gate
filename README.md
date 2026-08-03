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

Watch mode is event-driven. It publishes a commit status named `gate` whenever a
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
      checks: read
      statuses: write
      actions: read
    steps:
      - uses: muratkeremozcan/pr-gate@<sha>
        with:
          mode: watch
```

Require only `gate` in the branch ruleset. Keep the job name as `watch` because
a job named `gate` would collide with the published status.

The `pull_request` trigger publishes the initial verdict. The `workflow_run`
trigger starts working after this workflow exists on the default branch.

### Why a commit status and not a check run

Because of how the pull request page labels them. A check run created through the
Checks API with `GITHUB_TOKEN` belongs to the github-actions app, and so does
every workflow run on the commit, each with its own check suite. An API-created
check run cannot choose its suite, so GitHub files it in the first suite that app
opened on the commit, which is whichever unrelated workflow started first. The
pull request page then labels the required check `<that workflow> / gate`, and a
failing gate reads as a failure of a workflow that passed. The suite it lands in
varies per commit, so the label cannot be relied on at all.

A commit status belongs to no suite and no workflow. It renders as `gate` alone,
and its description names the jobs that failed, for example
`1 job(s) did not pass: Playwright e2e / pw-e2e (2, 2): failure`.

Two costs come with it:

- A status description holds 140 characters, so the markdown summary goes to the
  job summary and `target_url` links to it.
- Two status rows per event, one moving the context to pending and one carrying
  the verdict. Statuses supersede rather than update, so only the latest for a
  context is read or displayed, but GitHub allows 1000 per commit per context and
  rejects the next one, so a single head SHA supports roughly 500 events.

Earlier versions published a check run instead. On a pull request that was gated
before the upgrade, the old `gate` check run stays on the commit and claims the
same required context, so GitHub can still report it and block a merge the status
has already passed. The action warns when it sees one. Push a new commit or
conclude that check run by hand.

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

The gate publishes a passing status that names the branch and the prefix that
matched. In watch mode this is the only workable escape hatch. The required check
is the published status, so a job skipped by an `if:` condition publishes
nothing, the required check never appears, and the merge blocks instead of
proceeding. The branch is resolved from the event payload, because
`github.head_ref` is empty on `workflow_run` events and an expression on the
caller's side would stop matching after the initial `pull_request` event.

## Important behavior

- The status write needs no ownership check. Posting supersedes whatever held the
  context before, and only the latest for a context is read, so a retried write
  cannot leave two verdicts behind.
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

The suite contains 171 tests and requires no dependency installation. The
action uses the Node 24 GitHub Actions runtime. The `Test` workflow also
exercises both modes against the live GitHub API, publishing temporary
`gate-smoke-status` and `gate-smoke-bypass` commit statuses.
