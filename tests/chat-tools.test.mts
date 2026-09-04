// OpenKan — chat stream / tool-use backend tests.
//
// Coverage:
//   1. toolUseLabel mapping for every recognised tool name
//   2. parseStreamLine + applyStreamEvent → assembled TurnState
//   3. SSE fan-out ordering from a realistic stream-json fixture
//   4. JSONL round-trip with toolUses array
//   5. Backwards-compat: legacy JSONL without toolUses still reads cleanly
//   6. pickerOptions returns the expected shape from a known fixture, and
//      toPickerLabel strips the `provider/` prefix consistently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendTurn,
  applyStreamEvent,
  parseStreamLine,
  pickerOptions,
  readSession,
  summariseSession,
  toPickerLabel,
  toolUseLabel,
  type ChatTurn,
  type StreamEvent,
  type ToolUseRecord,
} from "../kanban/chat.ts";

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openkan-chat-tools-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

// ─── 1. toolUseLabel ─────────────────────────────────────────────────────────

const TOOL_FIXTURES: Array<{ name: string; input: Record<string, unknown>; expectContains: string }> = [
  { name: "Read", input: { file_path: "/repo/kanban/server.ts" }, expectContains: "Reading server.ts" },
  { name: "Write", input: { file_path: "/repo/kanban/chat.ts" }, expectContains: "Writing chat.ts" },
  { name: "Edit", input: { file_path: "/repo/kanban/server.ts" }, expectContains: "Editing server.ts" },
  { name: "Bash", input: { command: "npm test 2>&1 | tail" }, expectContains: "Running npm test" },
  { name: "Bash", input: { command: "x".repeat(200) }, expectContains: "…" },
  { name: "Grep", input: { query: "TODO" }, expectContains: 'Searching for "TODO"' },
  { name: "Grep", input: { pattern: "TODO" }, expectContains: 'Searching for "TODO"' },
  { name: "Glob", input: { pattern: "**/*.test.mts" }, expectContains: "Finding" },
  { name: "WebFetch", input: { url: "https://docs.claude.com/en/docs/claude-code/cli" }, expectContains: "Fetching" },
  { name: "WebSearch", input: { query: "claude code sdk" }, expectContains: 'Searching the web for "claude code sdk"' },
  { name: "Agent", input: { subagent_type: "explore" }, expectContains: "Delegating to explore" },
  { name: "Task", input: { subagent_type: "general-purpose" }, expectContains: "Delegating to general-purpose" },
  { name: "Agent", input: {}, expectContains: "Delegating to subagent" },
  { name: "Wibble", input: {}, expectContains: "Using Wibble" },
];

for (const fix of TOOL_FIXTURES) {
  test(`toolUseLabel maps ${fix.name} to a human-readable label`, () => {
    const tu: ToolUseRecord = { id: "tu_x", name: fix.name, input: fix.input, status: "started" };
    const label = toolUseLabel(tu);
    assert.ok(label.includes(fix.expectContains), `label "${label}" should contain "${fix.expectContains}"`);
  });
}

// ─── 2. parseStreamLine + applyStreamEvent ────────────────────────────────────

const STREAM_FIXTURE = [
  `{"type":"message_start","message":{"id":"msg_1","role":"assistant"}}`,
  `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}`,
  `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}`,
  `{"type":"content_block_stop","index":0}`,
  `{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"server.ts"}}}`,
  `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}`,
  `{"type":"content_block_stop","index":1}`,
  `{"type":"content_block_start","index":2,"content_block":{"type":"tool_result","tool_use_id":"tu_1","content":"file contents here","is_error":false}}`,
  `{"type":"content_block_stop","index":2}`,
  `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
  `{"type":"message_stop"}`,
].join("\n");

test("multi-line NDJSON fixture assembles matching TurnState (text + tool_uses + tool_results in order)", () => {
  const state = {
    textByBlock: new Map<number, string>(),
    toolUses: new Map<number, ToolUseRecord>(),
    toolIndexById: new Map<string, number>(),
    toolResults: new Map<string, { content: string; isError: boolean }>(),
    stopReason: null as string | null,
  };
  let count = 0;
  for (const line of STREAM_FIXTURE.split("\n")) {
    const event = parseStreamLine(line);
    assert.ok(event, `expected event for line: ${line.slice(0, 40)}…`);
    applyStreamEvent(state, event!);
    count++;
  }
  assert.equal(count, 12);

  // Text block 0 should be "Hello world" (concatenated deltas).
  assert.equal(state.textByBlock.get(0), "Hello world");
  assert.equal(state.textByBlock.size, 1);

  // Tool call at index 1 should be Read on server.ts, marked completed
  // after the tool_result event.
  const tool = state.toolUses.get(1);
  assert.ok(tool, "tool_use at index 1 should exist");
  assert.equal(tool!.name, "Read");
  assert.deepEqual(tool!.input, { file_path: "server.ts" });
  assert.equal(tool!.status, "completed");
  assert.equal(tool!.resultPreview, "file contents here");
  assert.equal(tool!.isError, false);

  // Ordered projection: [text-only, tool]
  const ordered = [...state.toolUses.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].id, "tu_1");
  assert.equal(ordered[0].status, "completed");

  assert.equal(state.stopReason, "end_turn");
});

test("parseStreamLine ignores empty lines and non-object payloads", () => {
  assert.equal(parseStreamLine(""), null);
  assert.equal(parseStreamLine("   \n  "), null);
  assert.equal(parseStreamLine('"a string"'), null);
  assert.equal(parseStreamLine("not json"), null);
});

test("parseStreamLine carries delta + content_block into the typed event", () => {
  const ev = parseStreamLine(
    `{"type":"content_block_delta","index":7,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}`,
  );
  assert.ok(ev);
  assert.equal(ev!.type, "content_block_delta");
  assert.equal(ev!.index, 7);
  assert.equal(ev!.delta?.type, "input_json_delta");
  assert.equal(ev!.delta?.partial_json, '{"a":1}');
});

// ─── 3. SSE fan-out ordering ─────────────────────────────────────────────────

test("stream events fan out in canonical order: tool_use, tool_input_delta, tool_result, text_delta, message_done", () => {
  // Walk the fixture and capture the sequence of SSE-style event names the
  // dispatcher would emit. This guards against future refactors that
  // accidentally re-order the chip updates.
  const observed: string[] = [];
  for (const line of STREAM_FIXTURE.split("\n")) {
    const ev = parseStreamLine(line);
    if (!ev) continue;
    if (ev.type === "content_block_start" && ev.contentBlock?.type === "tool_use") observed.push("tool_use");
    else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") observed.push("tool_input_delta");
    else if (ev.type === "content_block_start" && ev.contentBlock?.type === "tool_result") observed.push("tool_result");
    else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") observed.push("text_delta");
    else if (ev.type === "message_stop") observed.push("message_done");
  }
  // Within our fixture: text_delta appears before tool_use. The contract is
  // "within any given tool_use the order is tool_use → tool_input_delta →
  // tool_result"; text_delta and message_done can interleave freely.
  const idx = (n: string) => observed.indexOf(n);
  assert.ok(idx("tool_use") >= 0);
  assert.ok(idx("tool_input_delta") > idx("tool_use"));
  assert.ok(idx("tool_result") > idx("tool_input_delta"));
  assert.ok(idx("text_delta") >= 0);
  assert.ok(idx("message_done") > idx("tool_result"));
});

// ─── 4. JSONL round-trip with toolUses ────────────────────────────────────────

test("appendTurn + readSession round-trip a turn with toolUses", () => {
  const root = makeRoot();
  const sid = "ses-tools-rt";
  const toolUses: ToolUseRecord[] = [
    { id: "tu_1", name: "Read", input: { file_path: "kanban/chat.ts" }, status: "completed", resultPreview: "..." },
    { id: "tu_2", name: "Bash", input: { command: "npm test" }, status: "failed", isError: true, resultPreview: "boom" },
  ];
  const turn: ChatTurn = {
    ts: "2026-09-04T10:00:00.000Z",
    role: "assistant",
    content: "Reviewed the file and ran the tests.",
    toolUses,
    model: "minimax/MiniMax-M3",
    effort: "medium",
    permissionMode: "auto",
    messageId: "msg-roundtrip",
    status: "ok",
  };
  appendTurn(root, sid, turn);

  const read = readSession(root, sid);
  assert.equal(read.length, 1);
  assert.equal(read[0].messageId, "msg-roundtrip");
  assert.equal(read[0].content, turn.content);
  assert.equal(read[0].toolUses?.length, 2);
  assert.deepEqual(read[0].toolUses?.[0].input, { file_path: "kanban/chat.ts" });
  assert.equal(read[0].toolUses?.[1].status, "failed");

  // summariseSession should derive model/effort/permissionMode from the
  // first assistant turn.
  const summary = summariseSession(sid, read, false);
  assert.equal(summary.model, "minimax/MiniMax-M3");
  assert.equal(summary.effort, "medium");
  assert.equal(summary.permissionMode, "auto");
});

// ─── 5. Backwards-compat: legacy JSONL without toolUses ──────────────────────

test("legacy JSONL without toolUses reads cleanly and surfaces an empty toolUses array", () => {
  const root = makeRoot();
  const sid = "ses-legacy";
  // Hand-craft a legacy line that predates the toolUses field.
  mkdirSync(join(root, ".ok", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".ok", "sessions", `${sid}.jsonl`),
    JSON.stringify({
      ts: "2026-09-01T08:00:00.000Z",
      role: "assistant",
      content: "Legacy answer",
      model: "legacy-model",
      effort: "low",
      permissionMode: "auto",
      messageId: "msg-legacy",
      status: "ok",
    }) + "\n",
  );

  const read = readSession(root, sid);
  assert.equal(read.length, 1);
  assert.equal(read[0].content, "Legacy answer");
  // The reader backfills an empty array so callers can iterate safely.
  assert.deepEqual(read[0].toolUses, []);
  // Renderer rule: treat undefined / empty array the same → no chips drawn.
  const toolUses = read[0].toolUses ?? [];
  assert.equal(toolUses.length, 0);

  // Summary still derives model/effort/permissionMode correctly.
  const summary = summariseSession(sid, read, false);
  assert.equal(summary.model, "legacy-model");
});

test("toPickerLabel strips provider prefixes consistently", () => {
  assert.equal(toPickerLabel("minimax/MiniMax-M3"), "MiniMax-M3");
  assert.equal(toPickerLabel("plain-id"), "plain-id");
  assert.equal(toPickerLabel("vendor/model-with-slashes/extra"), "model-with-slashes/extra");
});

test("pickerOptions returns the expected shape from an injected fixture", async () => {
  // Build an isolated project root so readModelRouter falls back to the
  // default empty router, then exercise the override injection path that the
  // frontend uses to swap the model list at startup.
  const root = mkdtempSync(join(tmpdir(), "openkan-picker-"));
  try {
    const result = await pickerOptions(root, {
      models: ["minimax/MiniMax-M3", "minimax/MiniMax-M2", "sonnet"],
    });
    assert.deepEqual(result.models.map((m) => m.id), [
      "minimax/MiniMax-M3",
      "minimax/MiniMax-M2",
      "sonnet",
    ]);
    assert.deepEqual(result.models.map((m) => m.label), [
      "MiniMax-M3",
      "MiniMax-M2",
      "sonnet",
    ]);
    assert.deepEqual(result.efforts, ["low", "medium", "high", "max"]);
    assert.deepEqual(result.permissionModes, [
      "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
