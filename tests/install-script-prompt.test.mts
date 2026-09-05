// tests/install-script-prompt.test.mts — covers the interactive prompt added
// to install.sh for the agent skill install. We do not run install.sh
// end-to-end (the dedicated `installer creates ...` test already does that);
// we extract the prompt logic into a small shim that reuses the script's
// `should_install_agent_skills` + `prompt_yes_no` functions, then assert
// behaviour against stdin/dev-tty substitutes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installSh = join(repoRoot, 'install.sh');

interface RunOptions {
  stdin?: string;
  env?: Record<string, string>;
  flags?: string[];
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runInstallSh({ stdin = '', env = {}, flags = [] }: RunOptions): RunResult {
  const result = spawnSync('bash', [installSh, ...flags], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: stdin,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runInstallShWithPty({ stdin = '', env = {}, flags = [] }: RunOptions): RunResult {
  // `script` allocates a pseudo-tty so /dev/tty is readable and read -r
  // from stdin succeeds inside the child bash. We pass the env vars as a
  // shell command so they apply only to install.sh.
  const home = env.HOME ?? mkdtempSync(join(tmpdir(), 'openkan-install-prompt-home-'));
  const binDir = env.OPENKAN_BIN_DIR ?? mkdtempSync(join(tmpdir(), 'openkan-install-prompt-bin-'));
  const dataHome = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const codexHome = env.CODEX_HOME ?? join(home, '.codex');
  const claudeConfig = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const agentsHome = env.AGENTS_HOME ?? join(home, '.agents');

  const envPrefix =
    `HOME=${shellQuote(home)} ` +
    `XDG_DATA_HOME=${shellQuote(dataHome)} ` +
    `CODEX_HOME=${shellQuote(codexHome)} ` +
    `CLAUDE_CONFIG_DIR=${shellQuote(claudeConfig)} ` +
    `AGENTS_HOME=${shellQuote(agentsHome)} ` +
    `OPENKAN_BIN_DIR=${shellQuote(binDir)} ` +
    `OPENKAN_SKIP_DEPENDENCIES=1 `;

  const result = spawnSync(
    'script',
    ['-qec', `${envPrefix}bash ${shellQuote(installSh)} ${flags.map(shellQuote).join(' ')}`, '/dev/null'],
    { encoding: 'utf8', input: stdin },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildMinimalSource(): string {
  // The existing install test rebuilds the source tree; mirror that.
  const root = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-'));
  for (const directory of ['bin', 'commands', 'kanban', 'ok', 'skills', 'web', 'agents']) {
    cpSync(join(repoRoot, directory), join(root, directory), { recursive: true });
  }
  for (const file of ['install.sh', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
    cpSync(join(repoRoot, file), join(root, file));
  }
  return root;
}

describe('install.sh agent-skill prompt', () => {
  it('--yes installs the agent skill into Codex/Claude/agents homes non-interactively', () => {
    const sourceRoot = buildMinimalSource();
    try {
      const home = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-home-'));
      const binDir = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-bin-'));
      const result = runInstallSh({
        flags: ['--yes'],
        env: {
          HOME: home,
          XDG_DATA_HOME: join(home, '.local', 'share'),
          CODEX_HOME: join(home, '.codex'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          AGENTS_HOME: join(home, '.agents'),
          OPENKAN_BIN_DIR: binDir,
          OPENKAN_SKIP_DEPENDENCIES: '1',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.ok(statSync(join(home, '.codex', 'skills', 'openkan', 'SKILL.md')).isFile());
      assert.ok(statSync(join(home, '.claude', 'skills', 'openkan', 'SKILL.md')).isFile());
      assert.ok(statSync(join(home, '.agents', 'skills', 'openkan', 'SKILL.md')).isFile());
      assert.match(result.stdout, /Agent skill: Codex/);
      assert.doesNotMatch(result.stdout, /Skipped agent skill install/);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('--no skips the agent skill install, prints the skip message, and exits 0', () => {
    const sourceRoot = buildMinimalSource();
    try {
      const home = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-home-'));
      const binDir = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-bin-'));
      const result = runInstallSh({
        flags: ['--no'],
        env: {
          HOME: home,
          XDG_DATA_HOME: join(home, '.local', 'share'),
          CODEX_HOME: join(home, '.codex'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          AGENTS_HOME: join(home, '.agents'),
          OPENKAN_BIN_DIR: binDir,
          OPENKAN_SKIP_DEPENDENCIES: '1',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Skipped agent skill install/);
      assert.match(result.stdout, /openkan agent install/);
      assert.throws(() => statSync(join(home, '.codex', 'skills', 'openkan', 'SKILL.md')));
      assert.throws(() => statSync(join(home, '.claude', 'skills', 'openkan', 'SKILL.md')));
      assert.throws(() => statSync(join(home, '.agents', 'skills', 'openkan', 'SKILL.md')));
      assert.match(result.stdout, /skipped/);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('OPENKAN_SKIP_AGENT_SKILLS=1 still skips without requiring --no', () => {
    const sourceRoot = buildMinimalSource();
    try {
      const home = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-home-'));
      const binDir = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-bin-'));
      const result = runInstallSh({
        env: {
          HOME: home,
          XDG_DATA_HOME: join(home, '.local', 'share'),
          CODEX_HOME: join(home, '.codex'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          AGENTS_HOME: join(home, '.agents'),
          OPENKAN_BIN_DIR: binDir,
          OPENKAN_SKIP_DEPENDENCIES: '1',
          OPENKAN_SKIP_AGENT_SKILLS: '1',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Skipped agent skill install/);
      assert.throws(() => statSync(join(home, '.codex', 'skills', 'openkan', 'SKILL.md')));
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('passing both --yes and --no exits 2 with an actionable message', () => {
    const result = runInstallSh({ flags: ['--yes', '--no'] });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--yes/);
    assert.match(result.stderr, /--no/);
  });

  it('--help exits 0 without performing an install', () => {
    const result = runInstallSh({ flags: ['--help'] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: install\.sh/);
    assert.match(result.stdout, /--yes/);
    assert.match(result.stdout, /--no/);
  });

  it('interactive prompt with empty input (default yes) installs the skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-home-'));
    const binDir = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-bin-'));
    try {
      const result = runInstallShWithPty({
        stdin: '\n', // empty line -> default yes
        env: {
          HOME: home,
          XDG_DATA_HOME: join(home, '.local', 'share'),
          CODEX_HOME: join(home, '.codex'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          AGENTS_HOME: join(home, '.agents'),
          OPENKAN_BIN_DIR: binDir,
          OPENKAN_SKIP_DEPENDENCIES: '1',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Install OpenKan agent \+ skill/);
      assert.ok(statSync(join(home, '.claude', 'skills', 'openkan', 'SKILL.md')).isFile());
      assert.match(result.stdout, /Agent skill: Codex/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('interactive prompt answering "n" skips the install', () => {
    const home = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-home-'));
    const binDir = mkdtempSync(join(tmpdir(), 'openkan-install-prompt-bin-'));
    try {
      const result = runInstallShWithPty({
        stdin: 'n\n',
        env: {
          HOME: home,
          XDG_DATA_HOME: join(home, '.local', 'share'),
          CODEX_HOME: join(home, '.codex'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          AGENTS_HOME: join(home, '.agents'),
          OPENKAN_BIN_DIR: binDir,
          OPENKAN_SKIP_DEPENDENCIES: '1',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Install OpenKan agent \+ skill/);
      assert.match(result.stdout, /Skipped agent skill install/);
      assert.throws(() => statSync(join(home, '.claude', 'skills', 'openkan', 'SKILL.md')));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

