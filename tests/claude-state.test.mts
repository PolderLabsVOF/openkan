// OpenKan — tests for kanban/claude-state.ts readers.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readAgents,
  readCommands,
  readHooks,
  readModelRouter,
  readNativeSessions,
  recordEvent,
  resetActivityRing,
  readSkills,
  readTeams,
  readWorkflows,
} from "../kanban/claude-state.ts";

let tempRoot: string | null = null;
let priorClaudeConfig: string | undefined;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openkan-claude-state-"));
  tempRoot = root;
  priorClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
  return root;
}

function writeFile(parts: string[], contents: string): string {
  const root = tempRoot!;
  const fullPath = join(root, ...parts);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, contents);
  return fullPath;
}

afterEach(() => {
  resetActivityRing();
  if (tempRoot && existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
  if (priorClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfig;
  priorClaudeConfig = undefined;
});

test("readAgents parses frontmatter and resolves model from router tier", async () => {
  const root = makeRoot();
  writeFile(
    [".claude", "agents", "mike.md"],
    `---
name: mike
description: Bizar office manager and team orchestrator.
tools: Read, Write, Bash
model: minimax/MiniMax-M3
---

# Mike
`,
  );
  writeFile(
    [".claude", "agents", "_shared", "baseline.md"],
    `---
name: shared
description: shared baseline
---

# Shared
`,
  );
  writeFile(
    [".claude", "model-router.json"],
    JSON.stringify({
      version: "13.0.0",
      endpoint: null,
      policies: { mainOrchestrator: "mike", unknownAgent: "minimax/MiniMax-M3" },
      userSelected: {
        models: ["minimax/MiniMax-M3"],
        tierHints: { mike: "default" },
      },
    }),
  );

  const agents = await readAgents(root);
  assert.equal(agents.length, 1, "shared agents must be skipped");
  assert.equal(agents[0].id, "mike");
  assert.equal(agents[0].model, "minimax/MiniMax-M3");
  assert.deepEqual(agents[0].tools, ["Read", "Write", "Bash"]);
  assert.match(agents[0].body, /# Mike/);
});

test("readAgents returns empty array when no agents dir exists", async () => {
  const root = makeRoot();
  const agents = await readAgents(root);
  assert.deepEqual(agents, []);
});

test("readSkills reads SKILL.md from each skill directory", async () => {
  const root = makeRoot();
  writeFile(
    [".claude", "skills", "bizar", "SKILL.md"],
    `---
name: bizar
description: Operate the Bizar Claude Code harness.
---

# Bizar
`,
  );
  writeFile(
    [".claude", "skills", "bizar", "secondary.md"],
    "# This file should be skipped because it's not SKILL.md",
  );

  const skills = await readSkills(root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, "bizar");
  assert.equal(skills[0].description, "Operate the Bizar Claude Code harness.");
});

test("readCommands returns all *.md files in ~/.claude/commands", async () => {
  const root = makeRoot();
  writeFile(
    [".claude", "commands", "bizar.md"],
    `---
description: Show Bizar controls.
---

# Bizar
`,
  );
  writeFile(
    [".claude", "commands", "workflow-cmd.md"],
    `---
workflow: true
description: Run a workflow.
---

# Workflow
`,
  );
  writeFile(
    [".claude", "commands", "openkan", "docs.md"],
    `---
description: Edit OpenKan docs.
---

# Docs
`,
  );
  writeFile(
    [".claude", "commands", "_shared", "fragment.md"],
    "# Shared fragment",
  );

  const commands = await readCommands(root);
  assert.equal(commands.length, 3);
  assert.ok(commands.some((command) => command.id === "openkan/docs"));
  const workflow = commands.find((c) => c.id === "workflow-cmd");
  assert.ok(workflow);
  assert.equal(workflow.workflow, true);
});

test("readHooks merges settings.json and filesystem hooks", async () => {
  const root = makeRoot();
  writeFile(
    [".claude", "settings.json"],
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "echo ups" }],
          },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo tool" }],
          },
        ],
      },
    }),
  );
  writeFile(
    [".claude", "hooks", "extra.mjs"],
    "#!/usr/bin/env node\nconsole.log('extra');\n",
  );

  const hooks = await readHooks(root);
  const events = new Set(hooks.map((h) => h.event));
  assert.ok(events.has("UserPromptSubmit"));
  assert.ok(events.has("PreToolUse"));
  assert.ok(events.has("filesystem"), "filesystem hooks should be present");
  assert.equal(hooks.find((h) => h.event === "PreToolUse")?.matcher, "Bash");
});

test("readHooks returns empty array on missing settings.json", async () => {
  const root = makeRoot();
  const hooks = await readHooks(root);
  assert.deepEqual(hooks, []);
});

test("readHooks applies user, project, and settings.local.json precedence without mutating sources", async () => {
  const root = makeRoot();
  process.env.CLAUDE_CONFIG_DIR = join(root, "user-claude");
  writeFile(["user-claude", "settings.json"], JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ command: "echo user" }] }],
      PreToolUse: [{ hooks: [{ command: "echo user-tool" }] }],
    },
  }));
  writeFile([".claude", "settings.json"], JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ command: "echo project" }] }] },
  }));
  writeFile([".claude", "settings.local.json"], JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ command: "echo local" }] }] },
  }));

  const hooks = await readHooks(root);
  assert.deepEqual(hooks.filter((hook) => hook.event === "UserPromptSubmit").map((hook) => hook.command), ["echo local"]);
  assert.deepEqual(hooks.filter((hook) => hook.event === "PreToolUse").map((hook) => hook.command), ["echo user-tool"]);
  assert.equal(hooks.find((hook) => hook.event === "UserPromptSubmit")?.source, join(root, ".claude", "settings.local.json"));
});

test("readModelRouter returns defaults when file missing", async () => {
  const root = makeRoot();
  const router = await readModelRouter(root);
  assert.equal(router.version, null);
  assert.deepEqual(router.models, []);
  assert.equal(router.policies.unknownAgent, "minimax/MiniMax-M3");
});

test("readModelRouter parses models, tierHints, and policies", async () => {
  const root = makeRoot();
  writeFile(
    [".claude", "model-router.json"],
    JSON.stringify({
      version: "13.0.0",
      endpoint: "https://example.test/v1",
      policies: { mainOrchestrator: "mike", unknownAgent: "minimax/MiniMax-M3" },
      userSelected: {
        models: ["minimax/MiniMax-M3", "minimax/MiniMax-M2.7"],
        tierHints: { mike: "default" },
      },
    }),
  );

  const router = await readModelRouter(root);
  assert.equal(router.version, "13.0.0");
  assert.equal(router.endpoint, "https://example.test/v1");
  assert.equal(router.models.length, 2);
  assert.equal(router.tierHints.mike, "default");
  assert.equal(router.policies.mainOrchestrator, "mike");
});

test("readTeams derives team from orchestrator policy and team-keyword agents", async () => {
  const root = makeRoot();
  writeFile(
    [".claude", "agents", "mike.md"],
    `---
name: mike
description: Bizar office manager and team orchestrator.
---
`,
  );
  writeFile(
    [".claude", "agents", "todd.md"],
    `---
name: todd
description: senior engineer who works in a team
---
`,
  );
  writeFile(
    [".claude", "agents", "greg.md"],
    `---
name: greg
description: research analyst for the team
---
`,
  );
  writeFile(
    [".claude", "agents", "lone-wolf.md"],
    `---
name: lone-wolf
description: a solitary worker
---
`,
  );
  writeFile(
    [".claude", "model-router.json"],
    JSON.stringify({
      policies: { mainOrchestrator: "mike" },
      userSelected: { models: [], tierHints: {} },
    }),
  );

  const teams = await readTeams(root);
  // Mike's team includes orchestrator + team-keyword members
  const mikeTeam = teams.find((t) => t.name === "mike");
  assert.ok(mikeTeam, "mike team should exist");
  assert.ok(mikeTeam.members.includes("mike"));
  assert.ok(mikeTeam.members.includes("todd"));
  assert.ok(mikeTeam.members.includes("greg"));
  assert.ok(!mikeTeam.members.includes("lone-wolf"));
});

test("readWorkflows picks skill kind=workflow and command workflow=true", async () => {
  const root = makeRoot();
  writeFile(
    [".claude", "skills", "ralph", "SKILL.md"],
    `---
name: ralph
description: Run a workflow.
kind: workflow
---

## Phase: Research

## Phase: Implementation

## Phase: Verify
`,
  );
  writeFile(
    [".claude", "commands", "workflow-cmd.md"],
    `---
workflow: true
description: A workflow command.
---

## Phase: Plan

## Phase: Execute
`,
  );
  writeFile(
    [".claude", "commands", "non-workflow-cmd.md"],
    `---
description: Not a workflow.
---

# Just a command
`,
  );

  const workflows = await readWorkflows(root);
  const ids = workflows.map((w) => w.id);
  assert.ok(ids.includes("ralph"));
  assert.ok(ids.includes("workflow-cmd"));
  assert.ok(!ids.includes("non-workflow-cmd"));
  const ralph = workflows.find((w) => w.id === "ralph");
  assert.ok(ralph);
  assert.deepEqual(ralph.phases, ["Research", "Implementation", "Verify"]);
  const wfCmd = workflows.find((w) => w.id === "workflow-cmd");
  assert.ok(wfCmd);
  assert.deepEqual(wfCmd.phases, ["Plan", "Execute"]);
});

test("readNativeSessions exposes only the active project's parents and subagents", async () => {
  const root = makeRoot();
  const projectId = root.replace(/[\\/]+/g, "-");
  writeFile([".claude", "projects", projectId, "parent-1.jsonl"], [
    JSON.stringify({ sessionId: "parent-1", agentName: "mike", customTitle: "Plan canvas", timestamp: "2026-09-04T09:00:00.000Z" }),
    JSON.stringify({ sessionId: "parent-1", taskId: "tsk-7", timestamp: "2026-09-04T09:01:00.000Z" }),
  ].join("\n"));
  writeFile([".claude", "projects", projectId, "parent-1", "subagents", "agent-child.jsonl"],
    JSON.stringify({ sessionId: "parent-1", agentId: "child", timestamp: "2026-09-04T09:02:00.000Z" }),
  );
  writeFile([".claude", "projects", "-unrelated", "other.jsonl"],
    JSON.stringify({ sessionId: "other", agentName: "nope" }),
  );

  const sessions = await readNativeSessions(root);
  assert.equal(sessions.length, 2);
  const parent = sessions.find((session) => session.kind === "parent");
  const child = sessions.find((session) => session.kind === "subagent");
  assert.deepEqual(parent && { id: parent.id, agentId: parent.agentId, taskId: parent.taskId, state: parent.state },
    { id: "parent-1", agentId: "mike", taskId: "tsk-7", state: "settled" });
  assert.deepEqual(child && { id: child.id, parentSessionId: child.parentSessionId, agentId: child.agentId },
    { id: "child", parentSessionId: "parent-1", agentId: "child" });
  recordEvent({
    id: "relay-parent", projectId: "parent-1", agentId: "mike", kind: "agent.started",
    status: "active", summary: "started", ts: new Date().toISOString(),
  });
  assert.equal((await readNativeSessions(root)).find((session) => session.id === "parent-1")?.state, "active");
});
