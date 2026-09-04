#!/usr/bin/env node

/**
 * End-to-end smoke test for the native Claude Code control plane on top of
 * OpenKan. Verifies that:
 *
 *   1. `/api/bizar/snapshot` still serves the legacy envelope (native-sourced).
 *   2. `/api/claude/snapshot` serves the full new shape.
 *   3. `POST /api/bizar/tasks` returns 410 with the deprecation marker.
 *   4. `ws://…/api/bizar/ws` streams an initial snapshot with the legacy
 *      envelope.
 *   5. `GET /api/claude/events` returns `text/event-stream` content-type.
 *   6. The HTML serves both `data-tab="bizar"` and `data-tab="claude"` and
 *      includes `claude-pane.js`.
 *
 * Boots a fresh primary server on 127.0.0.1:18778 (loopback only) so the test
 * is fully self-contained and never collides with a developer session.
 */

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

import { initBoard, setProjectRoot, type BoardContext } from "../kanban/board.ts";
import { startOrAttach } from "../kanban/server.ts";

const root = resolve(import.meta.dirname, "..");
const checks: string[] = [];
const ctx: BoardContext = {
  directory: root,
  client: null as any,
  log: async () => {},
};

function pass(name: string): void {
  checks.push(name);
  process.stdout.write(`  ✓ ${name}\n`);
}

async function websocketSnapshot(url: string): Promise<any> {
  return new Promise((resolveMessage, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Bizar WebSocket snapshot timed out"));
    }, 10_000);
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type !== "snapshot") return;
      clearTimeout(timeout);
      socket.close();
      resolveMessage(event.data);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

process.stdout.write("\n  OPENKAN × CLAUDE E2E\n\n");
setProjectRoot(root);
await initBoard(ctx);
const server = await startOrAttach(ctx, {
  host: "127.0.0.1",
  port: 18778,
  maxPortTries: 20,
  webRoot: join(root, "web"),
  _autoDetect: false,
});

try {
  assert.equal(server.isPrimary, true, "E2E requires its own primary server");
  pass("OpenKan server starts");

  // 1. Legacy envelope still served (native-sourced)
  const legacyResponse = await fetch(`${server.url}/api/bizar/snapshot`);
  assert.equal(legacyResponse.status, 200);
  const legacySnapshot = (await legacyResponse.json()) as Record<string, unknown>;
  assert.equal(legacySnapshot.version, 1, "legacy envelope carries version: 1");
  assert.equal(typeof legacySnapshot.projectRoot, "string", "legacy envelope carries projectRoot");
  assert.ok(Array.isArray(legacySnapshot.agents), "legacy envelope carries agents[]");
  assert.ok(Array.isArray(legacySnapshot.tasks), "legacy envelope carries tasks[]");
  assert.ok(Array.isArray(legacySnapshot.sessions), "legacy envelope carries sessions[]");
  assert.ok(Array.isArray(legacySnapshot.messages), "legacy envelope carries messages[]");
  pass("GET /api/bizar/snapshot returns the legacy envelope");

  // 2. Native snapshot returns the full new shape
  const claudeResponse = await fetch(`${server.url}/api/claude/snapshot`);
  assert.equal(claudeResponse.status, 200);
  const claudeSnapshot = (await claudeResponse.json()) as Record<string, unknown>;
  for (const key of [
    "agents",
    "skills",
    "commands",
    "hooks",
    "modelRouter",
    "teams",
    "workflows",
    "projects",
    "serverTs",
  ]) {
    assert.ok(key in claudeSnapshot, `claude snapshot is missing ${key}`);
  }
  pass("GET /api/claude/snapshot returns the full new shape");

  // 3. POST /api/bizar/tasks is deprecated
  const goneResponse = await fetch(`${server.url}/api/bizar/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(goneResponse.status, 410, "POST /api/bizar/tasks must return 410");
  const goneBody = (await goneResponse.json()) as Record<string, unknown>;
  assert.equal(goneBody.deprecated, true, "gone body carries deprecated: true");
  assert.equal(goneBody.successor, "/api/claude/*", "gone body points at the /api/claude/* successor");
  pass("POST /api/bizar/tasks returns 410 with deprecation marker");

  // 4. WebSocket legacy endpoint streams an initial snapshot
  const wsSnapshot = await websocketSnapshot(
    server.url.replace(/^http:/, "ws:") + "/api/bizar/ws",
  );
  assert.equal(wsSnapshot.version, 1, "websocket snapshot carries legacy envelope version");
  assert.equal(typeof wsSnapshot.projectRoot, "string");
  assert.ok(Array.isArray(wsSnapshot.agents));
  pass("ws://…/api/bizar/ws streams the legacy envelope");

  // 5. SSE content-type on the native events endpoint
  const eventsResponse = await fetch(`${server.url}/api/claude/events`);
  assert.equal(eventsResponse.status, 200);
  assert.match(
    eventsResponse.headers.get("content-type") || "",
    /text\/event-stream/,
    "/api/claude/events must respond with text/event-stream",
  );
  await eventsResponse.body?.cancel();
  pass("GET /api/claude/events returns text/event-stream");

  // 6. HTML serves both tabs and the new claude-pane module
  const html = await (await fetch(server.url)).text();
  assert.match(html, /data-tab="bizar"/, "HTML keeps the legacy bizar tab");
  assert.match(html, /data-tab="claude"/, "HTML exposes the claude tab");
  assert.match(html, /claude-pane\.js/, "HTML loads claude-pane.js");
  pass("HTML serves both bizar and claude tabs with claude-pane.js");
} finally {
  await server.stop();
}

process.stdout.write(`\n  ${checks.length}/${checks.length} checks passed\n\n`);
