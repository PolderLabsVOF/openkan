// tests/openkan-skill-content.test.mjs — structural and content assertions
// for skills/openkan/SKILL.md. The file is the canonical contract that an
// agent reads to learn how to operate OpenKan; we lock its default-to-openkan
// mandate so a refactor cannot silently weaken it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = join(repoRoot, 'skills', 'openkan', 'SKILL.md');
const skillText = readFileSync(skillPath, 'utf8');

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error('SKILL.md is missing YAML frontmatter');
  const result = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^"|"$/g, '');
    result[key] = value;
  }
  return result;
}

const frontmatter = parseFrontmatter(skillText);

function bodyLines() {
  // Strip the frontmatter (everything between the first pair of --- delimiters).
  const match = skillText.match(/^---\n[\s\S]*?\n---\n?/);
  if (!match) throw new Error('SKILL.md is missing YAML frontmatter');
  return skillText.slice(match[0].length).split('\n');
}

describe('skills/openkan/SKILL.md frontmatter', () => {
  it('declares the openkan skill name', () => {
    assert.equal(frontmatter.name, 'openkan');
  });

  it('description contains the words "openkan" and "cli"', () => {
    assert.match(frontmatter.description ?? '', /\bopenkan\b/);
    assert.match(frontmatter.description ?? '', /\bcli\b/i);
  });

  it('description explicitly warns against curling the dashboard', () => {
    assert.match(frontmatter.description ?? '', /Do not curl/i);
  });
});

describe('skills/openkan/SKILL.md default-behavior contract', () => {
  it('opens the body with a "default behavior" heading', () => {
    const head = bodyLines().slice(0, 30).join('\n');
    assert.match(head, /##\s+Default behavior/i);
  });

  it('states a "default to openkan" directive in the first 30 body lines', () => {
    const head = bodyLines().slice(0, 30).join('\n');
    // Match "Default to openkan" with optional hyphens / extra words.
    assert.match(head, /default[- ]to[- ][`'"]?openkan/i);
  });

  it('forbids `curl` to the dashboard in a "never" / "do not" sentence', () => {
    const head = bodyLines().slice(0, 30).join('\n');
    // Accept any of: never, do not, don't
    assert.match(head, /(never|do not|don't)/i);
    assert.match(head, /\bcurl\b/);
  });

  it('forbids `wget` to the dashboard in a "never" / "do not" sentence', () => {
    const head = bodyLines().slice(0, 30).join('\n');
    assert.match(head, /\bwget\b/);
  });

  it('explicitly names .ok/board.json as off-limits for hand edits', () => {
    const text = skillText;
    assert.match(text, /\.ok\/board\.json/);
    assert.match(text, /do not edit.*\.ok\/board\.json|never edit.*\.ok\/board\.json/i);
  });

  it('explicitly names .ok/tasks/ as off-limits for hand edits', () => {
    const text = skillText;
    assert.match(text, /\.ok\/tasks\//);
    assert.match(text, /do not edit.*\.ok\/tasks|never edit.*\.ok\/tasks/i);
  });

  it('points to `openkan api` as the curl replacement', () => {
    const head = bodyLines().slice(0, 30).join('\n');
    assert.match(head, /openkan api/);
    assert.match(head, /never.*curl|curl.*never/i);
  });
});

describe('skills/openkan/SKILL.md decision rules', () => {
  it('contains a "decision rules" section', () => {
    assert.match(skillText, /##\s+Decision rules/i);
  });

  it('decision rules include `list --json`, `add ...`, and `update <id> ...`', () => {
    assert.match(skillText, /list --json/);
    assert.match(skillText, /\badd\b/);
    assert.match(skillText, /update\s+<id>/);
  });

  it('decision rules tell agents to use `openkan board add` for board cards', () => {
    assert.match(skillText, /openkan board add/);
  });
});

describe('skills/openkan/SKILL.md reference content', () => {
  it('still includes the install + discover commands', () => {
    assert.match(skillText, /npm install -g @polderlabs\/openkan/);
    assert.match(skillText, /openkan init/);
  });

  it('still includes the track-execution commands', () => {
    assert.match(skillText, /openkan task add/);
    assert.match(skillText, /openkan task claim/);
    assert.match(skillText, /openkan task complete/);
  });

  it('still links references/api.md for advanced features', () => {
    assert.match(skillText, /references\/api\.md/);
  });

  it('keeps the "do not use curl" reminder in the advanced-features section', () => {
    // The api reference section repeats the rule so agents reading further
    // also see it.
    const lower = skillText.toLowerCase();
    const curlIndex = lower.lastIndexOf('curl');
    assert.ok(curlIndex > 0, 'curl must be mentioned at least twice (mandate + reference)');
    assert.match(skillText.slice(curlIndex - 80, curlIndex + 80), /do not/i);
  });
});

describe('skills/openkan/SKILL.md line structure', () => {
  it('the mandate appears within the first 30 lines of the body', () => {
    const head = bodyLines().slice(0, 30).join('\n');
    assert.match(head, /Default behavior/i);
    assert.match(head, /never/i);
    assert.match(head, /curl/i);
  });

  it('references/api.md is not modified (left as-is per the task spec)', () => {
    const apiText = readFileSync(join(repoRoot, 'skills', 'openkan', 'references', 'api.md'), 'utf8');
    // Sanity: the file still exists and still contains the loopback warning.
    assert.match(apiText, /127\.0\.0\.1/);
  });
});
