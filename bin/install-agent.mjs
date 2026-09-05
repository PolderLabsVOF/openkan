#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (content) => createHash('sha256').update(content).digest('hex');

/**
 * Parse the CLI flags this entry point understands. Only `--help`, `--yes`,
 * `--no`, and their short forms live here — anything else (e.g. `--force`)
 * belongs to `openkan agent install`, not the postinstall path.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, yes: boolean, no: boolean, unknown: string[] }}
 */
export function parseInstallAgentFlags(argv) {
  const flags = { help: false, yes: false, no: false, unknown: [] };
  for (const arg of argv) {
    switch (arg) {
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '-y':
      case '--yes':
        flags.yes = true;
        break;
      case '-n':
      case '--no':
        flags.no = true;
        break;
      default:
        flags.unknown.push(arg);
    }
  }
  return flags;
}

/**
 * Print usage for the postinstall entry point.
 */
export function printInstallAgentUsage() {
  console.log(`Usage: install-agent.mjs [options]

Options:
  -y, --yes    Install the OpenKan agent + skill into ~/.claude/ without prompting.
  -n, --no     Skip installation and exit 0.
  -h, --help   Print this message and exit 0.

Environment:
  OPENKAN_SKIP_AGENT_INSTALL=1
               Skip installation (equivalent to --no). Intended for CI.

When run interactively (stdout is a TTY) without --yes/--no and without
OPENKAN_SKIP_AGENT_INSTALL=1, install-agent prompts once with [Y/n]
(default yes on empty input).`);
}

/**
 * Ask the user once. Reads a single line from stdin (which is the prompt
 * stream when invoked from an interactive shell). Returns true on empty
 * input, "y", or "yes"; returns false on "n" or "no"; returns null when
 * the answer is ambiguous (so the caller can re-prompt or treat it as a
 * decline).
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, prompt?: string }} [options]
 */
export function readYesNoPrompt(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const prompt = options.prompt || '[openkan] Install OpenKan agent + skill into ~/.claude/? [Y/n] ';
  output.write(prompt);
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        const answer = buffer.slice(0, newline).trim().toLowerCase();
        resolve(answer);
      }
    };
    const onEnd = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      const answer = buffer.trim().toLowerCase();
      resolve(answer);
    };
    input.on('data', onData);
    input.on('end', onEnd);
  });
}

/**
 * Decide whether to install, given flags + env + TTY state. Pure function;
 * does not perform I/O. The caller still owns the actual install/skip path.
 *
 * @param {{ help?: boolean, yes?: boolean, no?: boolean, isTTY?: boolean, skipEnv?: boolean }} input
 * @returns {'help' | 'install' | 'skip' | 'prompt'}
 */
export function decideInstallAgent(input = {}) {
  if (input.help) return 'help';
  if (input.yes) return 'install';
  if (input.no) return 'skip';
  if (input.skipEnv) return 'skip';
  if (!input.isTTY) return 'skip';
  return 'prompt';
}

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
  const flags = parseInstallAgentFlags(process.argv.slice(2));
  if (flags.unknown.length) {
    console.error(`[openkan] Unknown option(s): ${flags.unknown.join(', ')}. Pass --help for usage.`);
    process.exit(2);
  }
  if (flags.help) {
    printInstallAgentUsage();
    process.exit(0);
  }
  const skipEnv = process.env.OPENKAN_SKIP_AGENT_INSTALL === '1';
  const decision = decideInstallAgent({
    help: flags.help,
    yes: flags.yes,
    no: flags.no,
    isTTY: Boolean(process.stdout.isTTY),
    skipEnv,
  });
  if (decision === 'help') {
    printInstallAgentUsage();
    process.exit(0);
  }
  if (decision === 'skip') {
    console.log('[openkan] Skipped agent install. Run `openkan agent install` later to add it.');
    process.exit(0);
  }
  if (decision === 'prompt') {
    readYesNoPrompt().then((answer) => {
      const normalized = (answer || '').trim().toLowerCase();
      if (normalized === 'n' || normalized === 'no') {
        console.log('[openkan] Skipped agent install. Run `openkan agent install` later to add it.');
        process.exit(0);
        return;
      }
      try {
        const result = installAgent();
        console.log(`[openkan] OpenKan agent and skill ready in ${result.configDir}`);
        if (result.preserved.length) console.warn(`[openkan] Preserved customized files: ${result.preserved.join(', ')}. Use openkan agent install --force to replace them.`);
      } catch (error) {
        console.warn(`[openkan] Could not install the Claude agent: ${error.message}. OpenKan remains usable; run openkan agent install to retry.`);
        process.exit(1);
      }
    }).catch((error) => {
      console.warn(`[openkan] Could not read prompt input (${error.message}); skipping agent install. Run openkan agent install to retry.`);
      process.exit(1);
    });
  } else {
    try {
      const result = installAgent();
      console.log(`[openkan] OpenKan agent and skill ready in ${result.configDir}`);
      if (result.preserved.length) console.warn(`[openkan] Preserved customized files: ${result.preserved.join(', ')}. Use openkan agent install --force to replace them.`);
    } catch (error) {
      console.warn(`[openkan] Could not install the Claude agent: ${error.message}. OpenKan remains usable; run openkan agent install to retry.`);
      process.exit(1);
    }
  }
}
