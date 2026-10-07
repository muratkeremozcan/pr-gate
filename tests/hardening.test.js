/**
 * Tests for the failure paths the October 2026 red-merge audit found in pr-gate.
 * A gate stuck pending after its own run died, a verdict for the wrong commit, a red "never started" before CI registered, a gate left wrong with no event coming, and GitHub's per-commit limits.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gate = require('../main.js');

const res = (body) => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => body, text: async () => JSON.stringify(body),
});

const ctx = { apiUrl: 'https://api.github.invalid', token: 't', owner: 'o', repo: 'r', sha: 'sha1', retryLimit: 0, baseDelayMs: 0 };

/** Options for runWatch, with every field defaulted so a test names only what it changes. */
const watchOpts = (over) => ({
  ctx,
  checkName: 'gate',
  publish: 'status',
  headBranch: 'feature',
  bypassPrefix: null,
  skipOpts: { skipSameWorkflow: false, skipList: [], ownExternalId: '' },
  earlyExit: true,
  dryRun: false,
  warmupMs: 0,
  minimumMs: 1,
  attemptLimits: 5,
  retryMethod: 'equal_intervals',
  waitFor: [],
  waitForTimeoutSec: 60,
  timeoutConclusion: 'failure',
  triggeringRun: null,
  ...over,
});

// A fixed instant far in the future, so a wait-for deadline measured from it never depends on the live clock.
const FUTURE = '2099-01-01T00:00:00Z';

const eventFile = (payload) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
};

/** Captures what the action writes to stdout, which is where warnings go. */
const captureStdout = () => {
  const original = process.stdout.write;
  const lines = [];
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return { lines, restore: () => { process.stdout.write = original; } };
};

describe('action_required waits for a person instead of failing the gate', () => {
  test('it keeps the evaluation open, so approving the run can still turn it green', () => {
    const entries = [
      { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'e2e', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
    ];
    const result = gate.evaluate(entries, { earlyExit: true });
    assert.strictEqual(result.done, false);
    assert.strictEqual(result.bad.length, 0);
    assert.strictEqual(result.pending.length, 1);
  });

  test('it is described as waiting for approval, not as "completed"', () => {
    const label = gate.formatEntry({ name: 'e2e', workflowName: 'CI', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' });
    assert.strictEqual(label, 'CI / e2e: waiting for approval');
  });

  test('a real failure beside it still ends the evaluation red', () => {
    const entries = [
      { name: 'e2e', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    const result = gate.evaluate(entries, { earlyExit: true });
    assert.strictEqual(result.done, true);
    assert.strictEqual(result.ok, false);
  });
});

describe('watch mode does not linger on an action_required run', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('it publishes pending after one read, because a person has to approve it', async () => {
    // awaitingArrivalOnly only holds the runner for wait-for placeholders. An unapproved run fires its own event once approved.
    let reads = 0;
    const posted = [];
    const createdAt = FUTURE;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/graphql')) {
        reads += 1;
        return res({ data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{
          id: 'S', createdAt,
          workflowRun: { databaseId: 1, workflow: { name: 'CI', resourcePath: '/o/r/actions/workflows/ci.yml' } },
          checkRuns: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [
            { name: 'e2e', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED', detailsUrl: 'u', externalId: '', startedAt: createdAt },
          ] },
        }] } } } } });
      }
      if (init.method === 'GET') return res([]);
      posted.push(JSON.parse(init.body));
      return res({ id: 1 });
    };
    const out = captureStdout();
    try {
      await gate.runWatch(watchOpts({ attemptLimits: 20 }));
    } finally {
      out.restore();
    }
    assert.strictEqual(reads, 1);
    const last = posted[posted.length - 1];
    assert.strictEqual(last.state, 'pending');
    assert.match(last.description, /waiting for approval/);
  });
});

describe('resolveSha never gates the wrong commit', () => {
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run']) {
    test(`${event} with an unreadable payload throws instead of using GITHUB_SHA`, () => {
      // GITHUB_SHA is the merge commit, the base tip or the default branch tip here, and each has green checks of its own.
      // The old fallback published a verdict for the wrong commit and the pull request merged on it.
      assert.throws(
        () => gate.resolveSha({ GITHUB_EVENT_NAME: event, GITHUB_SHA: 'defaultbranchtip' }),
        new RegExp(`could not read the head SHA from the ${event} event payload`)
      );
    });
  }

  test('a malformed payload on pull_request throws too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const file = path.join(dir, 'event.json');
    fs.writeFileSync(file, 'not json');
    assert.throws(
      () => gate.resolveSha({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: file, GITHUB_SHA: 'mergesha' }),
      /could not read the head SHA/
    );
  });

  test('an explicit ref still wins on those events', () => {
    assert.strictEqual(
      gate.resolveSha({ GITHUB_EVENT_NAME: 'pull_request', INPUT_REF: 'abc', GITHUB_SHA: 'mergesha' }),
      'abc'
    );
  });

  test('push, schedule and dispatch keep GITHUB_SHA, which is correct there', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      assert.strictEqual(gate.resolveSha({ GITHUB_EVENT_NAME: event, GITHUB_SHA: 'tip' }), 'tip');
    }
  });

});

describe('watch mode publishes a failure when it cannot compute a verdict', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const opts = watchOpts;

  /** Statuses are posted normally; every GraphQL read throws, like an API outage. */
  const brokenReads = () => {
    const posted = [];
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/graphql')) return { ok: false, status: 400, headers: new Headers(), text: async () => 'bad request' };
      if (init.method === 'GET') return res([]);
      posted.push(JSON.parse(init.body));
      return res({ id: 1 });
    };
    return posted;
  };

  test('after moving the context to pending, it ends on a failure that says why', async () => {
    // The catch used to log and exit, leaving the context pending with no event coming.
    const posted = brokenReads();
    const out = captureStdout();
    try {
      await assert.rejects(() => gate.runWatch(opts()), /GitHub API returned 400/);
    } finally {
      out.restore();
    }
    assert.strictEqual(posted[0].state, 'pending', 'invalidated first, as before');
    const last = posted[posted.length - 1];
    assert.strictEqual(last.state, 'failure');
    assert.match(last.description, /Gate could not compute a verdict/);
    assert.match(last.description, /400/);
  });

  test('the original error still fails the job', async () => {
    brokenReads();
    const out = captureStdout();
    try {
      await assert.rejects(() => gate.runWatch(opts()), /GitHub API returned 400/);
    } finally {
      out.restore();
    }
  });

  test('if the failure cannot be written either, the original error is the one reported', async () => {
    let posts = 0;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/graphql')) return { ok: false, status: 400, headers: new Headers(), text: async () => 'bad request' };
      if (init.method === 'GET') return res([]);
      // The invalidation lands, the read fails, then the failure write is rejected too, as it would be past the status cap.
      posts += 1;
      if (posts === 1) return res({ id: 1 });
      return { ok: false, status: 422, headers: new Headers(), text: async () => 'cap reached' };
    };
    const out = captureStdout();
    try {
      await assert.rejects(() => gate.runWatch(opts()), /GitHub API returned 400/);
    } finally {
      out.restore();
    }
    assert.ok(out.lines.some((line) => /Could not publish a failure either/.test(line)));
  });

  test('a dry run publishes nothing, even on an error', async () => {
    const posted = brokenReads();
    const out = captureStdout();
    try {
      await assert.rejects(() => gate.runWatch(opts({ dryRun: true })), /GitHub API returned 400/);
    } finally {
      out.restore();
    }
    assert.deepStrictEqual(posted, []);
  });

  test('check-run publishing fails closed the same way', async () => {
    const written = [];
    global.fetch = async (url, init) => {
      const target = String(url);
      if (target.endsWith('/graphql')) return { ok: false, status: 400, headers: new Headers(), text: async () => 'bad request' };
      if (init.method === 'GET') return res({ check_runs: [], total_count: 0 });
      written.push({ method: init.method, body: JSON.parse(init.body) });
      return res({ id: 9 });
    };
    const out = captureStdout();
    try {
      await assert.rejects(() => gate.runWatch(opts({ publish: 'check-run' })), /GitHub API returned 400/);
    } finally {
      out.restore();
    }
    const last = written[written.length - 1].body;
    assert.strictEqual(last.status, 'completed');
    assert.strictEqual(last.conclusion, 'failure');
    assert.strictEqual(last.output.title, 'Gate could not compute a verdict');
  });

  test('does not overwrite a successfully written final verdict when subsequent lookup rejects', async () => {
    const written = [];
    let lookupShouldFail = false;
    global.fetch = async (url, init) => {
      const target = String(url);
      if (target.endsWith('/graphql')) {
        return res({
          data: {
            repository: {
              object: {
                checkSuites: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{
                    id: 'S',
                    createdAt: '2026-10-01T00:00:00Z',
                    workflowRun: { databaseId: 1, workflow: { name: 'CI', resourcePath: '/o/r/actions/workflows/ci.yml' } },
                    checkRuns: {
                      totalCount: 1,
                      pageInfo: { hasNextPage: false },
                      nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u', externalId: '', startedAt: '2026-10-01T00:00:00Z' }],
                    },
                  }],
                },
              },
            },
          },
        });
      }
      if (init.method === 'GET') {
        if (lookupShouldFail) {
          return { ok: false, status: 500, headers: new Headers(), text: async () => 'lookup failed' };
        }
        return res({ check_runs: [], total_count: 0 });
      }
      written.push({ method: init.method, body: JSON.parse(init.body) });
      lookupShouldFail = true;
      return res({});
    };
    const out = captureStdout();
    try {
      await assert.rejects(() => gate.runWatch(opts({ publish: 'check-run' })), /lookup failed/);
    } finally {
      out.restore();
    }
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].body.conclusion, 'success');
  });

  test('the failure verdicts name the error and stay inside a status description', () => {
    const status = gate.errorStatus('gate', 'x'.repeat(500));
    assert.strictEqual(status.state, 'failure');
    assert.ok(status.description.length <= 140);
    const checkRun = gate.errorCheckRun('gate', 'boom `injected`');
    assert.match(checkRun.summary, /boom injected/, 'backticks stripped, since a name or message is untrusted text');
  });
});

describe('a gate does not conclude "never started" before CI has registered', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const suite = (createdAt, file, runs) => ({
    id: `S_${file}`, createdAt,
    workflowRun: { databaseId: 1, workflow: { name: file, resourcePath: `/o/r/actions/workflows/${file}` } },
    checkRuns: { totalCount: runs.length, pageInfo: { hasNextPage: false }, nodes: runs },
  });
  const run = (name) => ({
    name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u', externalId: '', startedAt: '2026-08-10T11:00:00Z',
  });

  const opts = (over) => watchOpts({ waitFor: [{ workflowFile: 'e2e.yml' }], ...over });

  const stub = (suitesFor) => {
    const posted = [];
    let reads = 0;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/graphql')) {
        reads += 1;
        return res({ data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: suitesFor(reads) } } } } });
      }
      if (init.method === 'GET') return res([]);
      posted.push(JSON.parse(init.body));
      return res({ id: 1 });
    };
    return { posted, reads: () => reads };
  };

  test('zero suites on the first read, CI registers on the third: no red in between', async () => {
    // The loop used to break on a null deadline, and the code after it turned the pending rule into a red "never started" seconds after the push.
    const s = stub((reads) =>
      reads < 3 ? [] : [suite(FUTURE, 'ci.yml', [run('unit')]), suite(FUTURE, 'e2e.yml', [run('e2e')])]);
    const out = captureStdout();
    try {
      await gate.runWatch(opts());
    } finally {
      out.restore();
    }
    assert.ok(s.reads() >= 3, 'kept reading until CI registered');
    assert.ok(!s.posted.some((row) => row.state === 'failure'), 'never published a failure');
    assert.strictEqual(s.posted[s.posted.length - 1].state, 'success');
  });

  test('if nothing ever registers, it fails after the poll budget and says so', async () => {
    const s = stub(() => []);
    const out = captureStdout();
    try {
      await gate.runWatch(opts({ attemptLimits: 3 }));
    } finally {
      out.restore();
    }
    assert.strictEqual(s.reads(), 3, 'bounded by attempt-limits');
    const last = s.posted[s.posted.length - 1];
    assert.strictEqual(last.state, 'failure');
    assert.match(last.description, /never started/);
    assert.match(last.description, /no check suite registered/);
  });
});

describe('the verdict names the check suites it cannot see', () => {
  test('droppedReporter keeps each name once', () => {
    const logs = captureStdout();
    let reporter;
    try {
      reporter = gate.droppedReporter();
      reporter(['Vercel – admin']);
      reporter(['Vercel – admin']);
      reporter(['GitGuardian Security Checks']);
    } finally {
      logs.restore();
    }
    assert.deepStrictEqual(reporter.excluded, ['Vercel – admin', 'GitGuardian Security Checks']);
  });

  const passed = { done: true, ok: true, pending: [], bad: [] };

  test('a green verdict says what it did not check', () => {
    const verdict = gate.verdictCheckRun(passed, { name: 'gate', totalWatched: 3, excluded: ['Vercel: Vercel – admin'] });
    assert.match(verdict.summary, /Not part of this verdict/);
    assert.match(verdict.summary, /Vercel: Vercel – admin/);
    assert.match(verdict.summary, /commit status/);
  });

  test('red and pending verdicts carry it too', () => {
    const bad = { done: true, ok: false, pending: [], bad: [{ name: 'unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }] };
    assert.match(gate.verdictCheckRun(bad, { name: 'gate', totalWatched: 1, excluded: ['GitGuardian'] }).summary, /GitGuardian/);
    const running = { done: false, ok: true, pending: [{ name: 'unit', workflowName: 'CI', status: 'IN_PROGRESS' }], bad: [] };
    assert.match(gate.verdictCheckRun(running, { name: 'gate', totalWatched: 1, excluded: ['GitGuardian'] }).summary, /GitGuardian/);
  });

  test('nothing is added when nothing was excluded', () => {
    const verdict = gate.verdictCheckRun(passed, { name: 'gate', totalWatched: 3 });
    assert.doesNotMatch(verdict.summary, /Not part of this verdict/);
    assert.strictEqual(gate.excludedNote([]), '');
  });

  test('the status form keeps its 140 character description and carries the note in the summary', () => {
    const verdict = gate.verdictStatus(passed, { context: 'gate', totalWatched: 3, excluded: ['Vercel'] });
    assert.ok(verdict.description.length <= 140);
    assert.match(verdict.summary, /Vercel/);
  });
});

describe('findOwnedCheckRun reads past the first page', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const foreign = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, external_id: 'other', app: { slug: 'x' } }));

  test('finds the owned check run when it sits on page two', async () => {
    // 100 same-named runs from other writers push ours off page one, and a lookup that stops there creates a second check run.
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      const page = Number(/[?&]page=(\d+)/.exec(String(url))[1]);
      return res({
        total_count: 101,
        check_runs: page === 1 ? foreign(100) : [{ id: 7, external_id: gate.externalIdFor('gate'), started_at: '2026-10-01T00:00:00Z' }],
      });
    };
    const found = await gate.findOwnedCheckRun(ctx, 'gate');
    assert.strictEqual(found.id, 7);
    assert.strictEqual(urls.length, 2);
  });

  test('stops after a short page rather than asking for more', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return res({ total_count: 3, check_runs: foreign(3) });
    };
    await assert.rejects(() => gate.findOwnedCheckRun(ctx, 'gate'), /created by something else/);
    assert.strictEqual(calls, 1);
  });

  test('is bounded when the API never reports a last page', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return res({ check_runs: foreign(100) });
    };
    await assert.rejects(() => gate.findOwnedCheckRun(ctx, 'gate'), /created by something else/);
    assert.strictEqual(calls, 10);
  });
});

describe('the status cap warning', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const rows = (n, context) => Array.from({ length: n }, () => ({ context, state: 'success' }));

  /** Serves a commit carrying `ours` rows of `gate` and `others` rows of another context. */
  const commitWith = (ours, others) => {
    const all = [...rows(ours, 'gate'), ...rows(others, 'ci/other')];
    global.fetch = async (url) => {
      const page = Number(/[?&]page=(\d+)/.exec(String(url))[1]);
      return res(all.slice((page - 1) * 100, page * 100));
    };
  };

  test('counts only this context across pages', async () => {
    commitWith(250, 40);
    assert.strictEqual(await gate.countContextStatuses(ctx, 'gate'), 250);
  });

  test('stays quiet on an ordinary pull request', async () => {
    commitWith(60, 10);
    const out = captureStdout();
    try {
      await gate.warnNearStatusCap(ctx, 'gate');
    } finally {
      out.restore();
    }
    assert.deepStrictEqual(out.lines.filter((line) => line.startsWith('::warning::')), []);
  });

  test('warns before the commit reaches 1000 rows, and says what to do', async () => {
    commitWith(820, 5);
    const out = captureStdout();
    try {
      await gate.warnNearStatusCap(ctx, 'gate');
    } finally {
      out.restore();
    }
    const warning = out.lines.find((line) => line.startsWith('::warning::'));
    assert.match(warning, /820 of 1000/);
    assert.match(warning, /push a new commit/);
  });

  test('a failed read never fails the gate', async () => {
    global.fetch = async () => ({ ok: false, status: 403, headers: new Headers(), text: async () => 'forbidden' });
    assert.strictEqual(await gate.warnNearStatusCap(ctx, 'gate'), null);
  });
});
