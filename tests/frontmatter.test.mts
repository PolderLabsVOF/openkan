// tests/frontmatter.test.mts — unit tests for MDX frontmatter stripping

import { describe, it } from "node:test";
import assert from "node:assert";
import { stripMdxFrontmatter, renderMdx } from "../kanban/mdx-render.ts";
import { extractDescription } from "../kanban/mdx.ts";

describe("frontmatter stripping", () => {
  describe("stripMdxFrontmatter", () => {
    it("strips frontmatter from standard MDX with title", () => {
      const input = `---\ntitle: foo\n---\n# Hello`;
      const result = stripMdxFrontmatter(input);
      assert.strictEqual(result, "# Hello");
    });

    it("returns unchanged string when no frontmatter", () => {
      const input = "# Hello";
      const result = stripMdxFrontmatter(input);
      assert.strictEqual(result, "# Hello");
    });

    it("only strips the first frontmatter block", () => {
      const input = `---\ntitle: foo\n---\n\n---\n# Body`;
      const result = stripMdxFrontmatter(input);
      // trimStart removes the leading \n after the frontmatter
      assert.strictEqual(result, "---\n# Body");
    });

    it("handles frontmatter at EOF without trailing newline", () => {
      const input = `---\ntitle: foo\n---`;
      const result = stripMdxFrontmatter(input);
      assert.strictEqual(result, "");
    });

    it("handles CRLF line endings", () => {
      const input = `---\r\ntitle: foo\r\n---\r\n# Hello`;
      const result = stripMdxFrontmatter(input);
      assert.strictEqual(result, "# Hello");
    });

    it("returns empty string for empty input", () => {
      assert.strictEqual(stripMdxFrontmatter(""), "");
      assert.strictEqual(stripMdxFrontmatter(undefined as any), "");
    });

    it("handles frontmatter with many fields", () => {
      const input = `---\ntitle: My Task\nid: tsk123\ncolumn: doing\npriority: high\n---\n# My Task\n\nSome description.`;
      const result = stripMdxFrontmatter(input);
      assert.strictEqual(result, "# My Task\n\nSome description.");
    });
  });

  describe("renderMdx (frontmatter stripped from HTML output)", () => {
    it("does not include frontmatter markers in rendered HTML", async () => {
      const input = `---\ntitle: foo\n---\n# Hello`;
      const result = await renderMdx(input);
      assert.ok(!result.html.includes("---"), "frontmatter delimiter should not appear in HTML");
      assert.ok(!result.html.includes("title: foo"), "frontmatter content should not appear in HTML");
      assert.ok(result.html.includes("<h1>Hello</h1>"), "actual content should be rendered");
    });

    it("renders content normally when no frontmatter", async () => {
      const input = "# Hello\n\nSome paragraph.";
      const result = await renderMdx(input);
      assert.ok(result.html.includes("<h1>Hello</h1>"));
      assert.ok(!result.html.includes("---"));
    });

    it("renders correctly when frontmatter has many fields", async () => {
      const input = `---\ntitle: Test\nid: tsk1\ncolumn: todo\n---\n## Section\n\nParagraph here.`;
      const result = await renderMdx(input);
      assert.ok(!result.html.includes("---"));
      assert.ok(!result.html.includes("title:"));
      assert.ok(result.html.includes("<h2>Section</h2>"));
      assert.ok(result.html.includes("<p>Paragraph here.</p>"));
    });
  });

  describe("extractDescription (mdx.ts)", () => {
    it("extracts body after frontmatter", () => {
      const input = `---\ntitle: foo\n---\n# Hello`;
      const result = extractDescription(input);
      assert.strictEqual(result, "# Hello");
    });

    it("returns trimmed body when no frontmatter", () => {
      const input = "# Hello";
      const result = extractDescription(input);
      assert.strictEqual(result, "# Hello");
    });
  });
});
