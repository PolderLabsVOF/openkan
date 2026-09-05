// tests/install-agent-prompt.test.mjs — covers the new interactive prompt and
// flag handling in bin/install-agent.mjs. Each test isolates CLAUDE_CONFIG_DIR
// to a temp directory so it can never touch the user's real ~/.claude.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const cliPath = join(repoRoot, 'bin', 'install-agent.mjs');
const skillSource = join(repoRoot, 'skills', 'openkan');
const agentSource = join(repoRoot, 'agents', 'openkan.md');

function run(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: '',
  });
}

function freshConfigDir() {
  return mkdtempSync(join(tmpdir(), 'openkan-install-agent-prompt-'));
}

describe('install-agent.mjs flag parsing', () => {
  it('--help prints usage and exits 0 without installing', () => {
    const configDir = freshConfigDir();
    try {
      const result = run(['--help'], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage: install-agent\.mjs/);
      assert.match(result.stdout, /--yes/);
      assert.match(result.stdout, /--no/);
      assert.equal(existsSync(join(configDir, '.openkan-managed.json')), false, 'should not have written a manifest');
      assert.equal(existsSync(join(configDir, 'agents/openkan.md')), false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('-h is equivalent to --help', () => {
    const configDir = freshConfigDir();
    try {
      const result = run(['-h'], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage: install-agent\.mjs/);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('--no skips install, prints the skip message, and exits 0', () => {
    const configDir = freshConfigDir();
    try {
      const result = run(['--no'], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Skipped agent install/);
      assert.match(result.stdout, /openkan agent install/);
      assert.equal(existsSync(join(configDir, 'agents/openkan.md')), false);
      assert.equal(existsSync(join(configDir, 'skills/openkan/SKILL.md')), false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('-n is equivalent to --no', () => {
    const configDir = freshConfigDir();
    try {
      const result = run(['-n'], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Skipped agent install/);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('--yes installs even with no TTY / closed stdin', () => {
    const configDir = freshConfigDir();
    try {
      const result = run(['--yes'], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /OpenKan agent and skill ready/);
      assert.ok(existsSync(join(configDir, 'agents/openkan.md')));
      assert.ok(existsSync(join(configDir, 'skills/openkan/SKILL.md')));
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('-y is equivalent to --yes', () => {
    const configDir = freshConfigDir();
    try {
      const result = run(['-y'], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(configDir, 'agents/openkan.md')));
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('OPENKAN_SKIP_AGENT_INSTALL=1 matches --no behaviour', () => {
    const configDir = freshConfigDir();
    try {
      const result = run([], {
        CLAUDE_CONFIG_DIR: configDir,
        OPENKAN_SKIP_AGENT_INSTALL: '1',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Skipped agent install/);
      assert.equal(existsSync(join(configDir, 'agents/openkan.md')), false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('non-TTY without flags defaults to skip (preserves CI behaviour)', () => {
    const configDir = freshConfigDir();
    try {
      const result = run([], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Skipped agent install/);
      assert.equal(existsSync(join(configDir, 'agents/openkan.md')), false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('--yes preserves manifest tracking across custom edits (does not regress the force flag)', () => {
    const configDir = freshConfigDir();
    try {
      const first = run(['--yes'], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(first.status, 0, first.stderr);
      const profile = join(configDir, 'agents/openkan.md');
      writeFileSync(profile, 'My custom agent');
      // Default re-run: should preserve the customization (manifest hash mismatch).
      const second = run([], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(second.status, 0, second.stderr);
      assert.match(readFileSync(profile, 'utf8'), /My custom agent/);
      // --yes alone does not imply --force; it just skips the prompt. The
      // existing force flag is owned by `openkan agent install`, not by
      // the postinstall path.
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('unknown flags exit with status 2 and an actionable message', () => {
    const configDir = freshConfigDir();
    try {
      const result = run(['--bogus'], { CLAUDE_CONFIG_DIR: configDir });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /Unknown option/);
      assert.match(result.stderr, /--help/);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
