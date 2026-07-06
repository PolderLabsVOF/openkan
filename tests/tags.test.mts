import { describe, it } from "node:test";
import assert from "node:assert";
import { extractMetadata } from "../kanban/tags.ts";

describe("extractMetadata", () => {

  it("extracts bug tag from 'Fix the login bug'", () => {
    const result = extractMetadata({ title: "Fix the login bug" });
    assert.ok(result.tags.includes("bug"), `expected bug tag, got ${JSON.stringify(result.tags)}`);
    assert.equal(result.category, "task");
    assert.ok(!result.tags.includes("ux")); // no UI signal
  });

  it("infers frontend category from button/css keywords", () => {
    const result = extractMetadata({
      title: "Add a button to the page",
      description: "Style with css",
    });
    assert.equal(result.category, "frontend");
    // "add" alone is not a feature keyword (feature, "add support", implement are)
    // Only the category-derived tag is present
    assert.ok(result.tags.includes("frontend"), `expected frontend tag, got ${JSON.stringify(result.tags)}`);
  });

  it("infers backend category and refactor tag from 'Refactor API handler'", () => {
    const result = extractMetadata({ title: "Refactor API handler" });
    assert.equal(result.category, "backend");
    assert.ok(result.tags.includes("refactor"), `expected refactor tag, got ${JSON.stringify(result.tags)}`);
  });

  it("marks P0 outage as urgent priority with bug tag and explicit payments tag", () => {
    const result = extractMetadata({
      title: "P0 outage in checkout #payments",
      description: "Customers cannot pay",
    });
    assert.equal(result.priority, "urgent");
    assert.ok(result.tags.includes("bug"), `expected bug (outage=crash), got ${JSON.stringify(result.tags)}`);
    assert.ok(result.tags.includes("payments"), `expected explicit #payments tag, got ${JSON.stringify(result.tags)}`);
  });

  it("infers infra category from Terraform mention", () => {
    const result = extractMetadata({ title: "Add Terraform module" });
    assert.equal(result.category, "infra");
  });

  it("infers data category from migration/index mention", () => {
    const result = extractMetadata({ title: "Migration: drop the index" });
    assert.equal(result.category, "data");
    assert.ok(result.tags.includes("migration"), `expected migration tag, got ${JSON.stringify(result.tags)}`);
  });

  it("infers small effort from 'Quick fix'", () => {
    const result = extractMetadata({ title: "Quick fix" });
    assert.equal(result.effort, "s");
  });

  it("defaults to normal priority, null effort, task category for 'hello'", () => {
    const result = extractMetadata({ title: "hello" });
    assert.equal(result.priority, "normal");
    assert.equal(result.effort, null);
    assert.equal(result.category, "task");
  });

  it("is deterministic — same input twice gives same output", () => {
    const input = { title: "Refactor API handler for performance" };
    const a = extractMetadata(input);
    const b = extractMetadata(input);
    assert.deepStrictEqual(a, b);
  });

  it("extracts all explicit #tag tokens, lowercased and deduped", () => {
    const result = extractMetadata({ title: "Fix the #login bug and #auth regression" });
    assert.ok(result.explicitTags.includes("login"), `expected login, got ${JSON.stringify(result.explicitTags)}`);
    assert.ok(result.explicitTags.includes("auth"), `expected auth, got ${JSON.stringify(result.explicitTags)}`);
    // deduplicated with derived
    const loginCount = result.tags.filter(t => t === "login").length;
    assert.equal(loginCount, 1, "explicit tags should be deduplicated in tags array");
  });

  it("always includes category in tags array", () => {
    const result = extractMetadata({ title: "hello world" });
    assert.ok(result.tags.includes(result.category), `category ${result.category} should be in tags`);
  });

  it("sorts tags: derived keyword tags first (table order), then explicit alphabetical", () => {
    const result = extractMetadata({
      title: "Fix bug #auth",
      description: "it is a crash",  // crash → bug (already in table)
    });
    // bug should come before feature (bug is earlier in TAG_KEYWORDS table)
    // explicit tag auth should come after derived tags, alphabetically
    const bugIdx = result.tags.indexOf("bug");
    const authIdx = result.tags.indexOf("auth");
    assert.ok(bugIdx < authIdx, `bug (${bugIdx}) should come before auth (${authIdx}): ${JSON.stringify(result.tags)}`);
  });

  it("handles #P0 / #P1 style tags", () => {
    const result = extractMetadata({ title: "Fix issue #P0 #urgent" });
    assert.ok(result.explicitTags.includes("p0"), `expected p0, got ${JSON.stringify(result.explicitTags)}`);
    assert.ok(result.explicitTags.includes("urgent"), `expected urgent, got ${JSON.stringify(result.explicitTags)}`);
  });

  it("handles keywords that span multiple words (e.g. 'add support')", () => {
    const result = extractMetadata({ title: "Add support for webhooks" });
    assert.ok(result.tags.includes("feature"), `expected feature (from 'add support'), got ${JSON.stringify(result.tags)}`);
  });

  it("handles 'clean up' as refactor keyword", () => {
    const result = extractMetadata({ title: "Clean up the utils module" });
    assert.ok(result.tags.includes("refactor"), `expected refactor (from 'clean up'), got ${JSON.stringify(result.tags)}`);
  });

  it("derives security tag and category from xss/auth keywords", () => {
    const result = extractMetadata({ title: "Fix XSS vulnerability in auth flow" });
    assert.ok(result.tags.includes("security"), `expected security, got ${JSON.stringify(result.tags)}`);
    assert.equal(result.category, "security");
  });

  it("infers docs category from readme keyword", () => {
    const result = extractMetadata({ title: "Update README with new instructions" });
    assert.equal(result.category, "docs");
    assert.ok(result.tags.includes("docs"), `expected docs tag, got ${JSON.stringify(result.tags)}`);
  });

  it("infers test category from vitest/playwright keywords", () => {
    const result = extractMetadata({ title: "Add playwright e2e test for login" });
    assert.equal(result.category, "test");
    assert.ok(result.tags.includes("test"), `expected test tag, got ${JSON.stringify(result.tags)}`);
  });

  it("infers design category from figma/sketch keywords", () => {
    const result = extractMetadata({ title: "Create mockup in Figma" });
    assert.equal(result.category, "design");
  });

  it("infers perf tag from 'optimi' substring", () => {
    const result = extractMetadata({ title: "Optimize database query performance" });
    assert.ok(result.tags.includes("perf"), `expected perf (from 'optimi'), got ${JSON.stringify(result.tags)}`);
  });

  it("infers a11y tag from accessibility keyword", () => {
    const result = extractMetadata({ title: "Improve accessibility of forms" });
    assert.ok(result.tags.includes("a11y"), `expected a11y, got ${JSON.stringify(result.tags)}`);
  });

  it("infers i18n tag from l10n keyword", () => {
    const result = extractMetadata({ title: "Add l10n support for French" });
    assert.ok(result.tags.includes("i18n"), `expected i18n, got ${JSON.stringify(result.tags)}`);
  });

  it("infers deprecation tag from 'deprecat'", () => {
    const result = extractMetadata({ title: "Deprecate old v1 API" });
    assert.ok(result.tags.includes("deprecation"), `expected deprecation, got ${JSON.stringify(result.tags)}`);
  });

  it("infers xl effort from 'multi-week'", () => {
    const result = extractMetadata({ title: "Multi-week migration project" });
    assert.equal(result.effort, "xl");
  });

  it("infers xs effort from 'typo'", () => {
    const result = extractMetadata({ title: "Fix typo in error message" });
    assert.equal(result.effort, "xs");
  });

  it("derives 'high' priority from 'important' keyword", () => {
    const result = extractMetadata({ title: "Important security fix" });
    assert.equal(result.priority, "high");
  });

  it("derives 'low' priority from 'low priority' phrase", () => {
    const result = extractMetadata({ title: "Low priority refactor cleanup" });
    assert.equal(result.priority, "low");
  });

  it("derives 'normal' priority from 'backlog' keyword", () => {
    const result = extractMetadata({ title: "Backlog item for later" });
    assert.equal(result.priority, "normal");
  });

});
