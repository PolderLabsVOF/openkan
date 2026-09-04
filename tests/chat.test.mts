// OpenKan — chat session storage + subprocess wrapper tests.
//
// Coverage:
//   1. JSONL append + read round-trip
//   2. Subprocess spawn with selectors (mocked by replacing `claude` in PATH)
//   3. Abort kills the running process
//   4. Session list returns archived + active in correct order
//   5. validateSelectors enforces effort + permissionMode

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  abortSession,
  appendTurn,
  archiveSession,
  deleteSession,
  generateSessionId,
  isSessionActive,
  isSessionArchived,
  listSessions,
  listRunningSessions,
  readSession,
  resolveClaudeBin,
  sendTurn,
  summariseSession,
  validateSelectors,
  _resetRunningProcsForTests,
  type ChatTurn,
} from "../kanban/chat.ts";

const roots: string[] = [];

afterEach(() => {
  _resetRunningProcsForTests();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openkan-chat-"));
  roots.push(root);
  return root;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

test("appendTurn writes one JSON line per turn and readSession round-trips", () => {
  const root = makeRoot();
  const sid = generateSessionId();
  const turns: ChatTurn[] = [
    { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "hello" },
    { ts: "2026-09-04T10:00:01.000Z", role: "assistant", content: "hi there" },
    { ts: "2026-09-04T10:00:02.000Z", role: "system", content: "ack", status: "ok" },
  ];
  for (const t of turns) appendTurn(root, sid, t);

  const loaded = readSession(root, sid);
  assert.equal(loaded.length, 3);
  assert.deepEqual(loaded[0].content, "hello");
  assert.equal(loaded[1].role, "assistant");
  assert.equal(loaded[2].status, "ok");
});

test("summariseSession derives title from first user message", () => {
  const root = makeRoot();
  const sid = generateSessionId();
  appendTurn(root, sid, { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "Fix the kanban sidebar" });
  appendTurn(root, sid, { ts: "2026-09-04T10:00:01.000Z", role: "assistant", content: "On it." });

  const turns = readSession(root, sid);
  const summary = summariseSession(sid, turns, false);
  assert.equal(summary.id, sid);
  assert.equal(summary.title, "Fix the kanban sidebar");
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.archived, false);
});

test("summariseSession truncates long titles to 80 chars with ellipsis", () => {
  const root = makeRoot();
  const sid = generateSessionId();
  const longMsg = "x".repeat(200);
  appendTurn(root, sid, { ts: "2026-09-04T10:00:00.000Z", role: "user", content: longMsg });
  const turns = readSession(root, sid);
  const summary = summariseSession(sid, turns, false);
  assert.equal(summary.title.length, 80);
  assert.ok(summary.title.endsWith("…"));
});

test("listSessions returns active and archived, sorted by lastActivity desc", async () => {
  const root = makeRoot();
  const a = generateSessionId();
  const b = generateSessionId();
  const c = generateSessionId();

  appendTurn(root, a, { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "older" });
  appendTurn(root, a, { ts: "2026-09-04T10:00:01.000Z", role: "assistant", content: "ok" });

  // Add a small delay so the timestamps differ at millisecond resolution.
  await new Promise((r) => setTimeout(r, 5));
  appendTurn(root, b, { ts: "2026-09-04T10:00:10.000Z", role: "user", content: "newer" });
  appendTurn(root, b, { ts: "2026-09-04T10:00:11.000Z", role: "assistant", content: "ok" });

  await new Promise((r) => setTimeout(r, 5));
  appendTurn(root, c, { ts: "2026-09-04T10:00:20.000Z", role: "user", content: "newest" });

  // Archive `b` — list should still contain all three, with archived flag set.
  assert.equal(archiveSession(root, b), true);
  assert.equal(isSessionArchived(root, b), true);
  assert.equal(isSessionActive(root, b), false);

  const summaries = listSessions(root);
  assert.equal(summaries.length, 3);
  assert.equal(summaries[0].id, c);          // newest first
  assert.equal(summaries[1].id, b);          // archived, middle
  assert.equal(summaries[2].id, a);
  assert.equal(summaries[0].archived, false);
  assert.equal(summaries[1].archived, true);
  assert.equal(summaries[2].archived, false);
});

test("archiveSession is idempotent — second call is a no-op false", () => {
  const root = makeRoot();
  const sid = generateSessionId();
  appendTurn(root, sid, { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "x" });
  assert.equal(archiveSession(root, sid), true);
  assert.equal(archiveSession(root, sid), false);
});

test("deleteSession removes both active and archived files", () => {
  const root = makeRoot();
  const sid = generateSessionId();
  appendTurn(root, sid, { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "x" });
  assert.equal(deleteSession(root, sid), true);
  assert.equal(existsSync(join(root, ".ok", "sessions", `${sid}.jsonl`)), false);
  // Second delete returns false.
  assert.equal(deleteSession(root, sid), false);
});

// ─── Selector validation ─────────────────────────────────────────────────────

test("validateSelectors accepts known effort + permission combinations", () => {
  validateSelectors({ model: "minimax/MiniMax-M3", effort: "low", permissionMode: "acceptEdits" });
  validateSelectors({ model: "minimax/MiniMax-M3", effort: "high", permissionMode: "bypassPermissions" });
});

test("validateSelectors rejects unknown effort", () => {
  assert.throws(
    () => validateSelectors({ model: "x", effort: "ultra", permissionMode: "auto" }),
    /Invalid effort/,
  );
});

test("validateSelectors rejects unknown permission mode", () => {
  assert.throws(
    () => validateSelectors({ model: "x", effort: "low", permissionMode: "yolo" }),
    /Invalid permissionMode/,
  );
});

test("validateSelectors requires a model", () => {
  assert.throws(
    () => validateSelectors({ model: "", effort: "low", permissionMode: "auto" }),
    /model is required/,
  );
});

// ─── Binary resolution ───────────────────────────────────────────────────────

test("resolveClaudeBin honours $CLAUDE_BIN and overrides", () => {
  const prev = process.env.CLAUDE_BIN;
  try {
    process.env.CLAUDE_BIN = "/opt/claude/bin/claude";
    assert.equal(resolveClaudeBin(), "/opt/claude/bin/claude");
    assert.equal(resolveClaudeBin("/custom/bin/claude"), "/custom/bin/claude");
    process.env.CLAUDE_BIN = "";
    assert.equal(resolveClaudeBin(), "claude");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;
  }
});

// ─── Subprocess wrapper ──────────────────────────────────────────────────────

function fakeClaudeFixture(): { root: string; binDir: string; log: string; fake: string } {
  const root = makeRoot();
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const log = join(root, "claude-args.jsonl");
  const fake = join(binDir, "claude");
  writeFileSync(log, "");
  // Fake claude binary: write its argv to `log`, then echo the response on
  // stdout. If the prompt contains the sentinel "STAY_ALIVE", the process
  // sleeps forever so abort can be exercised. When `--output-format
  // stream-json --verbose` is requested (the production shape), emit NDJSON
  // events the parser can consume; otherwise emit plain text.
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  env: { PATH: process.env.PATH, MODEL: process.env.CLAUDE_MODEL || null },
}) + "\\n");
const promptIdx = args.indexOf("-p");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";
const outIdx = args.indexOf("--output-format");
const outFormat = outIdx >= 0 ? args[outIdx + 1] : "text";
if (prompt.includes("STAY_ALIVE")) {
  setInterval(() => {}, 1000);
} else if (outFormat === "stream-json") {
  const text = "PROMPT:" + prompt + "\\n" + "ARGS:" + JSON.stringify(args) + "\\n";
  process.stdout.write(JSON.stringify({ type: "message_start", message: { id: "msg_test", role: "assistant" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + "\\n");
  for (const ch of text) {
    process.stdout.write(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ch } }) + "\\n");
  }
  process.stdout.write(JSON.stringify({ type: "content_block_stop", index: 0 }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "message_stop" }) + "\\n");
} else {
  process.stdout.write("PROMPT:" + prompt + "\\n");
  process.stdout.write("ARGS:" + JSON.stringify(args) + "\\n");
}
`);
  chmodSync(fake, 0o755);
  return { root, binDir, log, fake };
}

test("sendTurn spawns claude -p with selectors and persists both turns", async () => {
  const { root, binDir, log } = fakeClaudeFixture();
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ":" + prevPath;
  try {
    const result = await sendTurn(root, {
      sessionId: "ses-test-1",
      message: "hello there",
      model: "minimax/MiniMax-M3",
      effort: "high",
      permissionMode: "acceptEdits",
    });
    assert.equal(result.sessionId, "ses-test-1");
    assert.equal(result.userTurn.role, "user");
    assert.equal(result.assistantTurn.role, "assistant");
    assert.ok(result.assistantTurn.content.includes("PROMPT:hello there"));

    const turns = readSession(root, "ses-test-1");
    assert.equal(turns.length, 2);
    assert.equal(turns[0].content, "hello there");
    assert.equal(turns[1].content.includes("PROMPT:"), true);
    assert.equal(turns[1].model, "minimax/MiniMax-M3");
    assert.equal(turns[1].effort, "high");
    assert.equal(turns[1].permissionMode, "acceptEdits");

    const logLine = JSON.parse(
      (await import("node:fs")).readFileSync(log, "utf-8").trim().split("\n").pop()!,
    );
    assert.deepEqual(logLine.argv.slice(0, 1), ["-p"]);
    assert.equal(logLine.argv[2], "--model");
    assert.equal(logLine.argv[3], "minimax/MiniMax-M3");
    assert.equal(logLine.argv[4], "--effort");
    assert.equal(logLine.argv[5], "high");
    assert.equal(logLine.argv[6], "--permission-mode");
    assert.equal(logLine.argv[7], "acceptEdits");
  } finally {
    process.env.PATH = prevPath;
  }
});

test("abortSession kills the running subprocess for a session", async () => {
  const { root, binDir } = fakeClaudeFixture();
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ":" + prevPath;
  try {
    // Spawn a long-lived process; we'll abort it.
    const promise = sendTurn(root, {
      sessionId: "ses-abort-1",
      message: "please STAY_ALIVE so we can abort you",
      model: "minimax/MiniMax-M3",
      effort: "low",
      permissionMode: "plan",
      claudeBin: join(binDir, "claude"),
    });
    // Wait a tick so the child has actually started.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(listRunningSessions().includes("ses-abort-1"));
    assert.equal(abortSession("ses-abort-1"), true);
    const result = await promise;
    assert.equal(result.assistantTurn.status, "aborted");
    // Registry cleared.
    assert.equal(listRunningSessions().includes("ses-abort-1"), false);
  } finally {
    process.env.PATH = prevPath;
  }
});

test("abortSession returns false when nothing is running for the session", () => {
  assert.equal(abortSession("ses-never-existed"), false);
});

test("sendTurn records an error turn when the subprocess exits non-zero", async () => {
  const root = makeRoot();
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, "claude");
  writeFileSync(fake, `#!/usr/bin/env node
process.stderr.write("boom\\n");
process.exit(42);
`);
  chmodSync(fake, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ":" + prevPath;
  try {
    const result = await sendTurn(root, {
      sessionId: "ses-err-1",
      message: "make it fail",
      model: "minimax/MiniMax-M3",
      effort: "low",
      permissionMode: "auto",
    });
    assert.equal(result.assistantTurn.role, "system");
    assert.equal(result.assistantTurn.status, "error");
    assert.match(result.assistantTurn.error ?? "", /boom|42/);
  } finally {
    process.env.PATH = prevPath;
  }
});

test("sendTurn auto-generates a sessionId when none provided", async () => {
  const { root, binDir } = fakeClaudeFixture();
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ":" + prevPath;
  try {
    const result = await sendTurn(root, {
      message: "no session yet",
      model: "minimax/MiniMax-M3",
      effort: "high",
      permissionMode: "auto",
    });
    assert.ok(result.sessionId.startsWith("ses-"));
    assert.ok(existsSync(join(root, ".ok", "sessions", `${result.sessionId}.jsonl`)));
  } finally {
    process.env.PATH = prevPath;
  }
});

// ─── HTTP dispatcher ─────────────────────────────────────────────────────────

import { handleChatRequest } from "../kanban/chat.ts";

test("handleChatRequest lists sessions", async () => {
  const root = makeRoot();
  appendTurn(root, "ses-x", { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "first" });
  const res = await handleChatRequest(root, new Request("http://l/api/chat/sessions"), "/api/chat/sessions");
  assert.equal(res.status, 200);
  const body = await res.json() as { sessions: Array<{ id: string }> };
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].id, "ses-x");
});

test("handleChatRequest returns 404 for unknown session", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/sessions/ses-missing"),
    "/api/chat/sessions/ses-missing",
  );
  assert.equal(res.status, 404);
});

test("handleChatRequest returns full transcript for a session", async () => {
  const root = makeRoot();
  appendTurn(root, "ses-y", { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "hi" });
  appendTurn(root, "ses-y", { ts: "2026-09-04T10:00:01.000Z", role: "assistant", content: "hello" });
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/sessions/ses-y"),
    "/api/chat/sessions/ses-y",
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { turns: ChatTurn[]; session: { id: string } };
  assert.equal(body.turns.length, 2);
  assert.equal(body.session.id, "ses-y");
});

test("handleChatRequest rejects send with invalid selectors", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/send", {
      method: "POST",
      body: JSON.stringify({ message: "hi", model: "x", effort: "ultra", permissionMode: "auto" }),
    }),
    "/api/chat/send",
  );
  assert.equal(res.status, 422);
  const body = await res.json() as { error: string };
  assert.match(body.error, /effort/);
});

test("handleChatRequest rejects send without message", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/send", {
      method: "POST",
      body: JSON.stringify({ model: "minimax/MiniMax-M3", effort: "high", permissionMode: "auto" }),
    }),
    "/api/chat/send",
  );
  assert.equal(res.status, 422);
});

test("handleChatRequest rejects send with invalid JSON", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/send", {
      method: "POST",
      body: "not json",
    }),
    "/api/chat/send",
  );
  assert.equal(res.status, 400);
});

test("handleChatRequest DELETE moves active session to archived", async () => {
  const root = makeRoot();
  appendTurn(root, "ses-z", { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "x" });
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/sessions/ses-z", { method: "DELETE" }),
    "/api/chat/sessions/ses-z",
  );
  assert.equal(res.status, 200);
  assert.equal(isSessionActive(root, "ses-z"), false);
  assert.equal(isSessionArchived(root, "ses-z"), true);
});

test("handleChatRequest POST abort returns killed:false when nothing running", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/sessions/ses-quiet/abort", { method: "POST" }),
    "/api/chat/sessions/ses-quiet/abort",
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { killed: boolean };
  assert.equal(body.killed, false);
});

test("handleChatRequest GET selectors returns allowed values", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/selectors"),
    "/api/chat/selectors",
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { efforts: string[]; permissionModes: string[] };
  assert.ok(body.efforts.includes("low"));
  assert.ok(body.efforts.includes("max"));
  assert.ok(body.permissionModes.includes("acceptEdits"));
  assert.ok(body.permissionModes.includes("bypassPermissions"));
});

test("handleChatRequest returns 404 for unknown chat path", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/nope"),
    "/api/chat/nope",
  );
  assert.equal(res.status, 404);
});

test("handleChatRequest SSE returns text/event-stream content-type", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/events"),
    "/api/chat/events",
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  // Cancel the stream to clean up the controller.
  await res.body?.cancel();
});

test("handleChatRequest render-markdown returns sanitised HTML", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/render-markdown", {
      method: "POST",
      body: JSON.stringify({ markdown: "# hello\n\n- one\n- two\n\n<script>alert(1)</script>" }),
    }),
    "/api/chat/render-markdown",
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
  const html = await res.text();
  assert.ok(html.includes("<h1"));
  assert.ok(html.includes("one"));
  // <script> is sanitised away.
  assert.ok(!html.toLowerCase().includes("<script>"));
});

test("handleChatRequest GET /api/chat/picker-options returns the expected shape", async () => {
  const root = makeRoot();
  const res = await handleChatRequest(
    root,
    new Request("http://l/api/chat/picker-options"),
    "/api/chat/picker-options",
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
  const body = await res.json() as {
    models: Array<{ id: string; label: string }>;
    efforts: string[];
    permissionModes: string[];
  };
  // Router falls back to a default empty list when model-router.json is
  // absent; the frontend cares about the shape, not the count.
  assert.ok(Array.isArray(body.models));
  assert.deepEqual(body.efforts, ["low", "medium", "high", "max"]);
  assert.deepEqual(body.permissionModes, [
    "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan",
  ]);
});
