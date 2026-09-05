import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installAgent } from '../bin/install-agent.mjs';

test('agent installer installs Claude profile and skill, is idempotent and preserves local edits', () => {
  const home = mkdtempSync(join(tmpdir(), 'openkan-install-agent-'));
  const configDir = join(home, '.claude');
  try {
    const options = { configDir, packageRoot: resolve('.') };
    const first = installAgent(options);
    const profile = join(configDir, 'agents/openkan.md');
    assert.ok(first.installed.includes('agents/openkan.md'));
    assert.match(readFileSync(profile, 'utf8'), /name: openkan/);
    assert.ok(existsSync(join(configDir, 'skills/openkan/SKILL.md')));
    assert.equal(installAgent(options).installed.length, 0);
    writeFileSync(profile, 'My custom agent');
    assert.ok(installAgent(options).preserved.includes('agents/openkan.md'));
    assert.equal(readFileSync(profile, 'utf8'), 'My custom agent');
    assert.ok(installAgent({ ...options, force: true }).installed.includes('agents/openkan.md'));
    assert.match(readFileSync(profile, 'utf8'), /name: openkan/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
