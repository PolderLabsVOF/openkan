// tests/web-status-indicator.test.mts — regression tests for the shared
// task status derivation helper (web/status.js). The bug being guarded:
// every task on the board used to render with the same "idle" pill
// because the web client read the literal `state` field from the API,
// which the server defaults to "idle" regardless of column.
//
// `displayState(task)` is loaded in a jsdom-less shim: we stub
// `window`, read `web/status.js` as a string, and evaluate it in a
// Function-bound scope. This keeps the test in plain Node + node:test,
// matching the rest of the suite.

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const statusJs = readFileSync(join(root, "web/status.js"), "utf8");

function loadDisplayState(): (task: unknown) => string {
  const fakeWindow: { OpenKanStatus?: { displayState: (t: unknown) => string } } = {};
  // The helper is an IIFE that assigns `window.OpenKanStatus`. Run it
  // against a fresh object so test isolation holds.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const runner = new Function("window", statusJs);
  runner(fakeWindow);
  if (!fakeWindow.OpenKanStatus) throw new Error("status.js did not register window.OpenKanStatus");
  return fakeWindow.OpenKanStatus.displayState;
}

const displayState = loadDisplayState();

describe("web/status.js — task status derivation", () => {
  it("returns 'cancelled' for archived tasks regardless of column", () => {
    assert.equal(displayState({ column: "todo", archived: true }), "cancelled");
    assert.equal(displayState({ column: "doing", archived: true }), "cancelled");
    assert.equal(displayState({ column: "done", archived: true, state: "done" }), "cancelled");
  });

  it("passes explicit non-idle lifecycle states through unchanged", () => {
    assert.equal(displayState({ column: "todo", state: "running" }), "running");
    assert.equal(displayState({ column: "doing", state: "waiting-for-input" }), "waiting-for-input");
    assert.equal(displayState({ column: "doing", state: "failed" }), "failed");
    assert.equal(displayState({ column: "review", state: "cancelled" }), "cancelled");
    assert.equal(displayState({ column: "doing", state: "done" }), "done");
  });

  it("derives in_progress from the doing column when state is the idle default", () => {
    assert.equal(displayState({ column: "doing", state: "idle" }), "in_progress");
    assert.equal(displayState({ column: "doing" }), "in_progress");
  });

  it("derives review from the review column when state is the idle default", () => {
    assert.equal(displayState({ column: "review", state: "idle" }), "review");
    assert.equal(displayState({ column: "review" }), "review");
  });

  it("derives done from the done column when state is the idle default", () => {
    assert.equal(displayState({ column: "done", state: "idle" }), "done");
    assert.equal(displayState({ column: "done" }), "done");
  });

  it("derives pending from backlog/todo when state is the idle default", () => {
    assert.equal(displayState({ column: "backlog", state: "idle" }), "pending");
    assert.equal(displayState({ column: "todo", state: "idle" }), "pending");
    assert.equal(displayState({ column: "backlog" }), "pending");
    assert.equal(displayState({ column: "todo" }), "pending");
  });

  it("falls back to pending for an empty/null task", () => {
    assert.equal(displayState(null), "pending");
    assert.equal(displayState(undefined), "pending");
  });

  it("accepts either the `state` or `status` API field", () => {
    // Some legacy endpoints use `status`. The helper falls back to it
    // so existing callers don't break.
    assert.equal(displayState({ column: "doing", status: "running" }), "running");
    assert.equal(displayState({ column: "doing", state: undefined, status: "running" }), "running");
  });

  it("web/app.js delegates to window.OpenKanStatus.displayState", () => {
    // Structural guard: prevents accidental regression to the old
    // `t.state ?? t.status ?? "idle"` shortcut. If anyone reintroduces
    // the shortcut, this string assertion fails.
    const appJs = readFileSync(join(root, "web/app.js"), "utf8");
    assert.match(appJs, /OpenKanStatus\??\s*\.\s*displayState/);
    assert.doesNotMatch(appJs, /t\.state\s*\?\?\s*t\.status\s*\?\?\s*"idle"/);
  });

  it("web/task-view.js delegates to window.OpenKanStatus.displayState", () => {
    const taskViewJs = readFileSync(join(root, "web/task-view.js"), "utf8");
    assert.match(taskViewJs, /OpenKanStatus\??\s*\.\s*displayState/);
    assert.doesNotMatch(taskViewJs, /t\.state\s*\?\?\s*t\.status\s*\?\?\s*"idle"/);
  });

  it("web/index.html loads status.js before task-view.js and app.js", () => {
    const html = readFileSync(join(root, "web/index.html"), "utf8");
    const statusIdx = html.indexOf('src="status.js"');
    const taskViewIdx = html.indexOf('src="task-view.js"');
    const appIdx = html.indexOf('src="app.js"');
    assert.ok(statusIdx > 0, "status.js must be loaded by index.html");
    assert.ok(statusIdx < taskViewIdx, "status.js must load before task-view.js");
    assert.ok(statusIdx < appIdx, "status.js must load before app.js");
  });

  it("web/style.css defines colour rules for the new state classes", () => {
    const css = readFileSync(join(root, "web/style.css"), "utf8");
    assert.match(css, /\.status-dot\.pending/);
    assert.match(css, /\.status-dot\.in_progress/);
    assert.match(css, /\.status-dot\.review/);
    assert.match(css, /\.state-pill\.state-pending/);
    assert.match(css, /\.state-pill\.state-in_progress/);
    assert.match(css, /\.state-pill\.state-review/);
  });
});
