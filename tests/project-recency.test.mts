import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProject, listProjects, setActiveProject, setRegistryPathForTesting, saveRegistry } from '../kanban/projects.ts';

test('project selector deduplicates physical roots, preserves distinct same-named repositories and sorts activity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openkan-recency-'));
  setRegistryPathForTesting(join(dir, 'projects.json'));
  try {
    const a = join(dir, 'a', 'app'), b = join(dir, 'b', 'app');
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
    const first = addProject({ name: 'First', root: a });
    const repeated = addProject({ name: 'First', root: `${a}/` });
    assert.equal(repeated.id, first.id);
    assert.equal(listProjects().length, 1);
    const second = addProject({ name: 'Second', root: b });
    assert.notEqual(second.id, first.id);
    const alias = join(dir, 'alias'); symlinkSync(a, alias);
    assert.equal(addProject({ name: 'Alias', root: alias }).id, first.id);
    assert.equal(listProjects().length, 2);
    saveRegistry({ projects: [
      { ...first, active: false, addedAt: '2020-01-01T00:00:00Z', lastOpenedAt: '2021-01-01T00:00:00Z' },
      { ...first, root: alias, active: true, addedAt: '2020-01-01T00:00:00Z', lastOpenedAt: '2022-01-01T00:00:00Z' },
      { ...second, active: false, addedAt: '2020-01-01T00:00:00Z', lastOpenedAt: '2023-01-01T00:00:00Z' },
    ] });
    assert.equal(listProjects().length, 2);
    assert.equal(listProjects()[0].id, second.id);
    mkdirSync(join(a, '.ok'));
    writeFileSync(join(a, '.ok', 'board.json'), '{}');
    const recent = new Date(Date.now() - 1000); utimesSync(join(a, '.ok', 'board.json'), recent, recent);
    assert.equal(listProjects()[0].id, first.id);
    setActiveProject(second.id);
    assert.equal(listProjects()[0].id, second.id);
    assert.ok(listProjects()[0].lastOpenedAt);
    assert.equal(listProjects().filter(p => p.active).length, 1);
  } finally { setRegistryPathForTesting(null); rmSync(dir, { recursive: true, force: true }); }
});
