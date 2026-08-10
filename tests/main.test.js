/**
 * Tests for the pr-gate action.
 *
 * The group that matters most is "API errors are retried, job failures are not".
 * That distinction is the entire reason this action exists instead of a
 * third-party poller wrapped in a retry action, so it is asserted directly
 * against a stubbed fetch rather than inferred.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const gate = require('../main.js');

describe('parseDurationSeconds', () => {
  const cases = [
    ['PT15S', 15],
    ['PT10S', 10],
    ['PT1M', 60],
    ['PT1M30S', 90],
    ['PT2H', 7200],
    ['P1D', 86400],
    ['pt45s', 45, 'case insensitive'],
    ['15', 15, 'plain seconds, so callers do not have to learn ISO 8601'],
    ['0', 0],
    ['2.5', 2.5],
    ['20m', 1200, 'the readable form, since PT20M in a workflow file explains nothing'],
    ['15s', 15],
    ['2h', 7200],
    ['1D', 86400, 'case insensitive here too'],
    ['1.5m', 90],
  ];
  for (const [input, expected, why] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}${why ? ` (${why})` : ''}`, () => {
      assert.strictEqual(gate.parseDurationSeconds(input, 999), expected);
    });
  }

  test('empty falls back rather than becoming zero', () => {
    assert.strictEqual(gate.parseDurationSeconds('', 15), 15);
    assert.strictEqual(gate.parseDurationSeconds(undefined, 15), 15);
  });

  // '1h30m' is deliberately rejected. One unit or ISO 8601, so there is no half
  // grammar for a reader to guess at.
  for (const bad of ['PT', 'P', 'abc', 'PT15X', '-5', '15x', '1h30m', 'm', '15 m']) {
    test(`rejects ${JSON.stringify(bad)} instead of silently defaulting`, () => {
      assert.throws(() => gate.parseDurationSeconds(bad, 15), /invalid duration/);
    });
  }
});

describe('classify', () => {
  for (const status of ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED']) {
    test(`${status} is pending`, () => {
      assert.strictEqual(gate.classify({ status, conclusion: null }), 'pending');
    });
  }
  for (const conclusion of ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'success', 'skipped']) {
    test(`completed/${conclusion} is ok`, () => {
      assert.strictEqual(gate.classify({ status: 'COMPLETED', conclusion }), 'ok');
    });
  }
  for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE']) {
    test(`completed/${conclusion} is bad`, () => {
      assert.strictEqual(gate.classify({ status: 'COMPLETED', conclusion }), 'bad');
    });
  }
  test('completed with an unknown conclusion is bad, not ok', () => {
    // Fail closed: a conclusion GitHub adds later must not silently pass the gate.
    assert.strictEqual(gate.classify({ status: 'COMPLETED', conclusion: 'SOMETHING_NEW' }), 'bad');
    assert.strictEqual(gate.classify({ status: 'COMPLETED', conclusion: null }), 'bad');
  });
});

describe('parseMode', () => {
  test('accepts the two modes', () => {
    assert.strictEqual(gate.parseMode('wait'), 'wait');
    assert.strictEqual(gate.parseMode(' watch '), 'watch');
  });

  for (const missing of ['', '   ', null, undefined]) {
    test(`rejects ${JSON.stringify(missing)} rather than defaulting`, () => {
      // The modes need different permissions and different triggers, so a caller
      // that never said which one it wanted is misconfigured. Defaulting would
      // hide that behind a gate quietly doing the wrong thing.
      assert.throws(() => gate.parseMode(missing), /mode is required/);
    });
  }

  test('rejects an unknown mode', () => {
    assert.throws(() => gate.parseMode('report'), /must be wait or watch/);
  });
});

describe('parseSkipList', () => {
  test('empty means skip nothing', () => {
    assert.deepStrictEqual(gate.parseSkipList(''), []);
    assert.deepStrictEqual(gate.parseSkipList('[]'), []);
  });

  test('parses the real footprint-collector rule', () => {
    const parsed = gate.parseSkipList(
      '[{"workflowFile":"claude-code-review.yaml","jobName":"review","jobMatchMode":"prefix"}]'
    );
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].workflowFile, 'claude-code-review.yaml');
  });

  const bad = [
    ['{not json', /not valid JSON/],
    ['{"a":1}', /must be a JSON array/],
    ['[[]]', /must be an object/],
    ['[null]', /must be an object/],
    ['[{}]', /needs workflowFile, jobName, or both/],
    ['[{"jobName":"x","jobMatchMode":"regex"}]', /jobMatchMode must be/],
  ];
  for (const [input, pattern] of bad) {
    test(`rejects ${input}`, () => {
      // A typo in skip-list must be loud. Silently skipping nothing would make
      // the gate wait forever on a job it was told to ignore.
      assert.throws(() => gate.parseSkipList(input), pattern);
    });
  }
});

describe('shouldSkip', () => {
  const entry = {
    name: 'review',
    workflowPath: '/org/repo/actions/workflows/claude-code-review.yaml',
    workflowRunId: 111,
  };
  const base = { currentRunId: '999', currentWorkflowFile: 'pr-gate.yml', skipSameWorkflow: true, skipList: [] };
  const ownGate = {
    name: 'gate',
    workflowPath: '/org/repo/actions/workflows/pr-gate.yml',
    workflowRunId: 12345,
  };

  test('skips the gate\'s own workflow run so it cannot wait on itself', () => {
    assert.strictEqual(gate.shouldSkip({ ...entry, workflowRunId: 999 }, base), true);
  });

  test('skips an EARLIER run of its own workflow, not just the current run id', () => {
    // Caught against live data: a re-run or a second trigger on the same commit
    // gives the same workflow a different run id. Matching on run id alone left
    // the gate waiting on a previous instance of itself and inheriting its
    // result, which is a self-inflicted flake on a required check.
    assert.strictEqual(gate.shouldSkip(ownGate, base), true);
  });

  test('falls back to run id when GITHUB_WORKFLOW_REF is unavailable', () => {
    const opts = { ...base, currentWorkflowFile: '' };
    assert.strictEqual(gate.shouldSkip({ ...ownGate, workflowRunId: 999 }, opts), true);
    assert.strictEqual(gate.shouldSkip(ownGate, opts), false);
  });

  test('does not skip other runs when skip-same-workflow is on', () => {
    assert.strictEqual(gate.shouldSkip(entry, base), false);
  });

  test('honours skip-same-workflow: false', () => {
    const opts = { ...base, skipSameWorkflow: false };
    assert.strictEqual(gate.shouldSkip({ ...entry, workflowRunId: 999 }, opts), false);
  });

  test('matches workflowFile by basename, not full resourcePath', () => {
    const opts = { ...base, skipList: [{ workflowFile: 'claude-code-review.yaml' }] };
    assert.strictEqual(gate.shouldSkip(entry, opts), true);
  });

  test('jobName defaults to exact match', () => {
    const opts = { ...base, skipList: [{ jobName: 'review' }] };
    assert.strictEqual(gate.shouldSkip(entry, opts), true);
    assert.strictEqual(gate.shouldSkip({ ...entry, name: 'review (1)' }, opts), false);
  });

  test('jobMatchMode prefix matches the matrix-suffixed names Actions generates', () => {
    const opts = { ...base, skipList: [{ jobName: 'review', jobMatchMode: 'prefix' }] };
    assert.strictEqual(gate.shouldSkip({ ...entry, name: 'review (ubuntu-latest)' }, opts), true);
  });

  test('workflowFile and jobName must both match when both are given', () => {
    const opts = {
      ...base,
      skipList: [{ workflowFile: 'other.yaml', jobName: 'review' }],
    };
    assert.strictEqual(gate.shouldSkip(entry, opts), false);
  });
});

describe('evaluate', () => {
  const ok = { status: 'COMPLETED', conclusion: 'SUCCESS', name: 'a' };
  const failed = { status: 'COMPLETED', conclusion: 'FAILURE', name: 'b' };
  const running = { status: 'IN_PROGRESS', conclusion: null, name: 'c' };

  test('all passed means done and ok', () => {
    assert.deepStrictEqual(gate.evaluate([ok, ok], { earlyExit: true }), {
      done: true, ok: true, pending: [], bad: [],
    });
  });

  test('no siblings at all passes rather than hanging', () => {
    const r = gate.evaluate([], { earlyExit: true });
    assert.strictEqual(r.done, true);
    assert.strictEqual(r.ok, true);
  });

  test('still running means keep polling', () => {
    const r = gate.evaluate([ok, running], { earlyExit: true });
    assert.strictEqual(r.done, false);
  });

  test('early-exit reports a failure without waiting for the rest', () => {
    const r = gate.evaluate([failed, running], { earlyExit: true });
    assert.strictEqual(r.done, true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.bad.length, 1);
  });

  test('without early-exit it waits for the full picture', () => {
    const r = gate.evaluate([failed, running], { earlyExit: false });
    assert.strictEqual(r.done, false, 'keeps polling so the report lists every failure');
    assert.strictEqual(r.bad.length, 1);
  });

  test('without early-exit it still fails once everything finishes', () => {
    const r = gate.evaluate([failed, ok], { earlyExit: false });
    assert.strictEqual(r.done, true);
    assert.strictEqual(r.ok, false);
  });
});

describe('retry classification', () => {
  const headers = (obj) => new Headers(obj);

  for (const status of [408, 429, 500, 502, 503, 504]) {
    test(`${status} is retryable`, () => {
      assert.strictEqual(gate.isRetryableStatus(status, headers({})), true);
    });
  }

  for (const status of [400, 401, 404, 422]) {
    test(`${status} is not retryable, it will not fix itself`, () => {
      assert.strictEqual(gate.isRetryableStatus(status, headers({})), false);
    });
  }

  test('a plain 403 is a permissions problem, not retryable', () => {
    assert.strictEqual(gate.isRetryableStatus(403, headers({})), false);
  });

  test('a 403 carrying secondary-rate-limit signals is retryable', () => {
    assert.strictEqual(gate.isRetryableStatus(403, headers({ 'retry-after': '30' })), true);
    assert.strictEqual(gate.isRetryableStatus(403, headers({ 'x-ratelimit-remaining': '0' })), true);
  });

  test('transient GraphQL error types are retryable', () => {
    assert.strictEqual(gate.isRetryableGraphQLErrors([{ type: 'RATE_LIMITED' }]), true);
    assert.strictEqual(gate.isRetryableGraphQLErrors([{ type: 'INTERNAL_SERVER_ERROR' }]), true);
  });

  test('a mix of transient and permanent is not retried', () => {
    // Retrying would loop until the attempt limit and still fail on NOT_FOUND.
    assert.strictEqual(
      gate.isRetryableGraphQLErrors([{ type: 'RATE_LIMITED' }, { type: 'NOT_FOUND' }]),
      false
    );
  });

  test('no errors is not a retry condition', () => {
    assert.strictEqual(gate.isRetryableGraphQLErrors([]), false);
    assert.strictEqual(gate.isRetryableGraphQLErrors(undefined), false);
  });

  test('an error with no type is not retried', () => {
    // GraphQL validation errors (a bad field, a malformed query) arrive as
    // {message} with no type. Retrying those burns the retry budget on every
    // poll and then reports a timeout instead of the real query problem.
    assert.strictEqual(gate.isRetryableGraphQLErrors([{ message: 'Field x doesn\'t exist' }]), false);
    assert.strictEqual(gate.isRetryableGraphQLErrors([{}]), false);
    assert.strictEqual(gate.isRetryableGraphQLErrors([null]), false);
  });
});

describe('unmatchedRules', () => {
  const entries = [
    { name: 'review', workflowPath: '/o/r/actions/workflows/claude-code-review.yaml' },
    { name: 'Run unit tests', workflowPath: '/o/r/actions/workflows/unit-tests.yaml' },
  ];

  test('a rule that matches nothing is reported', () => {
    // The real footgun: .yml vs .yaml. Both spellings are legitimate in
    // different repos, so a mismatched rule silently skips nothing and the gate
    // waits on the job it was told to ignore.
    const unmatched = gate.unmatchedRules(entries, [
      { workflowFile: 'claude-code-review.yml', jobName: 'review', jobMatchMode: 'prefix' },
    ]);
    assert.strictEqual(unmatched.length, 1);
  });

  test('a rule that matches is not reported', () => {
    const unmatched = gate.unmatchedRules(entries, [
      { workflowFile: 'claude-code-review.yaml', jobName: 'review', jobMatchMode: 'prefix' },
    ]);
    assert.deepStrictEqual(unmatched, []);
  });

  test('reports only the rules that missed', () => {
    const unmatched = gate.unmatchedRules(entries, [
      { workflowFile: 'claude-code-review.yaml' },
      { jobName: 'nonexistent-job' },
    ]);
    assert.deepStrictEqual(unmatched, [{ jobName: 'nonexistent-job' }]);
  });

  test('an empty skip-list reports nothing', () => {
    assert.deepStrictEqual(gate.unmatchedRules(entries, []), []);
  });
});

describe('setOutput', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  test('uses the delimiter form so a newline cannot inject another output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-out-'));
    const file = path.join(dir, 'out.txt');
    fs.writeFileSync(file, '');
    const saved = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = file;
    try {
      gate.setOutput('conclusion', 'failure\nsmuggled=yes');
    } finally {
      if (saved === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = saved;
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const delimiter = lines[0].split('<<')[1];
    assert.match(lines[0], /^conclusion<<ghadelimiter_/);
    assert.strictEqual(lines[lines.length - 1], delimiter, 'body is fenced');
    // The smuggled line lands inside the fence, so the runner reads it as part of
    // the value instead of as a second output parameter.
    assert.deepStrictEqual(lines.slice(1, -1), ['failure', 'smuggled=yes']);
  });

  test('is a no-op without GITHUB_OUTPUT rather than throwing', () => {
    const saved = process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_OUTPUT;
    try {
      gate.setOutput('polls', '3');
    } finally {
      if (saved !== undefined) process.env.GITHUB_OUTPUT = saved;
    }
  });
});

describe('backoff and intervals', () => {
  test('backoff grows and stays within the jitter band', () => {
    const noJitter = () => 1;
    assert.strictEqual(gate.backoffMs(1, 1000, noJitter), 1000);
    assert.strictEqual(gate.backoffMs(2, 1000, noJitter), 2000);
    assert.strictEqual(gate.backoffMs(3, 1000, noJitter), 4000);
  });

  test('backoff is capped so a long outage does not park the job for hours', () => {
    assert.strictEqual(gate.backoffMs(30, 1000, () => 1), 60_000);
  });

  test('jitter never drops below half the interval', () => {
    assert.strictEqual(gate.backoffMs(1, 1000, () => 0), 500);
  });

  test('retry-after wins over computed backoff', () => {
    assert.strictEqual(gate.retryAfterMs(new Headers({ 'retry-after': '30' })), 30_000);
  });

  test('x-ratelimit-reset is honoured and capped', () => {
    const soon = Math.floor(Date.now() / 1000) + 10;
    const ms = gate.retryAfterMs(new Headers({ 'x-ratelimit-reset': String(soon) }));
    assert.ok(ms > 0 && ms <= 60_000);
  });

  test('a reset already in the past is ignored', () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    assert.strictEqual(gate.retryAfterMs(new Headers({ 'x-ratelimit-reset': String(past) })), null);
  });

  test('equal_intervals holds steady, exponential_backoff grows', () => {
    assert.strictEqual(gate.pollIntervalMs('equal_intervals', 15_000, 9), 15_000);
    assert.strictEqual(gate.pollIntervalMs('exponential_backoff', 15_000, 2), 15_000);
    assert.strictEqual(gate.pollIntervalMs('exponential_backoff', 15_000, 4), 60_000);
  });
});

describe('flattenCheckSuites', () => {
  test('flattens Actions suites', () => {
    const entries = gate.flattenCheckSuites([
      {
        workflowRun: { databaseId: 7, workflow: { name: 'Unit tests', resourcePath: '/o/r/actions/workflows/unit-tests.yaml' } },
        checkRuns: { nodes: [{ name: 'Run unit tests', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u' }] },
      },
    ]);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].workflowName, 'Unit tests');
    assert.strictEqual(entries[0].workflowRunId, 7);
  });

  test('drops non-Actions check suites but reports what it dropped', () => {
    // Silently ignoring an external app's red X would be indistinguishable from
    // "nothing to wait for", so the drop is surfaced.
    const dropped = [];
    const entries = gate.flattenCheckSuites(
      [{ workflowRun: null, checkRuns: { nodes: [{ name: 'coderabbit', status: 'COMPLETED', conclusion: 'FAILURE' }] } }],
      (names) => dropped.push(...names)
    );
    assert.deepStrictEqual(entries, []);
    assert.deepStrictEqual(dropped, ['coderabbit']);
  });

  test('tolerates nulls and missing fields', () => {
    assert.deepStrictEqual(gate.flattenCheckSuites([null, undefined, {}]), []);
    assert.deepStrictEqual(gate.flattenCheckSuites(null), []);
  });
});

describe('graphql: API errors are retried, real errors are not', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const okBody = { data: { repository: { object: { checkSuites: { nodes: [], pageInfo: {} } } } } };
  const res = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  // baseDelayMs 0 keeps the backoff sleeps at zero so the suite stays fast.
  const ctx = { apiUrl: 'https://api.github.invalid', token: 't', query: 'q', variables: {}, retryLimit: 3, baseDelayMs: 0 };

  test('a transient 500 is retried and then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return calls < 3 ? res(500, { message: 'boom' }) : res(200, okBody);
    };
    const data = await gate.graphql(ctx);
    assert.strictEqual(calls, 3);
    assert.ok(data.repository);
  });

  test('a 401 fails immediately without burning retries', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return res(401, { message: 'Bad credentials' });
    };
    await assert.rejects(() => gate.graphql(ctx), /401/);
    assert.strictEqual(calls, 1, 'a bad token will not fix itself');
  });

  test('a network error is retried', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return res(200, okBody);
    };
    const data = await gate.graphql(ctx);
    assert.strictEqual(calls, 3);
    assert.ok(data.repository);
  });

  test('retries are bounded and then surface the failure', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return res(503, { message: 'unavailable' });
    };
    await assert.rejects(() => gate.graphql(ctx), /503/);
    assert.strictEqual(calls, ctx.retryLimit + 1, 'one initial attempt plus retryLimit retries');
  });

  test('a secondary rate limit is retried', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return calls === 1
        ? res(403, { message: 'secondary rate limit' }, { 'retry-after': '0' })
        : res(200, okBody);
    };
    await gate.graphql(ctx);
    assert.strictEqual(calls, 2);
  });

  test('a transient GraphQL error is retried', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return calls === 1 ? res(200, { errors: [{ type: 'RATE_LIMITED' }] }) : res(200, okBody);
    };
    await gate.graphql(ctx);
    assert.strictEqual(calls, 2);
  });

  test('a transient GraphQL error that never clears is thrown, not returned', async () => {
    // The retry loop must not hand back a body it knows is broken and leave the
    // caller to notice. graphql() would catch this one anyway, which is exactly
    // why the swallow was invisible.
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return res(200, { errors: [{ type: 'RATE_LIMITED' }] });
    };
    await assert.rejects(() => gate.graphql(ctx), /persisted after \d+ retries/);
    assert.strictEqual(calls, ctx.retryLimit + 1, 'one initial attempt plus retryLimit retries');
  });

  test('a permanent GraphQL error fails immediately', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return res(200, { errors: [{ type: 'NOT_FOUND', message: 'no commit' }] });
    };
    await assert.rejects(() => gate.graphql(ctx), /GraphQL error/);
    assert.strictEqual(calls, 1);
  });

  test('an unparseable body is retried', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error('bad json'); }, text: async () => '' };
      return res(200, okBody);
    };
    await gate.graphql(ctx);
    assert.strictEqual(calls, 2);
  });

  test('retryLimit 0 means one attempt', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return res(500, { message: 'boom' });
    };
    await assert.rejects(() => gate.graphql({ ...ctx, retryLimit: 0 }), /500/);
    assert.strictEqual(calls, 1);
  });
});

describe('currentWorkflowFile', () => {
  test('extracts the file from GITHUB_WORKFLOW_REF', () => {
    assert.strictEqual(
      gate.currentWorkflowFile({
        GITHUB_WORKFLOW_REF: 'seontechnologies/footprint-collector/.github/workflows/pr-gate.yml@refs/heads/master',
      }),
      'pr-gate.yml'
    );
  });

  test('tolerates a ref containing an @ in the branch name', () => {
    assert.strictEqual(
      gate.currentWorkflowFile({ GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/gate.yml@refs/heads/feat@2' }),
      'gate.yml'
    );
  });

  test('empty when unset, so the run-id fallback takes over', () => {
    assert.strictEqual(gate.currentWorkflowFile({}), '');
  });
});

describe('resolveSha', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  test('an explicit ref input wins', () => {
    assert.strictEqual(gate.resolveSha({ 'INPUT_REF': 'abc123', GITHUB_SHA: 'zzz' }), 'abc123');
  });

  test('on pull_request it uses the head SHA, not the merge commit', () => {
    // Check runs attach to the head SHA; GITHUB_SHA is the ephemeral merge commit,
    // which has no check runs and would make the gate see nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const file = path.join(dir, 'event.json');
    fs.writeFileSync(file, JSON.stringify({ pull_request: { head: { sha: 'headsha' } } }));
    assert.strictEqual(gate.resolveSha({ GITHUB_EVENT_PATH: file, GITHUB_SHA: 'mergesha' }), 'headsha');
  });

  test('falls back to GITHUB_SHA on push', () => {
    assert.strictEqual(gate.resolveSha({ GITHUB_SHA: 'pushsha' }), 'pushsha');
  });

  test('a malformed event payload falls back instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const file = path.join(dir, 'event.json');
    fs.writeFileSync(file, 'not json');
    assert.strictEqual(gate.resolveSha({ GITHUB_EVENT_PATH: file, GITHUB_SHA: 'pushsha' }), 'pushsha');
  });

  test('on workflow_run it uses the payload head SHA, never GITHUB_SHA', () => {
    // On workflow_run, GITHUB_SHA is the tip of the default branch and GITHUB_REF
    // is the default branch. Using either would gate the wrong commit, and would
    // silently pass because master's checks are green.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const file = path.join(dir, 'event.json');
    fs.writeFileSync(file, JSON.stringify({ workflow_run: { head_sha: 'prhead' } }));
    assert.strictEqual(gate.resolveSha({ GITHUB_EVENT_PATH: file, GITHUB_SHA: 'masterhead' }), 'prhead');
  });
});

describe('resolveHeadBranch', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const payloadEnv = (payload, env = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const file = path.join(dir, 'event.json');
    fs.writeFileSync(file, JSON.stringify(payload));
    return { GITHUB_EVENT_PATH: file, ...env };
  };

  test('on pull_request it reads the head ref from the payload', () => {
    assert.strictEqual(
      gate.resolveHeadBranch(payloadEnv({ pull_request: { head: { ref: 'hotfix/db-pool' } } })),
      'hotfix/db-pool'
    );
  });

  test('on workflow_run it reads head_branch, never GITHUB_REF_NAME', () => {
    // This is the whole reason the branch is resolved in here. On workflow_run
    // GITHUB_REF_NAME is the default branch and GITHUB_HEAD_REF is empty, so a
    // caller-side startsWith(github.head_ref, 'hotfix/') reads false on every
    // event after the seed, and the bypass silently stops working.
    const env = payloadEnv(
      { workflow_run: { head_branch: 'hotfix/db-pool' } },
      { GITHUB_REF_NAME: 'master', GITHUB_HEAD_REF: '' }
    );
    assert.strictEqual(gate.resolveHeadBranch(env), 'hotfix/db-pool');
  });

  test('falls back to GITHUB_HEAD_REF, then GITHUB_REF_NAME', () => {
    assert.strictEqual(gate.resolveHeadBranch({ GITHUB_HEAD_REF: 'feat/x', GITHUB_REF_NAME: 'master' }), 'feat/x');
    assert.strictEqual(gate.resolveHeadBranch({ GITHUB_REF_NAME: 'master' }), 'master');
  });

  test('a malformed payload falls back instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const file = path.join(dir, 'event.json');
    fs.writeFileSync(file, 'not json');
    assert.strictEqual(gate.resolveHeadBranch({ GITHUB_EVENT_PATH: file, GITHUB_REF_NAME: 'master' }), 'master');
  });

  test('an unresolvable branch is empty rather than a guess', () => {
    assert.strictEqual(gate.resolveHeadBranch({}), '');
  });
});

describe('bypass-branch-prefixes', () => {
  test('parses comma and newline separated lists, trimming both', () => {
    assert.deepStrictEqual(gate.parseBypassPrefixes('hotfix/, emergency/'), ['hotfix/', 'emergency/']);
    assert.deepStrictEqual(gate.parseBypassPrefixes('hotfix/\nemergency/\n'), ['hotfix/', 'emergency/']);
  });

  test('an empty input is no prefixes, so nothing is ever bypassed', () => {
    assert.deepStrictEqual(gate.parseBypassPrefixes(''), []);
    assert.deepStrictEqual(gate.parseBypassPrefixes(undefined), []);
    assert.strictEqual(gate.matchedBypassPrefix('hotfix/x', []), null);
  });

  test('returns the prefix that matched, for the summary and the log', () => {
    assert.strictEqual(gate.matchedBypassPrefix('hotfix/db-pool', ['hotfix/', 'emergency/']), 'hotfix/');
    assert.strictEqual(gate.matchedBypassPrefix('emergency/now', ['hotfix/', 'emergency/']), 'emergency/');
  });

  test('an unrelated branch does not match', () => {
    assert.strictEqual(gate.matchedBypassPrefix('feat/hotfix-docs', ['hotfix/']), null);
    assert.strictEqual(gate.matchedBypassPrefix('master', ['hotfix/']), null);
  });

  test('an unresolved branch never matches', () => {
    // The bypass publishes a passing gate, so an unknown branch has to fail
    // closed. Matching on empty would open the gate wherever the payload is
    // missing a branch.
    assert.strictEqual(gate.matchedBypassPrefix('', ['hotfix/']), null);
    assert.strictEqual(gate.matchedBypassPrefix(undefined, ['hotfix/']), null);
  });

  test('the published verdict passes and says it checked nothing', () => {
    const body = gate.bypassCheckRun('gate', { branch: 'hotfix/db-pool', prefix: 'hotfix/' });
    assert.strictEqual(body.status, 'completed');
    assert.strictEqual(body.conclusion, 'success');
    assert.match(body.title, /hotfix\/db-pool/);
    assert.match(body.summary, /did not check anything/);
    assert.match(body.summary, /hotfix\//);
  });

  test('a branch name cannot break out of the summary markdown', () => {
    // Branch names are attacker-controlled on a fork PR and land in a markdown
    // summary, same reason formatEntry uses codeSpan.
    const body = gate.bypassCheckRun('gate', { branch: 'hotfix/`x`', prefix: 'hotfix/' });
    assert.ok(!body.summary.includes('`x`'));
  });
});

describe('watch mode: own check run is ignored', () => {
  const base = { currentRunId: '999', currentWorkflowFile: 'pr-gate.yml', skipSameWorkflow: true, skipList: [] };
  const ownId = gate.externalIdFor('gate');

  test('skips the check run it publishes itself', () => {
    // Without this the gate reads its own previous verdict as a sibling. Once
    // that verdict is a failure it is permanently self-confirming, because the
    // failing sibling it sees is itself.
    const own = { name: 'gate', externalId: ownId, workflowPath: '/o/r/actions/workflows/other.yml', workflowRunId: 1 };
    assert.strictEqual(gate.shouldSkip(own, { ...base, ownExternalId: ownId }), true);
  });

  test('a legitimate sibling job named `gate` is still watched', () => {
    // Ownership is external_id, not the name. Matching on the name would silence
    // a real job that happens to share it.
    const namesake = { name: 'gate', externalId: '', workflowPath: '/o/r/actions/workflows/other.yml', workflowRunId: 1 };
    assert.strictEqual(gate.shouldSkip(namesake, { ...base, ownExternalId: ownId }), false);
  });

  test('another writer\'s external_id is not treated as ours', () => {
    const other = { name: 'gate', externalId: 'someone-else', workflowPath: '/o/r/actions/workflows/other.yml', workflowRunId: 1 };
    assert.strictEqual(gate.shouldSkip(other, { ...base, ownExternalId: ownId }), false);
  });

  test('wait mode passes no ownExternalId and behaves as before', () => {
    const own = { name: 'gate', externalId: ownId, workflowPath: '/o/r/actions/workflows/other.yml', workflowRunId: 1 };
    assert.strictEqual(gate.shouldSkip(own, base), false);
  });
});

describe('verdictCheckRun', () => {
  const pendingEntry = { name: 'unit-tests', workflowName: 'CI', status: 'IN_PROGRESS' };
  const badEntry = { name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' };

  test('pending stays in_progress, which keeps blocking the merge', () => {
    // The fail-closed direction. A gate that never hears about the last sibling
    // must leave the PR unmergeable, not mergeable.
    const v = gate.verdictCheckRun(
      { done: false, ok: true, pending: [pendingEntry], bad: [] },
      { name: 'gate', totalWatched: 3 }
    );
    assert.strictEqual(v.status, 'in_progress');
    assert.strictEqual(v.conclusion, undefined);
    assert.match(v.title, /Waiting on 1 of 3/);
  });

  test('all done and clean is a completed success', () => {
    const v = gate.verdictCheckRun(
      { done: true, ok: true, pending: [], bad: [] },
      { name: 'gate', totalWatched: 4 }
    );
    assert.strictEqual(v.status, 'completed');
    assert.strictEqual(v.conclusion, 'success');
  });

  test('a bad sibling is a completed failure naming it', () => {
    const v = gate.verdictCheckRun(
      { done: true, ok: false, pending: [], bad: [badEntry] },
      { name: 'gate', totalWatched: 2 }
    );
    assert.strictEqual(v.status, 'completed');
    assert.strictEqual(v.conclusion, 'failure');
    assert.match(v.summary, /lint/);
  });

  test('zero siblings says so rather than claiming jobs passed', () => {
    const v = gate.verdictCheckRun(
      { done: true, ok: true, pending: [], bad: [] },
      { name: 'gate', totalWatched: 0 }
    );
    assert.match(v.summary, /nothing to gate/);
  });

  test('a huge pending list is truncated, since an oversized summary is rejected', () => {
    // A rejected write loses the verdict entirely, so this cannot be left
    // unbounded on a repo with a large matrix.
    const many = Array.from({ length: 90 }, (_, i) => ({ ...pendingEntry, name: `job-${i}` }));
    const v = gate.verdictCheckRun(
      { done: false, ok: true, pending: many, bad: [] },
      { name: 'gate', totalWatched: 90 }
    );
    assert.match(v.summary, /and 60 more/);
    assert.ok(v.summary.length < 65535);
  });

  test('the name carries through, since it is the required status context', () => {
    const v = gate.verdictCheckRun(
      { done: true, ok: true, pending: [], bad: [] },
      { name: 'custom-gate', totalWatched: 1 }
    );
    assert.strictEqual(v.name, 'custom-gate');
  });
});

describe('codeSpan', () => {
  test('a job name cannot break out of its span into the summary markdown', () => {
    // Job names come from workflow files, which a PR can edit, and this text is
    // rendered as markdown in the check run summary.
    assert.strictEqual(gate.codeSpan('a`b'), '`ab`');
    assert.strictEqual(gate.codeSpan('<img src=x>'), '`<img src=x>`');
  });

  test('null and undefined render as an empty span, not "null"', () => {
    assert.strictEqual(gate.codeSpan(null), '``');
    assert.strictEqual(gate.codeSpan(undefined), '``');
  });
});

describe('upsertCheckRun', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 'deadbeef', retryLimit: 3, baseDelayMs: 0 };
  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const record = (lookupBody) => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === 'GET') return res(200, lookupBody);
      return res(200, { id: 555 });
    };
    return calls;
  };

  const ours = (id) => ({ id, external_id: gate.externalIdFor('gate') });

  test('creates the check run on the first event, stamped with our external_id', async () => {
    const calls = record({ check_runs: [] });
    const out = await gate.upsertCheckRun(ctx, { name: 'gate', status: 'in_progress', title: 't', summary: 's' });

    assert.strictEqual(out.created, true);
    const post = calls.find((c) => c.method === 'POST');
    assert.strictEqual(post.body.head_sha, 'deadbeef');
    assert.strictEqual(post.body.name, 'gate');
    assert.strictEqual(post.body.external_id, gate.externalIdFor('gate'));
    assert.ok(post.body.started_at);
  });

  test('updates its own check run instead of creating a second one', async () => {
    // Two check runs of the same name means the status context flips to whichever
    // was written last, so the gate must own exactly one per commit.
    const calls = record({ check_runs: [ours(42)] });
    const out = await gate.upsertCheckRun(ctx, { name: 'gate', status: 'in_progress', title: 't', summary: 's' });

    assert.strictEqual(out.created, false);
    assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 0);
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.match(patch.url, /\/check-runs\/42$/);
  });

  test('refuses to hijack a same-named check run it does not own', async () => {
    // Patching someone else's check would take over their status context, and two
    // writers on one name make the required check flip between them.
    record({ check_runs: [{ id: 42, external_id: 'other-tool', app: { slug: 'sonarcloud' } }] });
    await assert.rejects(
      () => gate.upsertCheckRun(ctx, { name: 'gate', status: 'in_progress', title: 't', summary: 's' }),
      /created by something else \(sonarcloud\)/
    );
  });

  test('picks its own check run out of several sharing the name', async () => {
    const calls = record({ check_runs: [{ id: 7, external_id: 'other' }, ours(42)] });
    await gate.upsertCheckRun(ctx, { name: 'gate', status: 'in_progress', title: 't', summary: 's' });

    const patch = calls.find((c) => c.method === 'PATCH');
    assert.match(patch.url, /\/check-runs\/42$/);
  });

  test('the update omits head_sha, which the endpoint rejects', async () => {
    const calls = record({ check_runs: [ours(42)] });
    await gate.upsertCheckRun(ctx, { name: 'gate', status: 'completed', conclusion: 'success', title: 't', summary: 's' });

    const patch = calls.find((c) => c.method === 'PATCH');
    assert.strictEqual(patch.body.head_sha, undefined);
    assert.strictEqual(patch.body.conclusion, 'success');
    assert.ok(patch.body.completed_at);
  });

  test('an in_progress write carries no conclusion or completed_at', async () => {
    const calls = record({ check_runs: [ours(42)] });
    await gate.upsertCheckRun(ctx, { name: 'gate', status: 'in_progress', title: 't', summary: 's' });

    const patch = calls.find((c) => c.method === 'PATCH');
    assert.strictEqual(patch.body.conclusion, undefined);
    assert.strictEqual(patch.body.completed_at, undefined);
  });

  test('the lookup is scoped to the commit and the exact name', async () => {
    const calls = record({ check_runs: [] });
    await gate.upsertCheckRun(ctx, { name: 'my gate', status: 'in_progress', title: 't', summary: 's' });

    const get = calls.find((c) => c.method === 'GET');
    assert.match(get.url, /\/commits\/deadbeef\/check-runs/);
    assert.match(get.url, /check_name=my%20gate/);
    assert.match(get.url, /filter=all/);
  });

  test('REST writes inherit the retry rules, so a 502 does not lose the verdict', async () => {
    let calls = 0;
    global.fetch = async (url, init) => {
      calls += 1;
      if (init.method === 'GET') return res(200, { check_runs: [ours(42)] });
      return calls < 4 ? res(502, { message: 'bad gateway' }) : res(200, { id: 42 });
    };
    await gate.upsertCheckRun(ctx, { name: 'gate', status: 'completed', conclusion: 'failure', title: 't', summary: 's' });
    assert.strictEqual(calls, 4, 'one lookup plus two retried writes plus the success');
  });

  test('a 422 on the write is surfaced rather than retried away', async () => {
    global.fetch = async (url, init) =>
      init.method === 'GET' ? res(200, { check_runs: [] }) : res(422, { message: 'Invalid request' });
    await assert.rejects(
      () => gate.upsertCheckRun(ctx, { name: 'gate', status: 'in_progress', title: 't', summary: 's' }),
      /422/
    );
  });

  test('a lost create response does not produce a duplicate check run', async () => {
    // The first POST may have created the run server-side while its response
    // was lost. The retry must re-check ownership before POSTing again, and the
    // lost POST already carried this verdict, so finding the run settles it.
    // Two check runs of one name would flip the required context between them.
    let gets = 0;
    let posts = 0;
    global.fetch = async (url, init) => {
      if (init.method === 'GET') {
        gets += 1;
        return res(200, { check_runs: gets === 1 ? [] : [ours(42)] });
      }
      posts += 1;
      throw new Error('socket hang up');
    };
    const out = await gate.upsertCheckRun(ctx, { name: 'gate', status: 'completed', conclusion: 'success', title: 't', summary: 's' });

    assert.strictEqual(posts, 1, 'the create was sent once and never blindly retried');
    assert.strictEqual(out.id, 42);
  });

  test('the create is retried only while the follow-up lookup finds nothing', async () => {
    let posts = 0;
    global.fetch = async (url, init) => {
      if (init.method === 'GET') return res(200, { check_runs: [] });
      posts += 1;
      throw new Error('socket hang up');
    };
    await assert.rejects(
      () => gate.upsertCheckRun(ctx, { name: 'gate', status: 'in_progress', title: 't', summary: 's' }),
      /network error/
    );
    assert.strictEqual(posts, ctx.retryLimit + 1, 'bounded by the same retry limit as any other call');
  });
});

describe('parsePublish', () => {
  test('defaults to check-run, so an existing caller keeps the behaviour it has', () => {
    assert.strictEqual(gate.parsePublish(''), 'check-run');
    assert.strictEqual(gate.parsePublish(undefined), 'check-run');
  });

  for (const value of ['check-run', 'status']) {
    test(`accepts ${value}`, () => {
      assert.strictEqual(gate.parsePublish(` ${value} `), value);
    });
  }

  for (const bad of ['commit-status', 'checkrun', 'both', 'true']) {
    test(`rejects ${JSON.stringify(bad)} rather than falling back to a primitive nobody asked for`, () => {
      assert.throws(() => gate.parsePublish(bad), /publish must be check-run or status/);
    });
  }
});

describe('verdictStatus', () => {
  const entry = (name, conclusion) => ({
    name,
    status: conclusion ? 'COMPLETED' : 'IN_PROGRESS',
    conclusion,
    workflowName: 'Playwright e2e',
  });

  const pending = { done: false, ok: true, pending: [entry('pw-e2e (2, 2)', null)], bad: [] };
  const passed = { done: true, ok: true, pending: [], bad: [] };
  const failed = { done: true, ok: false, pending: [], bad: [entry('pw-e2e (2, 2)', 'FAILURE')] };

  test('an unfinished verdict is pending, which a ruleset reads as blocking', () => {
    const status = gate.verdictStatus(pending, { context: 'gate', totalWatched: 5 });
    assert.strictEqual(status.state, 'pending');
    assert.strictEqual(status.context, 'gate');
  });

  test('the failing description names the job, which is the point of publishing a status', () => {
    // The whole confusion this primitive exists to fix is a pull request page
    // that named an unrelated workflow. The replacement has to name the culprit.
    const status = gate.verdictStatus(failed, { context: 'gate', totalWatched: 5 });
    assert.strictEqual(status.state, 'failure');
    assert.strictEqual(status.description, '1 job(s) did not pass: Playwright e2e / pw-e2e (2, 2): failure');
  });

  test('a pending description names what it is still waiting on', () => {
    const status = gate.verdictStatus(pending, { context: 'gate', totalWatched: 5 });
    assert.match(status.description, /Waiting on 1 of 5 job\(s\): Playwright e2e \/ pw-e2e \(2, 2\)/);
  });

  test('a passing verdict has nothing to name, so the description is just the title', () => {
    const status = gate.verdictStatus(passed, { context: 'gate', totalWatched: 5 });
    assert.strictEqual(status.state, 'success');
    assert.strictEqual(status.description, 'All 5 watched job(s) passed');
  });

  test('the description is trimmed to what the endpoint accepts', () => {
    // A rejected write loses the verdict, and a matrix can produce a lot of
    // failures, so the length is bounded here rather than at GitHub's discretion.
    const many = { done: true, ok: false, pending: [], bad: Array.from({ length: 40 }, (_, i) => entry(`job-number-${i}`, 'FAILURE')) };
    const status = gate.verdictStatus(many, { context: 'gate', totalWatched: 40 });
    assert.ok(status.description.length <= 140, `got ${status.description.length}`);
    assert.ok(status.description.endsWith('…'), 'the reader can see it was cut');
  });

  test('it carries the check run markdown too, for the job summary', () => {
    const status = gate.verdictStatus(failed, { context: 'gate', totalWatched: 5 });
    assert.match(status.summary, /Failed:/);
    assert.match(status.summary, /`Playwright e2e \/ pw-e2e \(2, 2\): failure`/);
  });

  test('the two primitives cannot disagree about the same result', () => {
    // Both are derived from one verdict on purpose. A repo switching `publish`
    // mid-flight would otherwise be gated on two different readings of one commit.
    for (const result of [pending, passed, failed]) {
      const asCheckRun = gate.verdictCheckRun(result, { name: 'gate', totalWatched: 5 });
      const asStatus = gate.verdictStatus(result, { context: 'gate', totalWatched: 5 });
      assert.strictEqual(asStatus.state, gate.statusState(asCheckRun));
      assert.strictEqual(asStatus.title, asCheckRun.title);
      assert.strictEqual(asStatus.summary, asCheckRun.summary);
    }
  });
});

describe('statusState', () => {
  test('unfinished is pending, and a ruleset treats pending as unmergeable', () => {
    assert.strictEqual(gate.statusState({ status: 'in_progress' }), 'pending');
  });

  test('only success is success; every other conclusion fails closed', () => {
    assert.strictEqual(gate.statusState({ status: 'completed', conclusion: 'success' }), 'success');
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', undefined]) {
      assert.strictEqual(gate.statusState({ status: 'completed', conclusion }), 'failure');
    }
  });
});

describe('plainText', () => {
  test('a newline in a job name cannot break the single-line description', () => {
    // A status description is plain text, so the markdown escaping codeSpan does
    // is the wrong tool, but a name spanning lines still has to be flattened.
    assert.strictEqual(gate.plainText('a\nb\tc  d'), 'a b c d');
    assert.strictEqual(gate.plainText(null), '');
  });

  test('it does not strip backticks, because there is no markdown here to escape', () => {
    assert.strictEqual(gate.plainText('a`b'), 'a`b');
  });
});

describe('truncateForStatus', () => {
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  test('empty stays empty', () => {
    assert.strictEqual(gate.truncateForStatus(''), '');
    assert.strictEqual(gate.truncateForStatus(null), '');
  });

  test('exactly at the limit is left alone', () => {
    const exact = 'a'.repeat(140);
    assert.strictEqual(gate.truncateForStatus(exact), exact);
  });

  test('one over the limit includes the ellipsis inside the limit', () => {
    const cut = gate.truncateForStatus('a'.repeat(141));
    assert.strictEqual(cut.length, 140);
    assert.ok(cut.endsWith('…'));
    assert.strictEqual(cut.slice(0, -1), 'a'.repeat(139));
  });

  test('a cut landing inside an emoji does not leave half a surrogate pair', () => {
    for (let pad = 0; pad < 12; pad += 1) {
      const cut = gate.truncateForStatus('a'.repeat(pad) + '🚀'.repeat(120));
      assert.ok(!loneSurrogate.test(cut), `pad ${pad} split a surrogate pair`);
      assert.strictEqual(Buffer.from(cut, 'utf8').toString('utf8'), cut);
      assert.ok(cut.length <= 140);
      assert.ok(cut.endsWith('…'));
    }
  });

  test('multi-byte text fills the available UTF-16 budget', () => {
    const cut = gate.truncateForStatus('🚀'.repeat(120));
    assert.strictEqual(cut.length, 139);
  });
});

describe('statusDescription', () => {
  const entry = (name) => ({ name, status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CI' });

  test('with nothing to name it is just the title', () => {
    assert.strictEqual(gate.statusDescription('All 5 watched job(s) passed', []), 'All 5 watched job(s) passed');
    assert.strictEqual(gate.statusDescription('title', undefined), 'title');
  });

  test('names the entries after the title, comma separated', () => {
    assert.strictEqual(
      gate.statusDescription('2 job(s) did not pass', [entry('a'), entry('b')]),
      '2 job(s) did not pass: CI / a: failure, CI / b: failure'
    );
  });

  test('the title alone is trimmed too, not only the entry list', () => {
    const cut = gate.statusDescription('t'.repeat(200), []);
    assert.strictEqual(cut.length, 140);
  });
});

describe('warnLeftoverCheckRun', () => {
  const originalWrite = process.stdout.write;
  const captured = [];
  const capture = () => {
    process.stdout.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };
  };
  afterEach(() => {
    process.stdout.write = originalWrite;
    captured.length = 0;
  });

  const owned = gate.externalIdFor('gate');
  const ours = { name: 'gate', externalId: owned };
  const theirs = { name: 'gate', externalId: 'some-other-tool' };

  test('warns when this commit still carries a check run this action published', () => {
    capture();
    gate.warnLeftoverCheckRun([theirs, ours], owned, 'gate');
    process.stdout.write = originalWrite;

    assert.strictEqual(captured.length, 1);
    assert.match(captured[0], /^::warning::/);
    assert.match(captured[0], /still carries a check run named "gate"/);
  });

  test('silent when nothing on the commit is ours', () => {
    capture();
    gate.warnLeftoverCheckRun([theirs], owned, 'gate');
    process.stdout.write = originalWrite;
    assert.strictEqual(captured.length, 0);
  });

  test('matches on external_id, not on the name', () => {
    capture();
    gate.warnLeftoverCheckRun([{ name: 'gate', externalId: 'x' }], owned, 'gate');
    process.stdout.write = originalWrite;
    assert.strictEqual(captured.length, 0);
  });

  test('silent when there is no owned id to match, as in wait mode', () => {
    capture();
    gate.warnLeftoverCheckRun([ours], '', 'gate');
    process.stdout.write = originalWrite;
    assert.strictEqual(captured.length, 0);
  });
});

describe('bypassStatus', () => {
  test('publishes a pass whose summary still admits it checked nothing', () => {
    const status = gate.bypassStatus('gate', { branch: 'hotfix/pager', prefix: 'hotfix/' });
    assert.strictEqual(status.state, 'success');
    assert.match(status.description, /Bypassed for hotfix\/pager/);
    assert.match(status.summary, /did not check anything/);
  });
});

describe('invalidationStatus', () => {
  test('pending, so a write that fails after it blocks instead of merging on a stale green', () => {
    assert.strictEqual(gate.invalidationStatus('gate').state, 'pending');
    assert.strictEqual(gate.invalidationStatus('gate').context, 'gate');
  });
});

describe('workflowRunUrl', () => {
  test('points at this run, which is where the summary the description cannot hold lives', () => {
    assert.strictEqual(
      gate.workflowRunUrl({ GITHUB_SERVER_URL: 'https://github.com/', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' }),
      'https://github.com/o/r/actions/runs/9'
    );
  });

  test('empty rather than a broken link when the environment is incomplete', () => {
    assert.strictEqual(gate.workflowRunUrl({ GITHUB_REPOSITORY: 'o/r' }), '');
    assert.strictEqual(gate.workflowRunUrl({ GITHUB_RUN_ID: '9' }), '');
  });
});

describe('writeCommitStatus', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 'deadbeef', retryLimit: 3, baseDelayMs: 0 };
  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const verdict = { context: 'gate', state: 'failure', description: 'pw-e2e (2, 2) failed' };

  test('posts to the commit, with the context a ruleset requires', async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      return res(201, { id: 1 });
    };
    await gate.writeCommitStatus(ctx, verdict, 'https://github.com/o/r/actions/runs/9');

    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].url, /\/repos\/o\/r\/statuses\/deadbeef$/);
    assert.strictEqual(calls[0].method, 'POST');
    assert.deepStrictEqual(calls[0].body, {
      state: 'failure',
      context: 'gate',
      description: 'pw-e2e (2, 2) failed',
      target_url: 'https://github.com/o/r/actions/runs/9',
    });
  });

  test('omits target_url rather than sending an empty one', async () => {
    let sent;
    global.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return res(201, { id: 1 });
    };
    await gate.writeCommitStatus(ctx, verdict, '');
    assert.ok(!('target_url' in sent));
  });

  test('a 502 is retried, so a blip does not lose the verdict', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return calls < 3 ? res(502, { message: 'bad gateway' }) : res(201, { id: 1 });
    };
    await gate.writeCommitStatus(ctx, verdict, '');
    assert.strictEqual(calls, 3);
  });

  test('needs no lost-response guard, because a repeat supersedes instead of duplicating', async () => {
    // The check-run create has to re-check ownership before retrying or it leaves
    // two check runs of one required name. A status has no id and no ownership:
    // the latest post for a context wins, so the retry is free to be blind.
    let posts = 0;
    global.fetch = async () => {
      posts += 1;
      throw new Error('socket hang up');
    };
    await assert.rejects(() => gate.writeCommitStatus(ctx, verdict, ''), /network error/);
    assert.strictEqual(posts, ctx.retryLimit + 1);
  });

  test('a 422 is surfaced rather than retried away', async () => {
    global.fetch = async () => res(422, { message: 'Invalid request' });
    await assert.rejects(() => gate.writeCommitStatus(ctx, verdict, ''), /422/);
  });
});

describe('parseIntOr', () => {
  test('missing or non-numeric input falls back instead of producing NaN', () => {
    // NaN is the dangerous case: `attempt > NaN` is false, so a NaN retryLimit
    // retries forever and a NaN attemptLimits never polls.
    assert.strictEqual(gate.parseIntOr('', 5), 5);
    assert.strictEqual(gate.parseIntOr(undefined, 5), 5);
    assert.strictEqual(gate.parseIntOr('abc', 5), 5);
    assert.strictEqual(gate.parseIntOr('Infinity', 5), 5);
  });

  test('valid numbers pass through', () => {
    assert.strictEqual(gate.parseIntOr('0', 5), 0);
    assert.strictEqual(gate.parseIntOr('12', 5), 12);
  });
});

describe('two-phase write: a stale verdict is invalidated before it is recomputed', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 'deadbeef', retryLimit: 3, baseDelayMs: 0 };
  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  test('the invalidation body leaves the gate unconcluded', () => {
    // The whole point: after this write the gate carries no conclusion, so a
    // failure to publish the new verdict blocks the merge rather than leaving the
    // previous green in place.
    const body = gate.invalidationCheckRun('gate');
    assert.strictEqual(body.status, 'in_progress');
    assert.strictEqual(body.name, 'gate');
    assert.strictEqual(body.conclusion, undefined);
  });

  test('writing it sends no conclusion or completed_at', async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      return res(200, { id: 42 });
    };

    await gate.writeCheckRun(ctx, gate.invalidationCheckRun('gate'), { id: 42, status: 'completed' });
    assert.strictEqual(calls[0].method, 'PATCH');
    assert.strictEqual(calls[0].body.status, 'in_progress');
    assert.strictEqual(calls[0].body.conclusion, undefined);
    assert.strictEqual(calls[0].body.completed_at, undefined);
  });

  test('a failed second write therefore leaves a blocking gate, not a stale green', async () => {
    // Sequence a real event follows: find the previous success, invalidate it,
    // then fail to publish the new verdict. What matters is the order, because it
    // decides whether an unpublishable failure can merge.
    const writes = [];
    global.fetch = async (url, init) => {
      if (init.method === 'GET') {
        return res(200, { check_runs: [{ id: 42, status: 'completed', conclusion: 'success', external_id: gate.externalIdFor('gate') }] });
      }
      const body = JSON.parse(init.body);
      writes.push(body);
      if (writes.length === 1) return res(200, { id: 42 });
      return res(500, { message: 'boom' });
    };

    const existing = await gate.findOwnedCheckRun(ctx, 'gate');
    assert.strictEqual(existing.id, 42);
    await gate.writeCheckRun(ctx, gate.invalidationCheckRun('gate'), existing);

    await assert.rejects(() =>
      gate.writeCheckRun(ctx, { name: 'gate', status: 'completed', conclusion: 'failure', title: 't', summary: 's' }, existing)
    );

    assert.strictEqual(writes[0].status, 'in_progress');
    assert.strictEqual(writes[0].conclusion, undefined);
    assert.ok(writes.length > 1, 'the terminal write was attempted');
  });
});

describe('findOwnedCheckRun', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 'deadbeef', retryLimit: 3, baseDelayMs: 0 };
  const urls = [];
  const lookup = (check_runs) => {
    urls.length = 0;
    global.fetch = async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ check_runs }),
        text: async () => '',
      };
    };
  };

  test('asks for every check run, not just the latest', async () => {
    // filter=latest is scoped to the newest check suite, so once any workflow is
    // rerun the gate this action already owns can vanish from the response. The
    // lookup then reports nothing found and a second check run of the same
    // required name gets created, which is the one thing owning it must prevent.
    // Seen on couture-cast PR #95 when a workflow was rerun by hand.
    lookup([]);
    await gate.findOwnedCheckRun(ctx, 'gate');
    assert.match(urls[0], /[?&]filter=all(&|$)/);
    assert.doesNotMatch(urls[0], /filter=latest/);
  });

  test('picks the newest of several it owns, so the stale duplicate is left alone', async () => {
    // Duplicates already exist on commits gated before the fix. GitHub treats the
    // most recently updated check run of a name as the status context, so writing
    // to the newest is what keeps the required check consistent.
    lookup([
      { id: 10, external_id: gate.externalIdFor('gate'), started_at: '2026-07-29T10:00:00Z' },
      { id: 11, external_id: gate.externalIdFor('gate'), started_at: '2026-07-29T12:00:00Z' },
      { id: 9, external_id: gate.externalIdFor('gate'), started_at: '2026-07-29T09:00:00Z' },
    ]);
    assert.strictEqual((await gate.findOwnedCheckRun(ctx, 'gate')).id, 11);
  });

  test('null on the first event for a commit', async () => {
    lookup([]);
    assert.strictEqual(await gate.findOwnedCheckRun(ctx, 'gate'), null);
  });

  test('returns the one carrying our external_id', async () => {
    lookup([{ id: 1, external_id: 'other' }, { id: 2, external_id: gate.externalIdFor('gate') }]);
    assert.strictEqual((await gate.findOwnedCheckRun(ctx, 'gate')).id, 2);
  });

  test('a same-named check run owned by someone else is an error', async () => {
    lookup([{ id: 1, external_id: 'other', app: { slug: 'sonarcloud' } }]);
    await assert.rejects(() => gate.findOwnedCheckRun(ctx, 'gate'), /sonarcloud/);
  });
});

describe('getInput', () => {
  test('reads the dashed env name the runner actually sets', () => {
    assert.strictEqual(gate.getInput('github-token', { 'INPUT_GITHUB-TOKEN': ' t ' }), 't');
  });

  test('booleans accept the usual spellings and reject nonsense', () => {
    assert.strictEqual(gate.getBooleanInput('x', { INPUT_X: 'true' }), true);
    assert.strictEqual(gate.getBooleanInput('x', { INPUT_X: 'FALSE' }), false);
    assert.strictEqual(gate.getBooleanInput('x', {}), false);
    assert.throws(() => gate.getBooleanInput('x', { INPUT_X: 'maybe' }), /must be a boolean/);
  });
});

// ─── re-running a failed job ─────────────────────────────────────────────────

describe('triggeringWorkflowRun', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const payload = (body) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')), 'event.json');
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };
  const read = (body, name = 'workflow_run') =>
    gate.triggeringWorkflowRun({ GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: payload(body) });

  const run = { id: 31385709364, run_attempt: 2, run_started_at: '2026-08-10T11:58:10Z', name: 'CI', path: '.github/workflows/ci.yml' };

  test('an in_progress event reports an unfinished run', () => {
    // Measured against the API: "re-run failed jobs" produced exactly this, six
    // seconds after the click, and no `requested` event at all.
    const found = read({ action: 'in_progress', workflow_run: run });
    assert.strictEqual(found.runId, '31385709364');
    assert.strictEqual(found.attempt, 2);
    assert.strictEqual(found.finished, false);
    assert.strictEqual(found.startedAtMs, Date.parse('2026-08-10T11:58:10Z'));
  });

  test('a first attempt is read too, because its jobs are equally invisible', () => {
    // The earlier version ignored attempt 1 as uninteresting. It is not: the run
    // has no check runs yet, so any older passing job on the commit makes the
    // whole thing read as finished.
    const found = read({ action: 'in_progress', workflow_run: { ...run, run_attempt: 1 } });
    assert.strictEqual(found.finished, false);
    assert.strictEqual(found.attempt, 1);
  });

  test('a completed event carries the conclusion the check runs may not show yet', () => {
    const found = read({ action: 'completed', workflow_run: { ...run, conclusion: 'FAILURE' } });
    assert.strictEqual(found.finished, true);
    assert.strictEqual(found.conclusion, 'failure');
  });

  test('other event types and missing payloads report nothing', () => {
    assert.strictEqual(read({ action: 'in_progress', workflow_run: run }, 'pull_request'), null);
    assert.strictEqual(gate.triggeringWorkflowRun({ GITHUB_EVENT_NAME: 'workflow_run' }), null);
  });
});

describe('the run that woke the gate cannot be read as finished', () => {
  const ok = {
    name: 'unit', workflowName: 'CI', workflowPath: '/o/r/actions/workflows/ci.yml',
    workflowRunId: 7, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-08-10T11:20:24Z',
  };
  const inFlight = {
    runId: '7', attempt: 2, startedAtMs: Date.parse('2026-08-10T11:58:10Z'),
    finished: false, conclusion: '', workflowName: 'CI', workflowPath: '.github/workflows/ci.yml',
  };

  test("the previous attempt's failure reads as re-running", () => {
    // Without this the gate republishes the red the re-run exists to clear, which
    // is what teaches people to go and re-run the gate by hand.
    const [entry] = gate.markInFlight([{ ...ok, conclusion: 'FAILURE' }], inFlight);
    assert.strictEqual(gate.classify(entry), 'pending');
    assert.match(gate.formatEntry(entry), /re-running/);
  });

  test("the previous attempt's success reads as re-running too", () => {
    // "Re-run all jobs" leaves attempt 1's successes as the newest check runs, so
    // trusting them publishes a pass for a run that is still going and may fail.
    const [entry] = gate.markInFlight([ok], inFlight);
    assert.strictEqual(gate.classify(entry), 'pending');
  });

  test('a check run proven to belong to this attempt keeps its result', () => {
    const fresh = { ...ok, startedAt: '2026-08-10T11:58:13Z' };
    assert.deepStrictEqual(gate.markInFlight([fresh], inFlight), [fresh]);
  });

  test('a check run with no usable timestamp is held pending, not trusted', () => {
    // CheckRun.startedAt is nullable. Pending only ever blocks a merge, so the
    // unproven case costs an event of latency and cannot pass a bad commit.
    const [entry] = gate.markInFlight([{ ...ok, startedAt: '' }], inFlight);
    assert.strictEqual(gate.classify(entry), 'pending');
  });

  test('other workflow runs on the commit are untouched', () => {
    const other = { ...ok, workflowRunId: 8 };
    assert.deepStrictEqual(gate.markInFlight([other], inFlight), [other]);
  });

  test('an invisible run is projected, so an older success cannot carry the verdict', () => {
    // The event says work started. The snapshot shows one unrelated job that
    // passed. Read literally that is a finished, green commit.
    const older = { ...ok, workflowRunId: 9 };
    const bare = gate.assessment([older], {
      skipOpts: { skipSameWorkflow: false, skipList: [] }, triggeringRun: null,
      waitFor: [], waitForTimeoutSec: 600, timeoutConclusion: 'failure', earlyExit: true,
    });
    assert.deepStrictEqual([bare.result.done, bare.result.ok], [true, true], 'green without the projection');

    const guarded = gate.assessment([older], {
      skipOpts: { skipSameWorkflow: false, skipList: [] }, triggeringRun: inFlight,
      waitFor: [], waitForTimeoutSec: 600, timeoutConclusion: 'failure', earlyExit: true,
    });
    assert.strictEqual(guarded.result.done, false, 'the run that just started is pending');
    assert.strictEqual(guarded.result.pending[0].projected, true);
  });

  test('a projected run still obeys skip-list', () => {
    // Waiting on a run the caller explicitly told the gate to ignore would be a
    // worse bug than the one the projection fixes.
    const guarded = gate.assessment([{ ...ok, workflowRunId: 9 }], {
      skipOpts: { skipSameWorkflow: false, skipList: [{ workflowFile: 'ci.yml' }] },
      triggeringRun: inFlight, waitFor: [], waitForTimeoutSec: 600,
      timeoutConclusion: 'failure', earlyExit: true,
    });
    assert.strictEqual(guarded.result.done, true);
  });

  test('a completed run that did not pass is failed even if its checks still read green', () => {
    // The event is the authority on its own run. A stale attempt-1 success must
    // not outvote a failed attempt-2 completion.
    const finished = { ...inFlight, finished: true, conclusion: 'failure' };
    const guarded = gate.assessment([ok], {
      skipOpts: { skipSameWorkflow: false, skipList: [] }, triggeringRun: finished,
      waitFor: [], waitForTimeoutSec: 600, timeoutConclusion: 'failure', earlyExit: true,
    });
    assert.deepStrictEqual([guarded.result.done, guarded.result.ok], [true, false]);
  });

  test('a completed run that passed adds nothing', () => {
    const finished = { ...inFlight, finished: true, conclusion: 'success' };
    assert.deepStrictEqual(gate.withTriggeringRun([ok], finished), [ok]);
  });

  test('no triggering run means no rewriting at all', () => {
    assert.deepStrictEqual(gate.withTriggeringRun([ok], null), [ok]);
  });
});

// ─── wait-for: late, conditional and never-arriving jobs ─────────────────────

describe('parseWaitFor', () => {
  test('the error names wait-for, not skip-list', () => {
    // Same rule shape, two inputs. An error naming the wrong one sends the reader
    // to the wrong block of YAML.
    assert.throws(() => gate.parseWaitFor('{"a":1}'), /wait-for must be a JSON array/);
    assert.throws(() => gate.parseWaitFor('[{}]'), /each wait-for entry needs/);
  });

  test('accepts the same rules skip-list does', () => {
    const parsed = gate.parseWaitFor('[{"workflowFile":"e2e.yml","jobName":"e2e","jobMatchMode":"prefix"}]');
    assert.strictEqual(parsed.length, 1);
  });
});

describe('parseTimeoutConclusion', () => {
  test('defaults to failure, because an expected job that never ran should block', () => {
    assert.strictEqual(gate.parseTimeoutConclusion(''), 'failure');
  });

  test('success is allowed, for a job that may legitimately never run', () => {
    assert.strictEqual(gate.parseTimeoutConclusion('success'), 'success');
  });

  test('anything else is rejected rather than silently treated as one of them', () => {
    assert.throws(() => gate.parseTimeoutConclusion('neutral'), /must be failure or success/);
  });
});

describe('waitForDeadlineMs', () => {
  const entry = (createdAt) => ({ suiteCreatedAt: createdAt });

  test('anchors on the newest check suite, so the timeout means "quiet this long"', () => {
    // Measuring from the earliest suite cuts off the late job this input exists
    // to wait for: it has to fit a budget that started before it could register.
    const deadline = gate.waitForDeadlineMs(
      [entry('2026-08-10T11:10:00Z'), entry('2026-08-10T11:00:00Z'), entry('2026-08-10T11:30:00Z')],
      600
    );
    assert.strictEqual(deadline, Date.parse('2026-08-10T11:40:00Z'));
  });

  test('a workflow starting pushes the deadline out rather than eating the budget', () => {
    const first = gate.waitForDeadlineMs([entry('2026-08-10T11:00:00Z')], 600);
    const later = gate.waitForDeadlineMs(
      [entry('2026-08-10T11:00:00Z'), entry('2026-08-10T11:09:00Z')], 600
    );
    assert.ok(later > first, 'the chain of late jobs each get their own window');
  });

  test('a commit that already carried CI does not arrive with the budget spent', () => {
    // The fail-open this replaces: an old suite put the deadline in the past on
    // the first look, so wait-for-timeout-conclusion: success waived a fresh
    // missing job without the gate waiting at all.
    const stale = '2026-08-10T06:00:00Z';
    const fresh = '2026-08-10T11:59:00Z';
    const deadline = gate.waitForDeadlineMs([entry(stale), entry(fresh)], 600);
    assert.ok(deadline > Date.parse(fresh), 'the fresh generation still gets its full window');
  });

  test('no suites yet means no deadline, since the clock has not started', () => {
    // A deadline measured from a clock that never started would expire at once and
    // fail the gate for a job that was never given the chance to register.
    assert.strictEqual(gate.waitForDeadlineMs([], 600), null);
    assert.strictEqual(gate.waitForDeadlineMs([entry(''), entry('nonsense')], 600), null);
  });
});

describe('waitForEntries', () => {
  const rule = { workflowFile: 'e2e.yml', jobName: 'e2e', jobMatchMode: 'prefix' };
  const arrived = { name: 'e2e (1, 2)', workflowPath: '/o/r/actions/workflows/e2e.yml', status: 'IN_PROGRESS' };
  const deadlineMs = Date.parse('2026-08-10T12:00:00Z');
  const before = deadlineMs - 1000;
  const after = deadlineMs + 1000;

  test('a rule that matched produces nothing to wait for', () => {
    const { entries, waived } = gate.waitForEntries([arrived], [rule], {
      deadlineMs, nowMs: before, timeoutConclusion: 'failure',
    });
    assert.deepStrictEqual([entries, waived], [[], []]);
  });

  test('an unmatched rule is pending, which holds the gate open', () => {
    const { entries } = gate.waitForEntries([], [rule], {
      deadlineMs, nowMs: before, timeoutConclusion: 'failure',
    });
    assert.strictEqual(gate.classify(entries[0]), 'pending');
    assert.match(gate.formatEntry(entries[0]), /e2e\.yml \/ e2e\*: not started yet/);
  });

  test('past the deadline it fails, naming the job that never came', () => {
    const { entries } = gate.waitForEntries([], [rule], {
      deadlineMs, nowMs: after, timeoutConclusion: 'failure',
    });
    assert.strictEqual(gate.classify(entries[0]), 'bad');
    assert.match(gate.formatEntry(entries[0]), /never started/);
  });

  test('with a success conclusion it is waived rather than failed', () => {
    const { entries, waived } = gate.waitForEntries([], [rule], {
      deadlineMs, nowMs: after, timeoutConclusion: 'success',
    });
    assert.deepStrictEqual(entries, []);
    assert.deepStrictEqual(waived, [rule]);
  });

  test('a null deadline never expires', () => {
    // Nothing has registered on the commit, so there is no clock to measure from.
    const { entries } = gate.waitForEntries([], [rule], {
      deadlineMs: null, nowMs: after, timeoutConclusion: 'failure',
    });
    assert.strictEqual(gate.classify(entries[0]), 'pending');
  });
});

describe('assessment: wait-for holds a gate that would otherwise pass', () => {
  const suite = { suiteCreatedAt: '2026-08-10T11:00:00Z' };
  const passed = {
    ...suite, name: 'unit', workflowName: 'CI', workflowPath: '/o/r/actions/workflows/ci.yml',
    status: 'COMPLETED', conclusion: 'SUCCESS',
  };
  const opts = {
    skipOpts: { skipSameWorkflow: false, skipList: [] },
    triggeringRun: null,
    waitFor: [{ workflowFile: 'e2e.yml' }],
    waitForTimeoutSec: 600,
    timeoutConclusion: 'failure',
    earlyExit: true,
  };

  test('without wait-for, a commit whose only job passed is a pass', () => {
    const { result } = gate.assessment([passed], { ...opts, waitFor: [] });
    assert.deepStrictEqual([result.done, result.ok], [true, true]);
  });

  test('with wait-for, the same commit stays pending until e2e registers', () => {
    // The failure this prevents: e2e is chained behind a deployment, so at this
    // moment it does not exist, and a gate that only reads what exists would
    // publish a pass that checked nothing.
    const { result } = gate.assessment([passed], opts, Date.parse('2026-08-10T11:05:00Z'));
    assert.strictEqual(result.done, false);
    assert.strictEqual(gate.awaitingArrivalOnly(result), true);
  });

  test('once e2e registers it is an ordinary sibling and must pass', () => {
    const e2e = { ...passed, name: 'e2e', workflowPath: '/o/r/actions/workflows/e2e.yml', conclusion: 'FAILURE' };
    const { result } = gate.assessment([passed, e2e], opts, Date.parse('2026-08-10T11:05:00Z'));
    assert.deepStrictEqual([result.done, result.ok], [true, false]);
    assert.strictEqual(gate.awaitingArrivalOnly(result), false);
  });

  test('past the timeout the gate fails rather than pending forever', () => {
    const { result } = gate.assessment([passed], opts, Date.parse('2026-08-10T11:20:00Z'));
    assert.deepStrictEqual([result.done, result.ok], [true, false]);
    assert.strictEqual(result.bad[0].placeholder, true);
  });

  test('a real failure beats a missing arrival, so the gate does not wait to report it', () => {
    const broken = { ...passed, name: 'lint', conclusion: 'FAILURE' };
    const { result } = gate.assessment([broken], opts, Date.parse('2026-08-10T11:05:00Z'));
    assert.deepStrictEqual([result.done, result.ok], [true, false]);
    assert.strictEqual(gate.awaitingArrivalOnly(result), false);
  });

  test('a sibling still running is not an arrival problem, so watch mode does not linger', () => {
    // The linger exists because a job that has not started fires no events. A job
    // that is running will fire one, so holding the runner for it is pure waste.
    const running = { ...passed, name: 'slow', status: 'IN_PROGRESS', conclusion: null };
    const { result } = gate.assessment([passed, running], opts, Date.parse('2026-08-10T11:05:00Z'));
    assert.strictEqual(gate.awaitingArrivalOnly(result), false);
  });
});

describe('verdictCheckRun with wait-for', () => {
  const awaited = gate.placeholderEntry(
    { workflowFile: 'e2e.yml', jobName: 'e2e' },
    { status: 'QUEUED', conclusion: null, stateLabel: 'not started yet' }
  );
  const running = { name: 'unit', workflowName: 'CI', status: 'IN_PROGRESS' };

  test('waiting only on a job that has not started says so', () => {
    // "Waiting on 1 of 12" reads as a slow job. The two need different reactions
    // from whoever is looking at the pull request.
    const v = gate.verdictCheckRun(
      { done: false, ok: true, pending: [awaited], bad: [] },
      { name: 'gate', totalWatched: 12 }
    );
    assert.match(v.title, /Waiting for 1 expected job\(s\) to start/);
    assert.match(v.summary, /e2e\.yml \/ e2e/);
  });

  test('a mix reports both, and neither list swallows the other', () => {
    const v = gate.verdictCheckRun(
      { done: false, ok: true, pending: [running, awaited], bad: [] },
      { name: 'gate', totalWatched: 12 }
    );
    assert.match(v.title, /Waiting on 2 of 12/);
    assert.match(v.summary, /Still running:/);
    assert.match(v.summary, /Expected, not started yet:/);
  });

  test('a job that never started is a failure that names it', () => {
    const gone = { ...awaited, status: 'COMPLETED', conclusion: 'failure', stateLabel: 'never started' };
    const v = gate.verdictCheckRun(
      { done: true, ok: false, pending: [], bad: [gone] },
      { name: 'gate', totalWatched: 1 }
    );
    assert.strictEqual(v.conclusion, 'failure');
    assert.match(v.title, /1 expected job\(s\) never started/);
  });

  test('a waived job is named, so the pass does not look like a full pass', () => {
    const v = gate.verdictCheckRun(
      { done: true, ok: true, pending: [], bad: [] },
      { name: 'gate', totalWatched: 3, waived: [{ workflowFile: 'e2e.yml' }] }
    );
    assert.strictEqual(v.conclusion, 'success');
    assert.match(v.summary, /wait-for-timeout-conclusion/);
    assert.match(v.summary, /e2e\.yml/);
  });

  test('the status description names the awaited job within its 140 characters', () => {
    const s = gate.verdictStatus(
      { done: false, ok: true, pending: [awaited], bad: [] },
      { context: 'gate', totalWatched: 12 }
    );
    assert.strictEqual(s.state, 'pending');
    assert.ok(s.description.length <= 140);
    assert.match(s.description, /e2e/);
  });
});

describe('ruleMatches', () => {
  const entry = { name: 'e2e (1, 2)', workflowPath: '/o/r/actions/workflows/pr-e2e.yml' };

  test('workflowFile matches on basename, not on the full resource path', () => {
    assert.strictEqual(gate.ruleMatches({ workflowFile: 'pr-e2e.yml' }, entry), true);
    assert.strictEqual(gate.ruleMatches({ workflowFile: 'pr-e2e.yaml' }, entry), false);
  });

  test('prefix mode is what matches the matrix suffixes Actions generates', () => {
    assert.strictEqual(gate.ruleMatches({ jobName: 'e2e', jobMatchMode: 'prefix' }, entry), true);
    assert.strictEqual(gate.ruleMatches({ jobName: 'e2e' }, entry), false);
  });
});

describe('watch mode holds its runner only for a job that has not started', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const res = (body) => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => body, text: async () => JSON.stringify(body),
  });

  // The commit's only job passed. Without wait-for this is a green gate.
  const suite = (createdAt, file, runs) => ({
    id: `S_${file}`, createdAt,
    workflowRun: { databaseId: 1, workflow: { name: file, resourcePath: `/o/r/actions/workflows/${file}` } },
    checkRuns: { totalCount: runs.length, pageInfo: { hasNextPage: false }, nodes: runs },
  });
  const run = (name, over) => ({
    name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u', externalId: '',
    startedAt: '2026-08-10T11:00:00Z', ...over,
  });
  // The awaited job lives in its own workflow, which is the whole shape of the
  // problem: it is chained behind something else, so its suite arrives late.
  const ci = (createdAt, runs) => suite(createdAt, 'ci.yml', runs);
  const e2eSuite = (createdAt) => suite(createdAt, 'e2e.yml', [run('e2e')]);

  const opts = (over) => ({
    ctx: { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 'sha1', retryLimit: 0, baseDelayMs: 0 },
    checkName: 'gate',
    publish: 'status',
    headBranch: 'feature',
    bypassPrefix: null,
    skipOpts: { skipSameWorkflow: false, skipList: [], ownExternalId: '' },
    earlyExit: true,
    dryRun: false,
    warmupMs: 0,
    minimumMs: 1,
    attemptLimits: 20,
    retryMethod: 'equal_intervals',
    waitFor: [{ workflowFile: 'e2e.yml' }],
    waitForTimeoutSec: 1,
    timeoutConclusion: 'failure',
    triggeringRun: null,
    ...over,
  });

  /** Serves check suites, records every status posted, and counts GraphQL reads. */
  const stub = (suitesFor) => {
    const posted = [];
    let reads = 0;
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/graphql')) {
        reads += 1;
        return res({ data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: suitesFor(reads) } } } } });
      }
      posted.push(body);
      return res({ id: 1 });
    };
    return { posted, reads: () => reads };
  };

  test('it waits, then publishes the arrival rather than a timeout', async () => {
    // The awaited job registers on the third read. Nothing on the commit would
    // have fired an event to tell the gate that, which is why it stayed.
    const started = new Date(Date.now() - 100).toISOString();
    const s = stub((reads) =>
      reads < 3 ? [ci(started, [run('unit')])] : [ci(started, [run('unit')]), e2eSuite(started)]);
    await gate.runWatch(opts({ waitForTimeoutSec: 60 }));

    assert.ok(s.reads() >= 3, 'kept polling until the awaited job appeared');
    const last = s.posted[s.posted.length - 1];
    assert.strictEqual(last.state, 'success');
  });

  test('a deadline that runs out concludes, instead of leaving the gate pending', async () => {
    // The failure this prevents is silent: no further event is coming, so a gate
    // that published pending here would block the pull request forever.
    const s = stub(() => [ci(new Date(Date.now() - 5000).toISOString(), [run('unit')])]);
    await gate.runWatch(opts());

    const last = s.posted[s.posted.length - 1];
    assert.strictEqual(last.state, 'failure');
    assert.match(last.description, /never started/);
  });

  test('it does not hold the runner when a real job is still running', async () => {
    // A running job will fire a completion event. Waiting for it here would burn
    // minutes to learn what arrives for free.
    const running = run('slow', { status: 'IN_PROGRESS', conclusion: null });
    const s = stub(() => [ci(new Date().toISOString(), [run('unit'), running])]);
    await gate.runWatch(opts({ waitFor: [], waitForTimeoutSec: 60 }));

    assert.strictEqual(s.reads(), 1);
    assert.strictEqual(s.posted[s.posted.length - 1].state, 'pending');
  });

  test('without wait-for it stays a single read, as watch mode always was', async () => {
    const s = stub(() => [ci(new Date().toISOString(), [run('unit')])]);
    await gate.runWatch(opts({ waitFor: [] }));

    assert.strictEqual(s.reads(), 1);
    assert.strictEqual(s.posted[s.posted.length - 1].state, 'success');
  });
});

describe('lingering does not duplicate the required check run', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const res = (body) => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => body, text: async () => JSON.stringify(body),
  });

  test('the check run created before the wait is updated after it, not created twice', async () => {
    // The linger writes twice: once to say what it is waiting for, once with the
    // verdict. On the first event of a commit the first write is a create, so a
    // second create would leave two check runs holding one required name and the
    // context would flip between whichever was written last.
    const created = [];
    let reads = 0;
    // Fixed, not regenerated per read. A timestamp built inside the stub moves
    // the anchor forward on every look, so the deadline recedes and the loop
    // runs to attempt-limits instead of converging.
    const suiteCreatedAt = new Date(Date.now() - 100).toISOString();
    global.fetch = async (url, init) => {
      const target = String(url);
      if (target.endsWith('/graphql')) {
        reads += 1;
        return res({ data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{
          id: 'S', createdAt: suiteCreatedAt,
          workflowRun: { databaseId: 1, workflow: { name: 'CI', resourcePath: '/o/r/actions/workflows/ci.yml' } },
          checkRuns: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [
            { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u', externalId: '', startedAt: '2026-08-10T11:00:00Z' },
          ] },
        }] } } } } });
      }
      // Always empty, even after a create. The check-runs list is not
      // read-your-writes consistent, so looking the check run up again to learn
      // its id is exactly what cannot be relied on here.
      if (init.method === 'GET' || !init.method) return res({ check_runs: [] });
      if (target.endsWith('/check-runs')) {
        created.push(JSON.parse(init.body));
        return res({ id: 42 });
      }
      return res({ id: 42 }); // PATCH
    };

    await gate.runWatch({
      ctx: { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 'sha1', retryLimit: 0, baseDelayMs: 0 },
      checkName: 'gate',
      publish: 'check-run',
      headBranch: 'feature',
      bypassPrefix: null,
      skipOpts: { skipSameWorkflow: false, skipList: [], ownExternalId: gate.externalIdFor('gate') },
      earlyExit: true,
      dryRun: false,
      warmupMs: 0,
      // Longer than what is left on the deadline, so the single sleep lands past
      // it and the loop concludes on the next look rather than spinning.
      minimumMs: 5000,
      attemptLimits: 20,
      retryMethod: 'equal_intervals',
      waitFor: [{ workflowFile: 'e2e.yml' }],
      waitForTimeoutSec: 1,
      timeoutConclusion: 'failure',
      triggeringRun: null,
    });

    assert.strictEqual(created.length, 1, 'created the check run once, then updated it by carried id');
    assert.ok(reads >= 2, 'looked again after the wait');
  });
});

describe('the linger cannot busy-loop against the API', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('a deadline that keeps receding is still bounded by the poll interval', async () => {
    // Found by watching the poll log: "0s left" repeating. The loop had captured
    // the deadline once while assessment() recomputed it, so an anchor that moved
    // left the loop sleeping zero and re-reading the API as fast as it could for
    // the whole of attempt-limits. Nothing in production moves the anchor, which
    // is exactly why the floor has to be in the loop rather than in the anchor.
    const res = (body) => ({
      ok: true, status: 200, headers: new Headers(),
      json: async () => body, text: async () => JSON.stringify(body),
    });
    let reads = 0;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/graphql')) {
        reads += 1;
        // A fresh timestamp per read, so the deadline never arrives.
        return res({ data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{
          id: 'S', createdAt: new Date(Date.now() - 10).toISOString(),
          workflowRun: { databaseId: 1, workflow: { name: 'CI', resourcePath: '/o/r/actions/workflows/ci.yml' } },
          checkRuns: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [
            { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u', externalId: '', startedAt: '2026-08-10T11:00:00Z' },
          ] },
        }] } } } } });
      }
      return res({ id: 1 });
    };

    const startedAt = Date.now();
    await gate.runWatch({
      ctx: { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 'sha1', retryLimit: 0, baseDelayMs: 0 },
      checkName: 'gate', publish: 'status', headBranch: 'f', bypassPrefix: null,
      skipOpts: { skipSameWorkflow: false, skipList: [], ownExternalId: '' },
      earlyExit: true, dryRun: false, warmupMs: 0, minimumMs: 60_000,
      // Three polls of a one-second floor, not three hundred of none.
      attemptLimits: 3, retryMethod: 'equal_intervals',
      waitFor: [{ workflowFile: 'e2e.yml' }], waitForTimeoutSec: 1,
      timeoutConclusion: 'failure', triggeringRun: null,
    });

    assert.strictEqual(reads, 3, 'one read per poll, bounded by attempt-limits');
    assert.ok(Date.now() - startedAt >= 1900, 'each poll waited the floor rather than spinning');
  });
});

describe('wait-for rules cannot be discharged by a type-invalid match', () => {
  test('a non-string jobName is rejected instead of matching everything', () => {
    // `[].startsWith` is never reached: String([]) is "", so a prefix rule
    // matches every check run on the commit. In skip-list that ignores
    // everything; in wait-for the rule is discharged by the first unrelated job
    // and a green verdict follows without the job it was told to wait for.
    assert.throws(
      () => gate.parseWaitFor('[{"jobName":[],"jobMatchMode":"prefix"}]'),
      /jobName must be a non-empty string/
    );
    assert.throws(() => gate.parseSkipList('[{"workflowFile":123}]'), /workflowFile must be a non-empty string/);
    assert.throws(() => gate.parseWaitFor('[{"jobName":"   "}]'), /jobName must be a non-empty string/);
  });

  test('the empty-string rule that used to match everything no longer parses', () => {
    assert.throws(() => gate.parseWaitFor('[{"workflowFile":""}]'), /needs workflowFile, jobName, or both/);
  });
});

describe('the linger concludes rather than parking the gate pending forever', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('running out of polls before the deadline is a failure that names the knob', () => {
    // awaitingArrivalOnly means nothing is coming to recompute this. Publishing
    // pending would block the pull request on a timeout that is never evaluated.
    const res = (b) => ({ ok: true, status: 200, headers: new Headers(), json: async () => b, text: async () => JSON.stringify(b) });
    const posted = [];
    const createdAt = new Date().toISOString();
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/graphql')) {
        return res({ data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{
          id: 'S', createdAt,
          workflowRun: { databaseId: 1, workflow: { name: 'CI', resourcePath: '/o/r/actions/workflows/ci.yml' } },
          checkRuns: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [
            { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u', externalId: '', startedAt: createdAt },
          ] },
        }] } } } } });
      }
      posted.push(JSON.parse(init.body));
      return res({ id: 1 });
    };

    return gate.runWatch({
      ctx: { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 's', retryLimit: 0, baseDelayMs: 0 },
      checkName: 'gate', publish: 'status', headBranch: 'f', bypassPrefix: null,
      skipOpts: { skipSameWorkflow: false, skipList: [], ownExternalId: '' },
      earlyExit: true, dryRun: false, warmupMs: 0, minimumMs: 1000,
      // A poll budget far too small for the timeout, which is the misconfiguration
      // that used to end in a permanently pending required check.
      attemptLimits: 2, retryMethod: 'equal_intervals',
      waitFor: [{ workflowFile: 'e2e.yml' }], waitForTimeoutSec: 86_400,
      timeoutConclusion: 'failure', triggeringRun: null,
    }).then(() => {
      const last = posted[posted.length - 1];
      assert.strictEqual(last.state, 'failure');
      assert.match(last.description, /never started/);
    });
  });
});
