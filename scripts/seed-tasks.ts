#!/usr/bin/env node
// Seed the openkan board with project history tasks.
// Run with: node --experimental-strip-types scripts/seed-tasks.ts
// Stops the server, clears .openkan/, writes new state, restarts.

import { writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { M7_MDX } from "./mdx/m7.ts";
import { M8_MDX } from "./mdx/m8.ts";
import { M9_MDX } from "./mdx/m9.ts";
import { M10_MDX } from "./mdx/m10.ts";
import { M11_MDX } from "./mdx/m11.ts";
import { AUTOTAG_MDX } from "./mdx/autotag.ts";
import { BUGFIX_MDX } from "./mdx/bugfix.ts";
import { SKILL_MDX } from "./mdx/skill.ts";
import { TESTS_MDX } from "./mdx/tests.ts";
import { DOCS_MDX } from "./mdx/docs.ts";
import { POPULATE_MDX } from "./mdx/populate.ts";

const ROOT = process.cwd();
const KANBAN_DIR = join(ROOT, ".openkan");
const TASKS_DIR = join(KANBAN_DIR, "tasks");
const SESSIONS_DIR = join(KANBAN_DIR, "sessions");
const CONFIG_FILE = join(KANBAN_DIR, "config.json");
const BOARD_FILE = join(KANBAN_DIR, "board.json");
const TASKS_INDEX_FILE = join(KANBAN_DIR, "tasks.json");
const CHANGELOG_FILE = join(KANBAN_DIR, "changelog.jsonl");

mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(TASKS_DIR, { recursive: true });

// ─── Auto-derivation (mirror of kanban/tags.ts) ──────────────────────────────
const TAG_KEYWORDS = [
  ["bug", /\b(fix|bug|broken|regression|crash|outage|error)\b/i],
  ["feature", /\b(feature|add support|implement)\b/i],
  ["refactor", /\b(refactor|cleanup|clean up)\b/i],
  ["docs", /\b(doc|docs|documentation|readme|changelog)\b/i],
  ["test", /\b(test|spec|e2e|coverage|playwright|vitest|jest)\b/i],
  ["perf", /\b(perf|performance|slow|optimi)\b/i],
  ["security", /\b(security|vuln|cve|xss|csp|auth|oauth|jwt|rbac)\b/i],
  ["a11y", /\b(a11y|accessibility)\b/i],
  ["ux", /\b(ux|design|figma|mockup)\b/i],
  ["i18n", /\b(i18n|l10n|locale)\b/i],
  ["migration", /\b(migration|migrate)\b/i],
  ["deprecation", /\b(deprecat)\b/i],
];

const CATEGORY_RULES = [
  ["frontend", /\.(tsx|jsx|css|scss)|component|page|button|modal|html|css|ui\b/i],
  ["backend", /\b(api|endpoint|route|handler|server|db|sql|query)\b/i],
  ["infra", /\b(k8s|kubernetes|docker|terraform|helm|deploy|ci|cd|pipeline)\b/i],
  ["docs", /\breadme|changelog|docs?\/|documentation|jsdoc/i],
  ["test", /\b(playwright|vitest|jest|mocha|cypress|e2e|unit test)\b/i],
  ["design", /\b(figma|sketch|wireframe|mockup|style guide)\b/i],
  ["data", /\b(sql|postgres|mysql|schema|index|migration)\b/i],
  ["security", /\b(xss|csp|cve|auth|oauth|jwt|vuln|rbac)\b/i],
];

const PRIORITY_RULES = [
  ["urgent", /\b(p0|urgent|asap|critical|blocker|outage)\b/i],
  ["high", /\b(p1|high|important)\b/i],
  ["low", /\b(p2|low priority)\b/i],
  ["normal", /\b(p3|backlog)\b/i],
];

const EFFORT_RULES = [
  ["xs", /\b(xs|trivial|1-line|one-liner|typo)\b/i],
  ["s", /\b(small|quick|minutes)\b/i],
  ["m", /\b(medium|afternoon|half-day)\b/i],
  ["l", /\b(large|big|week)\b/i],
  ["xl", /\b(xl|epic|multi[\s_-]?week|quarter)\b/i],
];

function extractMetadata(title, description) {
  const text = `${title || ""} ${description || ""}`;
  const tags = [];
  const explicitTags = [];
  const m = text.match(/#([a-zA-Z0-9-]+)/g) || [];
  for (const tok of m) {
    const t = tok.slice(1).toLowerCase();
    if (!explicitTags.includes(t)) explicitTags.push(t);
  }
  for (const [k, re] of TAG_KEYWORDS) {
    if (re.test(text)) tags.push(k);
  }
  for (const t of explicitTags) {
    if (!tags.includes(t)) tags.push(t);
  }
  let category = "task";
  for (const [k, re] of CATEGORY_RULES) {
    if (re.test(text)) { category = k; break; }
  }
  tags.push(category);
  let priority = "normal";
  for (const [k, re] of PRIORITY_RULES) {
    if (re.test(text)) { priority = k; break; }
  }
  let effort = null;
  for (const [k, re] of EFFORT_RULES) {
    if (re.test(text)) { effort = k; break; }
  }
  return { tags: [...new Set(tags)], category, priority, effort, explicitTags };
}

// ─── ID generation ───────────────────────────────────────────────────────────
function makeId() {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

function chgId() {
  return "chg-" + makeId();
}

const now = () => new Date().toISOString();

// ─── Tasks ───────────────────────────────────────────────────────────────────
const TASKS = [
  {
    id: "m7kx9p2a",
    title: "M7 — Tasks index, MDX-centric model, waiting-for-input state",
    description: "Make .openkan/ an MDX-first workspace. Every task gets a rich, agent-writable MDX artifact. New tasks.json index. First-class waiting-for-input state so the agent can ask the user a structured question and block for the answer. Standalone CLI for init/start/stop/status/open/config/logs/reset.",
    column: "done", order: 0, status: "done",
    agent: "thor", model: null,
    explicitTags: ["m7", "shipped"],
    mdx: M7_MDX,
  },
  {
    id: "m8b7q3tw",
    title: "M8 — Inline comments on rendered MDX",
    description: "User clicks any block on a rendered MDX to leave a comment anchored to that block. Comments persist to tasks/<id>/comments.json with the source line and content-hash block id. The agent reads the file and sees exactly which block the user was reacting to.",
    column: "done", order: 1, status: "done",
    agent: "thor", model: null,
    explicitTags: ["m8", "shipped"],
    mdx: M8_MDX,
  },
  {
    id: "m9zr4n8c",
    title: "M9 — TSX/JSX preview components in MDX",
    description: "Agent embeds live, interactive TSX/JSX components inside a task's MDX via <Preview tsx=\"…\" props=\"…\" />. Compiled server-side with sucrase (jsxPragma: h, no React). Runs in a sandboxed iframe (sandbox=allow-scripts, no allow-same-origin). Built-in component library: Button, Card, Row, Column, Text, Heading, Image, ColorSwatch, Code. No hooks.",
    column: "done", order: 2, status: "done",
    agent: "thor", model: null,
    explicitTags: ["m9", "shipped", "sandbox", "tsx"],
    mdx: M9_MDX,
  },
  {
    id: "m10hx7k5",
    title: "M10 — Dashboard tabs, full changelog, git attribution, archive, settings",
    description: "Turn the single board view into a tabbed dashboard: Tasks / Changelog / Contributors. Append-only changelog.jsonl. Git log attribution. Archive flag. Settings modal.",
    column: "done", order: 3, status: "done",
    agent: "thor", model: null,
    explicitTags: ["m10", "shipped", "dashboard"],
    mdx: M10_MDX,
  },
  {
    id: "m11vr2jp",
    title: "M11 — /organize slash command, auto-progress, sort/filter polish",
    description: "First-class /organize slash command delegates to the agent for batch reorganization. Auto-progress notes appended to task MDX on OpenCode session events. Sort dropdown, saved filters (localStorage), contributors filter (@me), archive segmented control.",
    column: "done", order: 4, status: "done",
    agent: "thor", model: null,
    explicitTags: ["m11", "shipped"],
    mdx: M11_MDX,
  },
  {
    id: "tag5nm9q",
    title: "Auto-tagging and categorization system",
    description: "Every task gets tags, category, priority, and effort derived from title + description. Override with #tag in the title. Categories: frontend, backend, infra, docs, test, design, data, security, task. Tags: bug, feature, refactor, docs, test, perf, security, a11y, ux, i18n, migration, deprecation. Priorities: urgent, high, normal, low. Efforts: xs, s, m, l, xl.",
    column: "done", order: 5, status: "done",
    agent: "thor", model: null,
    explicitTags: ["feature"],
    mdx: AUTOTAG_MDX,
  },
  {
    id: "bug3kx7p",
    title: "Server and CLI bug fixes (webRoot, argv, modal CSS, sucrase, flock)",
    description: "Five integration bugs caught after parallel implementation: webRoot path-doubling in static file serving, CLI argv dispatcher ignoring flags, modal [hidden] CSS specificity loss to display:flex, sucrase default JSX output using React.createElement, and node:fs.flock not exposed in Node 24.",
    column: "review", order: 0, status: "done",
    agent: "thor", model: null,
    explicitTags: ["bug"],
    mdx: BUGFIX_MDX,
  },
  {
    id: "skl7rn2v",
    title: "Agent skill + /organize slash command",
    description: "skills/openkan/SKILL.md teaches agents how to use openkan effectively. .opencode/command/organize.md is the /organize slash command that delegates to the agent for batch reorganization. install.sh deploys both to the global OpenCode config.",
    column: "review", order: 1, status: "done",
    agent: "heimdall", model: null,
    explicitTags: ["docs", "feature"],
    mdx: SKILL_MDX,
  },
  {
    id: "tst9mq4r",
    title: "Test infrastructure (0 → 114 tests, node --test runner)",
    description: "Project had no tests. Added tests/ folder with node --test runner (no extra deps). 114 tests across 12 files: io, inputs, comments, tags, tsx-sandbox, mdx-render, migration, changelog, git, archive, organize, CLI. All green. Run with npm test.",
    column: "done", order: 6, status: "done",
    agent: "thor", model: null,
    explicitTags: ["test"],
    mdx: TESTS_MDX,
  },
  {
    id: "doc8wp3f",
    title: "Documentation overhaul (M7–M11 milestones, README, CHANGELOG, skill)",
    description: "M0–M6 milestones exist. Added M7, M8, M9, M10, M11 milestones as MDX. Updated docs/README.mdx, project README.md, CHANGELOG.md (0.2.0), sample project AGENTS.md, ID format (tsk_ → tsk-) across all docs.",
    column: "done", order: 7, status: "done",
    agent: "heimdall", model: null,
    explicitTags: ["docs"],
    mdx: DOCS_MDX,
  },
  {
    id: "pop4cn6x",
    title: "Populate the openkan board with project history",
    description: "After shipping M7–M11, replace the seed test data with real tasks that document the work done. Each task gets a full MDX file with goal, what was delivered, files touched, verification, and links to the milestone docs.",
    column: "doing", order: 0, status: "running",
    agent: "odin", model: null,
    explicitTags: ["task"],
    mdx: POPULATE_MDX,
  },
];

// ─── Write all tasks ─────────────────────────────────────────────────────────

const boardTasks = [];
const changelogEvents = [];

for (let i = 0; i < TASKS.length; i++) {
  const t = TASKS[i];
  const meta = extractMetadata(t.title, t.description);
  for (const tag of t.explicitTags || []) {
    if (!meta.tags.includes(tag)) meta.tags.push(tag);
  }
  if (t.column === "done" && !meta.tags.includes("shipped")) meta.tags.push("shipped");
  if (t.column === "doing" && !meta.tags.includes("wip")) meta.tags.push("wip");
  // Final dedupe (preserve order)
  meta.tags = [...new Set(meta.tags)];

  const task = {
    id: t.id,
    title: t.title,
    description: t.description,
    column: t.column,
    order: t.order,
    sessionId: null,
    agent: t.agent || "",
    model: t.model,
    status: t.status,
    state: t.status,
    lastError: null,
    createdAt: now(),
    updatedAt: now(),
    artifact: `tasks/${t.id}/task.mdx`,
    artifacts: {
      mdxPath: `tasks/${t.id}/task.mdx`,
      commentsPath: `tasks/${t.id}/comments.json`,
      inputsPath: `tasks/${t.id}/inputs.json`,
      statePath: `tasks/${t.id}/state.json`,
    },
    tags: meta.tags,
    category: meta.category,
    priority: meta.priority,
    effort: meta.effort,
    archived: false,
  };
  boardTasks.push(task);

  // Write the per-task dir
  const taskDir = join(TASKS_DIR, t.id);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.mdx"), t.mdx, "utf-8");
  writeFileSync(join(taskDir, "comments.json"), "[]\n", "utf-8");
  writeFileSync(join(taskDir, "inputs.json"), "[]\n", "utf-8");
  writeFileSync(
    join(taskDir, "state.json"),
    JSON.stringify({ archived: false, lastError: null }, null, 2),
    "utf-8",
  );

  // Changelog event
  changelogEvents.push({
    id: chgId(),
    ts: now(),
    kind: "task.created",
    taskId: t.id,
    author: "odin",
    summary: `created "${t.title}"`,
    payload: { column: t.column, tags: meta.tags, category: meta.category },
  });
}

const board = {
  version: 1,
  columns: [
    { id: "backlog", title: "Backlog" },
    { id: "todo", title: "To Do" },
    { id: "doing", title: "In Progress" },
    { id: "review", title: "Review" },
    { id: "done", title: "Done" },
  ],
  tasks: boardTasks,
  sessions: {},
};

writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2) + "\n", "utf-8");
writeFileSync(
  TASKS_INDEX_FILE,
  JSON.stringify(
    {
      tasks: boardTasks.map((t) => ({
        id: t.id,
        title: t.title,
        column: t.column,
        order: t.order,
        state: t.state,
        mdxPath: t.artifacts.mdxPath,
        agent: t.agent,
        model: t.model,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        tags: t.tags,
        category: t.category,
        priority: t.priority,
        effort: t.effort,
        archived: t.archived,
      })),
    },
    null,
    2,
  ) + "\n",
  "utf-8",
);

writeFileSync(
  CONFIG_FILE,
  JSON.stringify(
    {
      port: 7777,
      host: "127.0.0.1",
      defaultAgent: "",
      defaultModel: null,
      defaultColumn: "todo",
      autoArchiveAfterDays: 0,
      import: { include: [], exclude: [] },
      sandbox: { tsxMaxBytes: 32768 },
    },
    null,
    2,
  ) + "\n",
  "utf-8",
);

for (const ev of changelogEvents) {
  appendFileSync(CHANGELOG_FILE, JSON.stringify(ev) + "\n", "utf-8");
}

console.log(`Created ${boardTasks.length} tasks.`);
console.log(`Tasks by column:`);
for (const t of boardTasks) {
  console.log(`  [${t.column.padEnd(8)}] ${t.id} ${t.title}`);
}
console.log(`\nChangelog events: ${changelogEvents.length}`);
console.log(`\nRestart the server: node bin/openkan.mjs start --no-open`);
