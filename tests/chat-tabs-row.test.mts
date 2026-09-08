// OpenKan — chat sidebar tabs row tests.
//
// Verifies that:
//   1. buildShell() renders the full tabs row (project / files / plugins /
//      activity / desktop-app CTA).
//   2. The desktop-app CTA links to the GitHub releases page.
//   3. setActiveTab toggles `chat-sidebar__tabs-tab--active` and
//      `aria-selected` on the matching tab.
//   4. The tabs nav is hidden via CSS (Project / Files / Plugins are now
//      reachable via the overflow menu instead).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("web/chat-sidebar.js"), "utf8");
const css = readFileSync(resolve("web/style.css"), "utf8") +
             readFileSync(resolve("web/experience.css"), "utf8");

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

test("tabs nav is intentionally hidden; Project/Files/Plugins live in the overflow menu", () => {
  assert.match(
    css,
    /\.chat-sidebar__tabs\s*{\s*display\s*:\s*none\s*[;}]/,
    "tabs nav should be hidden (Project/Files/Plugins moved to overflow menu)",
  );
  // The active-tab class styles are still needed since openTab() still sets them.
  assert.match(
    css,
    /\.chat-sidebar__tabs-tab--active/,
    "expected an active-tab style (openTab still toggles the class)",
  );
});

test("desktop-app CTA is not part of the ARIA tablist", () => {
  const t = loadTabs();
  const match = t.shellHtml.match(/<a[^>]*data-tab="desktop-app"[^>]*>/);
  assert.ok(match, "expected an <a> with data-tab=desktop-app");
  const tag = match![0];
  assert.doesNotMatch(tag, /role="tab"/, "desktop-app CTA should not have role=tab");
  assert.doesNotMatch(tag, /aria-selected/, "desktop-app CTA should not have aria-selected");
  // The tablist role now lives on the inner row, not the outer <nav>.
  assert.match(t.shellHtml, /<div class="chat-sidebar__tabs-row" role="tablist"/);
  assert.doesNotMatch(
    t.shellHtml.match(/<nav class="chat-sidebar__tabs"[^>]*>/)?.[0] ?? "",
    /role="tablist"/,
    "the outer <nav> should no longer carry role=tablist",
  );
});

test("activity tab no longer carries the unused activity-toggle data attribute", () => {
  const t = loadTabs();
  assert.doesNotMatch(
    t.shellHtml,
    /data-chat-sidebar-activity-toggle/,
    "activity-toggle attribute should be removed (the toggle flows through data-tab)",
  );
});

test("tabs row supports ARIA keyboard navigation between tab buttons", () => {
  // Load the IIFE in isolation so we can capture both the handler and the
  // mutable state object, then inject a fake tabsRow to drive the handler.
  const focused: string[] = [];
  function fakeTab(name: string): any {
    return {
      tagName: "BUTTON",
      classList: { contains: () => true },
      getAttribute(k: string) { return k === "data-tab" ? name : null; },
      focus() { focused.push(name); },
    };
  }
  const tabs = ["project", "files", "plugins", "activity"].map(fakeTab);
  const cta = {
    tagName: "A",
    classList: { contains: () => false },
    getAttribute() { return null; },
    focus() { focused.push("desktop-app"); },
    closest() { return null; },
  };
  const row: any = {
    querySelectorAll(sel: string) { return sel === ".chat-sidebar__tabs-tab" ? tabs : []; },
  };
  function createElement(tag: string): any {
    const attrs = new Map<string, string>();
    const set = new Set<string>();
    return {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      hidden: false,
      children: [],
      attributes: attrs,
      classList: {
        add: (c: string) => set.add(c),
        remove: (c: string) => set.delete(c),
        toggle(c: string, force?: boolean) {
          if (force === true) set.add(c);
          else if (force === false) set.delete(c);
          else if (set.has(c)) set.delete(c);
          else set.add(c);
        },
        contains: (c: string) => set.has(c),
      },
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
  // Expose the handler and the live state via the same instrumentation
  // hook as loadTabs().
  const instrumented = source.replace(
    "  window.OpenKanChatSidebar =",
    `window.__testChat = {
       get state() { return state; },
       onTabsKeydown,
     };
     window.OpenKanChatSidebar =`,
  );
  const win: any = { addEventListener() {}, OpenKanAPI: { api: async () => ({}) }, __testChat: {} };
  const doc: any = {
    readyState: "loading",
    addEventListener() {},
    body: { appendChild() {} },
    createElement,
  };
  new Function("window", "document", "localStorage", instrumented)(win, doc, { getItem: () => null, setItem() {}, removeItem() {} });
  const onTabsKeydown = win.__testChat.onTabsKeydown;
  assert.ok(onTabsKeydown, "onTabsKeydown should be exposed for tests");
  // The handler reads `state.tabsRow`; inject our fake row.
  win.__testChat.state.tabsRow = row;

  // ArrowRight from project -> files.
  focused.length = 0;
  onTabsKeydown({ key: "ArrowRight", target: tabs[0], preventDefault() {} });
  assert.deepEqual(focused, ["files"]);

  // ArrowLeft from files -> project.
  focused.length = 0;
  onTabsKeydown({ key: "ArrowLeft", target: tabs[1], preventDefault() {} });
  assert.deepEqual(focused, ["project"]);

  // ArrowLeft wraps from project -> activity.
  focused.length = 0;
  onTabsKeydown({ key: "ArrowLeft", target: tabs[0], preventDefault() {} });
  assert.deepEqual(focused, ["activity"]);

  // ArrowRight wraps from activity -> project.
  focused.length = 0;
  onTabsKeydown({ key: "ArrowRight", target: tabs[3], preventDefault() {} });
  assert.deepEqual(focused, ["project"]);

  // Home from any tab -> project.
  focused.length = 0;
  onTabsKeydown({ key: "Home", target: tabs[2], preventDefault() {} });
  assert.deepEqual(focused, ["project"]);

  // End from any tab -> activity.
  focused.length = 0;
  onTabsKeydown({ key: "End", target: tabs[1], preventDefault() {} });
  assert.deepEqual(focused, ["activity"]);

  // Target is the CTA link — handler must NOT move focus onto it.
  focused.length = 0;
  onTabsKeydown({ key: "ArrowRight", target: cta, preventDefault() {} });
  assert.deepEqual(focused, []);

  // Unrelated keys are ignored.
  focused.length = 0;
  onTabsKeydown({ key: "Enter", target: tabs[0], preventDefault() {} });
  assert.deepEqual(focused, []);
});
