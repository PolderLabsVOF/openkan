// Tests for docs response shape: html/rendered alias and raw mode.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "path";

const TEST_ROOT = "/tmp/openkan-docs-shape-test";
const DOCS_ROOT = join(TEST_ROOT, "docs");

describe("docs-shape", async () => {
  let readDoc: (opts: { root: string; relPath: string; render?: boolean }) => Promise<any>;
  let extractDescription: (mdx: string) => string;

  before(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(DOCS_ROOT, { recursive: true });
    // Simple markdown with no frontmatter
    writeFileSync(join(DOCS_ROOT, "simple.md"), "# Hello\n\nWorld content.\n");
    // Markdown with YAML frontmatter
    writeFileSync(join(DOCS_ROOT, "with-fm.mdx"),
      "---\ntitle: My Doc\ntags: [one, two]\n---\n# Heading\n\nSome body text.\n");

    const mod = await import("../kanban/docs.ts");
    readDoc = mod.readDoc;
    const mdxMod = await import("../kanban/mdx.ts");
    extractDescription = mdxMod.extractDescription;
  });

  after(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ─── html / rendered alias ─────────────────────────────────────────────────

  it("readDoc returns both html and rendered (same value) in rendered mode", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "simple.md", render: true });
    assert.ok("html" in doc, "should have html key");
    assert.ok("rendered" in doc, "should have rendered key");
    assert.strictEqual(doc.html, doc.rendered, "html and rendered should be equal");
    assert.ok(doc.html!.includes("<h1"), "html should contain rendered h1");
  });

  it("readDoc rendered mode sets html alias to the same sanitized HTML as rendered", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "with-fm.mdx", render: true });
    assert.ok(doc.html);
    assert.ok(doc.rendered);
    assert.strictEqual(doc.html, doc.rendered);
  });

  // ─── raw mode ─────────────────────────────────────────────────────────────

  it("raw mode returns path, raw, mtime, size with no html or rendered", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "simple.md", render: false });
    assert.strictEqual(doc.path, "simple.md");
    assert.strictEqual(doc.raw, "# Hello\n\nWorld content.\n");
    assert.ok(typeof doc.mtime === "string");
    assert.ok(typeof doc.size === "number");
    assert.strictEqual(doc.contentType, "text/markdown");
    assert.ok(!("html" in doc) || doc.html === undefined, "should not have html key in raw mode");
    assert.ok(!("rendered" in doc) || doc.rendered === undefined, "should not have rendered key in raw mode");
  });

  it("raw mode does not include blocks key", async () => {
    const doc = await readDoc({ root: TEST_ROOT, relPath: "simple.md", render: false });
    assert.ok(!("blocks" in doc) || doc.blocks === undefined, "should not have blocks in raw mode");
  });

  // ─── extractDescription ───────────────────────────────────────────────────

  it("extractDescription strips frontmatter and returns body trimmed", () => {
    const mdx = `---
title: Test
tags: [a, b]
---
# Heading

Some description text.`;
    const desc = extractDescription(mdx);
    assert.strictEqual(desc, "# Heading\n\nSome description text.");
  });

  it("extractDescription handles no frontmatter", () => {
    const mdx = "# Just a heading\n\nSome text.";
    const desc = extractDescription(mdx);
    assert.strictEqual(desc, "# Just a heading\n\nSome text.");
  });

  it("extractDescription trims whitespace", () => {
    const mdx = `---
title: Test
---

# Body

`;
    const desc = extractDescription(mdx);
    assert.strictEqual(desc.trimEnd(), desc);
    assert.ok(desc.startsWith("# Body"));
  });
});
