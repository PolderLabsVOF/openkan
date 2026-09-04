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
  assert.match(motion, /thinking[\s\S]*searching[\s\S]*reading[\s\S]*command[\s\S]*editing[\s\S]*agent[\s\S]*orchestration[\s\S]*mcp[\s\S]*writing/);
  assert.match(sidebar, /OpenKanChatMotion\?\.render/);
  assert.match(sidebar, /OpenKanChatMotion\?\.stop/);
});

test("classifies live chat work into distinct GSAP motion states", () => {
  const windowStub: Record<string, unknown> = {};
  const load = new Function("window", read("web/chat-status-motion.js"));
  load(windowStub);
  const motion = (windowStub as any).OpenKanChatMotion;
  assert.equal(motion.modeFor({ label: "Thinking" }), "thinking");
  assert.equal(motion.modeFor({ label: "Searching the web for OpenKan docs" }), "searching");
  assert.equal(motion.modeFor({ label: "Reading package.json" }), "reading");
  assert.equal(motion.modeFor({ label: "Running npm test" }), "command");
  assert.equal(motion.modeFor({ label: "Editing chat-sidebar.js" }), "editing");
  assert.equal(motion.modeFor({ label: "Delegating to verifier" }), "agent");
  assert.equal(motion.modeFor({ label: "Coordinating team" }), "orchestration");
  assert.equal(motion.modeFor({ label: "Calling MCP" }), "mcp");
  assert.equal(motion.modeFor({ label: "Writing response" }), "writing");
  assert.equal(motion.modeFor({ label: "Chat failed" }), "error");
});

test("reconciles completed tool status instead of retaining a stale web-search label", () => {
  const sidebar = read("web/chat-sidebar.js");
  assert.match(sidebar, /phase: data\.name === "WebSearch" \? "searching" : "tool"/);
  assert.match(sidebar, /chat\.tool-result[\s\S]*?renderLiveChips\(\);[\s\S]*?syncLiveToolStatus\(\)/);
  assert.match(sidebar, /function syncLiveToolStatus\(\)/);
  assert.match(sidebar, /updateLiveStatus\(\{ phase: "thinking", label: "Thinking" \}\)/);
  assert.match(sidebar, /function stopSessionStream\(\)[\s\S]*?removeStreamingIndicator\(\)/);
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

test("keeps the board placement indicator stable within one insertion target", () => {
  const app = read("web/app.js");
  assert.match(app, /indicatorBody: null/);
  assert.match(app, /indicatorIndex: null/);
  assert.match(app, /function clearDropIndicator/);
  assert.match(app, /dragState\.indicatorBody === body && dragState\.indicatorIndex === idx/);
  assert.match(app, /indicator\?\.isConnected\) return/);
  assert.match(app, /clearDropIndicator\(\);/);
  assert.match(app, /dragState\.indicator = indicator/);
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

test("renders an expandable file and command audit trail instead of raw tool payloads", () => {
  const chat = read("web/chat-sidebar.js");
  const css = read("web/style.css");
  assert.match(chat, /function activityInfo/);
  assert.match(chat, /kind: "created"/);
  assert.match(chat, /kind: "changed"/);
  assert.match(chat, /kind: "deleted"/);
  assert.match(chat, /deletedPathsFromCommand/);
  assert.match(chat, /file read/);
  assert.match(chat, /command run/);
  assert.match(chat, /chat-activity-row__details/);
  assert.doesNotMatch(chat, /JSON\.stringify\(tool\.input/);
  assert.match(css, /Chat activity is an audit trail/);
  assert.match(css, /\.chat-activity-row--read/);
  assert.match(css, /\.chat-activity-row--created/);
  assert.match(css, /\.chat-activity-row--changed/);
  assert.match(css, /\.chat-activity-row--deleted/);
  assert.match(css, /\.chat-activity-row--command/);
});

test("deduplicates assistant snapshots before live chat streaming", () => {
  const server = read("kanban/chat.ts");
  assert.match(server, /function mergeText/);
  assert.match(server, /event\.raw\.type === "assistant"/);
  assert.match(server, /onStreamEvent: \(event, applied\)/);
  assert.match(server, /"textDelta" in applied/);
});

test("keeps live chat activity quiet and retains subagent file work after completion", () => {
  const chat = read("web/chat-sidebar.js");
  const server = read("kanban/chat.ts");
  assert.match(chat, /if \(isForwardedTranscript\(event\)\) return false/);
  assert.match(chat, /group\.events\.slice\(-3\)/);
  assert.match(chat, /const current = \[\.\.\.list\]\.reverse\(\)\.find/);
  assert.match(server, /function isHighSignalActivity/);
  assert.match(server, /individual thinking\/text tokens are retained nowhere in the UI/);
  assert.match(server, /function applyForwardedToolEvent/);
  assert.match(server, /subagentToolUses/);
});

test("renders native Claude subagent and hook activity as a grouped chat timeline", () => {
  const chat = read("web/chat-sidebar.js");
  const server = read("kanban/chat.ts");
  const css = read("web/style.css");
  assert.match(server, /--forward-subagent-text/);
  assert.match(server, /--include-hook-events/);
  assert.match(server, /parentToolUseId/);
  assert.match(server, /if \(event\.parentToolUseId\) return;/);
  assert.match(chat, /function nativeActivityGroups/);
  assert.match(chat, /function nativeActivityTreeHTML/);
  assert.match(chat, /SubagentStart/);
  assert.match(chat, /SubagentStop/);
  assert.match(chat, /chat-native-activity-tree/);
  assert.match(chat, /chat-native-agent/);
  assert.match(css, /\.chat-native-agent/);
  assert.match(css, /\.chat-native-event/);
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

test("gives long Docs documents an explicit scroll owner", () => {
  const css = read("web/style.css");
  assert.match(css, /#tab-docs \{ min-height: 0; overflow: hidden; \}/);
  assert.match(css, /\.docs-shell \{ display: flex; min-height: 0; height: 100%; flex-direction: column; overflow: hidden; \}/);
  assert.match(css, /\.docs-stage \{ overflow: auto; overscroll-behavior: contain; \}/);
  assert.match(css, /\.docs-file-list \{ min-height: 0; flex: 1 1 auto; \}/);
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

test("scopes chat restoration state to the active project", () => {
  const sidebar = read("web/chat-sidebar.js");
  assert.match(sidebar, /async function resolveProjectScope\(\)/);
  assert.match(sidebar, /GET", "\/api\/project"/);
  assert.match(sidebar, /function projectStorageKey\(key\)/);
  assert.match(sidebar, /state\.projectScope = await resolveProjectScope\(\)/);
  assert.match(sidebar, /loadString\(projectStorageKey\(STORAGE_KEYS\.lastSession\)\)/);
  assert.match(sidebar, /saveString\(projectStorageKey\(STORAGE_KEYS\.lastSession\)/);
});

test("uses text-led priority and source metadata on task cards", () => {
  const app = read("web/app.js");
  const taskView = read("web/task-view.js");
  const workspace = read("web/workspace.css");
  assert.match(app, /urgent: \{ code: "P0", label: "Urgent"/);
  assert.match(app, /text: `\$\{meta\.code\} \$\{meta\.label\}`/);
  assert.match(app, /card-source-label", \{ text: "Source"/);
  assert.match(app, /card-state-label/);
  assert.doesNotMatch(app, /emoji:/);
  assert.doesNotMatch(taskView, /emoji:/);
  assert.match(taskView, /mkIconBtn\("Archive", "Archive"/);
  assert.match(workspace, /Task-card readability refresh/);
  assert.match(workspace, /\.card-header/);
  assert.match(workspace, /\.card-priority\.priority-urgent/);
});
