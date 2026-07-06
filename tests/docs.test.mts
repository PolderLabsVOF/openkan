// Tests for the docs module (kanban/docs.ts)

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOT = "/tmp/openkan-docs-test";
// The docs root is TEST_ROOT itself; listDocs defaults docsDir to "docs"
// so we need to put our files under TEST_ROOT/docs
const DOCS_ROOT = join(TEST_ROOT, "docs");

describe("docs.ts", async () => {
  let listDocs: (opts: { root: string; docsDir?: string; maxDepth?: number }) => { entries: any[] };
  let readDoc: (opts: { root: string; relPath: string; render?: boolean }) => Promise<any>;

  before(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(join(DOCS_ROOT, "milestones"), { recursive: true });
    mkdirSync(join(DOCS_ROOT, "guides"), { recursive: true });
    writeFileSync(join(DOCS_ROOT, "README.md"), "# Welcome\n\nThis is the readme.\n");
    writeFileSync(join(DOCS_ROOT, "milestones", "M1.mdx"), "# Milestone 1\n\n## Goals\n\n- Goal 1\n- Goal 2\n");
    writeFileSync(join(DOCS_ROOT, "guides", "setup.md"), "# Setup Guide\n\nFollow these steps.\n");
    writeFileSync(join(DOCS_ROOT, "guides", "advanced.md"), "# Advanced\n\nSome advanced content.\n");

    const mod = await import("../kanban/docs.ts");
    listDocs = mod.listDocs;
    readDoc = mod.readDoc;
  });

  after(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ─── listDocs ───────────────────────────────────────────────────────────────

  it("listDocs returns nested tree of entries", () => {
    // docs root is TEST_ROOT/docs (default docsDir = "docs")
    const { entries } = listDocs({ root: TEST_ROOT });
    assert.ok(Array.isArray(entries));
    const names = entries.map((e: any) => e.name).sort();
    assert.deepStrictEqual(names, ["README.md", "guides", "milestones"]);
  });

  it("listDocs includes size and modified for files", () => {
    const { entries } = listDocs({ root: TEST_ROOT });
    const readme = entries.find((e: any) => e.name === "README.md");
    assert.ok(readme, "README.md should be present");
    assert.strictEqual(readme.isDir, false);
    assert.ok(typeof readme.size === "number");
    assert.ok(typeof readme.modified === "string");
    assert.ok(readme.modified.includes("T"));
  });

  it("listDocs includes children for directories", () => {
    const { entries } = listDocs({ root: TEST_ROOT });
    const guides = entries.find((e: any) => e.name === "guides");
    assert.ok(guides, "guides dir should be present");
    assert.strictEqual(guides.isDir, true);
    assert.ok(Array.isArray(guides.children));
    const guideNames = guides.children.map((c: any) => c.name).sort();
    assert.deepStrictEqual(guideNames, ["advanced.md", "setup.md"]);
  });

  it("listDocs returns empty entries for non-existent docs dir", () => {
    // root without a docs/ subdirectory
    const { entries } = listDocs({ root: "/tmp", docsDir: "nonexistent-docs-folder-xyz" });
    assert.deepStrictEqual(entries, []);
  });

  it("listDocs respects maxDepth", () => {
    const shallow = listDocs({ root: TEST_ROOT, maxDepth: 1 });
    const guides = shallow.entries.find((e: any) => e.name === "guides");
    assert.ok(guides, "guides should be present");
    assert.strictEqual(guides.isDir, true);
    // With maxDepth=1, children should be empty (depth limit reached, no recursion)
    assert.ok(Array.isArray(guides.children), "children should be an array (empty due to depth limit)");
    assert.strictEqual(guides.children.length, 0);
  });

  // ─── Path safety ─────────────────────────────────────────────────────────────

  it("readDoc rejects '..' in path", async () => {
    try {
      await readDoc({ root: TEST_ROOT, relPath: "../escape.md" });
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.message, "Unsafe path");
    }
  });

  it("readDoc rejects path escaping docs root", async () => {
    try {
      await readDoc({ root: TEST_ROOT, relPath: "guides/../../secret.md" });
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.message, "Unsafe path");
    }
  });

  it("readDoc rejects non-existent file", async () => {
    try {
      await readDoc({ root: TEST_ROOT, relPath: "nonexistent.md" });
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.message, "File not found");
    }
  });

  // ─── readDoc ─────────────────────────────────────────────────────────────────

  it("readDoc returns raw content for existing file", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "README.md", render: false });
    assert.strictEqual(doc.path, "README.md");
    assert.ok(doc.raw.includes("Welcome"));
    assert.strictEqual(doc.size, doc.raw.length);
    assert.ok(doc.mtime.includes("T"));
  });

  it("readDoc returns rendered HTML for .md file", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "README.md", render: true });
    assert.ok(doc.rendered, "should have rendered HTML");
    assert.ok(doc.rendered!.includes("<h1"), "should contain h1 tag");
    assert.ok(Array.isArray(doc.blocks));
    assert.ok(doc.blocks!.length > 0);
  });

  it("readDoc returns rendered HTML for .mdx file", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "milestones/M1.mdx", render: true });
    assert.ok(doc.rendered);
    assert.ok(Array.isArray(doc.blocks));
  });

  it("readDoc skips rendering when render=false for .md", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "README.md", render: false });
    assert.strictEqual(doc.rendered, undefined);
    assert.strictEqual(doc.blocks, undefined);
  });

  it("readDoc works with deep paths", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "guides/setup.md", render: false });
    assert.ok(doc.raw.includes("Setup Guide"));
  });
});
