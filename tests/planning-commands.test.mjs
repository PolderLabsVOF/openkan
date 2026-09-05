import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/openkan.ts', import.meta.url));
function run(cwd, ...args) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('command-only planning lifecycle works offline and from a nested directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkan-planning-'));
  try {
    run(root, 'init');
    const prd = run(root, 'prd', 'add', 'Ship', '--vision', 'Installable package');
    const goal = JSON.parse(run(root, 'goal', 'add', prd, 'Publish package', '--json'));
    assert.equal(goal.id, 'g1');
    const id = run(root, 'task', 'add', 'Verify install', '--prd', prd, '--owner', 'tester');
    const child = join(root, 'nested'); mkdirSync(child);
    run(child, 'task', 'claim', id, '--owner', 'tester');
    assert.equal(existsSync(join(child, '.ok')), false);
    run(child, 'task', 'complete', id, '--owner', 'tester', '--evidence', 'tarball smoke passed');
    run(root, 'goal', 'update', prd, goal.id, '--status', 'met', '--json');
    const progress = JSON.parse(run(child, 'progress', '--json'));
    assert.equal(progress.tasks.done, 1);
    assert.equal(progress.goals.met, 1);
    assert.equal(progress.tasks.percentComplete, 100);
    const tasks = JSON.parse(run(root, 'task', 'list', '--json'));
    assert.equal(tasks[0].status, 'done');
    const bad = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'goal', 'update', prd, 'missing', '--status', 'met'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /no such goal/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('help and skill installation do not create a workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkan-help-'));
  try {
    assert.match(run(root, '--help'), /goal/);
    // The CLI requires the --target dir to already exist (typo guard); create
    // it before invoking so this test exercises the install path. Pass
    // --force so the existence check on the freshly-created target passes.
    mkdirSync(join(root, 'skill'), { recursive: true });
    run(root, 'skill', 'install', '--target', join(root, 'skill'), '--force');
    assert.ok(existsSync(join(root, 'skill', 'SKILL.md')));
    assert.equal(existsSync(join(root, '.ok')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('progress filters PRDs and excludes cancelled tasks and dropped goals from completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkan-rollup-'));
  try {
    run(root, 'init');
    const prd = run(root, 'prd', 'add', 'Release', '--vision', 'Portable');
    const plan = run(root, 'plan', 'add', 'Validate', '--prd', prd);
    const task = run(root, 'task', 'add', 'Complete', '--plan', plan, '--owner', 'test');
    run(root, 'task', 'complete', task, '--owner', 'test', '--evidence', 'passed');
    const cancelled = run(root, 'task', 'add', 'Excluded', '--prd', prd, '--owner', 'test');
    run(root, 'task', 'cancel', cancelled, '--owner', 'test', '--reason', 'out of scope');
    run(root, 'task', 'add', 'Unrelated');
    run(root, 'goal', 'add', prd, 'Met');
    run(root, 'goal', 'add', prd, 'Dropped');
    run(root, 'goal', 'update', prd, 'g1', '--status', 'met');
    run(root, 'goal', 'update', prd, 'g2', '--status', 'dropped');
    const report = JSON.parse(run(root, 'progress', '--prd', prd, '--json'));
    assert.equal(report.tasks.total, 2);
    assert.equal(report.tasks.percentComplete, 100);
    assert.equal(report.goals.percentComplete, 100);
    assert.equal(report.plans.total, 1);
    assert.equal(existsSync(join(root, '.openkan')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('board command refuses a different active project without sending a mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkan-project-guard-'));
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ active: { root: join(root, 'other-project') } }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await assert.rejects(promisify(execFile)(process.execPath, ['--experimental-strip-types', cli, 'board', 'add', 'Do not create', '--port', String(server.address().port)], { cwd: root }), /Dashboard is on/);
    assert.deepEqual(methods, ['GET']);
    assert.equal(existsSync(join(root, '.ok')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
