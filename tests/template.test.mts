// tests/template.test.mts — unit tests for kanban/template.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { TASK_MDX_TEMPLATE, renderTaskTemplate, extractTemplate, TEMPLATE_PARSE_HINTS } from "../kanban/template.ts";

describe("TASK_MDX_TEMPLATE", () => {
  it("is non-empty", () => {
    assert.ok(TASK_MDX_TEMPLATE.length > 0, "template should not be empty");
  });

  it("has frontmatter", () => {
    assert.ok(TASK_MDX_TEMPLATE.trimStart().startsWith("---"), "template should start with --- frontmatter delimiter");
    const secondDash = TASK_MDX_TEMPLATE.indexOf("---", 3);
    assert.ok(secondDash > 0, "frontmatter should have closing ---");
  });

  it("has the 6 required sections", () => {
    const requiredSections = [
      "## Goal",
      "## Context",
      "## Acceptance criteria",
      "## Files to touch",
      "## Safety",
      "## Agent progress",
    ];
    for (const section of requiredSections) {
      assert.ok(
        TASK_MDX_TEMPLATE.includes(section),
        `Template should contain '${section}'`,
      );
    }
  });

  it("has placeholder comment markers", () => {
    assert.ok(
      TASK_MDX_TEMPLATE.includes("{/*"),
      "Template should contain placeholder comment markers {/*",
    );
    assert.ok(
      TASK_MDX_TEMPLATE.includes("*/}"),
      "Template should contain closing comment marker */",
    );
  });

  it("contains MDX component hints in comments", () => {
    // The component names appear inside comment blocks in the template
    const components = ["<Ask ", "<Choice ", "<Input ", "<Confirm ", "<Preview "];
    for (const comp of components) {
      assert.ok(
        TASK_MDX_TEMPLATE.includes(comp),
        `Template should contain '${comp}' hint`,
      );
    }
  });
});

describe("renderTaskTemplate", () => {
  it("fills in the title", () => {
    const result = renderTaskTemplate({ title: "Fix login bug" });
    assert.ok(result.includes("# Fix login bug"), "rendered template should include the title");
  });

  it("fills in goal when provided", () => {
    const result = renderTaskTemplate({ title: "Test", goal: "Make it work" });
    assert.ok(result.includes("Make it work"), "goal should be in output");
  });

  it("fills in context when provided", () => {
    const result = renderTaskTemplate({ title: "Test", context: "Because of bug #42" });
    assert.ok(result.includes("Because of bug #42"), "context should be in output");
  });

  it("fills in acceptance criteria", () => {
    const result = renderTaskTemplate({
      title: "Test",
      acceptance: ["- [ ] Criterion one", "- [ ] Criterion two"],
    });
    assert.ok(result.includes("Criterion one"), "first acceptance criterion should be in output");
    assert.ok(result.includes("Criterion two"), "second acceptance criterion should be in output");
  });

  it("fills in tags in frontmatter", () => {
    const result = renderTaskTemplate({ title: "Test", tags: ["bug", "auth"] });
    assert.ok(result.includes('"bug"'), "bug tag should appear in frontmatter");
    assert.ok(result.includes('"auth"'), "auth tag should appear in frontmatter");
  });

  it("fills in frontmatter fields", () => {
    const result = renderTaskTemplate({ title: "Fix something" });
    assert.ok(result.includes("title: Fix something"), "title should be in frontmatter");
    assert.ok(result.includes("column: todo"), "default column should be in frontmatter");
    assert.ok(result.includes("state: idle"), "default state should be in frontmatter");
    assert.ok(result.includes("archived: false"), "default archived should be in frontmatter");
  });
});

describe("extractTemplate", () => {
  it("returns true for unfilled template with placeholder comments", () => {
    const unfilled = TASK_MDX_TEMPLATE;
    assert.ok(extractTemplate(unfilled), "extractTemplate should return true for unfilled template");
  });

  it("returns true for partially filled template", () => {
    const partial = TASK_MDX_TEMPLATE
      .replace("{/* Task title — replace */}", "My Actual Title");
    assert.ok(extractTemplate(partial), "extractTemplate should return true for partially filled template");
  });

  it("returns false for fully filled template (no placeholders)", () => {
    const filled = `# Fix authentication bug

## Goal

Make the login work correctly.

## Context

Fixes #42.

## Acceptance criteria

- [ ] Login works
- [ ] Logout works

## Files to touch

src/auth/login.ts

## Safety

None.
`;
    assert.strictEqual(extractTemplate(filled), false, "extractTemplate should return false for filled-in template");
  });

  it("returns false for empty string", () => {
    assert.strictEqual(extractTemplate(""), false, "extractTemplate should return false for empty string");
  });
});

describe("TEMPLATE_PARSE_HINTS", () => {
  it("contains component hints", () => {
    assert.ok(TEMPLATE_PARSE_HINTS.length > 0, "parse hints should not be empty");
    assert.ok(TEMPLATE_PARSE_HINTS.some(h => h.includes("<Ask>")), "hints should include <Ask>");
    assert.ok(TEMPLATE_PARSE_HINTS.some(h => h.includes("<Choice>")), "hints should include <Choice>");
  });
});
