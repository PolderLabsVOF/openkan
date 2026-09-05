import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const temp = mkdtempSync(join(tmpdir(), 'openkan-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm run can export this npm 12 option; it is invalid for a nested install.
const installEnv = { ...process.env };
delete installEnv.npm_config_allow_scripts;
delete installEnv.NPM_CONFIG_ALLOW_SCRIPTS;
let server;
try {
  execFileSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
  const raw = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
  const pack = Array.isArray(raw) ? raw[0] : raw[packageName];
  assert.ok(pack.files.some(file => file.path === 'dist/bin/openkan.js'));
  assert.ok(pack.files.some(file => file.path === 'dist/web/index.html'));
  assert.ok(pack.files.every(file => !/(^|\/)\.ok\/|(^|\/)\.omx\/|(^|\/)worktrees\/|(^|\/)\.env|\.ts$/.test(file.path)), 'private state and TypeScript must not ship');
  execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, pack.filename)], { cwd: temp, env: installEnv, stdio: 'pipe' });
  const project = join(temp, 'project'); mkdirSync(project);
  const home = join(temp, 'home'); mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const installed = join(temp, 'node_modules', packageName);
  const cli = process.platform === 'win32' ? join(installed, 'bin/openkan.mjs') : join(temp, 'node_modules/.bin/openkan');
  const ok = process.platform === 'win32' ? join(installed, 'bin/ok.mjs') : join(temp, 'node_modules/.bin/ok');
  assert.ok(existsSync(cli), 'npm must link the openkan executable');
  assert.ok(existsSync(ok), 'npm must link the ok executable');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: 'utf8', timeout: 15000 }).trim();
  assert.match(run('--help'), /progress/);
  run('init');
  const id = run('task', 'add', 'Installed task', '--owner', 'tester');
  run('task', 'claim', id, '--owner', 'tester');
  run('task', 'complete', id, '--owner', 'tester', '--evidence', 'pack smoke');
  const prd = run('prd', 'add', 'Installed PRD', '--vision', 'Portable', '--goals', 'Install');
  run('goal', 'update', prd, 'g1', '--status', 'met');
  assert.equal(JSON.parse(run('progress', '--json')).goals.met, 1);
  // skill install --target requires the dir to already exist (typo guard).
  mkdirSync(join(home, 'skill'), { recursive: true });
  run('skill', 'install', '--target', join(home, 'skill'), '--force');
  assert.ok(existsSync(join(home, 'skill/SKILL.md')));
  assert.match(execFileSync(process.execPath, [ok, 'task', 'list', '--json'], { cwd: project, env, encoding: 'utf8' }), /Installed task/);

  // Use an isolated home and OS-assigned port; never change the user's registry.
  server = spawn(process.execPath, [join(installed, 'dist/bin/openkan.js'), 'start', '--port', '0', '--foreground', '--no-open', '--no-auto-detect', '--project', project], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', data => { log += data; });
  server.stderr.on('data', data => { log += data; });
  let url;
  for (let i = 0; i < 100; i++) {
    url = log.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0];
    if (url) break;
    if (server.exitCode !== null) throw new Error(`Installed server exited: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(url, `Server did not start: ${log}`);
  for (const path of ['/', '/app.js', '/style.css', '/vendor/gsap.min.js', '/api/board']) {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0, path);
  }
  const port = new URL(url).port;
  const card = JSON.parse(run('board', 'add', 'Installed board task', '--column', 'doing', '--port', port));
  assert.ok(card.id);
  run('board', 'comment', card.id, 'Install verified', '--port', port);
  run('board', 'move', card.id, 'done', '--port', port);
  assert.equal(JSON.parse(run('board', 'show', card.id, '--port', port)).task.column, 'done');
  console.log(`Package smoke passed: ${pack.id}, ${pack.files.length} files, ${pack.size} bytes; installed commands, skills and web server verified.`);
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  }
  rmSync(temp, { recursive: true, force: true });
}
