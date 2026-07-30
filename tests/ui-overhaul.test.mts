import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("workspace UI contract", () => {
  test("loads the dedicated workspace theme after legacy component styles", () => {
    const html = read("web/index.html");
    assert.ok(html.indexOf('href="style.css"') < html.indexOf('href="workspace.css?v=20260730"'));
  });

  test("provides board health and progressively disclosed filters", () => {
    const html = read("web/index.html");
    assert.match(html, /id="board-overview"/);
    assert.match(html, /id="overview-doing"/);
    assert.match(html, /id="filter-toggle-btn"[^>]+aria-controls="filter-advanced"/);
    assert.match(html, /id="filter-advanced"[^>]+hidden/);
  });

  test("updates visible workflow counts from the rendered task set", () => {
    const app = read("web/app.js");
    assert.match(app, /setOverview\("overview-total", visibleTasks\.length\)/);
    assert.match(app, /task\.column === "doing"/);
    assert.match(app, /task\.column === "review"/);
  });

  test("closes task detail before switching top-level tabs", () => {
    const app = read("web/app.js");
    const handler = app.slice(app.indexOf("function attachTabRouter"), app.indexOf("function attachFilterDisclosure"));
    assert.match(handler, /OpenKanTaskView\?\.getCurrentTaskId/);
    assert.ok(handler.indexOf("OpenKanTaskView.close()") < handler.indexOf("activateTab("));
  });

  test("routes the global new-task action to the visible Tasks workspace", () => {
    const app = read("web/app.js");
    const handler = app.slice(app.indexOf("function openModal"), app.indexOf("function closeModal"));
    assert.match(handler, /OpenKanTaskView\?\.getCurrentTaskId/);
    assert.match(handler, /activateTab\("tasks"\)/);
    assert.ok(handler.indexOf('activateTab("tasks")') < handler.indexOf("modal.hidden = false"));
  });

  test("defines responsive, accessible mobile behavior", () => {
    const css = read("web/workspace.css");
    assert.match(css, /@media \(max-width: 820px\)/);
    assert.match(css, /scroll-snap-type: x mandatory/);
    assert.match(css, /column\[data-column="todo"\] \{ order: 1; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
