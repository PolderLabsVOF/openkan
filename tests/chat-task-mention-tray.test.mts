// OpenKan — task mention tray / banner tests.
//
// Verifies that:
//   1. renderTaskMentionTray() shows the empty-state hint when no tasks
//      are dropped, and a chip with title / column pill / ID badge
//      when a task is referenced.
//   2. taskReferenceBannersHTML() emits a banner with title, column
//      pill, and truncated ID badge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("web/chat-sidebar.js"), "utf8");

interface TrayHelpers {
  state: {
    taskMentions: Map<string, any>;
    root: {
      querySelector(sel: string): any;
    } | null;
  };
  renderTaskMentionTray(): void;
  taskReferenceBannersHTML(turn: any): string;
}

function loadTray(): TrayHelpers {
  // Minimal DOM stub: createElement returns objects with the methods the
  // render path actually calls (classList, append, replaceChildren, etc).
  const win: any = { addEventListener() {}, OpenKanAPI: { api: async () => ({}) } };

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
      dataset: {} as Record<string, string>,
      setAttribute(k: string, v: string) { attrs.set(k, v); },
      getAttribute(k: string) { return attrs.get(k); },
      appendChild(child: any) { (this.children as any[]).push(child); return child; },
      append(...children: any[]) { (this.children as any[]).push(...children); },
      addEventListener() {},
      focus() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      replaceChildren(...children: any[]) { this.children = children; },
    };
  }

  const doc: any = {
    readyState: "loading",
    addEventListener() {},
    body: { appendChild() {} },
    createElement,
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  const instrumented = source.replace(
    "  window.OpenKanChatSidebar =",
    `window.__trayHelpers = {
       get state() { return state; },
       renderTaskMentionTray,
       taskReferenceBannersHTML,
     };
     window.OpenKanChatSidebar =`,
  );

  new Function("window", "document", "localStorage", instrumented)(win, doc, localStorage);
  return {
    state: win.__trayHelpers.state,
    renderTaskMentionTray: win.__trayHelpers.renderTaskMentionTray,
    taskReferenceBannersHTML: win.__trayHelpers.taskReferenceBannersHTML,
  };
}

/** Build a fake `state.root` with a tray + input node. */
function makeFakeRoot(tray: any, input: any) {
  return {
    querySelector(sel: string) {
      if (sel === "#chat-sidebar-mention-tray") return tray;
      if (sel === "#chat-sidebar-input") return input;
      return null;
    },
  };
}

test("renderTaskMentionTray shows the empty-state hint when no tasks dropped", () => {
  const t = loadTray();
  const trayChildren: any[] = [];
  const tray: any = {
    children: trayChildren,
    classList: {
      add() {}, remove() {},
      toggle(c: string, force?: boolean) {
        if (force === true) tray._set?.add(c);
        else if (force === false) tray._set?.delete(c);
      },
      contains() { return false; },
      _set: new Set<string>(),
    },
    setAttribute() {},
    replaceChildren(...children: any[]) { trayChildren.length = 0; trayChildren.push(...children); },
    append(child: any) { trayChildren.push(child); },
    getAttribute() { return null; },
  };
  const input: any = { focus() {} };
  t.state.root = makeFakeRoot(tray, input);
  t.renderTaskMentionTray();
  assert.equal(trayChildren.length, 1, "empty tray should render a single hint span");
  const hint = trayChildren[0];
  assert.match(hint.className, /mention-empty/);
  assert.equal(hint.textContent, "Drop a kanban task to reference it");
});

test("renderTaskMentionTray renders title, column pill, and ID badge for a dropped task", () => {
  const t = loadTray();
  const trayChildren: any[] = [];
  const tray: any = {
    children: trayChildren,
    classList: {
      add() {}, remove() {},
      toggle() {},
      contains() { return false; },
    },
    setAttribute() {},
    replaceChildren(...children: any[]) { trayChildren.length = 0; trayChildren.push(...children); },
    append(child: any) { trayChildren.push(child); },
    getAttribute() { return null; },
  };
  const input: any = { focus() {} };
  t.state.root = makeFakeRoot(tray, input);
  t.state.taskMentions.set("tsk-abcdef123456", {
    id: "tsk-abcdef123456",
    title: "Wire the kanban task chips",
    column: "doing",
  });
  t.renderTaskMentionTray();
  assert.equal(trayChildren.length, 1, "one chip per dropped task");
  const chip = trayChildren[0];
  assert.match(chip.className, /chat-sidebar__mention-chip/);
  assert.equal(chip.dataset.chatRemoveMention, "tsk-abcdef123456");

  const labels = chip.children.map((c: any) => c.className);
  assert.ok(labels.some((c: string) => /mention-chip-prefix/.test(c)), "chip should include a Task prefix");
  assert.ok(labels.some((c: string) => /mention-chip-title/.test(c)), "chip should include a title span");
  assert.ok(labels.some((c: string) => /mention-chip-column/.test(c)), "chip should include a column pill");
  assert.ok(labels.some((c: string) => /mention-chip-id/.test(c)), "chip should include an id badge");
  assert.ok(labels.some((c: string) => /mention-chip-remove/.test(c)), "chip should include a remove affordance");

  const titleNode = chip.children.find((c: any) => /mention-chip-title/.test(c.className));
  assert.equal(titleNode.textContent, "Wire the kanban task chips");

  const columnNode = chip.children.find((c: any) => /mention-chip-column/.test(c.className));
  assert.equal(columnNode.textContent, "In Progress");
  assert.match(columnNode.className, /--doing/);

  const idNode = chip.children.find((c: any) => /mention-chip-id/.test(c.className));
  assert.equal(idNode.textContent, "#abcdef");
});

test("taskReferenceBannersHTML emits title, column pill, and ID badge", () => {
  const t = loadTray();
  const html = t.taskReferenceBannersHTML({
    taskMentions: [
      { id: "tsk-xyz987654321", title: "Add hint copy to mention tray", column: "todo" },
    ],
  });
  assert.match(html, /chat-task-reference-banners/);
  assert.match(html, /chat-task-reference-banner__title/);
  assert.match(html, /Add hint copy to mention tray/);
  assert.match(html, /chat-task-reference-banner__column--todo/);
  assert.match(html, /To Do/);
  assert.match(html, /chat-task-reference-banner__id/);
  assert.match(html, /#xyz987/);
});

test("taskReferenceBannersHTML falls back to ID-only banner when title missing", () => {
  const t = loadTray();
  const html = t.taskReferenceBannersHTML({
    taskMentions: [{ id: "tsk-noTitle1", title: "", column: "doing" }],
  });
  assert.match(html, /Untitled task/);
  assert.match(html, /In Progress/);
  assert.match(html, /#noTitl/);
});

test("taskReferenceBannersHTML returns empty string when no mentions", () => {
  const t = loadTray();
  assert.equal(t.taskReferenceBannersHTML({ taskMentions: [] }), "");
  assert.equal(t.taskReferenceBannersHTML({}), "");
});
