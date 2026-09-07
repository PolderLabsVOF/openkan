// OpenKan — chat sidebar tabs row tests.
//
// Verifies that:
//   1. buildShell() renders the full tabs row (project / files / plugins /
//      activity / desktop-app CTA).
//   2. The desktop-app CTA links to the GitHub releases page.
//   3. setActiveTab toggles `chat-sidebar__tabs-tab--active` and
//      `aria-selected` on the matching tab.
//   4. The CSS rule that previously hid .chat-sidebar__tabs is gone, so the
//      row actually shows up at runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("web/chat-sidebar.js"), "utf8");
const css = readFileSync(resolve("web/style.css"), "utf8");

interface TabNode {
  attributes: Map<string, string>;
  classList: { _set: Set<string>; add(c: string): void; remove(c: string): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
}

interface TabRoot {
  querySelector(sel: string): TabNode | null;
  querySelectorAll(sel: string): TabNode[];
}

function makeTab(name: string): TabNode {
  const attrs = new Map<string, string>([["data-tab", name]]);
  const set = new Set<string>();
  return {
    attributes: attrs,
    classList: {
      _set: set,
      add(c: string) { set.add(c); },
      remove(c: string) { set.delete(c); },
      toggle(c: string, force?: boolean) {
        if (force === true) set.add(c);
        else if (force === false) set.delete(c);
        else if (set.has(c)) set.delete(c);
        else set.add(c);
      },
      contains(c: string) { return set.has(c); },
    },
    setAttribute(k: string, v: string) { attrs.set(k, v); },
    getAttribute(k: string) { return attrs.get(k); },
  };
}

function makeFakeRoot(tabs: TabNode[]): TabRoot {
  return {
    querySelector(sel: string) {
      const m = sel.match(/^\.chat-sidebar__tabs-tab\[data-tab="([^"]+)"\]$/);
      if (m) return tabs.find((t) => t.attributes.get("data-tab") === m[1]) || null;
      return null;
    },
    querySelectorAll(sel: string) {
      if (sel === ".chat-sidebar__tabs-tab") return tabs.slice();
      return [];
    },
  };
}

/**
 * Run the chat-sidebar IIFE in a sandboxed Function with a minimal DOM
 * stub, then capture the rendered aside HTML. We intercept
 * `document.body.appendChild(aside)` to read aside.innerHTML (where the
 * IIFE writes its full template) before it would otherwise be discarded.
 */
function loadTabs(): {
  state: { activeTab: string | null; root: TabRoot | null };
  shellHtml: string;
  setActiveTab: (name: string | null) => void;
} {
  // Mirror the document.createElement side of the chat-sidebar build.
  // Aside just needs .innerHTML (a write-only string sink here) and a
  // getAttribute/setAttribute for tabs attribute manipulation.
  function createElement(tag: string): any {
    const attrs = new Map<string, string>();
    const set = new Set<string>();
    const classList = {
      add: (c: string) => set.add(c),
      remove: (c: string) => set.delete(c),
      toggle(c: string, force?: boolean) {
        if (force === true) set.add(c);
        else if (force === false) set.delete(c);
        else if (set.has(c)) set.delete(c);
        else set.add(c);
      },
      contains: (c: string) => set.has(c),
    };
    return {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      hidden: false,
      children: [],
      attributes: attrs,
      classList,
      innerHTML: "",
      setAttribute(k: string, v: string) { attrs.set(k, v); },
      getAttribute(k: string) { return attrs.get(k); },
      appendChild(child: any) { (this.children as any[]).push(child); return child; },
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      replaceChildren() { this.children = []; },
      focus() {},
    };
  }

  let captured = "";
  const win: any = { addEventListener() {}, OpenKanAPI: { api: async () => ({}) } };
  const doc: any = {
    readyState: "loading",
    addEventListener() {},
    body: {
      appendChild(aside: any) {
        captured = String(aside?.innerHTML ?? "");
        return aside;
      },
    },
    createElement,
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  // Instrument the source so the internal state and setActiveTab are
  // reachable from tests. `state` is captured by closure reference.
  const instrumented = source.replace(
    "  window.OpenKanChatSidebar =",
    `window.__testChat = {
       get state() { return state; },
       buildShell,
       setActiveTab,
       runBuildShell() { buildShell(); },
     };
     window.OpenKanChatSidebar =`,
  );

  new Function("window", "document", "localStorage", instrumented)(win, doc, localStorage);
  win.__testChat.runBuildShell();

  return {
    state: win.__testChat.state,
    shellHtml: captured,
    setActiveTab: win.__testChat.setActiveTab,
  };
}

test("buildShell renders all four tab buttons plus the desktop-app CTA", () => {
  const t = loadTabs();
  for (const tab of ["project", "files", "plugins", "activity"]) {
    assert.match(
      t.shellHtml,
      new RegExp(`data-tab="${tab}"`),
      `expected tabs row to include data-tab="${tab}"`,
    );
  }
  assert.match(t.shellHtml, /data-tab="desktop-app"/, "expected desktop-app CTA link");
});

test("desktop-app CTA links to the public releases page", () => {
  const t = loadTabs();
  const match = t.shellHtml.match(/<a[^>]*data-tab="desktop-app"[^>]*>/);
  assert.ok(match, "expected an <a> with data-tab=desktop-app");
  const tag = match![0];
  assert.match(tag, /href="https:\/\/github\.com\/PolderLabsVOF\/openkan\/releases"/, "desktop-app CTA should target the releases URL");
  assert.match(tag, /target="_blank"/, "desktop-app CTA should open in a new tab");
  assert.match(tag, /rel="noopener noreferrer"/);
});

test("activity tab wires aria-controls to the slide-in activity footer", () => {
  const t = loadTabs();
  const match = t.shellHtml.match(/<button[^>]*data-tab="activity"[^>]*>/);
  assert.ok(match, "expected activity tab button");
  assert.match(match![0], /aria-controls="chat-sidebar-activity"/);
});

test("setActiveTab toggles the active class on the matching tab only", () => {
  const t = loadTabs();
  const buttons = {
    project: makeTab("project"),
    files: makeTab("files"),
    plugins: makeTab("plugins"),
    activity: makeTab("activity"),
  };
  t.state.root = makeFakeRoot(Object.values(buttons));
  t.setActiveTab("files");
  assert.ok(buttons.files.classList.contains("chat-sidebar__tabs-tab--active"));
  assert.equal(buttons.files.getAttribute("aria-selected"), "true");
  for (const name of ["project", "plugins", "activity"] as const) {
    assert.ok(!buttons[name].classList.contains("chat-sidebar__tabs-tab--active"), `${name} should not be active`);
    assert.equal(buttons[name].getAttribute("aria-selected"), "false");
  }
  t.setActiveTab(null);
  for (const name of ["project", "files", "plugins", "activity"] as const) {
    assert.ok(!buttons[name].classList.contains("chat-sidebar__tabs-tab--active"), `${name} should clear when active tab is null`);
    assert.equal(buttons[name].getAttribute("aria-selected"), "false");
  }
});

test("stylesheet no longer hides the chat sidebar tabs row", () => {
  assert.doesNotMatch(
    css,
    /\.chat-sidebar__tabs\s*{\s*display\s*:\s*none\s*[;}]/,
    "expected .chat-sidebar__tabs { display: none; } to be removed",
  );
  assert.match(
    css,
    /\.chat-sidebar__tabs\s*{[^}]*display\s*:\s*flex/,
    "expected a real .chat-sidebar__tabs display rule",
  );
  assert.match(
    css,
    /\.chat-sidebar__tabs-tab--active/,
    "expected an active-tab style",
  );
});
