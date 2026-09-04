#!/usr/bin/env node
// Opt-in relay: forwards Claude Code hook payloads to OpenKan's
// /api/claude/events endpoint so the UI sees activity the moment a hook
// fires. Hooks must NEVER block Claude, so every path exits 0 and any
// failure (parse, fetch, timeout, unknown port) is logged to stderr only.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 200;
const DEFAULT_PORT = 4040;

async function readStdin() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

async function loadPort() {
  try {
    const raw = await readFile(join(homedir(), '.claude', 'openkan.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const port = Number(parsed?.port ?? parsed?.openkan?.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {}
  return DEFAULT_PORT;
}

(async () => {
  try {
    if (process.env.CLAUDE_OPENKAN_RELAY === '0') process.exit(0);
    const raw = await readStdin();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch {}
    const event = String(payload.hook_event_name ?? 'unknown');
    const sessionId = String(payload.session_id ?? 'unknown');
    const port = await loadPort();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await fetch(`http://127.0.0.1:${port}/api/claude/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, sessionId, payload, ts: Date.now() }),
        signal: controller.signal,
      });
    } catch (err) {
      process.stderr.write(`claude-activity-relay: ${err.message ?? err}\n`);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    process.stderr.write(`claude-activity-relay: ${err.message ?? err}\n`);
  }
  process.exit(0);
})();
