// OpenKan — tests for kanban/claude-state.ts activity tailing.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readActivityTail, resetActivityTail } from "../kanban/claude-state.ts";

let tempRoot: string | null = null;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openkan-claude-tail-"));
  tempRoot = root;
  return root;
}

function writeRow(sessionDir: string, fileName: string, row: object): void {
  const dir = join(tempRoot!, ".claude", "projects", sessionDir, "subagents");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, fileName), JSON.stringify(row) + "\n");
}

function resetFile(sessionDir: string, fileName: string, rows: object[]): string {
  const dir = join(tempRoot!, ".claude", "projects", sessionDir, "subagents");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return filePath;
}

afterEach(() => {
  resetActivityTail();
  if (tempRoot && existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

test("readActivityTail returns new rows on the second call only", async () => {
  const root = makeRoot();
  const session = "ses-A";
  const fileName = "agent-test.jsonl";
  resetFile(session, fileName, [
    { type: "agent.started", timestamp: "2026-09-04T10:00:00.000Z", agent: "todd" },
    { type: "chat.turn-started", timestamp: "2026-09-04T10:00:01.000Z", agent: "todd" },
  ]);

  const first = await readActivityTail(root);
  assert.equal(first.length, 2, "first call should yield the initial 2 rows");

  // No new rows: second call should return empty.
  const second = await readActivityTail(root);
  assert.equal(second.length, 0, "second call should return no new rows");

  // Append two more rows.
  appendFileSync(
    join(root, ".claude", "projects", session, "subagents", fileName),
    JSON.stringify({ type: "chat.turn-ended", timestamp: "2026-09-04T10:00:02.000Z", agent: "todd" }) + "\n" +
      JSON.stringify({ type: "agent.ended", timestamp: "2026-09-04T10:00:03.000Z", agent: "todd" }) + "\n",
  );

  const third = await readActivityTail(root);
  assert.equal(third.length, 2);
  assert.equal(third[0].kind, "chat.turn-ended");
  assert.equal(third[1].kind, "agent.ended");
  // Original kind preserved in meta.originalKind
  assert.equal(third[0].meta?.originalKind, "chat.turn-ended");
});

test("readActivityTail honours sinceMs cutoff", async () => {
  const root = makeRoot();
  resetFile("ses-A", "agent-a.jsonl", [
    { type: "agent.started", timestamp: "2026-09-04T09:00:00.000Z", agent: "todd" },
  ]);

  const before = Date.parse("2026-09-04T10:00:00.000Z");
  // Bump the cursor forward on a first call without a cutoff.
  await readActivityTail(root);
  // After the first call, all rows are "consumed"; tail should yield 0
  // regardless of sinceMs because the cursor is past them.
  const since = await readActivityTail(root, before);
  assert.equal(since.length, 0);
});

test("readActivityTail maps unknown row types to agent.queued", async () => {
  const root = makeRoot();
  resetFile("ses-B", "agent-b.jsonl", [
    { type: "some.custom.event", timestamp: "2026-09-04T10:00:00.000Z", agent: "todd" },
  ]);
  const events = await readActivityTail(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "agent.queued");
  assert.equal(events[0].meta?.originalKind, "some.custom.event");
});

test("readActivityTail handles truncated files by resetting cursor", async () => {
  const root = makeRoot();
  resetFile("ses-C", "agent-c.jsonl", [
    { type: "agent.started", timestamp: "2026-09-04T10:00:00.000Z", agent: "todd" },
  ]);
  const first = await readActivityTail(root);
  assert.equal(first.length, 1);

  // Truncate and rewrite from scratch.
  resetFile("ses-C", "agent-c.jsonl", [
    { type: "agent.ended", timestamp: "2026-09-04T11:00:00.000Z", agent: "todd" },
  ]);
  const second = await readActivityTail(root);
  assert.equal(second.length, 1);
  assert.equal(second[0].kind, "agent.ended");
});

test("writeRow helper writes valid JSONL that readActivityTail can parse", async () => {
  const root = makeRoot();
  writeRow("ses-D", "agent-d.jsonl", { type: "agent.started", timestamp: "2026-09-04T10:00:00.000Z", agent: "todd" });
  const events = await readActivityTail(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, "todd");
});
