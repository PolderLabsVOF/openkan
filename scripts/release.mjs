#!/usr/bin/env node
// scripts/release.mjs
// OpenKan release driver. Computes the next version for the selected channel,
// updates package.json, publishes to npm with OIDC provenance, and creates the
// matching GitHub release for stable and beta channels.
//
// Inputs (env):
//   RELEASE_CHANNEL   stable | beta | nightly (required)
//   RELEASE_SHA       exact commit SHA being released (required)
//   RELEASE_DRY_RUN   "true" / "1" to validate without publishing (default false)
//   RELEASE_VERSION   optional explicit version (overrides auto-compute)
//   GH_TOKEN          required for stable/beta GitHub releases
//
// npm trusted publishing handles authentication to the registry; no NPM_TOKEN
// is read or stored. The corresponding trusted publisher must be configured on
// npmjs.com for PolderLabsVOF/openkan / release.yml before publication.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageJsonPath = join(root, 'package.json');

const channel = process.env.RELEASE_CHANNEL;
const sha = process.env.RELEASE_SHA;
const dryRun = process.env.RELEASE_DRY_RUN === 'true' || process.env.RELEASE_DRY_RUN === '1';
const forcedVersion = process.env.RELEASE_VERSION || '';
const ghToken = process.env.GH_TOKEN || '';

const CHANNELS = new Set(['stable', 'beta', 'nightly']);
const DIST_TAGS = { stable: 'latest', beta: 'beta', nightly: 'nightly' };

if (!CHANNELS.has(channel)) {
  console.error(`✗ RELEASE_CHANNEL must be one of stable|beta|nightly (got: ${channel ?? '<unset>'})`);
  process.exit(1);
}
if (!sha) {
  console.error('✗ RELEASE_SHA is required');
  process.exit(1);
}
if (!dryRun && (channel === 'stable' || channel === 'beta') && !ghToken) {
  console.error('✗ GH_TOKEN is required for stable/beta GitHub releases');
  process.exit(1);
}

const original = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const { name: packageName, version: currentVersion } = original;

if (!forcedVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(currentVersion)) {
  console.error(`✗ Current package.json version is not semver: ${currentVersion}`);
  process.exit(1);
}

function runJson(cmd, args) {
  const result = spawnSync(cmd, [...args, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

const distTags = runJson('npm', ['view', packageName, 'dist-tags']);
const versions = runJson('npm', ['view', packageName, 'versions']);
const latestTag = distTags.latest || currentVersion;

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Cannot parse semver: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function nextBeta(patchBase) {
  const prefix = `${patchBase}-beta.`;
  const existing = versions
    .filter((v) => v.startsWith(prefix))
    .map((v) => Number(v.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
  const n = existing.length === 0 ? 1 : Math.max(...existing) + 1;
  return `${patchBase}-beta.${n}`;
}

function nextNightly(base) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // Nightlies always advance within the current minor to keep ordering simple.
  return `${base}-nightly.${date}`;
}

let nextVersion;
if (forcedVersion) {
  nextVersion = forcedVersion;
} else if (channel === 'stable') {
  nextVersion = bumpPatch(latestTag);
} else if (channel === 'beta') {
  nextVersion = nextBeta(bumpPatch(latestTag));
} else {
  nextVersion = nextNightly(latestTag);
}

const distTag = DIST_TAGS[channel];

if (versions.includes(nextVersion)) {
  console.error(`✗ Version ${nextVersion} already published on npm`);
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  console.error(`✗ Computed version is not semver: ${nextVersion}`);
  process.exit(1);
}

console.log('OpenKan release');
console.log(`  package:        ${packageName}`);
console.log(`  channel:        ${channel}  (dist-tag: ${distTag})`);
console.log(`  sha:            ${sha}`);
console.log(`  current:        ${currentVersion}`);
console.log(`  latest (npm):   ${latestTag}`);
console.log(`  next:           ${nextVersion}`);
console.log(`  dry run:        ${dryRun}`);

if (dryRun) {
  console.log('Dry run: skipping publish, tag, and GitHub release.');
  process.exit(0);
}

let failure;
try {
  const updated = { ...original, version: nextVersion };
  writeFileSync(packageJsonPath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`✓ Updated package.json to ${nextVersion}`);

  console.log(`Publishing ${packageName}@${nextVersion} with provenance…`);
  execFileSync('npm', [
    'publish',
    '--provenance',
    '--tag', distTag,
    '--access', 'public',
  ], { cwd: root, stdio: 'inherit' });
  console.log(`✓ Published ${packageName}@${nextVersion} (dist-tag=${distTag})`);

  if (channel !== 'nightly') {
    const tagName = `v${nextVersion}`;
    const notes = [
      `Automated ${channel} release of \`${packageName}@${nextVersion}\`.`,
      '',
      `Commit: ${sha}`,
    ].join('\n');
    const args = [
      'release', 'create', tagName,
      '--target', sha,
      '--title', tagName,
      '--notes', notes,
      '--generate-notes',
    ];
    if (channel === 'beta') args.push('--prerelease');
    console.log(`Creating GitHub release ${tagName}…`);
    execFileSync('gh', args, { cwd: root, env: { ...process.env, GH_TOKEN: ghToken }, stdio: 'inherit' });
    console.log(`✓ Created GitHub release ${tagName}`);
  }
} catch (err) {
  failure = err;
  console.error(`✗ Release failed: ${err?.message ?? err}`);
} finally {
  writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`);
  console.log(`✓ Restored package.json to ${currentVersion}`);
}

if (failure) process.exit(1);
