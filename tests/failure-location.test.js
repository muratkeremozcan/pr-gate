/**
 * Tests for the links from a failed verdict to where each job failed.
 *
 * The log fixture keeps the shape of a sharded Jest job where one test failed: the
 * previous step ends in the second the Test step starts, the step's group closes
 * with ##[endgroup], and Jest prints the failing file before the runner's own error.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const gate = require('../main.js');

const LOG = [
  '2026-10-23T13:40:25.8128243Z ##[group]Run # Wait for PostgreSQL',
  '2026-10-23T13:40:25.9154776Z ##[endgroup]',
  '2026-10-23T13:40:26.1000000Z localhost:5432 - accepting connections',
  '2026-10-23T13:40:26.8892268Z ##[group]Run cd server',
  '2026-10-23T13:40:26.8893000Z \u001b[36;1mcd server\u001b[0m',
  '2026-10-23T13:40:26.9869030Z ##[endgroup]',
  '2026-10-23T13:40:27.1144236Z ',
  '2026-10-23T13:41:01.0000000Z PASS src/__tests__/users/getUsers.test.ts',
  '2026-10-23T13:41:06.2938570Z FAIL src/__tests__/proposals/getProposals.test.ts (25.796 s)',
  '2026-10-23T13:41:06.2969004Z   ● Get proposals › general › single change type filter should work',
  '2026-10-23T13:47:48.9791562Z ##[error]Process completed with exit code 1.',
  '2026-10-23T13:47:48.9899643Z ##[group]Run actions/upload-artifact@v4',
].join('\n');

const SEED = { number: 9, name: 'Seed databases', started_at: '2026-10-23T13:40:25Z', completed_at: '2026-10-23T13:40:26Z', conclusion: 'success' };
const TEST = { number: 10, name: 'Test', started_at: '2026-10-23T13:40:26Z', completed_at: '2026-10-23T13:47:48Z', conclusion: 'failure' };

describe('locateFailureLine', () => {
  test('finds the Jest FAIL line and numbers it from the step header, without ##[endgroup]', () => {
    assert.deepStrictEqual(gate.locateFailureLine(LOG, TEST, SEED), {
      line: 5,
      text: 'FAIL src/__tests__/proposals/getProposals.test.ts (25.796 s)',
    });
  });

  test('falls back to the runner error when no test marker is present', () => {
    const plain = LOG.split('\n').filter((l) => !/FAIL|●/.test(l)).join('\n');
    assert.deepStrictEqual(gate.locateFailureLine(plain, TEST, SEED), { line: 5, text: 'Process completed with exit code 1.' });
  });

  test('returns null without timing or a failure line', () => {
    assert.strictEqual(gate.locateFailureLine(LOG, { ...TEST, started_at: null }, SEED), null);
    assert.strictEqual(gate.locateFailureLine('2026-10-23T13:40:26.0Z ##[group]Run x\n2026-10-23T13:40:27.0Z ok', TEST, null), null);
  });
});

const JOB_URL = 'https://github.com/o/r/actions/runs/1/job/100';
const failedEntry = () => ({
  name: 'test (1)',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  workflowName: 'Check PR',
  url: JOB_URL,
});
const CTX = { apiUrl: 'https://api.github.com', token: 't', owner: 'o', repo: 'r', retryLimit: 0, baseDelayMs: 1 };

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('locateFailures', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('links the failed step and log line, and keeps the token off the storage host', async () => {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url, headers: options.headers || {} });
      if (url.endsWith('/actions/jobs/100')) return response(200, { status: 'completed', steps: [SEED, TEST] });
      if (url.endsWith('/actions/jobs/100/logs')) return response(302, '', { location: 'https://storage.example/log?sig=1' });
      if (url.startsWith('https://storage.example/')) return response(200, LOG);
      return response(404, {});
    };
    const [entry] = await gate.locateFailures(CTX, [failedEntry()]);
    assert.deepStrictEqual(entry.failure, {
      step: 'Test',
      line: 5,
      text: 'FAIL src/__tests__/proposals/getProposals.test.ts (25.796 s)',
      url: `${JOB_URL}#step:10:5`,
    });
    assert.strictEqual(calls.find((c) => c.url.startsWith('https://storage.example/')).headers.authorization, undefined);
  });

  test('links the failed step when its log cannot be read', async () => {
    global.fetch = async (url) => {
      if (url.endsWith('/actions/jobs/100')) return response(200, { status: 'completed', steps: [SEED, TEST] });
      return response(410, '');
    };
    const [entry] = await gate.locateFailures(CTX, [failedEntry()]);
    assert.strictEqual(entry.failure.url, `${JOB_URL}#step:10:1`);
    assert.strictEqual(entry.failure.line, null);
  });

  test('leaves the entry plain when the jobs API refuses, and skips placeholders and non-Actions links', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return response(403, { message: 'Resource not accessible by integration' });
    };
    const entries = await gate.locateFailures(CTX, [
      failedEntry(),
      { ...failedEntry(), placeholder: true },
      { ...failedEntry(), url: 'https://ci.example/build/1' },
    ]);
    assert.ok(entries.every((e) => e.failure === undefined));
    assert.strictEqual(calls, 1);
  });
});

describe('failed verdict summary', () => {
  test('links where each located job failed and leaves the others plain', () => {
    const located = {
      ...failedEntry(),
      failure: { step: 'Test', line: 5, text: 'FAIL src/a.test.ts', url: `${JOB_URL}#step:10:5` },
    };
    const plain = { ...failedEntry(), name: 'lint' };
    const verdict = gate.verdictCheckRun({ done: true, ok: false, pending: [], bad: [located, plain] }, { name: 'gate', totalWatched: 4 });
    assert.strictEqual(
      verdict.summary,
      [
        'Failed:',
        `- \`Check PR / test (1): failure\` failed in [Test, line 5](${JOB_URL}#step:10:5): \`FAIL src/a.test.ts\``,
        '- `Check PR / lint: failure`',
      ].join('\n')
    );
  });

  test('strips markup from PR-authored step names and failure text', () => {
    const entry = {
      ...failedEntry(),
      failure: { step: 'x](javascript:alert(1)) [y', line: 2, text: 'FAIL `a`', url: `${JOB_URL}#step:3:2` },
    };
    const summary = gate.failedList('Failed:', [entry]);
    assert.ok(summary.includes('[x(javascript:alert(1)) y, line 2]'), summary);
    assert.ok(summary.includes('`FAIL a`'), summary);
  });
});

describe('locateFailures limits', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('reads at most the log cap from a streamed body and cancels the rest', async () => {
    let cancelled = false;
    let reads = 0;
    const chunk = new Uint8Array(8 * 1024 * 1024).fill(65);
    global.fetch = async (url) => {
      if (url.endsWith('/actions/jobs/100')) return response(200, { status: 'completed', steps: [SEED, TEST] });
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              reads += 1;
              return { done: false, value: chunk };
            },
            cancel: async () => {
              cancelled = true;
            },
          }),
        },
      };
    };
    const [entry] = await gate.locateFailures(CTX, [failedEntry()]);
    assert.ok(cancelled, 'stream cancelled at the cap');
    assert.strictEqual(reads, 3, 'three 8 MiB chunks reach the 20 MiB cap');
    assert.strictEqual(entry.failure.line, null);
  });

  test('stops once the time budget is used up', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return response(200, { status: 'completed', steps: [SEED, TEST] });
    };
    const entries = await gate.locateFailures(CTX, [failedEntry(), failedEntry()], 0);
    assert.strictEqual(calls, 0);
    assert.ok(entries.every((e) => e.failure === undefined));
  });
});

describe('step window edges', () => {
  test('a failure line logged by the previous step in the shared second is not taken', () => {
    const log = LOG.replace(
      '2026-10-23T13:40:26.1000000Z localhost:5432 - accepting connections',
      '2026-10-23T13:40:26.1000000Z FAIL seed/check.test.ts',
    );
    assert.strictEqual(gate.locateFailureLine(log, TEST, SEED).text, 'FAIL src/__tests__/proposals/getProposals.test.ts (25.796 s)');
  });

  test('the next step, starting in the completion second, closes the window', () => {
    const log = LOG.split('\n')
      .filter((l) => !/FAIL|●/.test(l))
      .concat('2026-10-23T13:47:48.9950000Z FAIL upload/never.test.ts')
      .join('\n');
    assert.strictEqual(gate.locateFailureLine(log, TEST, SEED).text, 'Process completed with exit code 1.');
  });
});

describe('locateFailures time budget', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('locates what fits in the budget and leaves the rest plain', async () => {
    const delayMs = 60;
    const jobIds = new Set();
    // Honours the abort signal the way fetch does, so the budget can cut a slow request short.
    global.fetch = async (url, options = {}) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      const id = /\/actions\/jobs\/(\d+)$/.exec(url)?.[1];
      if (id) {
        jobIds.add(id);
        return response(200, { status: 'in_progress', steps: [SEED, TEST] });
      }
      return response(404, '');
    };
    const entries = Array.from({ length: 6 }, (_, i) => ({ ...failedEntry(), url: `https://github.com/o/r/actions/runs/1/job/${100 + i}` }));
    await gate.locateFailures(CTX, entries, delayMs + 30);
    assert.deepStrictEqual(entries.map((e) => Boolean(e.failure)), [true, false, false, false, false, false]);
    assert.ok(jobIds.size <= 5);
  });
});
