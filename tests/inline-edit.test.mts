// tests/inline-edit.test.mts — regression for web/task-view.js wireInlineEdit.
//
// The old behaviour auto-saved task title/description 800 ms after every
// keystroke pause, which threw the user out of the edit context mid-sentence.
// The new behaviour persists ONLY on explicit user actions (Enter, Ctrl/Cmd
// +Enter, the Save button) or after a quiet period following blur. This test
// exercises the save-decision logic in isolation: it loads task-view.js as a
// string, stubs the browser globals it needs, and drives the function with a
// bare-bones DOM fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Handler = (event: any) => void;

interface FakeEventTarget {
  listeners: Map<string, Set<Handler>>;
  addEventListener: (type: string, fn: Handler) => void;
  removeEventListener: (type: string, fn: Handler) => void;
  dispatchEvent: (type: string, event: any) => void;
}

function makeTarget(): FakeEventTarget {
  const t: FakeEventTarget = {
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    },
    dispatchEvent(type, event) {
      const fns = this.listeners.get(type);
      if (!fns) return;
      // Slice so handlers that remove themselves don't break iteration.
      for (const fn of [...fns]) {
        try { fn(event); } catch (e) { /* keep going */ }
      }
    },
  };
  return t;
}

interface EditableEl extends FakeEventTarget {
  textContent: string;
  dataset: Record<string, string>;
  classList: { toggle: (cls: string, on?: boolean) => void; add: (cls: string) => void; remove: (cls: string) => void; contains: (cls: string) => boolean };
  parentElement: FakeElement | null;
  blur: () => void;
  focus: () => void;
  hidden: boolean;
}

interface FakeElement extends FakeEventTarget {
  tagName?: string;
  type?: string;
  textContent?: string;
  hidden?: boolean;
  title?: string;
  className?: string;
  children: FakeElement[];
  appendChild: (child: FakeElement) => FakeElement;
  removeChild: (child: FakeElement) => void;
  click: () => void;
  setAttribute: (k: string, v: string) => void;
}

function makeElement(): FakeElement {
  const el: FakeElement = makeTarget() as unknown as FakeElement;
  el.children = [];
  el.className = "";
  el.type = "";
  el.title = "";
  el.textContent = "";
  el.hidden = false;
  el.appendChild = function (child) { this.children.push(child); return child; };
  el.removeChild = function (child) {
    this.children = this.children.filter(c => c !== child);
  };
  el.setAttribute = function (k: string, v: any) { (this as any)[`_${k}`] = String(v); };
  return el;
}

function makeEditable(initial = ""): EditableEl {
  const base: FakeElement = makeElement();
  const clsSet = new Set<string>();
  const cls = {
    toggle(c: string, on?: boolean) {
      const shouldHave = on === undefined ? !clsSet.has(c) : on;
      if (shouldHave) clsSet.add(c); else clsSet.delete(c);
    },
    add(c: string) { clsSet.add(c); },
    remove(c: string) { clsSet.delete(c); },
    contains(c: string) { return clsSet.has(c); },
  };
  const e: EditableEl = base as unknown as EditableEl;
  e.textContent = initial;
  e.dataset = {};
  e.classList = cls;
  e.blur = () => {
    e.dispatchEvent("blur", { type: "blur", target: e });
    e.dispatchEvent("focusout", { type: "focusout", target: e });
  };
  e.focus = () => { e.dispatchEvent("focus", { type: "focus", target: e }); };
  e.hidden = false;
  return e;
}

interface InlineEditHarness {
  editable: EditableEl;
  saveBtn: FakeElement;
  patches: Array<{ method: string; path: string; body: any }>;
  setQuietMs?: number; // not used at the API surface; timings are real-time per the public surface
  now: () => number;
  advance: (ms: number) => Promise<void>;
  cleanup: () => void;
}

function loadHarness(): { build(opts?: { blurQuietMs?: number; editableText?: string }): InlineEditHarness; source: string } {
  const src = readFileSync(resolve("web/task-view.js"), "utf8");
  const source = src;

  // Extract only the slice of the IIFE we need for the test (the helpers
  // and wireInlineEdit definition). The full file calls fetchMe() and
  // hooks window.OpenKanTaskView at the bottom, which we don't want
  // running under the test harness.
  const start = source.indexOf("(() => {");
  const wireEnd = source.indexOf("window.OpenKanInlineEdit");
  if (start < 0 || wireEnd < 0) {
    throw new Error("could not locate IIFE start or wireInlineEdit export in task-view.js");
  }
  // Walk past the closing `}` of the `if (typeof window !== "undefined") { ... }`
  // block that holds the export, so the bracket count is balanced before
  // we close our wrapper IIFE.
  let cursor = source.indexOf("\n", wireEnd) + 1;
  while (cursor < source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const line = lineEnd < 0 ? source.slice(cursor) : source.slice(cursor, lineEnd);
    cursor = lineEnd + 1;
    if (line.trim() === "}") break;
  }
  const harnessSrc = source.slice(start, cursor) + "\n})();\n";
  return {
    source,
    build: (opts = {}) => {
      const patches: Array<{ method: string; path: string; body: any }> = [];
      const api = async (method: string, path: string, body: any) => {
        patches.push({ method, path, body });
        return { ok: true, id: "tsk-x" };
      };
      const on = (_event: string, _handler: any) => () => {};
      const OpenKanAPI = { api, on };
      const showToast = () => {};
      const OpenKanSettings = { showToast };

      const editable = makeEditable(opts.editableText ?? "");
      // The el() helper inside task-view needs a parent to attach the Save
      // button to. Simulate it with a fake document body that appendChild()
      // does nothing on.
      const document = {
        createElement(tag: string) {
          const el = makeElement();
          el.tagName = tag.toUpperCase();
          return el;
        },
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        getElementById() { return null; },
      };

      const win: any = {
        OpenKanAPI,
        OpenKanSettings,
        addEventListener() {},
        removeEventListener() {},
      };
      const parentEl = (editable as any) as FakeElement;
      (editable as any).parentElement = parentEl;

      const fn = new Function(
        "window", "document", "setTimeout", "clearTimeout",
        harnessSrc
      );
      fn(win, document, setTimeout, clearTimeout);
      const InlineEdit: any = win.OpenKanInlineEdit;
      if (!InlineEdit || typeof InlineEdit.wire !== "function") {
        throw new Error("failed to extract OpenKanInlineEdit.wire from task-view.js");
      }

      const cleanup = InlineEdit.wire(editable, { id: "tsk-x" }, "description", {
        blurQuietMs: opts.blurQuietMs ?? 1500,
      });
      const saveBtn = editable.children[0];

      const advance = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
      return { editable, saveBtn, patches, cleanup, now: () => Date.now(), advance };
    },
  };
}

test("rapid typing without blur never persists (regression for throwout-on-debounce bug)", async () => {
  const h = loadHarness();
  const { editable, patches } = h.build();

  // Simulate typing "Hello world." — multiple input events, no blur.
  editable.textContent = "H";
  editable.dispatchEvent("input", { type: "input", target: editable });
  editable.textContent = "He";
  editable.dispatchEvent("input", { type: "input", target: editable });
  editable.textContent = "Hello";
  editable.dispatchEvent("input", { type: "input", target: editable });
  editable.textContent = "Hello world.";
  editable.dispatchEvent("input", { type: "input", target: editable });

  // Wait past the old 800 ms debounce and well past the new 1500 ms
  // blur-quiet window — typing alone must never persist.
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(patches.length, 0, "input events must not trigger any PATCH");
  assert.ok(editable.classList.contains("dirty"), "field is dirty mid-edit");
});

test("blur alone (without explicit exit) waits the quiet period, then saves", async () => {
  const h = loadHarness();
  const QU = 200; // shrink the quiet window for a fast test
  const { editable, patches } = h.build({ blurQuietMs: QU });

  // Type then focus → leave the field via blur.
  editable.focus();
  editable.textContent = "Edited description";
  editable.dispatchEvent("input", { type: "input", target: editable });
  editable.blur();

  // Not yet: the quiet timer hasn't fired.
  await new Promise(r => setTimeout(r, QU - 50));
  assert.equal(patches.length, 0, "save must NOT fire before quiet period elapses");

  // Now the quiet window has elapsed.
  await new Promise(r => setTimeout(r, 200));
  assert.equal(patches.length, 1, "save fires once after quiet period");
  assert.equal(patches[0].method, "PATCH");
  assert.equal(patches[0].path, "/api/tasks/tsk-x");
  assert.equal(patches[0].body.description, "Edited description");
  assert.ok(!editable.classList.contains("dirty"), "dirty clears after save");
});

test("focus→blur→focus within quiet window cancels the pending save", async () => {
  const h = loadHarness();
  const QU = 400;
  const { editable, patches } = h.build({ blurQuietMs: QU });

  editable.focus();
  editable.textContent = "Not finished";
  editable.dispatchEvent("input", { type: "input", target: editable });
  editable.blur();
  await new Promise(r => setTimeout(r, QU / 2));
  editable.focus(); // come back before the timer expires
  await new Promise(r => setTimeout(r, QU + 100));
  assert.equal(patches.length, 0, "re-focus before the quiet window expires must cancel the save");
});

test("Enter commits immediately and exits the field (no quiet-period wait)", async () => {
  const h = loadHarness();
  const { editable, patches } = h.build();

  editable.focus();
  editable.textContent = "Entered text";
  editable.dispatchEvent("input", { type: "input", target: editable });
  editable.dispatchEvent("keydown", { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {} });

  // Save flushes synchronously enough that the await microtask resolves
  // before this assertion runs.
  await new Promise(r => setTimeout(r, 5));
  assert.equal(patches.length, 1, "Enter must commit immediately");
  assert.equal(patches[0].body.description, "Entered text");
});

test("Ctrl+Enter commits immediately (e.g. while still on a newline)", async () => {
  const h = loadHarness();
  const { editable, patches } = h.build();

  editable.focus();
  editable.textContent = "multi\nline text";
  editable.dispatchEvent("input", { type: "input", target: editable });
  editable.dispatchEvent("keydown", {
    key: "Enter",
    shiftKey: false,
    metaKey: true,
    ctrlKey: false,
    preventDefault() {},
  });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(patches.length, 1, "Ctrl+Enter commits immediately");
  assert.equal(patches[0].body.description, "multi\nline text");
});

test("Escape cancels (reverts text) and does NOT persist", async () => {
  const h = loadHarness();
  const { editable, patches } = h.build({ editableText: "Original description" });

  editable.focus();
  editable.textContent = "Half-typed sentence";
  editable.dispatchEvent("input", { type: "input", target: editable });
  editable.dispatchEvent("keydown", { key: "Escape", preventDefault() {} });

  await new Promise(r => setTimeout(r, 50));
  assert.equal(patches.length, 0, "Escape must not save");
  assert.equal(editable.textContent, "Original description", "Escape reverts to lastSaved");
});

test("Save button click commits explicitly (regression for the old debounced auto-save)", async () => {
  const h = loadHarness();
  const { editable, saveBtn, patches } = h.build();

  editable.focus();
  editable.textContent = "Via the button";
  editable.dispatchEvent("input", { type: "input", target: editable });
  assert.equal(saveBtn.hidden, false, "Save button is visible while editing");

  saveBtn.dispatchEvent("click", { type: "click", preventDefault() {} });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(patches.length, 1, "clicking Save must persist");
  assert.equal(patches[0].body.description, "Via the button");
});
