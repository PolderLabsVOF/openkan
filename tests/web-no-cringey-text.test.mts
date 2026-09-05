import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const FORBIDDEN_PHRASES = [
  "Move work forward",
  "Plan, coordinate, and review every task",
  "local-first workspace",
  "See the work before it becomes noise",
  "One place for the active project, live operators",
] as const;

const FILES_TO_SCAN = [
  "web/index.html",
  "web/app.js",
  "web/home-view.js",
] as const;

describe("web UI: no marketing-fluff copy", () => {
  for (const phrase of FORBIDDEN_PHRASES) {
    test(`"${phrase}" is absent from the web UI source`, () => {
      for (const file of FILES_TO_SCAN) {
        const source = read(file);
        assert.equal(
          source.includes(phrase),
          false,
          `expected "${phrase}" to be removed from ${file}`,
        );
      }
    });
  }

  test("the tasks page intro no longer renders tagline/subtitle markup", () => {
    const html = read("web/index.html");
    const tasksIntro = html.match(/<div class="workspace-intro">[\s\S]*?<\/div>/);
    assert.ok(tasksIntro, "tasks workspace-intro block should exist");
    assert.equal(/<h2>/i.test(tasksIntro[0]), false, "no <h2> should remain inside workspace-intro");
    assert.equal(/<p>/i.test(tasksIntro[0]), false, "no <p> should remain inside workspace-intro");
  });

  test("the home command header keeps its eyebrow label but drops the tagline", () => {
    const home = read("web/home-view.js");
    assert.match(home, /<span class="workspace-eyebrow">Workspace command center<\/span>/);
    assert.equal(home.includes("See the work before it becomes noise"), false);
    assert.equal(home.includes("One place for the active project"), false);
  });

  test("the footer keeps the version label without the tagline suffix", () => {
    const html = read("web/index.html");
    const footer = html.match(/<footer class="footer">[\s\S]*?<\/footer>/);
    assert.ok(footer, "page footer should exist");
    assert.match(footer[0], /OpenKan v0\.3\.0/);
    assert.equal(/local-first workspace/i.test(footer[0]), false);
  });
});
