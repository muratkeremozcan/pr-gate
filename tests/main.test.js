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

  for (const bad of ['PT', 'P', 'abc', '15s', 'PT15X', '-5']) {
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

describe('unmatchedSkipRules', () => {
  const entries = [
    { name: 'review', workflowPath: '/o/r/actions/workflows/claude-code-review.yaml' },
    { name: 'Run unit tests', workflowPath: '/o/r/actions/workflows/unit-tests.yaml' },
  ];

  test('a rule that matches nothing is reported', () => {
    // The real footgun: .yml vs .yaml. Both spellings are legitimate in
    // different repos, so a mismatched rule silently skips nothing and the gate
    // waits on the job it was told to ignore.
    const unmatched = gate.unmatchedSkipRules(entries, [
      { workflowFile: 'claude-code-review.yml', jobName: 'review', jobMatchMode: 'prefix' },
    ]);
    assert.strictEqual(unmatched.length, 1);
  });

  test('a rule that matches is not reported', () => {
    const unmatched = gate.unmatchedSkipRules(entries, [
      { workflowFile: 'claude-code-review.yaml', jobName: 'review', jobMatchMode: 'prefix' },
    ]);
    assert.deepStrictEqual(unmatched, []);
  });

  test('reports only the rules that missed', () => {
    const unmatched = gate.unmatchedSkipRules(entries, [
      { workflowFile: 'claude-code-review.yaml' },
      { jobName: 'nonexistent-job' },
    ]);
    assert.deepStrictEqual(unmatched, [{ jobName: 'nonexistent-job' }]);
  });

  test('an empty skip-list reports nothing', () => {
    assert.deepStrictEqual(gate.unmatchedSkipRules(entries, []), []);
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
