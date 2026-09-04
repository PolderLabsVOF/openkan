// OpenKan — API tests for /api/claude/* routes.
//
// Calls `handleClaudeRequest` directly with synthetic `Request` objects and a
// stubbed `~/.claude/` fixture under a temp directory; no live server boot.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  handleClaudeRequest,
  readEvents,
  resetActivityRing,
  resetActivityTail,
} from "../kanban/claude-state.ts";

let tempRoot: string | null = null;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openkan-api-claude-"));
  tempRoot = root;
  return root;
}

function writeFixture(parts: string[], contents: string): void {
  const full = join(tempRoot!, ...parts);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resetActivityRing();
  resetActivityTail();
  if (tempRoot && existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

test("GET /api/claude/snapshot returns the full reader composition", async () => {
  const root = makeRoot();
  writeFixture(
    [".claude", "agents", "mike.md"],
    `---
name: mike
description: Bizar office manager and team orchestrator.
tools: Read, Write
model: minimax/MiniMax-M3
---

# Mike
`,
  );
  writeFixture(
    [".claude", "skills", "bizar", "SKILL.md"],
    `---
name: bizar
description: Operate the harness.
---

# Bizar
`,
  );
  writeFixture(
    [".claude", "commands", "bizar.md"],
    `---
description: Bizar controls.
---

# Bizar
`,
  );
  writeFixture(
    [".claude", "model-router.json"],
    JSON.stringify({
      version: "13.0.0",
      policies: { mainOrchestrator: "mike" },
      userSelected: { models: ["minimax/MiniMax-M3"], tierHints: { mike: "default" } },
    }),
  );

  const res = await handleClaudeRequest(
    root,
    new Request("http://localhost/api/claude/snapshot"),
    "/api/claude/snapshot",
  );
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(Array.isArray(body.agents), true);
  assert.equal(Array.isArray(body.skills), true);
  assert.equal(Array.isArray(body.commands), true);
  assert.equal(Array.isArray(body.hooks), true);
  assert.equal(Array.isArray(body.teams), true);
  assert.equal(Array.isArray(body.workflows), true);
  assert.ok(body.modelRouter && typeof body.modelRouter === "object");
  assert.ok(body.serverTs);
  const agents = body.agents as Array<{ id: string; model: string | null }>;
  assert.equal(agents[0].id, "mike");
});

test("GET /api/claude/agents returns just the agents array", async () => {
  const root = makeRoot();
  writeFixture(
    [".claude", "agents", "todd.md"],
    `---
name: todd
description: senior engineer
---
`,
  );

  const res = await handleClaudeRequest(
    root,
    new Request("http://localhost/api/claude/agents"),
    "/api/claude/agents",
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { agents: Array<{ id: string }> };
  assert.equal(body.agents.length, 1);
  assert.equal(body.agents[0].id, "todd");
});

test("POST /api/claude/events stores a relay-pushed event in the ring buffer", async () => {
  const root = makeRoot();

  const res = await handleClaudeRequest(
    root,
    postJson("http://localhost/api/claude/events", {
      event: "agent.started",
      sessionId: "ses-1",
      payload: { agent: "mike", summary: "mike session starting" },
      ts: "2026-09-04T10:00:00.000Z",
    }),
    "/api/claude/events",
  );
  assert.equal(res.status, 200);
  const ack = await res.json() as { ok: boolean };
  assert.deepEqual(ack, { ok: true });

  const ring = readEvents();
  assert.equal(ring.length, 1);
  assert.equal(ring[0].kind, "agent.started");
  assert.equal(ring[0].agentId, "mike");
  assert.equal(ring[0].projectId, "ses-1");
});

test("POST /api/claude/events maps unknown kinds to agent.queued", async () => {
  const root = makeRoot();
  await handleClaudeRequest(
    root,
    postJson("http://localhost/api/claude/events", {
      event: "totally.custom.event",
      sessionId: "ses-2",
      payload: { agent: "@user" },
      ts: "2026-09-04T10:00:00.000Z",
    }),
    "/api/claude/events",
  );
  const ring = readEvents();
  assert.equal(ring.length, 1);
  assert.equal(ring[0].kind, "agent.queued");
  assert.equal(ring[0].meta?.originalKind, "totally.custom.event");
});

test("POST /api/claude/events rejects malformed payloads", async () => {
  const root = makeRoot();
  const res = await handleClaudeRequest(
    root,
    postJson("http://localhost/api/claude/events", { foo: "bar" }),
    "/api/claude/events",
  );
  assert.equal(res.status, 422);
});

test("POST /api/claude/events rejects invalid JSON", async () => {
  const root = makeRoot();
  const res = await handleClaudeRequest(
    root,
    new Request("http://localhost/api/claude/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
    "/api/claude/events",
  );
  assert.equal(res.status, 400);
});

test("GET /api/claude/activity tails sinceMs and skips already-seen rows", async () => {
  const root = makeRoot();
  const session = "ses-tail";
  const dir = join(root, ".claude", "projects", session, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent-a.jsonl"),
    JSON.stringify({ type: "agent.started", timestamp: "2026-09-04T09:00:00.000Z", agent: "todd" }) + "\n",
  );
  // Prime the cursor.
  await handleClaudeRequest(root, new Request("http://localhost/api/claude/activity"), "/api/claude/activity");

  // No new rows -> empty array.
  const res = await handleClaudeRequest(
    root,
    new Request("http://localhost/api/claude/activity?since=2026-09-04T08:00:00.000Z"),
    "/api/claude/activity",
  );
  const body = await res.json() as { events: unknown[] };
  assert.equal(body.events.length, 0);
});

test("GET /api/claude/relay-status reflects the relay env var", async () => {
  const root = makeRoot();
  const original = process.env.CLAUDE_OPENKAN_RELAY;
  try {
    delete process.env.CLAUDE_OPENKAN_RELAY;
    const off = await handleClaudeRequest(
      root,
      new Request("http://localhost/api/claude/relay-status"),
      "/api/claude/relay-status",
    );
    assert.deepEqual(await off.json(), { enabled: false });

    process.env.CLAUDE_OPENKAN_RELAY = "1";
    const on = await handleClaudeRequest(
      root,
      new Request("http://localhost/api/claude/relay-status"),
      "/api/claude/relay-status",
    );
    assert.deepEqual(await on.json(), { enabled: true });
  } finally {
    if (original === undefined) delete process.env.CLAUDE_OPENKAN_RELAY;
    else process.env.CLAUDE_OPENKAN_RELAY = original;
  }
});

test("GET /api/claude/events returns an SSE stream", async () => {
  const root = makeRoot();
  const res = await handleClaudeRequest(
    root,
    new Request("http://localhost/api/claude/events"),
    "/api/claude/events",
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  assert.ok(res.body, "SSE response should have a body stream");
  // Cancel the stream promptly so the test exits cleanly.
  await res.body?.cancel();
});

test("GET /api/claude/ring returns ring buffer entries newest-first", async () => {
  const root = makeRoot();
  await handleClaudeRequest(
    root,
    postJson("http://localhost/api/claude/events", {
      event: "agent.started",
      sessionId: "ses-A",
      payload: { agent: "mike" },
      ts: "2026-09-04T10:00:00.000Z",
    }),
    "/api/claude/events",
  );
  await handleClaudeRequest(
    root,
    postJson("http://localhost/api/claude/events", {
      event: "chat.turn-ended",
      sessionId: "ses-A",
      payload: { agent: "mike" },
      ts: "2026-09-04T10:01:00.000Z",
    }),
    "/api/claude/events",
  );
  const res = await handleClaudeRequest(
    root,
    new Request("http://localhost/api/claude/ring"),
    "/api/claude/ring",
  );
  const body = await res.json() as { events: Array<{ kind: string }> };
  assert.equal(body.events.length, 2);
  // Newest-first ordering.
  assert.equal(body.events[0].kind, "chat.turn-ended");
  assert.equal(body.events[1].kind, "agent.started");
});

test("Unknown GET routes return 404", async () => {
  const root = makeRoot();
  const res = await handleClaudeRequest(
    root,
    new Request("http://localhost/api/claude/nope"),
    "/api/claude/nope",
  );
  assert.equal(res.status, 404);
});
