'use strict';

/**
 * PR Gate: wait for every other check run on the commit, then pass only if they
 * all passed.
 *
 * The load-bearing distinction in here is between a failed API call and a failed
 * job. The first is retried, because a required gate must not go red on a PR
 * whose jobs all passed. The second is never retried, because retrying it either
 * masks a real failure or just triples the time to report it.
 *
 * Zero dependencies on purpose: no node_modules to audit, no bundle step, and no
 * third-party JavaScript in the path of the one check that blocks merges.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── workflow command helpers (replaces @actions/core, which would need deps) ──

/**
 * Mirrors @actions/core's lookup rule: uppercase the name, spaces to
 * underscores, dashes preserved. So `github-token` reads INPUT_GITHUB-TOKEN.
 */
function getInput(name, env = process.env) {
  const raw = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return raw == null ? '' : String(raw).trim();
}

function getBooleanInput(name, env = process.env) {
  const raw = getInput(name, env).toLowerCase();
  if (raw === '') return false;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`input ${name} must be a boolean, got "${raw}"`);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  try {
    // Delimiter form, matching @actions/core. The `name=value` form lets a newline
    // in a value inject further output parameters. Today's values are a number and
    // one of three literals, so this is hardening rather than a live hole.
    const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
    fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } catch {
    /* a lost output must not fail the gate */
  }
}

const log = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => log(`::warning::${msg}`);
const notice = (msg) => log(`::notice::${msg}`);

// ─── pure logic, exported for tests ───────────────────────────────────────────

/** Accepts ISO 8601 (`PT1M30S`) or plain seconds (`90`). */
function parseDurationSeconds(raw, fallbackSeconds) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return fallbackSeconds;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
    .exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined && m[4] === undefined)) {
    throw new Error(`invalid duration "${raw}", use ISO 8601 like PT15S or plain seconds like 15`);
  }
  const total = Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 +
    Number(m[3] || 0) * 60 + Number(m[4] || 0);
  if (!Number.isFinite(total) || total < 0) throw new Error(`invalid duration "${raw}"`);
  return total;
}

/**
 * Required rather than defaulted. The two modes need different `permissions` and
 * different triggers, so a caller that never said which one it wanted is
 * misconfigured, and defaulting would hide that behind a gate that quietly does
 * the wrong thing.
 */
function parseMode(raw) {
  const mode = String(raw == null ? '' : raw).trim();
  if (mode === '') {
    throw new Error("mode is required: set it to 'wait' or 'watch'");
  }
  if (!['wait', 'watch'].includes(mode)) {
    throw new Error(`mode must be wait or watch, got "${mode}"`);
  }
  return mode;
}

/**
 * Which primitive watch mode publishes its verdict as. Defaults, unlike `mode`,
 * because both values gate identically and an existing caller must keep the
 * behaviour it already has.
 */
function parsePublish(raw) {
  const publish = String(raw == null ? '' : raw).trim() || 'check-run';
  if (!['check-run', 'status'].includes(publish)) {
    throw new Error(`publish must be check-run or status, got "${publish}"`);
  }
  return publish;
}

const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/** 'pending' | 'ok' | 'bad'. Anything completed and not explicitly OK is bad. */
function classify(entry) {
  if (String(entry.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
  return OK_CONCLUSIONS.has(String(entry.conclusion || '').toLowerCase()) ? 'ok' : 'bad';
}

/**
 * Reports the workflow run that woke the gate as unfinished, whatever its check
 * runs currently say.
 *
 * The event that wakes the gate arrives before the run it describes is visible.
 * GitHub returns the newest check run per name, so for a few seconds that is
 * still the previous attempt's, and on a run's first attempt there may be no
 * check run at all. Reading that snapshot literally is how an event announcing
 * that work has STARTED produces a verdict saying the commit is finished.
 *
 * Three shapes, all of them green when they should not be, all reproduced
 * against the real assessment:
 *
 *   - re-run failed jobs: the old failure is still the newest check run, so the
 *     gate republishes the red the re-run exists to clear.
 *   - re-run all jobs: the old successes are still the newest check runs, so the
 *     gate publishes success while a new attempt runs that may fail.
 *   - a first attempt whose check runs have not registered: the run is invisible,
 *     and any older sibling that already passed makes the commit read as done.
 *
 * So the run is projected as pending rather than pattern-matched. An entry of
 * this run is only allowed to keep a terminal result when it can prove it belongs
 * to this attempt, by having started at or after the attempt did. Anything else,
 * including a check run with no usable timestamp, reads as unfinished until the
 * completion event settles it. Pending only ever blocks a merge, so being liberal
 * with it costs one event of latency and cannot pass a commit that should fail.
 */
function markInFlight(entries, inFlight) {
  if (!inFlight) return entries;
  const label = inFlight.attempt > 1 ? 're-running' : 'starting';
  return entries.map((entry) => {
    if (String(entry.workflowRunId) !== inFlight.runId) return entry;
    if (classify(entry) === 'pending') return entry;
    const startedMs = Date.parse(entry.startedAt || '');
    if (Number.isFinite(startedMs) && startedMs >= inFlight.startedAtMs) return entry;
    return { ...entry, status: 'IN_PROGRESS', conclusion: null, stateLabel: label };
  });
}

/**
 * The workflow run that woke the gate, as an entry, for when none of its check
 * runs are visible yet.
 *
 * Without this the run contributes nothing and the commit reads as whatever the
 * other suites happen to say, which on a commit with one older passing job is a
 * green gate published in response to an event announcing that work has begun.
 */
function inFlightEntry(inFlight) {
  return {
    projected: true,
    name: '(jobs not registered yet)',
    workflowName: inFlight.workflowName || '(unknown workflow)',
    workflowPath: inFlight.workflowPath || '',
    workflowRunId: inFlight.runId,
    status: 'QUEUED',
    conclusion: null,
    stateLabel: inFlight.attempt > 1 ? `re-running, attempt ${inFlight.attempt}` : 'starting',
  };
}

/**
 * The rule shape shared by `skip-list` and `wait-for`: a workflow file, a job
 * name, or both. One parser so the two inputs cannot drift into accepting
 * different spellings of the same rule, and `label` so the error names the input
 * the caller actually wrote.
 */
function parseRuleList(raw, label) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  for (const rule of parsed) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`each ${label} entry must be an object`);
    }
    if (!rule.workflowFile && !rule.jobName) {
      throw new Error(`each ${label} entry needs workflowFile, jobName, or both`);
    }
    // Typed, not just present. `{"jobName": []}` parses, and `[].startsWith` is
    // never reached because String([]) is "", so a prefix rule matches every
    // check run on the commit. In skip-list that ignores everything; in wait-for
    // the rule is discharged by the first unrelated job and the gate goes green
    // without the job it was told to wait for.
    for (const field of ['workflowFile', 'jobName']) {
      if (rule[field] === undefined || rule[field] === null) continue;
      if (typeof rule[field] !== 'string' || rule[field].trim() === '') {
        throw new Error(`${label} ${field} must be a non-empty string, got ${JSON.stringify(rule[field])}`);
      }
    }
    if (rule.jobMatchMode && !['exact', 'prefix'].includes(rule.jobMatchMode)) {
      throw new Error(`jobMatchMode must be "exact" or "prefix", got "${rule.jobMatchMode}"`);
    }
  }
  return parsed;
}

const parseSkipList = (raw) => parseRuleList(raw, 'skip-list');
const parseWaitFor = (raw) => parseRuleList(raw, 'wait-for');

/**
 * Does one rule describe this check run?
 *
 * `skip-list` reads this as "ignore it" and `wait-for` reads it as "this is the
 * one I was promised". Same predicate either way, so a rule that works in one
 * input works in the other.
 */
function ruleMatches(rule, entry) {
  if (rule.workflowFile && path.basename(entry.workflowPath || '') !== rule.workflowFile) return false;
  if (!rule.jobName) return true;
  const name = String(entry.name || '');
  return rule.jobMatchMode === 'prefix' ? name.startsWith(rule.jobName) : name === rule.jobName;
}

/**
 * The workflow file this job belongs to, from GITHUB_WORKFLOW_REF, which looks
 * like `owner/repo/.github/workflows/pr-gate.yml@refs/heads/branch`.
 */
function currentWorkflowFile(env = process.env) {
  const ref = String(env.GITHUB_WORKFLOW_REF || '');
  const withoutGitRef = ref.split('@')[0];
  return withoutGitRef ? path.basename(withoutGitRef) : '';
}

function shouldSkip(entry, { currentRunId, currentWorkflowFile: ownFile, skipSameWorkflow, skipList, ownExternalId }) {
  // Watch mode publishes its verdict as a check run on the same commit it is
  // inspecting. Without this the gate reads its own previous verdict as a
  // sibling and, once that verdict is a failure, can never recover to success.
  //
  // Matched on external_id, which this action sets and owns, rather than on the
  // check run's name. Name matching would also silence a legitimate sibling job
  // that happens to be called `gate`.
  if (ownExternalId && String(entry.externalId || '') === ownExternalId) return true;
  if (skipSameWorkflow) {
    // Match on the workflow file, not just the run id. A re-run, or a second
    // trigger on the same commit, produces a different run id for the same
    // workflow, and the gate would then sit waiting on an earlier instance of
    // itself and inherit its result. Run id is kept as a fallback for
    // environments that do not set GITHUB_WORKFLOW_REF.
    if (ownFile && path.basename(entry.workflowPath || '') === ownFile) return true;
    if (currentRunId && String(entry.workflowRunId) === String(currentRunId)) return true;
  }
  return skipList.some((rule) => ruleMatches(rule, entry));
}

/**
 * Rules that matched nothing on this commit.
 *
 * For `skip-list` the failure mode this catches is quiet and expensive: a rule
 * naming `claude-code-review.yml` when the repo's file is
 * `claude-code-review.yaml` matches nothing, so the gate waits on, and can fail
 * because of, a job it was explicitly told to ignore. Both spellings are
 * legitimate in different repos, so the fix is to report a rule that matches
 * nothing rather than to standardise the filename.
 *
 * For `wait-for` an unmatched rule is not a warning at all: it is the job that
 * has not registered yet, which is the thing that input exists to wait for.
 */
function unmatchedRules(entries, rules) {
  return rules.filter((rule) => !entries.some((entry) => ruleMatches(rule, entry)));
}

/**
 * `done` means stop polling. `ok` is only meaningful once done.
 * With earlyExit, one bad sibling ends it immediately; otherwise the gate waits
 * for the full picture before reporting.
 */
function evaluate(entries, { earlyExit }) {
  const pending = [];
  const bad = [];
  for (const entry of entries) {
    const kind = classify(entry);
    if (kind === 'pending') pending.push(entry);
    else if (kind === 'bad') bad.push(entry);
  }
  const allDone = pending.length === 0;
  if (bad.length > 0 && (earlyExit || allDone)) return { done: true, ok: false, pending, bad };
  if (allDone) return { done: true, ok: true, pending, bad };
  return { done: false, ok: bad.length === 0, pending, bad };
}

function formatEntry(entry) {
  // stateLabel is for entries whose real state would misdescribe them: a
  // placeholder for a job that has not registered would otherwise read `queued`,
  // which is what a job that GitHub has actually accepted reads.
  const state = entry.stateLabel || (classify(entry) === 'pending'
    ? String(entry.status || '').toLowerCase()
    : String(entry.conclusion || '').toLowerCase());
  return `${entry.workflowName || '(unknown workflow)'} / ${entry.name}: ${state}`;
}

// ─── wait-for: jobs that arrive late, conditionally, or not at all ────────────

/**
 * A `wait-for` rule that has not appeared on the commit, rendered as a check run.
 *
 * Modelled as an entry rather than as a second kind of thing the verdict has to
 * know about, because counting, formatting, listing, truncating and the two
 * publishing primitives already handle entries. A job that has not registered is
 * a job whose status the gate does not have yet, which is what `pending` means.
 */
function placeholderEntry(rule, state) {
  return {
    placeholder: true,
    name: rule.jobName ? `${rule.jobName}${rule.jobMatchMode === 'prefix' ? '*' : ''}` : '(any job)',
    workflowName: rule.workflowFile || '(any workflow)',
    ...state,
  };
}

const NOT_STARTED = { status: 'QUEUED', conclusion: null, stateLabel: 'not started yet' };
const NEVER_STARTED = { status: 'COMPLETED', conclusion: 'failure', stateLabel: 'never started' };

/**
 * When the wait-for clock runs out, as a millisecond timestamp, or null while
 * nothing has registered on the commit at all.
 *
 * The timeout means "the commit has been quiet this long", not "this long since
 * CI started". Anchored on the newest check suite, so every workflow that starts
 * pushes the deadline out and it only arrives once nothing new has appeared for
 * the full timeout.
 *
 * Measuring from the earliest suite instead reads naturally and is wrong in both
 * directions. A job chained behind a deployment has to fit inside a budget that
 * started before it could possibly register, so the thing this input exists to
 * wait for is the first thing cut off. And a commit that already carried CI, from
 * a force-push onto a commit that ran before or the same SHA on two branches,
 * arrives with the budget already spent: the deadline is in the past on the very
 * first look, and a caller who chose to let a missing job through gets that
 * decision applied without the gate waiting at all.
 *
 * Suites are only ever added to a commit, so this moves forward and never back.
 * Callers must read it from the assessment that used it rather than keeping a
 * copy, or they will sleep against one deadline while the verdict turns on
 * another.
 *
 * Null while the commit carries no suites yet. A deadline measured from a clock
 * that has not started would expire immediately and fail a gate for a job that
 * was never given the chance to register.
 */
function waitForDeadlineMs(entries, timeoutSeconds) {
  const stamps = entries
    .map((entry) => Date.parse(entry.suiteCreatedAt || ''))
    .filter((ms) => Number.isFinite(ms));
  return stamps.length === 0 ? null : Math.max(...stamps) + timeoutSeconds * 1000;
}

/**
 * The `wait-for` rules with nothing to show for them yet, as entries the verdict
 * can carry.
 *
 * Before the deadline they are pending, which holds the gate open. After it they
 * become the configured conclusion: a failure that names them, or nothing at all
 * when the caller said a job that never runs is acceptable.
 */
function waitForEntries(watched, waitFor, { deadlineMs, nowMs, timeoutConclusion }) {
  const missing = unmatchedRules(watched, waitFor);
  const expired = missing.length > 0 && deadlineMs != null && nowMs >= deadlineMs;
  if (!expired) return { entries: missing.map((rule) => placeholderEntry(rule, NOT_STARTED)), waived: [] };
  if (timeoutConclusion === 'success') return { entries: [], waived: missing };
  return { entries: missing.map((rule) => placeholderEntry(rule, NEVER_STARTED)), waived: [] };
}

/**
 * Renders untrusted text as a code span. Job and workflow names come from
 * workflow files, which a PR can edit, and this text lands in a markdown check
 * run summary. Backticks are stripped rather than escaped because there is no
 * escape for them inside a span, and a name containing one is not worth
 * reproducing exactly.
 */
function codeSpan(text) {
  return `\`${String(text == null ? '' : text).replace(/`/g, '')}\``;
}

// The Checks API rejects an output.summary over 65535 characters, and a monorepo
// with a big matrix can produce a lot of entries. A rejected write loses the
// verdict entirely, so the list is bounded well short of the limit.
const MAX_LISTED_ENTRIES = 30;

function bulletList(heading, items, format) {
  const shown = items.slice(0, MAX_LISTED_ENTRIES);
  const lines = shown.map((item) => `- ${codeSpan(format(item))}`);
  if (items.length > shown.length) {
    lines.push(`- and ${items.length - shown.length} more`);
  }
  return [heading, ...lines].join('\n');
}

const entryList = (heading, entries) => bulletList(heading, entries, formatEntry);

/** A `wait-for` rule as the caller wrote it, for a verdict that has no entry to name. */
function formatRule(rule) {
  const job = rule.jobName ? ` / ${rule.jobName}${rule.jobMatchMode === 'prefix' ? '*' : ''}` : '';
  return `${rule.workflowFile || '(any workflow)'}${job}`;
}

const ruleList = (heading, rules) => bulletList(heading, rules, formatRule);

/**
 * The check run body for a verdict, for watch mode.
 *
 * A `done` verdict becomes a terminal conclusion. Anything else stays
 * `in_progress`, which reads as pending to the branch ruleset and so keeps
 * blocking the merge. That is the fail-closed direction: a gate that never hears
 * about the last sibling leaves the PR unmergeable rather than mergeable.
 */
function verdictCheckRun(result, { name, totalWatched, waived = [] }) {
  const awaited = (list) => list.filter((entry) => entry.placeholder);

  if (!result.done) {
    const expected = awaited(result.pending);
    const running = result.pending.filter((entry) => !entry.placeholder);
    // Said differently when nothing is actually running, because "waiting on 1 of
    // 12" reads as a slow job rather than as a job that has not started, and the
    // two need different reactions from whoever is looking at the pull request.
    if (running.length === 0 && expected.length > 0) {
      return {
        name,
        status: 'in_progress',
        title: `Waiting for ${expected.length} expected job(s) to start`,
        summary: entryList(
          'Every other job on this commit finished. These are listed in `wait-for` and have not registered a check run yet:',
          expected
        ),
      };
    }
    return {
      name,
      status: 'in_progress',
      title: `Waiting on ${result.pending.length} of ${totalWatched} job(s)`,
      summary: [
        entryList('Still running:', running),
        expected.length > 0 ? entryList('Expected, not started yet:', expected) : '',
      ].filter(Boolean).join('\n\n'),
    };
  }

  if (result.ok) {
    return {
      name,
      status: 'completed',
      conclusion: 'success',
      title: `All ${totalWatched} watched job(s) passed`,
      summary: [
        totalWatched === 0
          ? 'No other check runs on this commit, so there was nothing to gate.'
          : 'Every watched check run on this commit finished and passed.',
        waived.length > 0
          ? ruleList(
            'These never started before `wait-for-timeout` ran out, and were let through because ' +
              '`wait-for-timeout-conclusion` is `success`:',
            waived
          )
          : '',
      ].filter(Boolean).join('\n\n'),
    };
  }

  const expected = awaited(result.bad);
  if (expected.length === result.bad.length) {
    return {
      name,
      status: 'completed',
      conclusion: 'failure',
      title: `${expected.length} expected job(s) never started`,
      summary: entryList(
        'Listed in `wait-for`, but no matching check run appeared on this commit before `wait-for-timeout` ran out:',
        expected
      ),
    };
  }
  return {
    name,
    status: 'completed',
    conclusion: 'failure',
    title: `${result.bad.length} job(s) did not pass`,
    summary: entryList('Failed:', result.bad),
  };
}

// The statuses endpoint caps `description` at 140 characters, so the list of
// culprits is trimmed here rather than left to however GitHub chooses to cut it.
const MAX_STATUS_DESCRIPTION = 140;

/**
 * A status description is one line of plain text, so the markdown escaping a
 * check run summary needs is wrong here, and a newline in a job name would break
 * the line. Whitespace is collapsed rather than escaped, because the same names
 * are reproduced faithfully in the job summary behind `target_url`.
 */
function plainText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function truncateForStatus(text) {
  const line = plainText(text);
  if (line.length <= MAX_STATUS_DESCRIPTION) return line;

  // Count UTF-16 units without cutting a Unicode code point in half. GitHub's
  // limit is measured in characters accepted by the endpoint, while JavaScript
  // slicing can leave a lone surrogate when an emoji crosses the boundary.
  let kept = '';
  for (const char of line) {
    if (kept.length + char.length > MAX_STATUS_DESCRIPTION - 1) break;
    kept += char;
  }
  return `${kept}…`;
}

/**
 * Names the jobs the verdict is about, which is the reason for publishing a
 * status at all: 140 characters of "1 job(s) did not pass: Playwright e2e /
 * pw-e2e (2, 2)" is the whole answer, on the pull request page, without opening
 * anything.
 */
function statusDescription(title, entries) {
  const named = (entries || []).map(formatEntry).join(', ');
  return truncateForStatus(named ? `${title}: ${named}` : title);
}

/** A check run's status and conclusion collapsed onto the four status states. */
function statusState(checkRun) {
  if (checkRun.status !== 'completed') return 'pending';
  return checkRun.conclusion === 'success' ? 'success' : 'failure';
}

/**
 * The commit status for a verdict, derived from the check run body so the two
 * primitives cannot drift into disagreeing about the same commit.
 *
 * `pending` is what carries the fail-closed property here. It is what a ruleset
 * reads as unfinished, so a gate that never hears about the last sibling leaves
 * the pull request unmergeable rather than mergeable.
 */
function verdictStatus(result, { context, totalWatched, waived = [] }) {
  const checkRun = verdictCheckRun(result, { name: context, totalWatched, waived });
  return {
    context,
    state: statusState(checkRun),
    description: statusDescription(checkRun.title, result.done ? result.bad : result.pending),
    title: checkRun.title,
    summary: checkRun.summary,
  };
}

// Bounds a single request. Without it a stalled connection parks until the job
// timeout kills it, with no retry; the abort surfaces as a network error and is
// retried like any other transient failure.
const REQUEST_TIMEOUT_MS = 30_000;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_GRAPHQL_TYPES = new Set([
  'RATE_LIMITED',
  'INTERNAL_SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
]);

function isRetryableStatus(status, headers) {
  if (RETRYABLE_STATUS.has(status)) return true;
  // A 403 is normally a permissions problem, except when it carries the
  // secondary-rate-limit signals, which are transient.
  if (status === 403 && headers && typeof headers.get === 'function') {
    if (headers.get('retry-after')) return true;
    if (headers.get('x-ratelimit-remaining') === '0') return true;
  }
  return false;
}

/**
 * Retry only when every error is transient. A mix of RATE_LIMITED and NOT_FOUND
 * will never succeed on retry, so it is surfaced instead of looped over.
 *
 * An error with no `type` is not retried. GraphQL validation errors (a bad field,
 * a malformed query) arrive as `{message}` with no type, and retrying those would
 * burn the retry budget on every poll and then report a confusing timeout instead
 * of the actual query problem.
 */
function isRetryableGraphQLErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => {
    const type = e && e.type;
    return type ? RETRYABLE_GRAPHQL_TYPES.has(String(type).toUpperCase()) : false;
  });
}

/** Exponential with 50-100% jitter, capped, so retries do not synchronise. */
function backoffMs(attempt, baseMs, rand = Math.random) {
  const capped = Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)), 60_000);
  return Math.round(capped * (0.5 + rand() * 0.5));
}

function retryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const retryAfter = headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const reset = headers.get('x-ratelimit-reset');
  if (reset && /^\d+$/.test(reset)) {
    const ms = Number(reset) * 1000 - Date.now();
    if (ms > 0) return Math.min(ms, 60_000);
  }
  return null;
}

function pollIntervalMs(method, minimumMs, attempt) {
  if (method === 'exponential_backoff') {
    return Math.min(minimumMs * Math.pow(2, Math.max(0, attempt - 2)), 300_000);
  }
  return minimumMs;
}

/** Flattens the GraphQL shape and reports any check suite it had to drop. */
function flattenCheckSuites(suites, onDropped = () => {}) {
  const entries = [];
  for (const suite of suites || []) {
    if (!suite) continue;
    // Check suites from non-Actions GitHub Apps have no workflowRun. The gate
    // cannot reason about their jobs, and reporting the drop beats silently
    // treating an external app's red X as "nothing to wait for".
    if (!suite.workflowRun) {
      const names = (suite.checkRuns?.nodes || []).filter(Boolean).map((r) => r.name);
      if (names.length > 0) onDropped(names);
      continue;
    }
    for (const run of suite.checkRuns?.nodes || []) {
      if (!run) continue;
      entries.push({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.detailsUrl,
        externalId: run.externalId || '',
        startedAt: run.startedAt || '',
        workflowName: suite.workflowRun.workflow?.name || '',
        workflowPath: suite.workflowRun.workflow?.resourcePath || '',
        workflowRunId: suite.workflowRun.databaseId,
        // When CI first started on this commit, for the wait-for deadline. Read
        // off the suite rather than the check run because a suite survives
        // re-runs, so every event computes the same deadline.
        suiteCreatedAt: suite.createdAt || '',
      });
    }
  }
  return entries;
}

// ─── IO ───────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SUITES_QUERY = /* GraphQL */ `
  query Gate($owner: String!, $repo: String!, $sha: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      object(expression: $sha) {
        ... on Commit {
          checkSuites(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              createdAt
              workflowRun {
                databaseId
                workflow { name resourcePath }
              }
              checkRuns(first: 100) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes { name status conclusion detailsUrl externalId startedAt }
              }
            }
          }
        }
      }
    }
  }
`;

const SUITE_RUNS_QUERY = /* GraphQL */ `
  query GateSuiteRuns($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on CheckSuite {
        checkRuns(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name status conclusion detailsUrl externalId startedAt }
        }
      }
    }
  }
`;

/**
 * One HTTP call to the GitHub API, with retries for transient failures only. A
 * non-retryable response throws, because a 401 or a 404 will not fix itself.
 *
 * `retryBody` lets a caller retry on a 200 whose body carries a transient error,
 * which is how GraphQL reports rate limiting. It shares this attempt counter on
 * purpose, so `api-retry-limit` bounds the total call count rather than being
 * spent twice over.
 *
 * `retryGuard` is for non-idempotent requests. It runs before each retry, and a
 * non-null return settles the call without sending the request again. A create
 * whose response was lost may have landed server-side, and blind retries would
 * then duplicate it; the guard re-checks instead.
 */
async function requestWithRetry({
  apiUrl,
  token,
  method = 'POST',
  path = '/graphql',
  body,
  retryLimit,
  baseDelayMs,
  retryBody,
  retryGuard,
}) {
  const endpoint = `${String(apiUrl || 'https://api.github.com').replace(/\/+$/, '')}${path}`;

  // A failed guard must not eat the retry budget, so its errors read as "keep retrying".
  const settledByGuard = async () => {
    if (!retryGuard) return null;
    try {
      return (await retryGuard()) ?? null;
    } catch {
      return null;
    }
  };

  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(endpoint, {
        method,
        headers: {
          authorization: `bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/vnd.github+json',
          'user-agent': 'muratkeremozcan/pr-gate',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt > retryLimit) {
        throw new Error(`network error contacting the GitHub API: ${err.message}`);
      }
      const settled = await settledByGuard();
      if (settled != null) return settled;
      const waitMs = backoffMs(attempt, baseDelayMs);
      warn(`Network error contacting the GitHub API (${err.message}), retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${retryLimit})`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isRetryableStatus(res.status, res.headers) && attempt <= retryLimit) {
        const settled = await settledByGuard();
        if (settled != null) return settled;
        const waitMs = retryAfterMs(res.headers) ?? backoffMs(attempt, baseDelayMs);
        warn(`GitHub API returned ${res.status}, retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${retryLimit})`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`GitHub API returned ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json().catch(() => null);
    if (!json) {
      if (attempt <= retryLimit) {
        const settled = await settledByGuard();
        if (settled != null) return settled;
        const waitMs = backoffMs(attempt, baseDelayMs);
        warn(`GitHub API returned an unparseable body, retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${retryLimit})`);
        await sleep(waitMs);
        continue;
      }
      throw new Error('GitHub API returned an unparseable body');
    }

    const transient = retryBody ? retryBody(json) : null;
    if (transient) {
      if (attempt <= retryLimit) {
        const waitMs = backoffMs(attempt, baseDelayMs);
        warn(`${transient}, retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${retryLimit})`);
        await sleep(waitMs);
        continue;
      }
      // Returning the body here would hand the caller a response known to be
      // broken and let it decide, silently, whether that matters. graphql()
      // happens to re-check and throw, so nothing is wrong today, but a gate is
      // the wrong place to leave that depending on a second look.
      throw new Error(`${transient} persisted after ${retryLimit} retries`);
    }

    return json;
  }
}

async function graphql({ apiUrl, token, query, variables, retryLimit, baseDelayMs }) {
  const json = await requestWithRetry({
    apiUrl,
    token,
    path: '/graphql',
    body: { query, variables },
    retryLimit,
    baseDelayMs,
    retryBody: (parsed) =>
      isRetryableGraphQLErrors(parsed.errors) ? 'GraphQL transient error' : null,
  });

  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return json.data;
}

/** REST counterpart, same retry rules. Used only by watch mode's check-run writes. */
function rest({ apiUrl, token, retryLimit, baseDelayMs }, method, path, body, retryGuard) {
  return requestWithRetry({ apiUrl, token, method, path, body, retryLimit, baseDelayMs, retryGuard });
}

async function fetchChecks(ctx) {
  const suites = [];
  let cursor = null;
  for (;;) {
    const data = await graphql({ ...ctx, query: SUITES_QUERY, variables: { owner: ctx.owner, repo: ctx.repo, sha: ctx.sha, cursor } });
    const commit = data?.repository?.object;
    if (!commit) throw new Error(`commit ${ctx.sha} not found in ${ctx.owner}/${ctx.repo}`);
    const page = commit.checkSuites;
    suites.push(...(page?.nodes || []).filter(Boolean));
    if (!page?.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  // A workflow with more than 100 jobs needs its check runs paged separately.
  for (const suite of suites) {
    let runPage = suite.checkRuns;
    while (runPage?.pageInfo?.hasNextPage) {
      const data = await graphql({ ...ctx, query: SUITE_RUNS_QUERY, variables: { id: suite.id, cursor: runPage.pageInfo.endCursor } });
      const next = data?.node?.checkRuns;
      if (!next) break;
      suite.checkRuns.nodes.push(...(next.nodes || []).filter(Boolean));
      runPage = next;
    }
  }

  return suites;
}

function readEventPayload(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * On pull_request the head SHA carries the check runs; GITHUB_SHA is the merge
 * commit. On workflow_run it is worse: GITHUB_SHA is the tip of the default
 * branch and GITHUB_REF is the default branch, neither of which has anything to
 * do with the PR being gated, so the head SHA must come from the payload.
 */
function resolveSha(env = process.env) {
  const explicit = getInput('ref', env);
  if (explicit) return explicit;
  const payload = readEventPayload(env);
  const head = payload?.pull_request?.head?.sha || payload?.workflow_run?.head_sha;
  if (head) return head;
  return env.GITHUB_SHA || '';
}

/**
 * The head branch, for the bypass check.
 *
 * Same trap as the SHA. On workflow_run, GITHUB_REF_NAME is the default branch
 * and GITHUB_HEAD_REF is empty, so a caller-side `startsWith(github.head_ref,
 * 'hotfix/')` reads false on every event after the first. Resolving it here from
 * the payload is the only way the bypass survives the switch of event type.
 */
function resolveHeadBranch(env = process.env) {
  const payload = readEventPayload(env);
  const fromPayload = payload?.pull_request?.head?.ref || payload?.workflow_run?.head_branch;
  if (fromPayload) return String(fromPayload);
  return String(env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '');
}

/**
 * The workflow run whose event woke the gate, or null.
 *
 * The payload is the only authority on that run that does not lag. Everything
 * else the gate reads is a snapshot of check runs, and the event always arrives
 * before the snapshot catches up with it, so a verdict computed purely from the
 * snapshot can contradict the very event that asked for it.
 *
 * Every action is parsed, not just the re-run ones. `requested` and `in_progress`
 * say the run is unfinished, which is a fact the check runs may not show yet.
 * `completed` carries the run's real conclusion, which is what catches a
 * previous attempt's success still standing where a failed attempt belongs.
 *
 * `in_progress` is the only signal a re-run gives off: GitHub documents that
 * `requested` does not fire for a re-run, and `check_run` and `check_suite`
 * never fire for check suites Actions created. Verified against the API, where
 * "re-run failed jobs" produced `in_progress` with `run_attempt: 2` six seconds
 * after the click and no `requested` at all.
 */
function triggeringWorkflowRun(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_run') return null;
  const payload = readEventPayload(env);
  const run = payload && payload.workflow_run;
  if (!run || !run.id) return null;
  const action = String(payload.action || '');
  if (!['requested', 'in_progress', 'completed'].includes(action)) return null;
  const startedAtMs = Date.parse(run.run_started_at || '');
  return {
    runId: String(run.id),
    attempt: Number(run.run_attempt || 1),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
    finished: action === 'completed',
    conclusion: String(run.conclusion || '').toLowerCase(),
    workflowName: String(run.name || ''),
    workflowPath: String(run.path || ''),
  };
}

/**
 * The run that woke the gate, as the event describes it rather than as the check
 * runs currently do.
 *
 * Unfinished: its entries are held pending and, if none are visible at all, one
 * is projected, so an event announcing that work has started can never produce a
 * verdict saying the commit is finished.
 *
 * Finished and not passing: the payload's conclusion is the truth. If no entry of
 * that run reads bad, the snapshot is still showing an earlier attempt, and a
 * failure is injected rather than waiting for a later event that may not come.
 */
function withTriggeringRun(entries, run, keep = () => true) {
  if (!run) return entries;

  if (!run.finished) {
    const marked = markInFlight(entries, run);
    if (marked.some((entry) => String(entry.workflowRunId) === run.runId)) return marked;
    const projected = inFlightEntry(run);
    return keep(projected) ? [...marked, projected] : marked;
  }

  if (OK_CONCLUSIONS.has(run.conclusion)) return entries;
  const mine = entries.filter((entry) => String(entry.workflowRunId) === run.runId);
  if (mine.some((entry) => classify(entry) === 'bad')) return entries;
  const projected = {
    projected: true,
    name: '(run did not pass)',
    workflowName: run.workflowName || '(unknown workflow)',
    workflowPath: run.workflowPath || '',
    workflowRunId: run.runId,
    status: 'COMPLETED',
    conclusion: run.conclusion || 'failure',
    stateLabel: `${run.conclusion || 'failure'}, reported by the event before its check runs caught up`,
  };
  return keep(projected) ? [...entries, projected] : entries;
}

/** Comma or newline separated, so both YAML styles work. */
function parseBypassPrefixes(raw) {
  return String(raw == null ? '' : raw)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The prefix that waves this branch through, or null.
 *
 * An unresolved branch never matches. The bypass publishes a passing gate, so
 * guessing here would open the gate on a commit nobody asked to exempt.
 */
function matchedBypassPrefix(branch, prefixes) {
  const name = String(branch == null ? '' : branch).trim();
  if (!name || !Array.isArray(prefixes) || prefixes.length === 0) return null;
  return prefixes.find((prefix) => name.startsWith(prefix)) || null;
}

/**
 * The check run body for a bypassed gate.
 *
 * Watch mode cannot use a skipped job as its escape hatch. In wait mode the
 * required check was the job, and GitHub counts a skipped job as passing; here
 * the required check is this check run, so a skipped job publishes nothing, the
 * context never appears, and the merge blocks on a check that is never coming.
 * The hatch therefore has to run and publish a pass.
 *
 * It says so in the summary. A skipped job was invisible unless you read the
 * workflow file, and a bypassed gate is worth seeing on the PR.
 */
function bypassCheckRun(name, { branch, prefix }) {
  return {
    name,
    status: 'completed',
    conclusion: 'success',
    title: `Bypassed for ${branch}`,
    summary:
      `This gate did not check anything. The branch ${codeSpan(branch)} matches the ` +
      `bypass prefix ${codeSpan(prefix)}, so the verdict was published as a pass ` +
      'without reading the other check runs on this commit.',
  };
}

/** The same bypass, as a commit status. Summary reused so the two cannot drift. */
function bypassStatus(context, { branch, prefix }) {
  const checkRun = bypassCheckRun(context, { branch, prefix });
  return {
    context,
    state: 'success',
    description: truncateForStatus(
      `Bypassed for ${branch}: matches the bypass prefix ${prefix}, so nothing was checked`
    ),
    title: checkRun.title,
    summary: checkRun.summary,
  };
}

/** Stamped on every check run this action creates, so it can recognise its own. */
function externalIdFor(checkName) {
  return `muratkeremozcan/pr-gate:${checkName}`;
}

/**
 * Finds the check run this action owns on the commit, or null on the first event.
 *
 * Ownership is decided by external_id, not by the name. Patching a same-named
 * check run this action did not create would hijack someone else's check, and two
 * writers on one name means the context flips to whoever wrote last, so a foreign
 * owner is an error rather than something to write through.
 */
async function findOwnedCheckRun(ctx, name) {
  const externalId = externalIdFor(name);
  // filter=all, not the default latest. `latest` is scoped to the newest check
  // suite, so rerunning any workflow can hide the check run this action already
  // owns; the lookup then finds nothing and creates a second one of the same
  // required name, which is exactly what owning it is supposed to prevent.
  const found = await rest(
    ctx,
    'GET',
    `/repos/${ctx.owner}/${ctx.repo}/commits/${encodeURIComponent(ctx.sha)}/check-runs` +
      `?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`
  );
  const sameName = (found?.check_runs || []).filter(Boolean);
  // Newest first, because commits gated before this fix can already carry
  // duplicates and GitHub takes the most recently updated one as the status
  // context. Writing to any other would leave the required check on a stale value.
  const owned = sameName
    .filter((run) => run.external_id === externalId)
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')) || (b.id || 0) - (a.id || 0))[0];
  if (owned) return owned;

  if (sameName.length > 0) {
    const owners = [...new Set(sameName.map((run) => run.app?.slug || 'unknown'))].join(', ');
    throw new Error(
      `a check run named "${name}" on ${ctx.sha} was created by something else (${owners}). ` +
        'Pick a different check-name; two writers on one name make the required status context flip between them.'
    );
  }
  return null;
}

/**
 * The body that invalidates a terminal verdict before it is recomputed.
 *
 * Without this step a write failure is fail-open: the previous verdict stays
 * published, so a gate that went green before a later failure merges. Moving it
 * back to in_progress first means any failure from here on leaves the gate
 * unconcluded, which blocks.
 */
function invalidationCheckRun(name) {
  return {
    name,
    status: 'in_progress',
    title: 'Recomputing',
    summary:
      'A CI workflow finished, so the previous verdict no longer describes this commit. ' +
      'The gate stays unconcluded until the new verdict is published, so a failure to ' +
      'publish blocks the merge instead of leaving a stale result in place.',
  };
}

/** The same invalidation, as a commit status. */
function invalidationStatus(context) {
  return {
    context,
    state: 'pending',
    description: 'Recomputing: a CI workflow finished and the previous verdict no longer applies',
  };
}

/**
 * Writes the verdict as a check run on the inspected commit, creating it when
 * `existing` is null and updating it otherwise.
 *
 * The name is what the branch ruleset requires, so it must stay stable across
 * updates. GitHub keeps only the most recently updated check run of a given name
 * as the status context, which is what makes the update path safe.
 */
async function writeCheckRun(ctx, verdict, existing) {
  const base = `/repos/${ctx.owner}/${ctx.repo}`;
  const body = {
    status: verdict.status,
    output: { title: verdict.title, summary: verdict.summary },
  };
  if (verdict.status === 'completed') {
    body.conclusion = verdict.conclusion;
    body.completed_at = new Date().toISOString();
  }

  if (existing) {
    // head_sha is not an accepted field on the update endpoint, and sending it
    // is a 422. The SHA is already fixed by the check run being updated.
    await rest(ctx, 'PATCH', `${base}/check-runs/${existing.id}`, body);
    return { created: false, id: existing.id };
  }

  const created = await rest(
    ctx,
    'POST',
    `${base}/check-runs`,
    {
      ...body,
      name: verdict.name,
      head_sha: ctx.sha,
      external_id: externalIdFor(verdict.name),
      started_at: new Date().toISOString(),
    },
    async () => findOwnedCheckRun(ctx, verdict.name)
  );
  return { created: true, id: created?.id };
}

/** Kept as the simple composition, for callers that write once. */
async function upsertCheckRun(ctx, verdict) {
  return writeCheckRun(ctx, verdict, await findOwnedCheckRun(ctx, verdict.name));
}

/**
 * Writes the verdict as a commit status on the inspected commit.
 *
 * No ownership lookup and no update path, because statuses supersede rather than
 * mutate: the most recently posted state for a context is the one a ruleset
 * reads. That also makes the write idempotent, so unlike the check-run create it
 * needs no guard against a lost response duplicating anything. A normal event
 * writes two rows: one pending invalidation and one verdict. GitHub allows 1000
 * statuses per commit and context, so a single head SHA supports roughly 500
 * events before another commit is needed.
 */
async function writeCommitStatus(ctx, verdict, targetUrl) {
  await rest(ctx, 'POST', `/repos/${ctx.owner}/${ctx.repo}/statuses/${encodeURIComponent(ctx.sha)}`, {
    state: verdict.state,
    context: verdict.context,
    description: verdict.description,
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

/** Where a status sends the reader for the detail its description cannot hold. */
function workflowRunUrl(env = process.env) {
  const server = String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const repo = String(env.GITHUB_REPOSITORY || '');
  const runId = String(env.GITHUB_RUN_ID || '');
  return repo && runId ? `${server}/${repo}/actions/runs/${runId}` : '';
}

function appendStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${markdown}\n`);
  } catch {
    /* a lost summary must not fail the gate */
  }
}

/**
 * Watch mode's two publishing primitives, behind one interface so the flow that
 * computes the verdict does not branch on the primitive at each of the four
 * points where it writes.
 *
 * `locate` reads whatever the primitive needs to write again, `prepare` also
 * invalidates a terminal verdict first, and `write` publishes one.
 *
 * The reason there are two is presentation, not gating. A check run created
 * through the Checks API with GITHUB_TOKEN belongs to the github-actions app, and
 * so does every workflow run on the commit, each with its own check suite. An
 * API-created check run cannot choose its suite, so GitHub files it in the first
 * suite that app opened on the commit, which is whichever unrelated workflow
 * happened to start first. The pull request page then labels the required check
 * "<that workflow> / gate", so a failing gate reads as a failure of a workflow
 * that passed. Observed across four pull requests on couture-cast, where the same
 * gate was filed under three different workflows.
 *
 * A commit status belongs to no suite and no workflow, so it renders as `gate`
 * and nothing else. It costs the markdown summary, which becomes a 140-character
 * line plus a link to the job summary.
 */
function checkRunPublisher(ctx, name) {
  return {
    label: 'check run',
    verdictFor: (result, totalWatched, waived) => verdictCheckRun(result, { name, totalWatched, waived }),
    bypassFor: (bypass) => bypassCheckRun(name, bypass),
    describe: (verdict) =>
      `${verdict.status}${verdict.conclusion ? `/${verdict.conclusion}` : ''}: ${verdict.title}`,
    locate: () => findOwnedCheckRun(ctx, name),
    async prepare() {
      const existing = await findOwnedCheckRun(ctx, name);
      if (existing && existing.status === 'completed') {
        await writeCheckRun(ctx, invalidationCheckRun(name), existing);
        log(`Invalidated the previous ${existing.conclusion} verdict before recomputing.`);
      }
      return existing;
    },
    async write(existing, verdict) {
      const { created, id } = await writeCheckRun(ctx, verdict, existing);
      // Hands back the check run it just wrote, so a caller that writes twice
      // updates the second time instead of creating again. The id comes from the
      // write itself and not from a fresh lookup: the check-runs list is not
      // read-your-writes consistent, so a create followed immediately by a
      // lookup can come back empty, and a second create would leave two check
      // runs holding one required name. Falls back to the lookup only when the
      // response carried no id at all.
      return {
        note: created ? 'Created' : 'Updated',
        handle: id ? { id } : await findOwnedCheckRun(ctx, name),
      };
    },
  };
}

function commitStatusPublisher(ctx, context) {
  const targetUrl = workflowRunUrl();
  return {
    label: 'commit status',
    verdictFor: (result, totalWatched, waived) => verdictStatus(result, { context, totalWatched, waived }),
    bypassFor: (bypass) => bypassStatus(context, bypass),
    describe: (verdict) => `${verdict.state}: ${verdict.description}`,
    // Nothing to read: there is no id to keep and no foreign owner to refuse,
    // because a status has no external_id and posting one supersedes whatever
    // held the context before.
    locate: async () => null,
    async prepare() {
      // Posted unconditionally, where the check-run path only invalidates a
      // verdict it found to be terminal. Reading the combined status first to
      // make that same distinction would cost the call this write costs, and
      // publishing pending regardless is the stronger version of the property:
      // from here on, any failure leaves the context unfinished and blocking
      // rather than leaving a stale green to merge on.
      await writeCommitStatus(ctx, invalidationStatus(context), targetUrl);
      log('Moved the context to pending before recomputing, so a failed write cannot leave a stale verdict.');
      return null;
    },
    async write(_handle, verdict) {
      // The markdown a check run carries as its summary has nowhere to go on a
      // status. It goes to the job summary, which is what target_url points at.
      appendStepSummary(`## ${verdict.title}\n\n${verdict.summary}\n`);
      await writeCommitStatus(ctx, verdict, targetUrl);
      // No handle to carry: a status has no id, and posting one supersedes
      // whatever held the context before, so writing twice cannot duplicate it.
      return { note: 'Published', handle: null };
    },
  };
}

/**
 * What the gate publishes for a `wait-for` job that never appeared. Defaulted to
 * a failure, because a job the caller named as expected and never got is the
 * case this input exists to catch. `success` is for the other reading of the same
 * input: a conditional job that may legitimately not run at all, where the list
 * says "if it runs, wait for it" rather than "it must run".
 */
function parseTimeoutConclusion(raw) {
  const value = String(raw == null ? '' : raw).trim() || 'failure';
  if (!['failure', 'success'].includes(value)) {
    throw new Error(`wait-for-timeout-conclusion must be failure or success, got "${value}"`);
  }
  return value;
}

/**
 * Missing or non-numeric input falls back instead of producing NaN, which
 * comparisons silently swallow: `attempt > NaN` is always false, so a NaN
 * retryLimit would retry forever and a NaN attemptLimits would never poll.
 */
function parseIntOr(raw, fallback) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

/** Everything both modes need, read once from inputs and the environment. */
function buildOptions() {
  const token = getInput('github-token');
  if (!token) throw new Error('github-token is required');

  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is not set');

  const sha = resolveSha();
  if (!sha) throw new Error('could not determine the commit SHA to inspect');

  const mode = parseMode(getInput('mode'));

  const retryMethod = getInput('retry-method') || 'equal_intervals';
  if (!['equal_intervals', 'exponential_backoff'].includes(retryMethod)) {
    throw new Error(`retry-method must be equal_intervals or exponential_backoff, got "${retryMethod}"`);
  }

  const checkName = getInput('check-name') || 'gate';
  const publish = parsePublish(getInput('publish'));

  const headBranch = resolveHeadBranch();
  const bypassPrefix = matchedBypassPrefix(headBranch, parseBypassPrefixes(getInput('bypass-branch-prefixes')));

  const ctx = {
    apiUrl: getInput('github-api-url') || 'https://api.github.com',
    token,
    owner,
    repo,
    sha,
    retryLimit: Math.max(0, Math.trunc(parseIntOr(getInput('api-retry-limit'), 5))),
    baseDelayMs: parseDurationSeconds(getInput('api-retry-base-delay'), 2) * 1000,
  };

  return {
    ctx,
    mode,
    checkName,
    publish,
    headBranch,
    bypassPrefix,
    retryMethod,
    warmupMs: parseDurationSeconds(getInput('warmup-delay'), 10) * 1000,
    minimumMs: parseDurationSeconds(getInput('minimum-interval'), 15) * 1000,
    attemptLimits: Math.max(1, Math.trunc(parseIntOr(getInput('attempt-limits'), 180))),
    earlyExit: getBooleanInput('early-exit'),
    dryRun: getBooleanInput('dry-run'),
    waitFor: parseWaitFor(getInput('wait-for')),
    waitForTimeoutSec: parseDurationSeconds(getInput('wait-for-timeout'), 1800),
    timeoutConclusion: parseTimeoutConclusion(getInput('wait-for-timeout-conclusion')),
    triggeringRun: triggeringWorkflowRun(),
    skipOpts: {
      currentRunId: process.env.GITHUB_RUN_ID,
      currentWorkflowFile: currentWorkflowFile(),
      skipSameWorkflow: getBooleanInput('skip-same-workflow'),
      skipList: parseSkipList(getInput('skip-list')),
      // Only watch mode has a check run of its own to collide with. Kept for
      // `publish: status` too, where this commit can still carry one left behind
      // by an earlier event that ran in check-run mode; counting that as a
      // sibling would leave the gate pending on its own abandoned verdict.
      ownExternalId: mode === 'watch' ? externalIdFor(checkName) : '',
    },
  };
}

/** Reports each non-Actions check suite it had to drop, once per name. */
function droppedReporter() {
  const seen = new Set();
  return (names) => {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      notice(`Ignoring "${name}": its check suite has no workflow run, so it is not a job this gate can wait on`);
    }
  };
}

/**
 * Reports a check run this action published on this commit while it was still in
 * `publish: check-run` mode.
 *
 * Only reachable mid-migration, on a commit that was gated before the input
 * changed. The status now carries the verdict and that check run is ignored as a
 * sibling, but both hold the same required context, so GitHub can still report
 * the abandoned one and block a merge the gate has already passed. Read off the
 * check runs already fetched, so detecting it costs no extra call.
 */
function warnLeftoverCheckRun(all, ownExternalId, checkName) {
  if (!ownExternalId || !all.some((entry) => String(entry.externalId || '') === ownExternalId)) return;
  warn(
    `This commit still carries a check run named "${checkName}" from an earlier event that ran in ` +
      'check-run mode. The commit status is the live verdict and that check run is ignored, but both ' +
      `claim the "${checkName}" context. If the merge stays blocked on a gate that reads green, push a ` +
      'new commit or conclude that check run by hand.'
  );
}

function warnUnmatchedSkips(all, skipList) {
  // Report a skip-list rule that matches nothing. Usually a filename typo, and
  // the quiet version leaves the gate waiting on the job it was told to skip.
  for (const rule of unmatchedRules(all, skipList)) {
    warn(`skip-list rule ${JSON.stringify(rule)} matched no check run on this commit. Check the workflow filename and job name.`);
  }
}

/**
 * Reports a `wait-for` rule that names something `skip-list` throws away.
 *
 * The two inputs are opposites, so a rule in both is a configuration mistake with
 * an expensive shape: the gate holds the pull request open for the whole of
 * `wait-for-timeout` waiting for a check run it is deleting from its own view on
 * every poll, and then fails for a job that was there the entire time.
 */
function warnConflictingWaitFor(all, skipOpts, waitFor) {
  const skipped = all.filter((entry) => shouldSkip(entry, skipOpts));
  for (const rule of waitFor) {
    if (!skipped.some((entry) => ruleMatches(rule, entry))) continue;
    warn(
      `wait-for rule ${JSON.stringify(rule)} matches a check run that skip-list ignores, so the gate ` +
        'can never see it. Remove it from one of the two inputs.'
    );
  }
}

/**
 * Everything the verdict is computed from, in one place, so watch mode's linger
 * loop and wait mode's poll loop reach the same answer from the same state.
 */
function assessment(all, { skipOpts, triggeringRun, waitFor, waitForTimeoutSec, timeoutConclusion, earlyExit }, nowMs = Date.now()) {
  // A projected entry goes through skip-list like any other. Waiting on a run the
  // caller explicitly told the gate to ignore would be a worse bug than the one
  // the projection fixes.
  const watched = withTriggeringRun(
    all.filter((entry) => !shouldSkip(entry, skipOpts)),
    triggeringRun,
    (entry) => !shouldSkip(entry, skipOpts)
  );
  const deadlineMs = waitForDeadlineMs(all, waitForTimeoutSec);
  const { entries: expected, waived } = waitForEntries(watched, waitFor, {
    deadlineMs,
    nowMs,
    timeoutConclusion,
  });
  const entries = [...watched, ...expected];
  // The deadline is returned rather than recomputed by the caller. It decides
  // `expired` here, so a caller holding its own copy could sleep against one
  // deadline while the loop exits on another.
  return { all, watched, entries, waived, deadlineMs, result: evaluate(entries, { earlyExit }) };
}

/**
 * True when the only thing holding the gate open is a `wait-for` job that has not
 * registered. Nothing on the commit will produce another event until it does, so
 * this is the one state where an event-driven gate has to hold its runner.
 */
function awaitingArrivalOnly(result) {
  return !result.done
    && result.pending.length > 0
    && result.pending.every((entry) => entry.placeholder);
}

/**
 * Watch mode: compute the verdict once from the current state of the commit and
 * publish it as a check run, then exit. No waiting.
 *
 * The job's own exit code is deliberately not the verdict. The verdict lives in
 * the published check run, which is what the branch ruleset requires, so this job
 * stays green even when the gate is red.
 */
async function runWatch(opts) {
  const {
    ctx, checkName, publish, headBranch, bypassPrefix, skipOpts, dryRun, warmupMs,
    waitFor, triggeringRun, minimumMs, attemptLimits, waitForTimeoutSec,
  } = opts;
  const reportDropped = droppedReporter();
  const publisher = publish === 'status'
    ? commitStatusPublisher(ctx, checkName)
    : checkRunPublisher(ctx, checkName);

  log(`Gate (watch) on ${ctx.owner}/${ctx.repo}@${ctx.sha}, publishing ${publisher.label} "${checkName}"`);
  log(`  event: ${process.env.GITHUB_EVENT_NAME || '(unknown)'}, api retries: ${ctx.retryLimit}`);
  if (skipOpts.skipList.length > 0) log(`  skip-list: ${JSON.stringify(skipOpts.skipList)}`);
  if (waitFor.length > 0) log(`  wait-for: ${JSON.stringify(waitFor)}, timeout ${waitForTimeoutSec}s`);
  if (triggeringRun && !triggeringRun.finished) {
    notice(
      `Woken by workflow run ${triggeringRun.runId} (attempt ${triggeringRun.attempt}) starting. Until its check ` +
        'runs are visible the gate reports it as unfinished, so an event announcing that work began cannot ' +
        'publish a verdict saying the commit is done.'
    );
  }

  if (bypassPrefix) {
    const verdict = publisher.bypassFor({ branch: headBranch, prefix: bypassPrefix });
    setOutput('polls', '0');
    setOutput('conclusion', 'success');
    if (dryRun) {
      warn(`dry-run: would have bypassed the gate for ${headBranch} (matches "${bypassPrefix}")`);
      return 0;
    }
    // Written straight to success with no invalidation step. The two-phase write
    // exists so a failed write cannot leave a stale green behind, and the target
    // here is green, so a failure leaves whatever was published before, which
    // blocks. Fails closed either way.
    await publisher.write(await publisher.locate(), verdict);
    notice(`Gate bypassed: ${headBranch} matches bypass-branch-prefixes entry "${bypassPrefix}". Published "${checkName}" as a pass without checking anything.`);
    return 0;
  }

  const assess = async () =>
    assessment(flattenCheckSuites(await fetchChecks(ctx), reportDropped), opts);

  // Invalidate before computing anything. Recomputing and only then discovering
  // the write fails is what leaves a stale green behind.
  let handle = dryRun ? null : await publisher.prepare();

  const seedEvent = ['pull_request', 'pull_request_target'].includes(process.env.GITHUB_EVENT_NAME);
  if (seedEvent && warmupMs > 0) {
    // On the first event of a commit the siblings have not registered their check
    // runs yet, and an empty commit reads as "nothing to gate", which would
    // publish a premature success.
    log(`Waiting ${Math.round(warmupMs / 1000)}s for sibling check runs to register.`);
    await sleep(warmupMs);
  }

  let state = await assess();
  if (state.watched.length === 0 && !seedEvent && warmupMs > 0) {
    // Nothing visible on a completion event should be impossible, since the
    // workflow that triggered it is itself a check run on this commit. Warm up
    // and look again rather than concluding success off an empty read.
    warn(`No watched check runs visible on a ${process.env.GITHUB_EVENT_NAME} event. Retrying after ${Math.round(warmupMs / 1000)}s.`);
    await sleep(warmupMs);
    state = await assess();
  }

  log(`${state.watched.length} watched check run(s) of ${state.all.length} total.`);
  for (const entry of state.entries) log(`  ${formatEntry(entry)}`);
  if (state.all.length > 0) warnUnmatchedSkips(state.all, skipOpts.skipList);
  if (waitFor.length > 0) warnConflictingWaitFor(state.all, skipOpts, waitFor);
  if (publish === 'status') warnLeftoverCheckRun(state.all, skipOpts.ownExternalId, checkName);

  let polls = 1;

  // The one place watch mode holds a runner. Every other verdict is recomputed by
  // the next completion event, but a job that has not started produces no events,
  // so leaving now would park the gate pending until a human noticed and would
  // never reach wait-for-timeout at all.
  if (awaitingArrivalOnly(state.result) && !dryRun) {
    log(`Every other job finished. Waiting for ${state.result.pending.length} expected job(s) to start.`);
    // Carry forward what that write produced. On the first event of a commit
    // there was no check run to update, so this write creates one, and publishing
    // the final verdict against a stale null would create a second check run of
    // the same required name. Two writers on one name make the status context
    // flip between them, which is the failure ownership by external_id exists to
    // prevent.
    ({ handle } = await publisher.write(handle, publisher.verdictFor(state.result, state.entries.length, state.waived)));

    while (awaitingArrivalOnly(state.result) && polls < attemptLimits) {
      // A null deadline means no check suite has been created on this commit at
      // all, so the clock the timeout is measured from has not started. Holding
      // the runner against a deadline that cannot arrive would burn the job's
      // timeout and publish nothing.
      if (state.deadlineMs == null) break;
      // Read off the last assessment, not captured once before the loop. The
      // assessment is what decides whether the deadline has passed, so a
      // separate copy here could sleep against one deadline while the loop exits
      // on another.
      //
      // Never break on an elapsed deadline without looking again first: the state
      // in hand was read before it passed, so it still says "waiting", and
      // publishing that would leave the gate pending on a timeout that has
      // already run out with no event left to come and notice. The floor is what
      // makes that safe to say. Sleeping the exact remainder would busy-loop
      // against the API for the rest of attempt-limits if the two ever disagreed,
      // and a second is nothing against a timeout measured in minutes.
      const remainingMs = state.deadlineMs - Date.now();
      await sleep(Math.max(1000, Math.min(minimumMs, remainingMs)));
      polls += 1;
      state = await assess();
      log(`Poll ${polls}: ${Math.round(Math.max(0, state.deadlineMs - Date.now()) / 1000)}s left on wait-for-timeout.`);
    }
    for (const entry of state.entries) log(`  ${formatEntry(entry)}`);

    // Still waiting, and the loop stopped for a reason that is not the deadline:
    // the poll budget ran out, or no check suite exists to measure a deadline
    // from. Publishing pending here is the trap this whole branch exists to
    // avoid. Nothing is coming to recompute a job that never started, so the
    // context would block on a timeout that is never evaluated. A failure blocks
    // too, and says which knob was too small.
    if (awaitingArrivalOnly(state.result)) {
      const reason = state.deadlineMs == null
        ? 'no check suite exists on this commit yet, so wait-for-timeout has no clock to run against'
        : `the gate ran out of polls after ${polls} of ${attemptLimits}, before wait-for-timeout elapsed. ` +
          'Raise attempt-limits or minimum-interval so their product exceeds wait-for-timeout';
      warn(`Gave up waiting for ${state.result.pending.length} expected job(s): ${reason}.`);
      state = {
        ...state,
        result: {
          done: true,
          ok: false,
          pending: [],
          bad: state.result.pending.map((entry) => ({
            ...entry,
            status: 'COMPLETED',
            conclusion: 'failure',
            stateLabel: `never started, and the gate stopped waiting because ${reason}`,
          })),
        },
      };
    }
  }

  const { result, waived, entries } = state;
  if (waived.length > 0) {
    // The one path here that can publish green for a job that never ran, so it
    // is never silent whatever the summary says.
    warn(
      `Waived ${waived.length} wait-for rule(s) that never matched, because wait-for-timeout-conclusion is ` +
        `success and nothing new has started on this commit since ` +
        `${new Date(state.deadlineMs - waitForTimeoutSec * 1000).toISOString()}. This pass did not check them.`
    );
  }
  const verdict = publisher.verdictFor(result, entries.length, waived);

  setOutput('polls', String(polls));
  setOutput('conclusion', result.done ? (result.ok ? 'success' : 'failure') : 'pending');

  if (dryRun) {
    warn(`dry-run: would have set ${publisher.label} "${checkName}" to ${publisher.describe(verdict)}`);
    return 0;
  }

  const { note } = await publisher.write(handle, verdict);
  log(`${note} ${publisher.label} "${checkName}": ${publisher.describe(verdict)}`);
  return 0;
}

async function runWait(opts) {
  const { ctx, headBranch, bypassPrefix, skipOpts, dryRun, warmupMs, minimumMs, retryMethod, attemptLimits, waitFor, waitForTimeoutSec } = opts;
  const { owner, repo, sha } = ctx;
  const reportDropped = droppedReporter();

  log(`Gate (wait) on ${owner}/${repo}@${sha}`);
  log(`  api retries: ${ctx.retryLimit}, poll limit: ${attemptLimits}, interval: ${minimumMs / 1000}s (${retryMethod})`);
  if (skipOpts.skipList.length > 0) log(`  skip-list: ${JSON.stringify(skipOpts.skipList)}`);
  if (waitFor.length > 0) log(`  wait-for: ${JSON.stringify(waitFor)}, timeout ${waitForTimeoutSec}s`);

  // Wait mode publishes nothing, so the bypass is just an early exit. Handled
  // here as well as in watch mode so the input means the same thing in both, and
  // so a caller can migrate modes without the escape hatch changing behaviour.
  if (bypassPrefix) {
    setOutput('polls', '0');
    setOutput('conclusion', 'success');
    notice(`Gate bypassed: ${headBranch} matches bypass-branch-prefixes entry "${bypassPrefix}". Nothing was checked.`);
    return 0;
  }

  let polls = 0;
  let warnedUnmatchedSkips = false;
  for (let attempt = 1; attempt <= attemptLimits; attempt += 1) {
    polls = attempt;
    const waitMs = attempt === 1 ? warmupMs : pollIntervalMs(retryMethod, minimumMs, attempt);
    if (waitMs > 0) {
      log(`Waiting ${Math.round(waitMs / 1000)}s before poll ${attempt}.`);
      await sleep(waitMs);
    }

    const suites = await fetchChecks(ctx);
    const { all, watched, entries, waived, result } = assessment(
      flattenCheckSuites(suites, reportDropped), opts
    );

    log(`Poll ${attempt}: ${watched.length} watched check run(s) of ${all.length} total.`);
    for (const entry of entries) log(`  ${formatEntry(entry)}`);

    if (!warnedUnmatchedSkips && all.length > 0) {
      warnedUnmatchedSkips = true;
      warnUnmatchedSkips(all, skipOpts.skipList);
      if (waitFor.length > 0) warnConflictingWaitFor(all, skipOpts, waitFor);
    }

    if (watched.length === 0 && attempt === 1) {
      notice('No other check runs visible yet. If this repo genuinely has no other jobs the gate will pass.');
    }

    if (!result.done) {
      log(`  ${result.pending.length} still running.`);
      continue;
    }

    setOutput('polls', String(polls));

    if (result.ok) {
      setOutput('conclusion', 'success');
      for (const rule of waived) {
        notice(`wait-for rule ${JSON.stringify(rule)} never appeared before wait-for-timeout, and was let through by wait-for-timeout-conclusion: success.`);
      }
      log('All watched jobs passed.');
      return 0;
    }

    setOutput('conclusion', 'failure');
    const lines = result.bad.map((entry) => `  ${formatEntry(entry)}${entry.url ? ` (${entry.url})` : ''}`);
    if (dryRun) {
      warn(`dry-run: the gate would have failed on ${result.bad.length} job(s):\n${lines.join('\n')}`);
      return 0;
    }
    log(`::error::Gate failed. ${result.bad.length} job(s) did not pass:\n${lines.join('\n')}`);
    return 1;
  }

  setOutput('polls', String(polls));
  setOutput('conclusion', 'timed_out');
  if (dryRun) {
    warn(`dry-run: gate gave up after ${polls} polls with jobs still running`);
    return 0;
  }
  log(`::error::Gate gave up after ${polls} polls with jobs still running. Raise attempt-limits if the slowest job legitimately takes longer.`);
  return 1;
}

async function run() {
  const opts = buildOptions();
  return opts.mode === 'watch' ? runWatch(opts) : runWait(opts);
}

if (require.main === module) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log(`::error::${err && err.message ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

module.exports = {
  getInput,
  setOutput,
  getBooleanInput,
  parseDurationSeconds,
  classify,
  parseMode,
  parsePublish,
  parseSkipList,
  parseWaitFor,
  parseTimeoutConclusion,
  ruleMatches,
  currentWorkflowFile,
  shouldSkip,
  unmatchedRules,
  markInFlight,
  inFlightEntry,
  withTriggeringRun,
  triggeringWorkflowRun,
  placeholderEntry,
  waitForDeadlineMs,
  waitForEntries,
  assessment,
  awaitingArrivalOnly,
  formatRule,
  evaluate,
  isRetryableStatus,
  isRetryableGraphQLErrors,
  backoffMs,
  retryAfterMs,
  pollIntervalMs,
  parseIntOr,
  flattenCheckSuites,
  warnLeftoverCheckRun,
  formatEntry,
  codeSpan,
  plainText,
  verdictCheckRun,
  verdictStatus,
  statusState,
  statusDescription,
  truncateForStatus,
  resolveHeadBranch,
  parseBypassPrefixes,
  matchedBypassPrefix,
  bypassCheckRun,
  bypassStatus,
  externalIdFor,
  findOwnedCheckRun,
  writeCheckRun,
  writeCommitStatus,
  invalidationCheckRun,
  invalidationStatus,
  workflowRunUrl,
  resolveSha,
  graphql,
  rest,
  upsertCheckRun,
  // Exported for the linger test. Holding a runner is the one thing watch mode
  // is not supposed to do, so the conditions that start and end it are worth
  // asserting against a stubbed API rather than reasoning about.
  runWatch,
};
