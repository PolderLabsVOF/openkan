// OpenKan — external Claude Code session discovery tests.
//
// Coverage:
//   1. discoverExternalSessions finds Claude Code sessions under the
//      encoded project dir and tags them source=claude-code.
//   2. Sessions from other projects' encoded dirs are filtered out.
//   3. Corrupt/missing JSONL files are skipped silently (no throw).
//   4. The history fallback returns source=history-fallback entries whose
//      title is derived from the `display` field.
//   5. GET /api/chat/sessions?include=external returns both internal and
//      external sessions, tagged by source.
//   6. GET /api/chat/sessions without the query stays native-only
//      (backwards-compatible).
//   7. Truncation: 600 external sessions produce a 500-item response plus
//      truncated: true at the top level.

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
  appendTurn,
  discoverExternalSessions,
  encodeClaudeProjectDir,
  generateSessionId,
  handleChatRequest,
  listSessions,
  type ChatSessionSummary,
} from "../kanban/chat.ts";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openkan-chat-ext-"));
  roots.push(root);
  return root;
}

function mockClaudeHome(root: string): string {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = home;
  return home;
}

function restoreClaudeHome(): void {
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
}

afterEach(() => {
  restoreClaudeHome();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Encode an external-session JSONL line in Claude Code's wire format. */
function externalLine(type: "user" | "assistant", message: Record<string, unknown>, ts: string, model?: string): string {
  const obj: Record<string, unknown> = { type, message, timestamp: ts };
  if (model) obj.model = model;
  return JSON.stringify(obj);
}

/** Write a complete external-session JSONL with one user + one assistant turn. */
function writeExternalSession(home: string, projectRoot: string, sessionId: string, opts: { title: string; model?: string; ts?: string }): void {
  const encoded = encodeClaudeProjectDir(projectRoot);
  const dir = join(home, ".claude", "projects", encoded);
  mkdirSync(dir, { recursive: true });
  const ts = opts.ts ?? "2026-09-04T10:00:00.000Z";
  const lines = [
    externalLine(
      "user",
      { role: "user", content: opts.title },
      ts,
    ),
  ];
  if (opts.model) {
    const ts2 = "2026-09-04T10:00:01.000Z";
    lines.push(externalLine(
      "assistant",
      { role: "assistant", content: [{ type: "text", text: "ok" }], model: opts.model },
      ts2,
    ));
  }
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

/** Append one or more history entries tagged with `entryProject`'s encoded
 *  form to ~/.claude/history.jsonl. The file is created on first write;
 *  subsequent calls append so multiple project tags can coexist in one
 *  fixture. */
function writeRawHistoryEntry(
  home: string,
  entryProject: string,
  entries: Array<{ sessionId: string; display: string; timestamp: string }>,
): void {
  const encoded = encodeClaudeProjectDir(entryProject);
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((entry) => JSON.stringify({
    display: entry.display,
    pastedContents: {},
    timestamp: entry.timestamp,
    project: encoded,
    sessionId: entry.sessionId,
  }));
  writeFileSync(join(dir, "history.jsonl"), lines.map((l) => l + "\n").join(""), { flag: "a" });
}

function writeHistoryFallback(home: string, projectRoot: string, entries: Array<{ sessionId: string; display: string; timestamp: string }>): void {
  writeRawHistoryEntry(home, projectRoot, entries);
}

// ─── discoverExternalSessions ─────────────────────────────────────────────────

test("discoverExternalSessions finds Claude Code sessions under the encoded project dir", () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  writeExternalSession(home, root, "ses-aaa", { title: "first external", model: "minimax/MiniMax-M3" });
  writeExternalSession(home, root, "ses-bbb", { title: "second external" });

  const summaries = discoverExternalSessions(root);
  assert.equal(summaries.length, 2);
  const ids = summaries.map((s) => s.id).sort();
  assert.deepEqual(ids, ["ses-aaa", "ses-bbb"]);
  for (const summary of summaries) {
    assert.equal(summary.source, "claude-code");
    assert.equal(summary.archived, false);
  }
  const aaa = summaries.find((s) => s.id === "ses-aaa");
  assert.equal(aaa?.title, "first external");
  assert.equal(aaa?.model, "minimax/MiniMax-M3");
  const bbb = summaries.find((s) => s.id === "ses-bbb");
  assert.equal(bbb?.title, "second external");
  assert.equal(bbb?.model, null);
});

test("discoverExternalSessions filters out sessions whose encoded dir does not match", () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  const otherRoot = "/tmp/some-other-project";
  writeExternalSession(home, root, "ses-mine", { title: "belongs here" });
  writeExternalSession(home, otherRoot, "ses-foreign", { title: "belongs elsewhere" });

  const summaries = discoverExternalSessions(root);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, "ses-mine");
  // Also verify that asking for the other project's dir flips the membership.
  const foreign = discoverExternalSessions(otherRoot);
  assert.equal(foreign.length, 1);
  assert.equal(foreign[0].id, "ses-foreign");
});

test("discoverExternalSessions skips corrupt JSONL silently without breaking the list", () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  writeExternalSession(home, root, "ses-good", { title: "intact session" });

  // Write a half-written / corrupt file directly into the encoded dir.
  const encoded = encodeClaudeProjectDir(root);
  const dir = join(home, ".claude", "projects", encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ses-corrupt.jsonl"), "{not valid json at all\n\x00\x00\x00");

  const summaries = discoverExternalSessions(root);
  // The good one survives, the corrupt one is dropped — no exception.
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, "ses-good");
});

test("discoverExternalSessions history fallback returns source=history-fallback summaries", () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  // One entry tagged with this project, one tagged with a foreign project —
  // the foreign one must be filtered out by the per-project `project`
  // check.
  writeHistoryFallback(home, root, [
    { sessionId: "ses-fallback", display: "Continue the bug investigation", timestamp: "2026-09-04T10:00:00.000Z" },
  ]);
  writeRawHistoryEntry(home, "/tmp/some-other-project", [
    { sessionId: "ses-other", display: "Other project chat", timestamp: "2026-09-04T10:00:00.000Z" },
  ]);
  const otherEncoded = encodeClaudeProjectDir("/tmp/some-other-project");
  assert.ok(otherEncoded !== encodeClaudeProjectDir(root));

  const summaries = discoverExternalSessions(root);
  assert.equal(summaries.length, 1);
  const fb = summaries[0];
  assert.equal(fb.id, "ses-fallback");
  assert.equal(fb.source, "history-fallback");
  assert.equal(fb.title, "Continue the bug investigation");
  assert.equal(fb.model, null);
  assert.equal(fb.turnCount, 0);
});

test("discoverExternalSessions merges claude-code and history-fallback without duplicating ids", () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  writeExternalSession(home, root, "ses-shared", { title: "real transcript" });
  writeHistoryFallback(home, root, [
    { sessionId: "ses-shared", display: "history entry", timestamp: "2026-09-04T11:00:00.000Z" },
    { sessionId: "ses-history-only", display: "metadata only", timestamp: "2026-09-04T11:00:00.000Z" },
  ]);
  const summaries = discoverExternalSessions(root);
  // The session present in BOTH places appears once (claude-code wins so
  // the rich transcript is visible); the history-only entry backfills.
  const shared = summaries.filter((s) => s.id === "ses-shared");
  assert.equal(shared.length, 1);
  assert.equal(shared[0].source, "claude-code");
  assert.equal(summaries.find((s) => s.id === "ses-history-only")?.source, "history-fallback");
});

// ─── HTTP endpoint ──────────────────────────────────────────────────────────

test("GET /api/chat/sessions?include=external returns both internal and external sessions, tagged correctly", async () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  writeExternalSession(home, root, "ses-ext", { title: "external conversation", model: "minimax/MiniMax-M3" });
  const internalId = generateSessionId();
  appendTurn(root, internalId, { ts: "2026-09-04T12:00:00.000Z", role: "user", content: "internal conversation" });
  appendTurn(root, internalId, { ts: "2026-09-04T12:00:01.000Z", role: "assistant", content: "ok" });

  const response = await handleChatRequest(
    root,
    new Request("http://l/api/chat/sessions?include=external"),
    "/api/chat/sessions",
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { sessions: ChatSessionSummary[]; truncated: boolean };

  const bySource = new Map<string, ChatSessionSummary[]>();
  for (const summary of body.sessions) {
    const arr = bySource.get(summary.source) ?? [];
    arr.push(summary);
    bySource.set(summary.source, arr);
  }
  assert.equal(bySource.get("openkan")?.length, 1);
  assert.equal(bySource.get("openkan")?.[0]?.id, internalId);
  assert.equal(bySource.get("claude-code")?.length, 1);
  assert.equal(bySource.get("claude-code")?.[0]?.id, "ses-ext");
  // The default endpoint shape now always includes truncated (false in
  // the happy path).
  assert.equal(body.truncated, false);
});

test("GET /api/chat/sessions without include=external returns only OpenKan sessions (backwards-compatible)", async () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  writeExternalSession(home, root, "ses-ext", { title: "external conversation" });
  const internalId = generateSessionId();
  appendTurn(root, internalId, { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "internal conversation" });

  const response = await handleChatRequest(
    root,
    new Request("http://l/api/chat/sessions"),
    "/api/chat/sessions",
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { sessions: ChatSessionSummary[]; truncated: boolean };
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].id, internalId);
  assert.equal(body.sessions[0].source, "openkan");
  assert.equal(body.truncated, false);
});

test("Unified list endpoint caps at 500 entries and reports truncated:true when 600 external sessions exist", async () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  // Generate 600 fake external sessions. The discovery code only needs the
  // file to exist + parse a user line for title derivation, so we keep the
  // payload tiny.
  const encoded = encodeClaudeProjectDir(root);
  const dir = join(home, ".claude", "projects", encoded);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 600; i++) {
    const sid = `ses-bulk-${String(i).padStart(4, "0")}`;
    const lines = [
      externalLine(
        "user",
        { role: "user", content: `bulk chat number ${i}` },
        "2026-09-04T10:00:00.000Z",
      ),
    ];
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
  }
  // Also seed an OpenKan session so the union tests the merge+cap path.
  const internalId = generateSessionId();
  appendTurn(root, internalId, { ts: "2026-09-04T09:00:00.000Z", role: "user", content: "internal" });

  const response = await handleChatRequest(
    root,
    new Request("http://l/api/chat/sessions?include=external"),
    "/api/chat/sessions",
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { sessions: ChatSessionSummary[]; truncated: boolean };
  // Internal (1) + external (599) is still capped at 500 from the union.
  assert.equal(body.sessions.length, 500);
  assert.equal(body.truncated, true);
});

// Sanity check: the existing single-argument listSessions still works after
// the optional-second-argument extension — used widely by the rest of the
// codebase.
test("listSessions(projectRoot) without options keeps the native-only contract", () => {
  const root = makeRoot();
  const home = mockClaudeHome(root);
  writeExternalSession(home, root, "ses-ext", { title: "external" });
  const internalId = generateSessionId();
  appendTurn(root, internalId, { ts: "2026-09-04T10:00:00.000Z", role: "user", content: "internal" });

  const summaries = listSessions(root);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].source, "openkan");
  assert.equal(summaries[0].id, internalId);
});

// Touch existsSync import to keep it referenced (avoid the "unused import"
// warning that would otherwise surface in toolchains that enable noUnusedLocals).
assert.ok(typeof existsSync === "function");
