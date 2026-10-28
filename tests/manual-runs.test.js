'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const gate = require('../main.js');
const main = path.resolve(__dirname, '../main.js');
const OLD = '2026-10-28T05:18:13Z';
const NEW = '2026-10-28T08:55:27Z';
// This manual suite would postpone wait-for expiry for decades if it entered the deadline calculation.
const FUTURE_MANUAL_RUN = '2099-01-01T00:00:00Z';

function suite(id, event, conclusion, { file = 'ci.yml', createdAt = OLD, status = 'COMPLETED' } = {}) {
  return {
    id: `S${id}`,
    createdAt,
    workflowRun: { databaseId: id, event, workflow: { name: file, resourcePath: `/o/r/actions/workflows/${file}` } },
    checkRuns: {
      totalCount: 1,
      pageInfo: { hasNextPage: false },
      nodes: [{ name: 'test', status, conclusion, detailsUrl: `https://github.com/o/r/actions/runs/${id}`, startedAt: createdAt }],
    },
  };
}

/** Runs the action entry point against a local GitHub API, including real verdict writes. */
async function runGate(t, { suites, trigger, action = 'completed', mode = 'watch', inputs = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-manual-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const event = trigger
    ? { action, workflow_run: { id: trigger.id, event: trigger.event, run_attempt: trigger.attempt || 1, name: trigger.file || 'ci.yml', path: `.github/workflows/${trigger.file || 'ci.yml'}`, head_sha: 'pr-head', run_started_at: NEW, conclusion: trigger.conclusion || 'failure' } }
    : { pull_request: { head: { sha: 'pr-head', ref: 'feature' } } };
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(event));
  const writes = [];
  const queries = [];
  const unexpected = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/graphql') {
      queries.push(body.query);
      res.end(JSON.stringify({ data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: false }, nodes: suites } } } } }));
    } else if (req.method === 'POST' && req.url === '/repos/o/r/statuses/pr-head') {
      writes.push(body);
      res.end(JSON.stringify({ id: writes.length }));
    } else if (req.method === 'GET' && req.url.startsWith('/repos/o/r/commits/pr-head/statuses?')) {
      res.end('[]');
    } else {
      unexpected.push(`${req.method} ${req.url}`);
      res.writeHead(404).end('{}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_EVENT_NAME: trigger ? 'workflow_run' : 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/pr-gate.yml@refs/heads/master',
    GITHUB_RUN_ID: '900',
    GITHUB_SHA: 'default-branch-tip',
    GITHUB_OUTPUT: path.join(dir, 'output'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    INPUT_MODE: mode,
    INPUT_PUBLISH: 'status',
    'INPUT_GITHUB-TOKEN': 'test-token',
    'INPUT_GITHUB-API-URL': `http://127.0.0.1:${server.address().port}`,
    'INPUT_WARMUP-DELAY': '0',
    'INPUT_MINIMUM-INTERVAL': '0',
    'INPUT_ATTEMPT-LIMITS': '1',
    'INPUT_API-RETRY-LIMIT': '0',
    'INPUT_SKIP-SAME-WORKFLOW': 'true',
    'INPUT_EARLY-EXIT': 'true',
    ...inputs,
  };
  const child = spawn(process.execPath, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.deepEqual(unexpected, [], output);
  if (mode === 'watch') assert.equal(code, 0, output);
  return { code, output, writes, queries };
}

describe('manual runs through the action entry point', () => {
  for (const mode of ['watch', 'wait']) {
    test(`${mode}: a failed manual workflow does not fail passing PR CI`, { timeout: 10000 }, async (t) => {
      const result = await runGate(t, {
        mode,
        suites: [suite(1, 'pull_request', 'SUCCESS'), suite(2, 'workflow_dispatch', 'FAILURE', { file: 'manual.yml', createdAt: NEW })],
        trigger: { id: 2, event: 'workflow_dispatch', file: 'manual.yml' },
      });
      assert.equal(result.code, 0, result.output);
      if (mode === 'watch') assert.equal(result.writes.at(-1).state, 'success', result.output);
      else assert.match(result.output, /All watched jobs passed/);
      assert.match(result.output, /Ignoring.*workflow_dispatch/);
      assert.match(result.queries[0], /workflowRun\s*\{[^}]*\bevent\b/);
    });

    test(`${mode}: a newer passing manual run cannot replace failed CI in the same workflow`, { timeout: 10000 }, async (t) => {
      const result = await runGate(t, {
        mode,
        suites: [suite(1, 'pull_request', 'FAILURE'), suite(2, 'workflow_dispatch', 'SUCCESS', { createdAt: NEW })],
        trigger: { id: 2, event: 'workflow_dispatch', conclusion: 'success' },
      });
      if (mode === 'watch') assert.equal(result.writes.at(-1).state, 'failure', result.output);
      else assert.equal(result.code, 1, result.output);
      assert.match(result.output, /ci.yml \/ test: failure/);
    });
  }

  for (const action of ['requested', 'in_progress', 'completed']) {
    test(`${action}: an invisible manual run cannot inject a pending or failed job`, { timeout: 10000 }, async (t) => {
      const result = await runGate(t, {
        action,
        suites: [suite(1, 'pull_request', 'SUCCESS')],
        trigger: { id: 2, event: 'workflow_dispatch', file: 'manual.yml' },
      });
      assert.equal(result.writes.at(-1).state, 'success', result.output);
    });
  }

  test('a running automatic run stays pending beside a newer passing manual run', { timeout: 10000 }, async (t) => {
    const result = await runGate(t, {
      suites: [suite(1, 'pull_request', null, { status: 'IN_PROGRESS' }), suite(2, 'workflow_dispatch', 'SUCCESS', { createdAt: NEW })],
      trigger: { id: 2, event: 'workflow_dispatch', conclusion: 'success' },
    });
    assert.equal(result.writes.at(-1).state, 'pending', result.output);
    assert.match(result.output, /ci.yml \/ test: in_progress/);
  });

  test('a manual run cannot satisfy wait-for or extend its deadline', { timeout: 10000 }, async (t) => {
    const result = await runGate(t, {
      suites: [suite(1, 'pull_request', 'SUCCESS'), suite(2, 'workflow_dispatch', 'SUCCESS', { file: 'e2e.yml', createdAt: FUTURE_MANUAL_RUN })],
      inputs: { 'INPUT_WAIT-FOR': '[{"workflowFile":"e2e.yml"}]', 'INPUT_WAIT-FOR-TIMEOUT': '1s' },
    });
    assert.equal(result.writes.at(-1).state, 'failure', result.output);
    assert.match(result.writes.at(-1).description, /never started/);
    assert.match(result.output, /wait-for rule.*skip-list or skip-events ignores.*can never see it/);
  });

  test('skip-events can explicitly include manual CI', { timeout: 10000 }, async (t) => {
    const result = await runGate(t, {
      suites: [suite(1, 'pull_request', 'SUCCESS'), suite(2, 'workflow_dispatch', 'FAILURE', { file: 'manual.yml', createdAt: NEW })],
      trigger: { id: 2, event: 'workflow_dispatch', file: 'manual.yml' },
      inputs: { 'INPUT_SKIP-EVENTS': '[]' },
    });
    assert.equal(result.writes.at(-1).state, 'failure', result.output);
  });

  test('re-running automatic CI holds the gate pending while previous checks still show success', { timeout: 10000 }, async (t) => {
    const result = await runGate(t, {
      action: 'in_progress',
      suites: [suite(1, 'pull_request', 'SUCCESS')],
      trigger: { id: 1, event: 'pull_request', attempt: 2 },
    });
    assert.equal(result.writes.at(-1).state, 'pending', result.output);
    assert.match(result.output, /re-running/);
  });

  test('wait-for sees automatic CI when an excluded manual run uses the same workflow', { timeout: 10000 }, async (t) => {
    const result = await runGate(t, {
      suites: [suite(1, 'pull_request', 'SUCCESS'), suite(2, 'workflow_dispatch', 'FAILURE', { createdAt: NEW })],
      inputs: { 'INPUT_WAIT-FOR': '[{"workflowFile":"ci.yml"}]' },
    });
    assert.equal(result.writes.at(-1).state, 'success', result.output);
    assert.doesNotMatch(result.output, /can never see it/);
  });

  test('custom skip-events excludes the selected trigger and keeps PR CI eligible', { timeout: 10000 }, async (t) => {
    const result = await runGate(t, {
      suites: [suite(1, 'pull_request', 'SUCCESS'), suite(2, 'schedule', 'FAILURE', { file: 'nightly.yml', createdAt: NEW })],
      trigger: { id: 2, event: 'schedule', file: 'nightly.yml' },
      inputs: { 'INPUT_SKIP-EVENTS': '["workflow_dispatch","schedule"]' },
    });
    assert.equal(result.writes.at(-1).state, 'success', result.output);
  });

  for (const event of ['pull_request', 'pull_request_target', 'push', 'repository_dispatch', 'workflow_run', 'merge_group', undefined]) {
    test(`failed ${event || 'unknown-event'} CI still blocks the gate`, { timeout: 10000 }, async (t) => {
      const result = await runGate(t, { suites: [suite(1, event, 'FAILURE')] });
      assert.equal(result.writes.at(-1).state, 'failure', result.output);
    });
  }

  for (const mode of ['watch', 'wait']) {
    test(`${mode}: a commit with only excluded manual runs follows the no-other-jobs pass rule`, { timeout: 10000 }, async (t) => {
      const result = await runGate(t, {
        mode,
        suites: [suite(1, 'workflow_dispatch', 'FAILURE'), suite(2, 'workflow_dispatch', null, { file: 'manual.yml', status: 'IN_PROGRESS', createdAt: NEW })],
        trigger: { id: 1, event: 'workflow_dispatch' },
      });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /0 watched check run\(s\) of 2 total/);
      if (mode === 'watch') assert.equal(result.writes.at(-1).state, 'success', result.output);
      else assert.match(result.output, /All watched jobs passed/);
    });
  }

  test('wait mode reports each excluded workflow run once across three polls', { timeout: 10000 }, async (t) => {
    const result = await runGate(t, {
      mode: 'wait',
      suites: [suite(1, 'pull_request', null, { status: 'IN_PROGRESS' }), suite(2, 'workflow_dispatch', 'FAILURE', { file: 'manual.yml', createdAt: NEW })],
      inputs: { 'INPUT_ATTEMPT-LIMITS': '3' },
    });
    assert.equal(result.code, 1, result.output);
    assert.equal(result.queries.length, 3, result.output);
    assert.equal((result.output.match(/Ignoring workflow run 2 /g) || []).length, 1, result.output);
    assert.match(result.output, /gave up after 3 polls with jobs still running/);
  });
});

describe('skip-events input', () => {
  test('defaults to workflow_dispatch and allows an explicit empty array', () => {
    assert.deepEqual(gate.parseSkipEvents(''), ['workflow_dispatch']);
    assert.deepEqual(gate.parseSkipEvents('[]'), []);
    assert.deepEqual(gate.parseSkipEvents('["workflow_dispatch","schedule"]'), ['workflow_dispatch', 'schedule']);
  });

  for (const value of ['workflow_dispatch', '{}', '[null]', '[{}]', '[""]', '[" workflow_dispatch "]']) {
    test(`rejects malformed skip-events: ${value}`, () => {
      assert.throws(() => gate.parseSkipEvents(value), /skip-events/);
    });
  }
});
