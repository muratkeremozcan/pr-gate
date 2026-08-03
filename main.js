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

const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/** 'pending' | 'ok' | 'bad'. Anything completed and not explicitly OK is bad. */
function classify(entry) {
  if (String(entry.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
  return OK_CONCLUSIONS.has(String(entry.conclusion || '').toLowerCase()) ? 'ok' : 'bad';
}

function parseSkipList(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(`skip-list is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('skip-list must be a JSON array');
  for (const rule of parsed) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error('each skip-list entry must be an object');
    }
    if (!rule.workflowFile && !rule.jobName) {
      throw new Error('each skip-list entry needs workflowFile, jobName, or both');
    }
    if (rule.jobMatchMode && !['exact', 'prefix'].includes(rule.jobMatchMode)) {
      throw new Error(`jobMatchMode must be "exact" or "prefix", got "${rule.jobMatchMode}"`);
    }
  }
  return parsed;
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
  // Watch mode used to publish its verdict as a check run on the same commit it
  // is inspecting. Without this the gate reads that abandoned verdict as a
  // sibling and, once it is a failure, can never recover to success.
  //
  // Matched on external_id, which this action set and owned, rather than on the
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
  for (const rule of skipList) {
    if (rule.workflowFile && path.basename(entry.workflowPath || '') !== rule.workflowFile) continue;
    if (rule.jobName) {
      const prefix = rule.jobMatchMode === 'prefix';
      const name = String(entry.name || '');
      if (prefix ? !name.startsWith(rule.jobName) : name !== rule.jobName) continue;
    }
    return true;
  }
  return false;
}

/**
 * skip-list rules that matched nothing.
 *
 * The failure mode this catches is quiet and expensive: a rule naming
 * `claude-code-review.yml` when the repo's file is `claude-code-review.yaml`
 * matches nothing, so the gate waits on, and can fail because of, a job it was
 * explicitly told to ignore. Both spellings are legitimate in different repos, so
 * the fix is to report a rule that matches nothing rather than to standardise the
 * filename.
 */
function unmatchedSkipRules(entries, skipList) {
  return skipList.filter(
    (rule) => !entries.some((entry) =>
      shouldSkip(entry, { skipSameWorkflow: false, skipList: [rule] })
    )
  );
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
  const state = classify(entry) === 'pending'
    ? String(entry.status || '').toLowerCase()
    : String(entry.conclusion || '').toLowerCase();
  return `${entry.workflowName || '(unknown workflow)'} / ${entry.name}: ${state}`;
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

// A monorepo with a big matrix can produce a lot of entries, and this list goes
// into the job summary, which GitHub caps at 1MB per step. Bounded well short of
// that, since a reader scanning for the culprit does not want a hundred lines.
const MAX_LISTED_ENTRIES = 30;

function entryList(heading, entries) {
  const shown = entries.slice(0, MAX_LISTED_ENTRIES);
  const lines = shown.map((entry) => `- ${codeSpan(formatEntry(entry))}`);
  if (entries.length > shown.length) {
    lines.push(`- and ${entries.length - shown.length} more`);
  }
  return [heading, ...lines].join('\n');
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
  // Cut on a code point boundary, counting the UTF-16 length of each one so the
  // result still fits the endpoint's limit. Slicing by unit instead leaves half
  // a surrogate pair whenever the cut lands inside an emoji, which a job name in
  // a workflow file is free to contain. A lone surrogate is not well-formed
  // text, and a write rejected for carrying one loses the verdict this trimming
  // exists to protect.
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

/**
 * The commit status for a verdict, for watch mode.
 *
 * A `done` verdict becomes `success` or `failure`. Anything else stays
 * `pending`, which a branch ruleset reads as unfinished and so keeps blocking
 * the merge. That is the fail-closed direction: a gate that never hears about
 * the last sibling leaves the pull request unmergeable rather than mergeable.
 *
 * `title` and `summary` do not go to the statuses endpoint, whose description is
 * a single 140-character line. They are the markdown for the job summary, which
 * `target_url` points at.
 */
function verdictStatus(result, { context, totalWatched }) {
  if (!result.done) {
    const title = `Waiting on ${result.pending.length} of ${totalWatched} job(s)`;
    return {
      context,
      state: 'pending',
      description: statusDescription(title, result.pending),
      title,
      summary: entryList('Still running:', result.pending),
    };
  }
  if (result.ok) {
    const title = `All ${totalWatched} watched job(s) passed`;
    return {
      context,
      state: 'success',
      description: statusDescription(title, []),
      title,
      summary: totalWatched === 0
        ? 'No other check runs on this commit, so there was nothing to gate.'
        : 'Every watched check run on this commit finished and passed.',
    };
  }
  const title = `${result.bad.length} job(s) did not pass`;
  return {
    context,
    state: 'failure',
    description: statusDescription(title, result.bad),
    title,
    summary: entryList('Failed:', result.bad),
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
        workflowName: suite.workflowRun.workflow?.name || '',
        workflowPath: suite.workflowRun.workflow?.resourcePath || '',
        workflowRunId: suite.workflowRun.databaseId,
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
              workflowRun {
                databaseId
                workflow { name resourcePath }
              }
              checkRuns(first: 100) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes { name status conclusion detailsUrl externalId }
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
          nodes { name status conclusion detailsUrl externalId }
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
 * Every request this action makes is idempotent, so a retry needs no guard
 * against a lost response having landed server-side: a repeated status POST
 * supersedes itself rather than accumulating a second verdict.
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
}) {
  const endpoint = `${String(apiUrl || 'https://api.github.com').replace(/\/+$/, '')}${path}`;

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
      const waitMs = backoffMs(attempt, baseDelayMs);
      warn(`Network error contacting the GitHub API (${err.message}), retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${retryLimit})`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isRetryableStatus(res.status, res.headers) && attempt <= retryLimit) {
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
function rest({ apiUrl, token, retryLimit, baseDelayMs }, method, path, body) {
  return requestWithRetry({ apiUrl, token, method, path, body, retryLimit, baseDelayMs });
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
 * The commit status for a bypassed gate.
 *
 * Watch mode cannot use a skipped job as its escape hatch. In wait mode the
 * required check was the job, and GitHub counts a skipped job as passing; here
 * the required check is the published status, so a skipped job publishes nothing,
 * the context never appears, and the merge blocks on a check that is never
 * coming. The hatch therefore has to run and publish a pass.
 *
 * It says so, in both the description and the summary. A skipped job was
 * invisible unless you read the workflow file, and a bypassed gate is worth
 * seeing on the pull request.
 */
function bypassStatus(context, { branch, prefix }) {
  return {
    context,
    state: 'success',
    description: truncateForStatus(
      `Bypassed for ${branch}: matches the bypass prefix ${prefix}, so nothing was checked`
    ),
    title: `Bypassed for ${branch}`,
    summary:
      `This gate did not check anything. The branch ${codeSpan(branch)} matches the ` +
      `bypass prefix ${codeSpan(prefix)}, so the verdict was published as a pass ` +
      'without reading the other check runs on this commit.',
  };
}

/**
 * Identifies a check run published by an older version of this action, back when
 * watch mode wrote one instead of a status.
 *
 * Nothing writes this any more. It is kept so a commit gated before the switch is
 * still recognised: that check run holds the same required context, and counting
 * it as a sibling would leave the gate pending on an abandoned verdict of its own.
 */
function externalIdFor(checkName) {
  return `muratkeremozcan/pr-gate:${checkName}`;
}

/**
 * The status that invalidates a terminal verdict before it is recomputed.
 *
 * Without this step a write failure is fail-open: the previous verdict stays
 * published, so a gate that went green before a later failure merges. Moving the
 * context back to pending first means any failure from here on leaves the gate
 * unconcluded, which blocks.
 */
function invalidationStatus(context) {
  return {
    context,
    state: 'pending',
    description: 'Recomputing: a CI workflow finished and the previous verdict no longer applies',
  };
}

/**
 * Writes the verdict as a commit status on the inspected commit.
 *
 * No ownership lookup and no update path, because statuses supersede rather than
 * mutate: the most recently posted state for a context is the one a ruleset
 * reads. That also makes the write idempotent, so it needs no guard against a
 * lost response duplicating anything. The cost is that the commit accumulates a
 * status row per write, and GitHub allows 1000 per commit per context before it
 * starts rejecting them.
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
 * Publishes a verdict, and puts its markdown where a reader can reach it.
 *
 * The status description is one 140-character line, so the detail goes to the
 * job summary, which is what `target_url` links to.
 */
async function publishVerdict(ctx, verdict, targetUrl) {
  appendStepSummary(`## ${verdict.title}\n\n${verdict.summary}\n`);
  await writeCommitStatus(ctx, verdict, targetUrl);
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
    headBranch,
    bypassPrefix,
    retryMethod,
    warmupMs: parseDurationSeconds(getInput('warmup-delay'), 10) * 1000,
    minimumMs: parseDurationSeconds(getInput('minimum-interval'), 15) * 1000,
    attemptLimits: Math.max(1, Math.trunc(parseIntOr(getInput('attempt-limits'), 180))),
    earlyExit: getBooleanInput('early-exit'),
    dryRun: getBooleanInput('dry-run'),
    skipOpts: {
      currentRunId: process.env.GITHUB_RUN_ID,
      currentWorkflowFile: currentWorkflowFile(),
      skipSameWorkflow: getBooleanInput('skip-same-workflow'),
      skipList: parseSkipList(getInput('skip-list')),
      // Watch mode used to publish a check run rather than a status, and a commit
      // gated before that change can still carry one. Counting it as a sibling
      // would leave the gate pending on its own abandoned verdict.
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
 * Reports a check run left on this commit by the version of watch mode that
 * published one instead of a status.
 *
 * Only reachable on a commit gated before that change. The status now carries
 * the verdict and the check run is ignored as a sibling, but both hold the same
 * required context, so GitHub can still report the abandoned one and block a
 * merge the gate has already passed. Read off the check runs already fetched, so
 * detecting it costs no extra call.
 */
function warnLeftoverCheckRun(all, ownExternalId, checkName) {
  if (!ownExternalId || !all.some((entry) => String(entry.externalId || '') === ownExternalId)) return;
  warn(
    `This commit still carries a check run named "${checkName}", published by an older version of ` +
      'this action. The commit status is the live verdict and that check run is ignored, but both ' +
      `claim the "${checkName}" context. If the merge stays blocked on a gate that reads green, push a ` +
      'new commit or conclude that check run by hand.'
  );
}

function warnUnmatchedSkips(all, skipList) {
  // Report a skip-list rule that matches nothing. Usually a filename typo, and
  // the quiet version leaves the gate waiting on the job it was told to skip.
  for (const rule of unmatchedSkipRules(all, skipList)) {
    warn(`skip-list rule ${JSON.stringify(rule)} matched no check run on this commit. Check the workflow filename and job name.`);
  }
}

/**
 * Watch mode: compute the verdict once from the current state of the commit and
 * publish it as a commit status, then exit. No waiting.
 *
 * A status rather than a check run because of how the pull request page labels
 * them. A check run created through the Checks API with GITHUB_TOKEN belongs to
 * the github-actions app, as does every workflow run on the commit, each with its
 * own check suite; an API-created check run cannot choose its suite, so GitHub
 * files it under whichever unrelated workflow opened the first one. The gate then
 * renders as "<that workflow> / gate", and a failing gate reads as a failure of a
 * workflow that passed. A status belongs to no suite, so it renders as `gate`.
 *
 * The job's own exit code is deliberately not the verdict. The verdict lives in
 * the published status, which is what the branch ruleset requires, so this job
 * stays green even when the gate is red.
 */
async function runWatch(opts) {
  const { ctx, checkName, headBranch, bypassPrefix, skipOpts, earlyExit, dryRun, warmupMs } = opts;
  const reportDropped = droppedReporter();
  const targetUrl = workflowRunUrl();

  log(`Gate (watch) on ${ctx.owner}/${ctx.repo}@${ctx.sha}, publishing commit status "${checkName}"`);
  log(`  event: ${process.env.GITHUB_EVENT_NAME || '(unknown)'}, api retries: ${ctx.retryLimit}`);
  if (skipOpts.skipList.length > 0) log(`  skip-list: ${JSON.stringify(skipOpts.skipList)}`);

  if (bypassPrefix) {
    const verdict = bypassStatus(checkName, { branch: headBranch, prefix: bypassPrefix });
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
    await publishVerdict(ctx, verdict, targetUrl);
    notice(`Gate bypassed: ${headBranch} matches bypass-branch-prefixes entry "${bypassPrefix}". Published "${checkName}" as a pass without checking anything.`);
    return 0;
  }

  const collect = async () => {
    const all = flattenCheckSuites(await fetchChecks(ctx), reportDropped);
    return { all, watched: all.filter((entry) => !shouldSkip(entry, skipOpts)) };
  };

  // Invalidate before computing anything. Recomputing and only then discovering
  // the write fails is what leaves a stale green behind.
  //
  // Posted unconditionally rather than only when a terminal verdict is already
  // published. Finding out which it is means reading the combined status, which
  // costs the call this write costs, and moving the context to pending
  // regardless is the stronger version of the property: from here on any failure
  // leaves the gate unfinished and blocking.
  if (!dryRun) {
    await writeCommitStatus(ctx, invalidationStatus(checkName), targetUrl);
    log('Moved the context to pending before recomputing, so a failed write cannot leave a stale verdict.');
  }

  const seedEvent = ['pull_request', 'pull_request_target'].includes(process.env.GITHUB_EVENT_NAME);
  if (seedEvent && warmupMs > 0) {
    // On the first event of a commit the siblings have not registered their check
    // runs yet, and an empty commit reads as "nothing to gate", which would
    // publish a premature success.
    log(`Waiting ${Math.round(warmupMs / 1000)}s for sibling check runs to register.`);
    await sleep(warmupMs);
  }

  let { all, watched } = await collect();
  if (watched.length === 0 && !seedEvent && warmupMs > 0) {
    // Nothing visible on a completion event should be impossible, since the
    // workflow that triggered it is itself a check run on this commit. Warm up
    // and look again rather than concluding success off an empty read.
    warn(`No watched check runs visible on a ${process.env.GITHUB_EVENT_NAME} event. Retrying after ${Math.round(warmupMs / 1000)}s.`);
    await sleep(warmupMs);
    ({ all, watched } = await collect());
  }

  log(`${watched.length} watched check run(s) of ${all.length} total.`);
  for (const entry of watched) log(`  ${formatEntry(entry)}`);
  if (all.length > 0) warnUnmatchedSkips(all, skipOpts.skipList);
  warnLeftoverCheckRun(all, skipOpts.ownExternalId, checkName);

  const result = evaluate(watched, { earlyExit });
  const verdict = verdictStatus(result, { context: checkName, totalWatched: watched.length });

  setOutput('polls', '1');
  setOutput('conclusion', result.done ? (result.ok ? 'success' : 'failure') : 'pending');

  if (dryRun) {
    warn(`dry-run: would have set commit status "${checkName}" to ${verdict.state} — ${verdict.description}`);
    return 0;
  }

  await publishVerdict(ctx, verdict, targetUrl);
  log(`Published commit status "${checkName}": ${verdict.state} — ${verdict.description}`);
  return 0;
}

async function runWait(opts) {
  const { ctx, headBranch, bypassPrefix, skipOpts, earlyExit, dryRun, warmupMs, minimumMs, retryMethod, attemptLimits } = opts;
  const { owner, repo, sha } = ctx;
  const reportDropped = droppedReporter();

  log(`Gate (wait) on ${owner}/${repo}@${sha}`);
  log(`  api retries: ${ctx.retryLimit}, poll limit: ${attemptLimits}, interval: ${minimumMs / 1000}s (${retryMethod})`);
  if (skipOpts.skipList.length > 0) log(`  skip-list: ${JSON.stringify(skipOpts.skipList)}`);

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
    const all = flattenCheckSuites(suites, reportDropped);
    const watched = all.filter((entry) => !shouldSkip(entry, skipOpts));

    log(`Poll ${attempt}: ${watched.length} watched check run(s) of ${all.length} total.`);
    for (const entry of watched) log(`  ${formatEntry(entry)}`);

    if (!warnedUnmatchedSkips && all.length > 0) {
      warnedUnmatchedSkips = true;
      warnUnmatchedSkips(all, skipOpts.skipList);
    }

    if (watched.length === 0 && attempt === 1) {
      notice('No other check runs visible yet. If this repo genuinely has no other jobs the gate will pass.');
    }

    const result = evaluate(watched, { earlyExit });
    if (!result.done) {
      log(`  ${result.pending.length} still running.`);
      continue;
    }

    setOutput('polls', String(polls));

    if (result.ok) {
      setOutput('conclusion', 'success');
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
  parseSkipList,
  currentWorkflowFile,
  shouldSkip,
  unmatchedSkipRules,
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
  verdictStatus,
  statusDescription,
  truncateForStatus,
  resolveHeadBranch,
  parseBypassPrefixes,
  matchedBypassPrefix,
  bypassStatus,
  externalIdFor,
  writeCommitStatus,
  invalidationStatus,
  workflowRunUrl,
  resolveSha,
  graphql,
  rest,
};
