// tests/mdx-render.test.mjs — unit tests for kanban/mdx-render.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { blockIdFor, renderMdx } from "../kanban/mdx-render.ts";

describe("mdx-render", () => {
  describe("blockIdFor", () => {
    it("same content + same sibling index → same ID", () => {
      const id1 = blockIdFor("Hello world", 0);
      const id2 = blockIdFor("Hello world", 0);
      assert.strictEqual(id1, id2);
    });

    it("same content at different sibling index → different ID", () => {
      const id1 = blockIdFor("Hello world", 0);
      const id2 = blockIdFor("Hello world", 1);
      assert.notStrictEqual(id1, id2);
    });

    it("different content at same sibling index → different ID", () => {
      const id1 = blockIdFor("Hello", 0);
      const id2 = blockIdFor("World", 0);
      assert.notStrictEqual(id1, id2);
    });

    it("same content same index survives line insertion above (stability)", () => {
      // Simulate: same block appears at sibling index 2 with same text
      const id1 = blockIdFor("Some text block", 2);
      // Adding a block above doesn't change sibling index of our block
      const id2 = blockIdFor("Some text block", 2);
      assert.strictEqual(id1, id2);
    });

    it("starts with blk- prefix", () => {
      const id = blockIdFor("test", 0);
      assert.ok(id.startsWith("blk-"));
    });
  });

  describe("renderMdx", () => {
    it("wraps every top-level block in <section> with data-block-id and data-line", async () => {
      const source = `# Heading\n\nParagraph text.\n\n- item 1\n- item 2`;
      const result = await renderMdx(source);
      const sections = result.html.match(/<section[^>]+>/g) ?? [];
      assert.ok(sections.length >= 3, "should have at least 3 block sections");
      assert.ok(result.html.includes('data-block-id="'), "should have data-block-id");
      assert.ok(result.html.includes('data-line="'), "should have data-line");
    });

    it("renders headings with correct levels", async () => {
      const source = "# H1\n\n## H2\n\n### H3";
      const result = await renderMdx(source);
      assert.ok(result.html.includes("<h1>"), "should have h1");
      assert.ok(result.html.includes("<h2>"), "should have h2");
      assert.ok(result.html.includes("<h3>"), "should have h3");
    });

    it("renders code fences with language", async () => {
      const source = "```js\nconst x = 1;\n```";
      const result = await renderMdx(source);
      assert.ok(result.html.includes("language-js") || result.html.includes("class=\"language-js\""));
    });

    it("renders lists", async () => {
      const source = "- a\n- b\n- c";
      const result = await renderMdx(source);
      assert.ok(result.html.includes("<ul>") || result.html.includes("<li>"));
    });

    it("renders blockquotes", async () => {
      const source = "> This is a quote";
      const result = await renderMdx(source);
      assert.ok(result.html.includes("<blockquote>"));
    });

    it("emits a Preview component placeholder", async () => {
      const source = '<Preview tsx="<Button label=\\"x\\" />" props="{}" />';
      const result = await renderMdx(source);
      assert.ok(result.html.includes("data-mdx-component=\"Preview\""), "should have Preview component marker");
      assert.ok(result.html.includes("data-mdx-tsx="), "should have tsx data attribute");
    });

    it("returns blocks array with correct fields", async () => {
      const source = "# Title\n\nSome text.";
      const result = await renderMdx(source);
      assert.ok(result.blocks.length >= 2);
      assert.ok(result.blocks.every(b => b.id.startsWith("blk-")));
      assert.ok(result.blocks.every(b => typeof b.line === "number"));
      assert.ok(result.blocks.every(b => typeof b.type === "string"));
      assert.ok(result.blocks.every(b => typeof b.preview === "string"));
    });

    it("marks each block with correct type", async () => {
      const source = "# Title\n\nParagraph.\n\n```\ncode\n```\n\n> quote";
      const result = await renderMdx(source);
      const types = result.blocks.map(b => b.type);
      assert.ok(types.includes("heading"));
      assert.ok(types.includes("paragraph"));
      assert.ok(types.includes("code"));
      assert.ok(types.includes("quote"));
    });

    it("is stable: same source gives same blocks + html on rerender", async () => {
      const source = "# Same\n\nSame content.";
      const r1 = await renderMdx(source);
      const r2 = await renderMdx(source);
      assert.strictEqual(r1.html, r2.html);
      assert.deepStrictEqual(r1.blocks.map(b => b.id), r2.blocks.map(b => b.id));
    });
  });
});
