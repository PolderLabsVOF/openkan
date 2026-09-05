// Regression tests for project selector agent-activity scanning.
//
// Bug: `projectActivity()` only tracked top-level files plus the bare
// `.ok/tasks`, `.ok/plans`, `.ok/prds` directories. Directory mtimes lie
// on ext4/APFS/btrfs, so adding `.ok/tasks/tsk-NEW.json` did NOT bump
// the project up in the recency sort. The selector also ignored
// `.ok/index.json`, `.ok/config.json`, and `.ok/locks/` — the canonical
// signals for "the OK CLI just did work here".
//
// These tests pin the fix and document the original bug for posterity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProject, listProjects, setRegistryPathForTesting, saveRegistry } from '../kanban/projects.ts';

/** Touch a path to an explicit mtime so tests don't depend on real time. */
function touch(path: string, mtime: Date): void {
  utimesSync(path, mtime, mtime);
}

/**
 * Set up two projects A (older) and B (younger) sharing a single registry.
 * A has only a `lastOpenedAt` of 2020; B's `.ok/board.json` carries a
 * 2024 mtime so B ranks ahead of A by default. The tests then nudge A's
 * mtime forward via the activity surface under test and assert A moves
 * to the top of the list — except the regression-guard test, which
 * deliberately nudges only the directory mtime and asserts A stays put.
 */
function setupTwoProjects(): { dir: string; a: string; b: string; firstId: string; secondId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'openkan-agent-activity-'));
  setRegistryPathForTesting(join(dir, 'projects.json'));
  const a = join(dir, 'a', 'app');
  const b = join(dir, 'b', 'app');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  mkdirSync(join(b, '.ok'));
  writeFileSync(join(b, '.ok', 'board.json'), '{}');
  const recent = new Date('2024-01-01T00:00:00Z');
  touch(join(b, '.ok', 'board.json'), recent);
  const first = addProject({ name: 'First', root: a });
  const second = addProject({ name: 'Second', root: b });
  // Reset both projects to fixed, known timestamps so tests don't depend
  // on the wall clock. A's lastOpenedAt is 2020; B is anchored by its
  // board.json mtime of 2024.
  saveRegistry({
    projects: [
      { ...first, active: false, addedAt: '2020-01-01T00:00:00Z', lastOpenedAt: '2020-01-01T00:00:00Z' },
      { ...second, active: true,  addedAt: '2020-01-01T00:00:00Z', lastOpenedAt: '2020-01-01T00:00:00Z' },
    ],
  });
  return { dir, a, b, firstId: first.id, secondId: second.id };
}

test('writing a new task file under .ok/tasks bumps project activity', () => {
  const ctx = setupTwoProjects();
  try {
    mkdirSync(join(ctx.a, '.ok', 'tasks'), { recursive: true });
    const old = new Date('2020-01-01T00:00:00Z');
    const fresh = new Date('2024-06-01T00:00:00Z');
    // Write a brand-new task file with a fresh mtime. This is exactly what
    // `ok task add` does — and the original bug missed it.
    const taskPath = join(ctx.a, '.ok', 'tasks', 'tsk-NEW.json');
    writeFileSync(taskPath, '{"id":"tsk-NEW"}');
    touch(taskPath, fresh);
    touch(join(ctx.a, '.ok', 'tasks'), old); // deliberately stale directory mtime
    const projects = listProjects();
    assert.equal(projects[0].id, ctx.firstId, 'A should rank first after a new task file lands');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('bumping .ok/index.json mtime bumps project activity', () => {
  const ctx = setupTwoProjects();
  try {
    const fresh = new Date('2024-06-01T00:00:00Z');
    mkdirSync(join(ctx.a, '.ok'), { recursive: true });
    const indexPath = join(ctx.a, '.ok', 'index.json');
    writeFileSync(indexPath, '{"schema":"ok.index.v1","tasks":[],"plans":[],"prds":[],"updatedAt":"2024-06-01T00:00:00Z"}');
    touch(indexPath, fresh);
    const projects = listProjects();
    assert.equal(projects[0].id, ctx.firstId, 'A should rank first after .ok/index.json is refreshed');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('appending to a session jsonl bumps project activity', () => {
  const ctx = setupTwoProjects();
  try {
    const fresh = new Date('2024-06-01T00:00:00Z');
    mkdirSync(join(ctx.a, '.ok', 'sessions'), { recursive: true });
    const sessionPath = join(ctx.a, '.ok', 'sessions', 'ses-abc.jsonl');
    writeFileSync(sessionPath, '{"role":"user","content":"hi"}\n');
    touch(sessionPath, fresh);
    const projects = listProjects();
    assert.equal(projects[0].id, ctx.firstId, 'A should rank first after a session append');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('in-place directory mtime alone does NOT bump activity (regression guard)', () => {
  // This pins the original bug: changing only the directory mtime of
  // `.ok/tasks` — without writing or touching any file inside — must not
  // move the project up. If this test ever flips, the scanner has
  // regressed to its old unreliable behavior.
  const ctx = setupTwoProjects();
  try {
    mkdirSync(join(ctx.a, '.ok', 'tasks'), { recursive: true });
    const fakeFresh = new Date('2099-01-01T00:00:00Z');
    // Touch only the directory itself; leave its contents untouched.
    touch(join(ctx.a, '.ok', 'tasks'), fakeFresh);
    const projects = listProjects();
    assert.notEqual(projects[0].id, ctx.firstId, 'A must NOT move up from a bare directory mtime');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('writing a new plan file under .ok/plans bumps project activity', () => {
  const ctx = setupTwoProjects();
  try {
    const fresh = new Date('2024-06-01T00:00:00Z');
    mkdirSync(join(ctx.a, '.ok', 'plans'), { recursive: true });
    const planPath = join(ctx.a, '.ok', 'plans', 'pln-NEW.json');
    writeFileSync(planPath, '{"id":"pln-NEW"}');
    touch(planPath, fresh);
    const projects = listProjects();
    assert.equal(projects[0].id, ctx.firstId, 'A should rank first after a new plan file lands');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('writing a new PRD file under .ok/prds bumps project activity', () => {
  const ctx = setupTwoProjects();
  try {
    const fresh = new Date('2024-06-01T00:00:00Z');
    mkdirSync(join(ctx.a, '.ok', 'prds'), { recursive: true });
    const prdPath = join(ctx.a, '.ok', 'prds', 'prd-NEW.json');
    writeFileSync(prdPath, '{"id":"prd-NEW"}');
    touch(prdPath, fresh);
    const projects = listProjects();
    assert.equal(projects[0].id, ctx.firstId, 'A should rank first after a new PRD file lands');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('legacy nested task artifacts under .ok/tasks/<id>/task.mdx still count', () => {
  // Older kanban layouts stored task transcripts under per-task subdirs.
  // The recursive scan must pick those up too, not just flat .json files.
  const ctx = setupTwoProjects();
  try {
    const fresh = new Date('2024-06-01T00:00:00Z');
    const nestedDir = join(ctx.a, '.ok', 'tasks', 'tsk-NESTED');
    mkdirSync(nestedDir, { recursive: true });
    const nestedFile = join(nestedDir, 'task.mdx');
    writeFileSync(nestedFile, '# stub');
    touch(nestedFile, fresh);
    const projects = listProjects();
    assert.equal(projects[0].id, ctx.firstId, 'A should rank first after a nested task artifact is touched');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('existing recency signal via .ok/board.json still wins when no agent activity is present', () => {
  // The original `.ok/board.json` signal must keep working alongside the
  // new agent-activity sources. This is the same scenario the legacy
  // `project-recency.test.mts` covered, repeated here to prove we did
  // not regress the pre-existing surface.
  const ctx = setupTwoProjects();
  try {
    const fresh = new Date('2024-06-01T00:00:00Z');
    mkdirSync(join(ctx.a, '.ok'), { recursive: true });
    const boardPath = join(ctx.a, '.ok', 'board.json');
    writeFileSync(boardPath, '{}');
    touch(boardPath, fresh);
    const projects = listProjects();
    assert.equal(projects[0].id, ctx.firstId, 'A should rank first via .ok/board.json');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('activity scan picks up multiple nested files in one pass', () => {
  // Soft guard for the recursive implementation: drop ten files across
  // the entity directories and confirm they all contribute to the
  // activity score (i.e. the soft cap does not kick in prematurely).
  const ctx = setupTwoProjects();
  try {
    const fresh = new Date('2024-06-01T00:00:00Z');
    mkdirSync(join(ctx.a, '.ok', 'tasks'), { recursive: true });
    mkdirSync(join(ctx.a, '.ok', 'plans'), { recursive: true });
    mkdirSync(join(ctx.a, '.ok', 'prds'), { recursive: true });
    for (let i = 0; i < 4; i++) {
      const p = join(ctx.a, '.ok', 'tasks', `tsk-${i}.json`);
      writeFileSync(p, '{}');
      touch(p, fresh);
    }
    for (let i = 0; i < 3; i++) {
      const p = join(ctx.a, '.ok', 'plans', `pln-${i}.json`);
      writeFileSync(p, '{}');
      touch(p, fresh);
    }
    for (let i = 0; i < 3; i++) {
      const p = join(ctx.a, '.ok', 'prds', `prd-${i}.json`);
      writeFileSync(p, '{}');
      touch(p, fresh);
    }
    const projects = listProjects();
    assert.equal(projects[0].id, ctx.firstId, 'A should rank first when 10 nested files are present');
  } finally { setRegistryPathForTesting(null); rmSync(ctx.dir, { recursive: true, force: true }); }
});
