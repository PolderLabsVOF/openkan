// tests/charts.test.mts — unit tests for web/charts.js
//
// Provides a minimal DOM mock (no jsdom dependency) sufficient for
// renderStackedBar: createElementNS, setAttribute, appendChild,
// removeChild, firstChild, textContent, querySelectorAll.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Minimal DOM stub ────────────────────────────────────────────────────────

class StubElement {
  public tagName: string;
  public namespaceURI: string | null;
  public children: StubElement[] = [];
  public parentNode: StubElement | null = null;
  public textContent = "";
  public attributes: Record<string, string> = {};

  constructor(tag: string, ns: string | null = null) {
    this.tagName = tag;
    this.namespaceURI = ns;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  get firstChild(): StubElement | null {
    return this.children[0] ?? null;
  }

  removeChild(child: StubElement): void {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
  }

  appendChild(child: StubElement): StubElement {
    // Move-if-attached
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  querySelectorAll(selector: string): StubElement[] {
    return collectAll(this).filter(el => matches(el, selector));
  }

  /** Mock SVG bbox: return 0,0 — unused by the renderer. */
  getBBox(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function collectAll(root: StubElement): StubElement[] {
  const out: StubElement[] = [root];
  for (const c of root.children) out.push(...collectAll(c));
  return out;
}

function matches(el: StubElement, selector: string): boolean {
  if (selector === "rect") return el.tagName === "rect";
  if (selector === "title") return el.tagName === "title";
  if (selector === "line") return el.tagName === "line";
  if (selector === "text") return el.tagName === "text";
  if (selector === "g") return el.tagName === "g";
  return false;
}

class StubDocument {
  createElementNS(ns: string, tag: string): StubElement {
    return new StubElement(tag, ns);
  }
  createElement(tag: string): StubElement {
    return new StubElement(tag);
  }
}

function installDomGlobals(): void {
  // @ts-expect-error — assigning to a global for the loaded script
  globalThis.document = new StubDocument();
  // charts.js references window.OpenKanCharts at load; provide a stub.
  // @ts-expect-error
  globalThis.window = globalThis.window ?? globalThis;
}

// ─── Load charts.js into the current realm ───────────────────────────────────

function loadChartsModule(): void {
  installDomGlobals();
  const path = resolve(import.meta.dirname, "..", "web", "charts.js");
  const source = readFileSync(path, "utf-8");
  // Run the script in the current realm. It self-registers on window.
  // eslint-disable-next-line no-eval
  (0, eval)(source);
  // @ts-expect-error
  globalThis.OpenKanCharts = globalThis.window?.OpenKanCharts ?? globalThis.OpenKanCharts;
}

function makeSampleData(dayCount = 30) {
  const days: string[] = [];
  const today = new Date();
  for (let i = dayCount - 1; i >= 0; i--) {
    const t = new Date(today);
    t.setDate(today.getDate() - i);
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, "0");
    const d = String(t.getDate()).padStart(2, "0");
    days.push(`${y}-${m}-${d}`);
  }
  const arr = (n: number) => new Array(dayCount).fill(0).map((_, i) => (i % 7 === 0 ? n : 0));
  return {
    days,
    columns: {
      backlog: arr(1),
      todo: arr(2),
      doing: arr(3),
      review: arr(2),
      done: arr(1),
    },
    windowDays: dayCount,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("charts — renderStackedBar", () => {
  beforeEach(() => {
    loadChartsModule();
  });

  it("renders 30 days with at least one segment per non-zero day", () => {
    // @ts-expect-error — set by the loader
    const { renderStackedBar } = globalThis.OpenKanCharts;
    const svg = new StubElement("svg");
    renderStackedBar(svg as never, makeSampleData(30));
    // Expect many rects — 30 bars worth of segments, plus axis lines, etc.
    const rects = svg.querySelectorAll("rect");
    assert.ok(rects.length >= 30, `expected at least 30 rects, got ${rects.length}`);
    // Each non-zero day should have at least 1 <title> on its segments.
    const titles = svg.querySelectorAll("title");
    assert.ok(titles.length >= 30, `expected at least 30 titles, got ${titles.length}`);
  });

  it("does not throw on zero data", () => {
    // @ts-expect-error
    const { renderStackedBar, isAllZero } = globalThis.OpenKanCharts;
    const data = makeSampleData(30);
    for (const col of Object.keys(data.columns) as (keyof typeof data.columns)[]) {
      data.columns[col] = new Array(30).fill(0);
    }
    assert.strictEqual(isAllZero(data), true);
    const svg = new StubElement("svg");
    assert.doesNotThrow(() => renderStackedBar(svg as never, data));
    // Empty baseline ghosts are still drawn for layout.
    const rects = svg.querySelectorAll("rect");
    assert.ok(rects.length >= 30, "empty days should still get baseline rects");
  });

  it("isAllZero returns false when any column has positive counts", () => {
    // @ts-expect-error
    const { isAllZero } = globalThis.OpenKanCharts;
    const data = makeSampleData(30);
    data.columns.done[5] = 1;
    assert.strictEqual(isAllZero(data), false);
  });

  it("isAllZero returns true for null/empty data", () => {
    // @ts-expect-error
    const { isAllZero } = globalThis.OpenKanCharts;
    assert.strictEqual(isAllZero(null), true);
    assert.strictEqual(isAllZero({ columns: {} }), true);
    assert.strictEqual(isAllZero({ columns: { backlog: [] } }), true);
  });

  it("emits accessible <desc> and aria-label", () => {
    // @ts-expect-error
    const { renderStackedBar } = globalThis.OpenKanCharts;
    const svg = new StubElement("svg");
    renderStackedBar(svg as never, makeSampleData(30));
    const all = collectAll(svg);
    const desc = all.find(el => el.tagName === "desc");
    assert.ok(desc, "expected a <desc> element");
    assert.ok((desc!.textContent || "").includes("30 days"), "desc should mention window length");
    const aria = svg.getAttribute("aria-label");
    assert.ok(aria, "expected an aria-label on the root SVG");
    assert.ok(aria!.includes("30 days"));
  });

  it("produces a <title> on each segment with the format '<col> on <date>: <n> move(s)'", () => {
    // @ts-expect-error
    const { renderStackedBar } = globalThis.OpenKanCharts;
    const data = makeSampleData(30);
    // Pin a known day to a known value so the title is deterministic.
    data.columns.doing[10] = 7;
    const svg = new StubElement("svg");
    renderStackedBar(svg as never, data);
    const titles = svg.querySelectorAll("title");
    const matches = titles.map(t => t.textContent || "").filter(t => /doing on .* 7 moves?/.test(t));
    assert.ok(matches.length >= 1, `expected a title with 'doing on … 7 moves', got ${matches.length}`);
  });
});
