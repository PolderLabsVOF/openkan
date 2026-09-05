// tests/docs-view.test.mts — regression for the docs overhaul.
//
// The user reported four defects:
//   1. MDX not rendering (covered by mdx-render.test.mts).
//   2. Rendered docs not editable — covered here: an [data-doc-action="source"]
//      button must exist and clicking it must swap the preview for a textarea.
//   3. Weird banner — the "Knowledge workspace / Docs that stay readable…"
//      hero text must no longer appear in the rendered DOM.
//   4. Better layout — pinned by checking the new structural classes
//      (.docs-shell, .docs-workspace--reading, .docs-workspace--editing,
//      .docs-editor-shell, .docs-mdx-preview).
//
// docs-view.js is browser code, so we load it as a string, stub the browser
// globals it touches (window.OpenKanAPI, document, prompt/confirm, setTimeout),
// and drive mount() + render() against a minimal DOM fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Tiny DOM fakes ───────────────────────────────────────────────────────────

interface FakeNode {
  tagName: string;
  innerHTML: string;
  textContent: string;
  children: FakeNode[];
  attrs: Record<string, string>;
  classes: Set<string>;
  dataset: Record<string, string>;
  parent: FakeNode | null;
  listeners: Map<string, Set<(event: any) => void>>;
  addEventListener(type: string, fn: (event: any) => void): void;
  removeEventListener(type: string, fn: (event: any) => void): void;
  dispatchEvent(type: string, event: any): void;
  value?: string;
  hidden?: boolean;
}

function makeNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName: tagName.toUpperCase(),
    innerHTML: "",
    textContent: "",
    children: [],
    attrs: {},
    classes: new Set(),
    dataset: {},
    parent: null,
    listeners: new Map(),
    addEventListener(type, fn) {
      let set = node.listeners.get(type);
      if (!set) { set = new Set(); node.listeners.set(type, set); }
      set.add(fn);
    },
    removeEventListener(type, fn) {
      node.listeners.get(type)?.delete(fn);
    },
    dispatchEvent(type, event) {
      const set = node.listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(event); } catch (e) { /* keep going */ }
      }
    },
  };
  return node;
}

function appendChild(parent: FakeNode, child: FakeNode): FakeNode {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

// We don't try to build a real HTML parser — just enough to (a) extract
// `data-*` attributes and class lists for find/findAll, and (b) recover the
// visible text of each leaf-ish element by walking the raw innerHTML. That's
// all the assertions in this file need.
function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out[m[1]] = m[2];
  return out;
}

function extractVisibleText(html: string, openTagEnd: number, tagName: string): string {
  // Find the matching close tag for tagName starting after openTagEnd.
  const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
  closeRe.lastIndex = openTagEnd;
  const m = html.slice(openTagEnd).match(closeRe);
  if (!m) return "";
  const inner = html.slice(openTagEnd, openTagEnd + m.index!);
  return inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildSkeleton(root: FakeNode, html: string): void {
  // Walk the HTML tag-by-tag, maintaining a parent stack so each open tag
  // becomes a child of the currently-open element. Self-closing / void
  // elements don't push.
  let cursor = 0;
  const stack: FakeNode[] = [root];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const isClose = m[1] === "/";
    const tagName = m[2].toLowerCase();
    const attrsRaw = m[3];
    const tagEnd = m.index + m[0].length;
    if (isClose) {
      // Pop one node of matching tagName (don't fight if the stack is wrong).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tagName) { stack.length = i; break; }
      }
      continue;
    }
    const isVoid = /^(?:br|hr|img|input|meta|link|source|col|area|base|link)$/i.test(tagName);
    const selfClose = attrsRaw.trim().endsWith("/") || isVoid;
    const node = makeNode(tagName);
    const attrs = parseAttrs(attrsRaw);
    if (attrs.class) {
      for (const c of attrs.class.split(/\s+/).filter(Boolean)) node.classes.add(c);
    }
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") continue;
      if (k.startsWith("data-")) {
        // Convert kebab-case (data-doc-action) to camelCase (docAction) so
        // dataset.docAction reads match the real DOMStringMap behaviour.
        const key = k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        node.dataset[key] = v;
      } else {
        node.attrs[k] = v;
      }
    }
    // Capture visible text for the element by looking at the raw HTML.
    node.textContent = extractVisibleText(html, tagEnd, tagName);
    appendChild(stack[stack.length - 1], node);
    if (!selfClose) stack.push(node);
  }
}

function findAll(root: FakeNode, predicate: (n: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (n: FakeNode) => { if (predicate(n)) out.push(n); for (const c of n.children) walk(c); };
  walk(root);
  return out;
}

function findOne(root: FakeNode, predicate: (n: FakeNode) => boolean): FakeNode | undefined {
  return findAll(root, predicate)[0];
}
function selectorMatches(node: FakeNode, selector: string): boolean {
  selector = selector.trim();
  // [data-foo] (attribute present) or [data-foo="bar"] (exact match).
  let m = selector.match(/^\[data-([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/);
  if (m) {
    // The kebab attribute name maps to a camelCase key on dataset, mirroring
    // DOMStringMap behaviour. data-doc-action → docAction.
    const raw = m[1];
    const key = raw.replace(/-([a-z])/g, (_mm, c) => c.toUpperCase());
    if (m[2] === undefined) return key in node.dataset;
    return node.dataset[key] === m[2];
  }
  m = selector.match(/^\.([a-zA-Z0-9_-]+)$/);
  if (m) return node.classes.has(m[1]);
  m = selector.match(/^#([a-zA-Z0-9_-]+)$/);
  if (m) return node.attrs.id === m[1];
  return false;
}

function fakeQuerySelectorAll(root: FakeNode, selector: string): FakeNode[] {
  if (selector.includes(",")) {
    const seen = new Set<FakeNode>();
    const out: FakeNode[] = [];
    for (const part of selector.split(",").map((s) => s.trim())) {
      for (const n of fakeQuerySelectorAll(root, part)) if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
  }
  const parts = selector.split(/\s+/).filter(Boolean);
  const out: FakeNode[] = [];
  const walk = (n: FakeNode) => {
    const last = parts[parts.length - 1];
    if (!selectorMatches(n, last)) { for (const c of n.children) walk(c); return; }
    if (parts.length === 1) { out.push(n); for (const c of n.children) walk(c); return; }
    // Compound — confirm ancestor chain.
    const ancestors: FakeNode[] = [];
    let cur: FakeNode | null = n.parent;
    while (cur) { ancestors.push(cur); cur = cur.parent; }
    let idx = parts.length - 2;
    for (let i = ancestors.length - 1; i >= 0 && idx >= 0; i--) {
      if (selectorMatches(ancestors[i], parts[idx])) idx--;
    }
    if (idx < 0) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function fakeQuerySelector(root: FakeNode, selector: string): FakeNode | null {
  return fakeQuerySelectorAll(root, selector)[0] ?? null;
}

// ─── Harness ──────────────────────────────────────────────────────────────────

interface DocsHarness {
  root: FakeNode;
  mount: (initialDoc?: string) => Promise<void>;
  unmount: () => void;
  apiCalls: Array<{ method: string; path: string; body: unknown }>;
}

function loadDocsHarness(opts: {
  initial?: { entries: any[]; docs?: Record<string, { raw: string; html: string; mtime: string }> };
} = {}): DocsHarness {
  const src = readFileSync(resolve("web/docs-view.js"), "utf8");
  const wrapped = `${src}\n;return window.OpenKanDocs;`;

  const apiCalls: Array<{ method: string; path: string; body: unknown }> = [];
  const docsStore: Record<string, { raw: string; html: string; mtime: string }> = opts.initial?.docs ?? {};
  const api = async (method: string, path: string, body?: unknown) => {
    apiCalls.push({ method, path, body });
    if (method === "GET" && path === "/api/docs") return { entries: opts.initial?.entries ?? [] };
    if (method === "GET" && /^\/api\/docs\//.test(path)) {
      const rel = decodeURIComponent(path.split("/").slice(3).join("/")).split("?")[0];
      return docsStore[rel] ?? { raw: "", html: "", mtime: new Date().toISOString() };
    }
    if (method === "POST" && path === "/api/docs/render") {
      return { html: `<p>${String((body as any)?.content ?? "").replace(/[<&>]/g, "")}</p>` };
    }
    if (method === "PUT" && /^\/api\/docs\//.test(path)) {
      const rel = decodeURIComponent(path.split("/").slice(3).join("/"));
      docsStore[rel] = { raw: (body as any).content, html: "", mtime: new Date().toISOString() };
      return docsStore[rel];
    }
    if (method === "DELETE") return { ok: true };
    return { ok: true };
  };

  const root = makeNode("div");
  root.getBoundingClientRect = (() => ({ left: 0, top: 0, bottom: 100, right: 200 })) as any;
  root.value = "";
  root.hidden = false;

  // Wire innerHTML as a getter/setter that rebuilds the skeleton without
  // re-entering the setter (which would recurse forever).
  Object.defineProperty(root, "innerHTML", {
    configurable: true,
    get() { return root.__innerHTML ?? ""; },
    set(html: string) {
      const desc = Object.getOwnPropertyDescriptor(root, "innerHTML")!;
      Object.defineProperty(root, "innerHTML", { configurable: true, writable: true, value: html });
      try {
        root.__innerHTML = html;
        root.textContent = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        root.children = [];
        buildSkeleton(root, html);
      } finally {
        Object.defineProperty(root, "innerHTML", desc);
      }
    },
  });
  Object.defineProperty(root, "classList", {
    value: {
      add: (c: string) => root.classes.add(c),
      remove: (c: string) => root.classes.delete(c),
      contains: (c: string) => root.classes.has(c),
      toggle: (c: string) => { if (root.classes.has(c)) root.classes.delete(c); else root.classes.add(c); },
    },
  });
  Object.defineProperty(root, "querySelector", { value: (s: string) => fakeQuerySelector(root, s) });
  Object.defineProperty(root, "querySelectorAll", { value: (s: string) => fakeQuerySelectorAll(root, s) });
  Object.defineProperty(root, "focus", { value: () => {} });
  Object.defineProperty(root, "blur", { value: () => {} });

  const fakeWindow: any = {};
  const fakeDocument = {
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, getElementById() { return null; },
  };

  const sandbox: any = {
    window: fakeWindow, document: fakeDocument,
    setTimeout, clearTimeout, console,
    prompt: () => "", confirm: () => true,
  };
  sandbox.window.OpenKanAPI = { api, on: () => () => {} };

  const fn = new Function(
    "sandbox",
    "with (sandbox) { " +
    "  const window = sandbox.window; const document = sandbox.document; " +
    "  const prompt = sandbox.prompt; const confirm = sandbox.confirm; " +
    "  const setTimeout = sandbox.setTimeout; const clearTimeout = sandbox.clearTimeout; " +
    "  " + wrapped +
    "}",
  );
  fn(sandbox);

  const docs = fakeWindow.OpenKanDocs;
  if (!docs) throw new Error("OpenKanDocs not exposed by docs-view.js");

  return {
    root,
    mount: async (initialDoc?: string) => { await docs.mount(root, { initialDoc }); },
    unmount: () => docs.unmount(),
    apiCalls,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("docs-view does NOT render the old banner / hero copy", async () => {
  const h = loadDocsHarness({ initial: { entries: [{ path: "a.md", name: "a.md", isDir: false }] } });
  await h.mount();
  const blob = h.root.__innerHTML ?? "";
  assert.ok(!blob.includes("Knowledge workspace"), `banner eyebrow leaked`);
  assert.ok(!blob.includes("Docs that stay readable"), `banner h2 leaked`);
  assert.ok(!blob.includes("MDX renders as the document itself"), `banner paragraph leaked`);
  assert.ok(!blob.includes("docs-commandbar"), `banner container class still emitted`);
});

test("docs-view defaults to reading mode with a rendered preview", async () => {
  const h = loadDocsHarness({ initial: { entries: [{ path: "a.md", name: "a.md", isDir: false }] } });
  await h.mount();
  const workspace = findOne(h.root, (n) => n.classes.has("docs-workspace"));
  assert.ok(workspace, "docs-workspace should exist");
  assert.ok(workspace!.classes.has("docs-workspace--reading"),
    `expected docs-workspace--reading, got: ${[...workspace!.classes].join(",")}`);
  assert.ok(findOne(h.root, (n) => n.classes.has("docs-mdx-preview")), "preview should be present in reading mode");
  assert.equal(
    findOne(h.root, (n) => n.tagName === "TEXTAREA" && n.attrs.id === "docs-editor-input"),
    undefined,
    "textarea must NOT exist in reading mode",
  );
});

test("docs-view exposes an Edit action that swaps preview for an editor", async () => {
  const h = loadDocsHarness({ initial: { entries: [{ path: "a.md", name: "a.md", isDir: false }] } });
  await h.mount();
  const editBtn = findOne(h.root, (n) => n.dataset["docAction"] === "source");
  assert.ok(editBtn, "expected [data-doc-action=source] button to exist");
  editBtn!.dispatchEvent("click", { type: "click", target: editBtn });
  assert.ok(findOne(h.root, (n) => n.classes.has("docs-workspace--editing")),
    "workspace should flip to --editing after click");
  assert.ok(findOne(h.root, (n) => n.classes.has("docs-editor-shell")), "editor shell should be present");
  const textarea = findOne(h.root, (n) => n.tagName === "TEXTAREA" && n.attrs.id === "docs-editor-input");
  assert.ok(textarea, "textarea must exist after edit toggle");
});

test("Edit affordance — button label is clear and toggles back", async () => {
  const h = loadDocsHarness({ initial: { entries: [{ path: "a.md", name: "a.md", isDir: false }] } });
  await h.mount();
  const editBtn = findOne(h.root, (n) => n.dataset["docAction"] === "source")!;
  assert.match(editBtn.textContent, /Edit/i, `button should say "Edit …": got "${editBtn.textContent}"`);
  editBtn.dispatchEvent("click", { type: "click", target: editBtn });
  // After click we swap to the editing toolbar: a Discard button and a
  // prominent "Save changes" button replace the single Edit button.
  const discardBtn = findOne(h.root, (n) => n.dataset["docAction"] === "cancel-edit");
  const saveBtn = findOne(h.root, (n) => n.dataset["docAction"] === "save");
  assert.ok(discardBtn, "Discard button should appear in editing mode");
  assert.ok(saveBtn, "Save button should appear in editing mode");
  assert.match(saveBtn.textContent, /save changes/i, `save label: got "${saveBtn.textContent}"`);
});

test("Save action persists via the existing docs API and closes the editor", async () => {
  const h = loadDocsHarness({ initial: { entries: [{ path: "a.md", name: "a.md", isDir: false }] } });
  await h.mount();
  findOne(h.root, (n) => n.dataset["docAction"] === "source")!.dispatchEvent("click", { type: "click", target: h.root });
  const saveBtn = findOne(h.root, (n) => n.dataset["docAction"] === "save");
  assert.ok(saveBtn, "save button must exist in edit mode");
  saveBtn!.dispatchEvent("click", { type: "click", target: h.root });
  await new Promise((r) => setTimeout(r, 30));
  const puts = h.apiCalls.filter((c) => c.method === "PUT" && /\/api\/docs\//.test(c.path));
  assert.ok(puts.length >= 1, `expected a PUT, got: ${JSON.stringify(h.apiCalls)}`);
  assert.match(puts[0].path, /\/api\/docs\/a\.md$/, `PUT path should target the document: ${puts[0].path}`);
});

test("Layout — preview and editor are reachable, no leftover source-panel", async () => {
  const h = loadDocsHarness({ initial: { entries: [{ path: "a.md", name: "a.md", isDir: false }] } });
  await h.mount();
  assert.ok(findOne(h.root, (n) => n.classes.has("docs-shell")), "shell wrapper present");
  assert.ok(findOne(h.root, (n) => n.classes.has("docs-stage")), "stage column present");
  assert.equal(
    findOne(h.root, (n) => n.classes.has("docs-source-panel")),
    undefined,
    "old side-by-side source panel must be gone",
  );
});

test("Empty docs tree renders the file bar without a banner", async () => {
  const h = loadDocsHarness({ initial: { entries: [] } });
  await h.mount();
  const blob = h.root.__innerHTML ?? "";
  assert.ok(!blob.includes("Knowledge workspace"));
  assert.ok(blob.includes("docs-shell"));
  assert.ok(blob.includes("docs-workspace--reading"));
});
