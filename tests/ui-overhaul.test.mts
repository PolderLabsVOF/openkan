import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("workspace UI contract", () => {
  test("loads the dedicated workspace theme after legacy component styles", () => {
    const html = read("web/index.html");
    assert.ok(html.indexOf('href="style.css"') < html.indexOf('href="workspace.css?v=20260730"'));
  });

  test("provides board health and progressively disclosed filters", () => {
    const html = read("web/index.html");
    assert.match(html, /id="board-overview"/);
    assert.match(html, /id="overview-doing"/);
    assert.match(html, /id="filter-toggle-btn"[^>]+aria-controls="filter-advanced"/);
    assert.match(html, /id="filter-advanced"[^>]+hidden/);
  });

  test("updates visible workflow counts from the rendered task set", () => {
    const app = read("web/app.js");
    assert.match(app, /setOverview\("overview-total", visibleTasks\.length\)/);
    assert.match(app, /task\.column === "doing"/);
    assert.match(app, /task\.column === "review"/);
  });

  test("closes task detail before switching top-level tabs", () => {
    const app = read("web/app.js");
    const handler = app.slice(app.indexOf("function attachTabRouter"), app.indexOf("function attachFilterDisclosure"));
    assert.match(handler, /OpenKanTaskView\?\.getCurrentTaskId/);
    assert.ok(handler.indexOf("OpenKanTaskView.close()") < handler.indexOf("activateTab("));
  });

  test("routes the global new-task action to the visible Tasks workspace", () => {
    const app = read("web/app.js");
    const handler = app.slice(app.indexOf("function openModal"), app.indexOf("function closeModal"));
    assert.match(handler, /OpenKanTaskView\?\.getCurrentTaskId/);
    assert.match(handler, /activateTab\("tasks"\)/);
    assert.ok(handler.indexOf('activateTab("tasks")') < handler.indexOf("modal.hidden = false"));
  });

  test("defines responsive, accessible mobile behavior", () => {
    const css = read("web/workspace.css");
    assert.match(css, /@media \(max-width: 820px\)/);
    assert.match(css, /scroll-snap-type: x mandatory/);
    assert.match(css, /column\[data-column="todo"\] \{ order: 1; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});

test("loads GSAP before the status-specific chat motion module", () => {
  const html = read("web/index.html");
  const motion = read("web/chat-status-motion.js");
  const sidebar = read("web/chat-sidebar.js");
  assert.ok(html.indexOf('src="vendor/gsap.min.js"') < html.indexOf('src="chat-status-motion.js"'));
  assert.ok(html.indexOf('src="chat-status-motion.js"') < html.indexOf('src="chat-sidebar.js"'));
  assert.match(motion, /gsap\.timeline/);
  assert.match(motion, /prefers-reduced-motion/);
  assert.match(motion, /timeline\.kill/);
  assert.match(motion, /thinking[\s\S]*reading[\s\S]*command[\s\S]*editing[\s\S]*agent[\s\S]*orchestration[\s\S]*mcp[\s\S]*writing/);
  assert.match(sidebar, /OpenKanChatMotion\?\.render/);
  assert.match(sidebar, /OpenKanChatMotion\?\.stop/);
});

test("classifies live chat work into distinct GSAP motion states", () => {
  const windowStub: Record<string, unknown> = {};
  const load = new Function("window", read("web/chat-status-motion.js"));
  load(windowStub);
  const motion = (windowStub as any).OpenKanChatMotion;
  assert.equal(motion.modeFor({ label: "Thinking" }), "thinking");
  assert.equal(motion.modeFor({ label: "Reading package.json" }), "reading");
  assert.equal(motion.modeFor({ label: "Running npm test" }), "command");
  assert.equal(motion.modeFor({ label: "Editing chat-sidebar.js" }), "editing");
  assert.equal(motion.modeFor({ label: "Delegating to verifier" }), "agent");
  assert.equal(motion.modeFor({ label: "Coordinating team" }), "orchestration");
  assert.equal(motion.modeFor({ label: "Calling MCP" }), "mcp");
  assert.equal(motion.modeFor({ label: "Writing response" }), "writing");
  assert.equal(motion.modeFor({ label: "Chat failed" }), "error");
});

test("keeps composer text neutral with a subtle selection tint", () => {
  const css = read("web/style.css");
  assert.match(css, /\.chat-sidebar \.chat-sidebar__composer-input\s*\{[\s\S]*color: var\(--text\)/);
  assert.match(css, /\.chat-sidebar \.chat-sidebar__composer-input::selection\s*\{[\s\S]*background: color-mix\(in srgb, var\(--accent\) 18%, transparent\)/);
});

test("uses the GSAP completion mark for settled chat activity", () => {
  const sidebar = read("web/chat-sidebar.js");
  const css = read("web/style.css");
  assert.match(sidebar, /chat-activity-completion/);
  assert.match(sidebar, /phase: "complete", label: "Completed"/);
  assert.match(sidebar, /completedMotionTs: new Set/);
  assert.match(sidebar, /completionTs && !state\.completedMotionTs\.has\(completionTs\)/);
  assert.match(sidebar, /assistantAdded \? \(assistantTurn\?\.ts/);
  assert.match(sidebar, /OpenKanChatMotion\?\.animate\?\.\(completion\)/);
  assert.match(css, /\.chat-status-motion--complete \.chat-status-motion__pixel--7/);
  assert.match(css, /data-chat-status-settled/);
  assert.match(read("web/chat-status-motion.js"), /repeat: terminal \? 0 : -1/);
  assert.match(read("web/chat-status-motion.js"), /delete node\.dataset\.chatStatusAnimating/);
});

test("keeps composer focus quiet and task drop affordance compact", () => {
  const css = read("web/style.css");
  assert.match(css, /\.chat-sidebar__composer-surface:focus-within,\n\.chat-sidebar--task-drop/);
  assert.match(css, /box-shadow: none/);
  assert.match(css, /\.chat-sidebar--task-drop \.chat-sidebar__composer-surface::before/);
  assert.match(css, /content: "Drop to mention"/);
  assert.match(css, /\.chat-sidebar::after \{ display: none !important; \}/);
});

test("supports a portable, non-destructive task-to-chat drag contract", () => {
  const app = read("web/app.js");
  const chat = read("web/chat-sidebar.js");
  assert.match(app, /effectAllowed = "copyMove"/);
  assert.match(app, /application\/x-openkan-task/);
  assert.match(app, /text\/x-openkan-task/);
  assert.match(app, /window\.OpenKanActiveTaskDrag = chatTask/);
  assert.match(chat, /function readDraggedTask/);
  assert.match(chat, /function insertTaskMention/);
  assert.match(chat, /chat-sidebar__mention-tray/);
  assert.match(chat, /data-chat-remove-mention/);
  assert.match(chat, /taskMentions,/);
  assert.match(chat, /References belong to the compact tray/);
  assert.match(chat, /e\.dataTransfer\.dropEffect = "copy"/);
});

test("keeps primary navigation finite and moves secondary people tools into More", () => {
  const html = read("web/index.html");
  const app = read("web/app.js");
  const tabs = html.slice(html.indexOf('<nav class="topbar-tabs"'), html.indexOf('</nav>', html.indexOf('<nav class="topbar-tabs"')));
  assert.match(html, /id="home-page-btn"/);
  assert.doesNotMatch(tabs, /data-tab="home"/);
  assert.doesNotMatch(tabs, /data-tab="contributors"/);
  assert.match(html, /id="workspace-more-btn"/);
  assert.match(html, /data-workspace-page="changelog"/);
  assert.match(html, /data-workspace-page="insights"/);
  assert.match(html, /data-workspace-page="contributors"/);
  assert.match(app, /homeButton\?\.classList\.toggle\("active", name === "home"\)/);
});

test("provides a preview-first MDX docs workspace backed by the native renderer", () => {
  const docs = read("web/docs-view.js");
  const server = read("kanban/server.ts");
  const css = read("web/style.css");
  assert.match(docs, /\/api\/docs\/render/);
  assert.match(docs, /docs-mdx-preview/);
  assert.match(docs, /sourceOpen:false/);
  assert.match(docs, /source-open/);
  assert.match(docs, /data-doc-format/);
  assert.match(server, /async function apiRenderDoc/);
  assert.match(server, /path === "\/api\/docs\/render"/);
  assert.match(css, /Preview-first docs/);
});

test("home command center queries live workspace sources without promoting worktrees", () => {
  const home = read("web/home-view.js");
  assert.match(home, /\/api\/projects/);
  assert.match(home, /\/api\/board/);
  assert.match(home, /\/api\/claude\/agents/);
  assert.match(home, /\/api\/goals/);
  assert.match(home, /\/api\/insights\/velocity\?days=30/);
  assert.match(home, /isWorktree/);
  assert.match(home, /home-network/);
});
