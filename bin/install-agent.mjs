#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (content) => createHash('sha256').update(content).digest('hex');

/** Install only package-owned files; retain edited profiles and unrelated configuration. */
export function installAgent(options = {}) {
  const root = options.packageRoot || packageRoot;
  const configDir = options.configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const manifestPath = join(configDir, '.openkan-managed.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { schema: 1, files: {} };
  if (manifest.schema !== 1 || !manifest.files || typeof manifest.files !== 'object') throw new Error('Unrecognized OpenKan install manifest; existing configuration was left unchanged');
  const files = [{ source: join(root, 'agents/openkan.md'), target: 'agents/openkan.md' }];
  function collect(directory, target) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(directory, entry.name), `${target}/${entry.name}`);
      else if (entry.isFile()) files.push({ source: join(directory, entry.name), target: `${target}/${entry.name}` });
    }
  }
  collect(join(root, 'skills/openkan'), 'skills/openkan');
  const result = { installed: [], preserved: [], unchanged: [], configDir };
  for (const file of files) {
    const target = join(configDir, file.target);
    const content = readFileSync(file.source, 'utf8');
    const incomingHash = digest(content);
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) { result.preserved.push(file.target); continue; }
      const currentHash = digest(readFileSync(target, 'utf8'));
      if (currentHash === incomingHash) { manifest.files[file.target] = currentHash; result.unchanged.push(file.target); continue; }
      if (!options.force && manifest.files[file.target] !== currentHash) { result.preserved.push(file.target); continue; }
    }
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temp, content, { flag: 'wx' });
    renameSync(temp, target);
    manifest.files[file.target] = incomingHash;
    result.installed.push(file.target);
  }
  mkdirSync(configDir, { recursive: true });
  const temp = `${manifestPath}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  renameSync(temp, manifestPath);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.OPENKAN_SKIP_AGENT_INSTALL === '1') {
    console.log('[openkan] Automatic agent installation skipped. Run openkan agent install later.');
  } else {
    try {
      const result = installAgent();
      console.log(`[openkan] OpenKan agent and skill ready in ${result.configDir}`);
      if (result.preserved.length) console.warn(`[openkan] Preserved customized files: ${result.preserved.join(', ')}. Use openkan agent install --force to replace them.`);
    } catch (error) {
      console.warn(`[openkan] Could not install the Claude agent: ${error.message}. OpenKan remains usable; run openkan agent install to retry.`);
    }
  }
}
