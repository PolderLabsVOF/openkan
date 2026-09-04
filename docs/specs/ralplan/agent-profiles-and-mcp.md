---
title: Agent Profiles, Onboarding, and MCP Transport for OpenKan
status: draft (planner pass)
owner: @mike
date: 2026-09-04
inputs:
  - /projects/openkan HEAD 7b566a3
  - /projects/openkan origin/main 7b566a3
  - upstream pivot commits 1eee650 .. 7b566a3
  - docs/HOOKS.md
  - docs/CLAUDE-NATIVE.md
  - docs/OK-PLANNING.md
  - docs/BIZAR_INTEGRATION.md
  - .claude/skills/ok-planning/SKILL.md
  - skills/openkan/SKILL.md
  - .ok/openkan.json
  - bin/openkan.ts, bin/ok.ts, ok/commands/*.ts
  - CHANGELOG.md (Unreleased)
related:
  - docs/specs/ralplan/agent-profiles-and-mcp.handoff.json
---

# Agent Profiles, Onboarding, and MCP Transport for OpenKan

## 1. One-paragraph summary

OpenKan already ships Claude-native agent runtime (transcript tail + relay
hook + `/api/claude/*` SSE/WS), the `.ok/` planning data layer, the `ok` CLI
subcommand family (`init`, `task`, `plan`, `prd`, `doctor`, `index`,
`migrate-from-openkan`), and a jargon-free `ok-planning` skill. What is
**missing** is (a) a multi-agent **profile** abstraction in settings so any
agent — Claude Code, Codex CLI, Cursor, Cline, custom — can be a first-class
target, (b) a jargon-free **onboarding** flow a non-technical user can run
end-to-end without reading docs, and (c) an **MCP transport** so MCP-aware
agents (Cursor, Cline, Codex, custom clients) reach OpenKan without HTTP
plumbing. This plan ships all three on top of existing primitives; nothing
here rebuilds runtime, replaces `.ok/`, or removes the Bizar compat block
this milestone.

## 2. Existing primitives — reuse, do not rebuild

These already exist and are the foundation of the plan. Every section below
must reference them rather than propose alternatives.

| Primitive | Path | Purpose |
|---|---|---|
| `.ok/` data layer | `.ok/`, `ok/schemas.ts`, `ok/storage.ts` | Canonical task/plan/PRD store; atomic writes via tmp-then-rename. |
| `ok` CLI | `bin/ok.ts`, `ok/commands/*.ts` | Subcommand family for tasks/plans/PRDs/doctor/index/migrate. |
| OpenKan engine | `kanban/`, `bin/openkan.ts` | Reads `.ok/`, serves REST + WebSocket on `127.0.0.1:7777`. |
| Claude-native runtime | `kanban/server.ts:2439-2564`, `web/claude-pane.js` | `/api/claude/ws`, `/api/claude/events` SSE, `claude-pane` UI tab. |
| Transcript tail | `kanban/claude-state.ts` (M18) | Default Claude Code state reader, no Bizar required. |
| Relay hook | `.claude/hooks/claude-activity-relay.mjs` (in repo), `docs/HOOKS.md` | Opt-in sub-200 ms relay. |
| Auto-init hook | SessionStart (config in repo) | `ok init` runs on first session if `.ok/` missing. |
| `ok-planning` skill | `.claude/skills/ok-planning/SKILL.md` | Jargon-free, self-contained — **the voice model** for everything new. |
| Settings sidebar | `web/settings.js`, `GET /api/config-sections`, `PATCH /api/config-sections/:id` | Already a sectioned UI for Project / Server / UI / Sandbox / Import / Contributors / Advanced. |
| Multi-project registry | `~/.config/openkan/projects.json` | Already wired; projects can be added/removed/switched. |

## 3. Scope and explicit non-goals

### In scope
- **Agent profile schema** stored in `.ok/openkan.json` under `agents.profiles`.
- **First-class onboarding command** `openkan onboard` that drives a guided
  flow: pick profile (Claude Code default), confirm port, optionally
  install relay hook, optionally register MCP server for non-Claude clients.
- **`openkan` skill rewrite** at `skills/openkan/SKILL.md` — rewrite to the
  voice of `ok-planning` (verbs, no jargon, declarative). An agent with the
  rewritten skill can run onboarding itself.
- **MCP stdio server** (`openkan mcp`) wrapping the existing REST API in a
  tool/resource surface for MCP-aware agents. Stdio first; Streamable HTTP
  deferred.
- **Profile-aware dispatcher** so the CLI / engine know which profile is
  active when starting sessions, dispatching tasks, or relaying events.

### Out of scope (explicit)
- Multi-tenant cloud, accounts, billing, auth.
- Cloud sync (GitHub Issues, Linear, Jira, Notion).
- LLM enrichment, semantic search, telemetry.
- LLM-assisted auto-config ("just figure it out").
- Replacing `.ok/` with anything else.
- Removing the Bizar compat block this milestone — it stays.
- WebSocket MCP transport (stdio first; HTTP deferred to a follow-up).

## 4. The four coupled pieces

The plan must be read as one design with four pieces that ship together as
a coherent milestone. Profiles are the smallest surface and ship first.

### 4.1 Agent profile schema (Shape A: profiles first)

Anchor shape against `.ok/openkan.json`'s existing `project` and `bizar`
blocks (flat, snake_case, optional). Extend with:

```jsonc
// .ok/openkan.json
{
  "agents": {
    "active": "claude-code",          // currently-active profile id
    "profiles": {
      "claude-code": {
        "kind": "claude-code",         // discriminator; one of: claude-code | codex-cli | cursor | cline | custom
        "binary": "claude",            // CLI binary name on PATH (PATH-resolved at first use)
        "defaultFlags": [],            // e.g. ["--model", "sonnet"]
        "transport": "native",          // native | mcp | http
        "capabilities": {
          "hooks": true,               // can we install the relay hook?
          "skills": true,              // can we install the ok-planning skill?
          "mcp": true                  // can we expose the MCP server to this agent?
        },
        "sessionStartHook": "config/claude/hooks/ok-init.mjs",  // optional, file path
        "notes": "Default Claude Code profile. Hooks already live in repo."
      },
      "codex-cli": {
        "kind": "codex-cli",
        "binary": "codex",
        "defaultFlags": [],
        "transport": "mcp",
        "capabilities": { "hooks": false, "skills": false, "mcp": true }
      },
      "cursor": {
        "kind": "cursor",
        "binary": "cursor",
        "defaultFlags": [],
        "transport": "mcp",
        "capabilities": { "hooks": false, "skills": false, "mcp": true }
      },
      "cline": {
        "kind": "cline",
        "binary": "cline",
        "defaultFlags": [],
        "transport": "mcp",
        "capabilities": { "hooks": false, "skills": false, "mcp": true }
      },
      "custom": {
        "kind": "custom",
        "binary": null,                 // user-supplied
        "defaultFlags": [],
        "transport": "mcp",
        "capabilities": { "hooks": false, "skills": false, "mcp": true }
      }
    }
  }
}
```

Validation rules (mirroring the style of existing schema validators in
`ok/schemas.ts`):

- `agents.active` must match a key in `agents.profiles` if both are set.
- `kind` is an enum of the four plus `custom`.
- `binary` is required unless `kind === "custom"` AND `binary` is `null`.
- `capabilities.hooks === true` requires `sessionStartHook` to be a path
  that exists at first use; otherwise fail closed.
- Profiles with `transport === "native"` MUST be Claude Code (only one
  native runtime today). Any other `kind` with `transport === "native"`
  is rejected.
- `bizar` block is read as a legacy profile — it remains valid input; the
  engine exposes `bizar` as a synthetic profile of `kind: "bizar"` for
  compatibility. Not a config-edit; a reader wrapper.

### 4.2 Onboarding — `openkan onboard` (Shape A: onboarding second)

A guided, non-interactive-default flow with a hard cap of **3 questions**
in interactive mode (5 questions if relay hook is opted in). The agent
drives this same flow with `--non-interactive` plus flags.

Interactive flow (the user only sees this many questions):

1. **"Which agent will run tasks here?"**
   Options: Claude Code (default), Codex CLI, Cursor, Cline, Custom.
2. **"Where should OpenKan listen?"**
   Default `127.0.0.1:7777`; user accepts or types `host:port`.
3. **"Anything else to set up now?"**
   Multi-select: install relay hook, install MCP server entry, write
   a starter `.ok/` project (plan + 3 tasks). All optional; "no, I'm done"
   exits cleanly.

Non-interactive (agent-driven, CI-friendly):

```sh
openkan onboard \
  --profile claude-code \
  --port 7777 \
  --install-relay-hook \
  --install-mcp \
  --seed-starter
```

The flow must be **idempotent**: re-running `openkan onboard` does not
overwrite existing choices; it reports the current state and asks only
about unset items. Re-running with `--reset` writes defaults but never
deletes existing tasks, plans, or profiles unless the user confirms
explicitly.

A single binary exit code:

- `0` — onboarding succeeded or nothing to do.
- `1` — user aborted or preconditions failed (e.g. binary not on PATH).
- `2` — invalid input.

The settings sidebar at `web/settings.js` gains one new section
`"Agents"` rendered via `GET /api/config-sections` with the active
profile and a "Run onboarding again" button. No raw JSON editing
required; the section editor handles profile CRUD.

### 4.3 MCP transport — stdio first (Shape A: transport third)

`openkan mcp` launches an MCP server over stdio. The server reads the
active profile from `.ok/openkan.json`, opens a connection to the
loopback HTTP API on `127.0.0.1:<port>`, and exposes:

- **Tools** (v1, names match REST verbs 1:1 so the surface is unambiguous):
  - `list_tasks` (filter: column, status, owner, archived)
  - `get_task` (id)
  - `create_task` (title, description?, column?, owner?, source?)
  - `update_task` (id, fields...)
  - `move_task` (id, column, order?)
  - `archive_task` (id)
  - `restore_task` (id)
  - `add_comment` (id, body, author)
  - `list_plans`, `get_plan`, `create_plan`, `add_task_to_plan`
  - `list_prds`, `get_prd`, `create_prd`
  - `get_board` (full snapshot)
  - `recheck_stale` (id)
  - `import` (optional include/exclude globs)
  - `doctor` (run `ok doctor`)
- **Resources** (read-only snapshots):
  - `ok://board` → JSON of `GET /api/board`
  - `ok://tasks-index` → JSON of `GET /api/tasks-index`
  - `ok://task/<id>` → JSON of `GET /api/tasks/:id`
  - `ok://changelog/summary` → JSON of `GET /api/changelog/summary`
  - `ok://config` → JSON of `.ok/openkan.json`

The server is **stdio-first** because the dominant MCP-aware clients
today (Cursor, Cline, Codex CLI, Claude Desktop) all prefer stdio over
HTTP for local servers. Streamable HTTP is deferred to a follow-up —
reusing the existing REST API for that is a small bounded task once
stdio is proven.

Discovery: `openkan mcp` writes the standard
`~/.config/<client>/mcp.json` snippet for each supported client when
`--install-mcp` is passed during onboarding. The snippet points at the
absolute path of the running `openkan` binary with the `mcp` subcommand.

### 4.4 `openkan` skill rewrite (Shape A: skill fourth)

`skills/openkan/SKILL.md` is the legacy entry point loaded by Claude Code
when `.ok/` is present. Today it is jargon-heavy and references Bizar.
The rewrite keeps the same `name: openkan` frontmatter so existing
clients keep loading it, but the body becomes a **jargon-free, voice-
matched companion to `ok-planning`**. Concretely:

- Drop every "Bizar" reference; replace with "the active agent profile".
- Replace `references/api.md` cross-references with `ok <subcommand>` calls.
- Add a 1-paragraph "What this skill is" that mirrors `ok-planning`'s
  `## Why this skill is self-contained` framing.
- Add a section "Run onboarding" that points at `openkan onboard
  --non-interactive --profile claude-code` so the agent can run it.
- Move the verbose curl examples to `references/http-api.md` and link
  from the body without inlining.

The rewrite is a **single self-contained commit** that does not change
the skill's behavior — only its voice and command recommendations. An
agent reading the rewritten skill can run end-to-end onboarding without
reading any other file (the same property `ok-planning` already has).

**Resolved C8 — voice model fidelity.** The two skills are
structurally different: `ok-planning` is a CLI reference for `.ok/`
itself; `openkan` is an in-session workflow guide covering the
running engine, hooks, REST API, and onboarding. M22 therefore does
**not** rewrite `openkan` to *be* `ok-planning`. It rewrites it to
follow the same **voice** (verbs, no jargon, declarative) and the
same **self-contained** property (a single read covers the standard
flow). Concretely: the rewritten `openkan` skill body is ~150 lines
of declarative guidance + `ok <subcommand>` examples; everything
verbose moves to `references/http-api.md` and `references/agents.md`.
This is a voice-and-organization rewrite, not a content replacement.

**Resolved C5 — preflight before M22 ships.** Before committing the
rewrite, run `grep -rEn 'skills/openkan/' .` (excluding `node_modules/`)
and audit every reference. Surface any doc, README, web copy, or
another skill that links to specific content inside `SKILL.md` (e.g.
a unique section heading or a specific command example) so the
rewrite does not silently break them. The audit result is the first
paragraph of the M22 commit message.

## 5. The first bounded task

This is the cheapest reversible first step the orchestrator can dispatch
in one worktree, with a real regression-test floor. **Profiles + onboarding
+ MCP transport are too big for one bounded task**; the first task is just
the **profile schema + active-profile dispatch**, plus the scaffolding for
onboarding and MCP, with **stubs** for the rest.

### First milestone — call it **M19: Agent profiles (schema + active dispatch)**

Files touched (with concrete integration points the planner missed in
round 1 — resolved here per the Architect's blockers C1 and C2):

- `.ok/openkan.json` — add `agents.profiles` block; ship
  `claude-code` as the default active profile; leave `bizar` block
  intact.
- `ok/schemas.ts` — add `AgentProfileSchema` and
  `AgentProfilesConfigSchema` validators.
- `ok/storage.ts` — extend the read/write helpers to preserve
  unknown fields (already does, per docs/OK-PLANNING.md "unknown fields
  are tolerated").
- `kanban/server.ts:1564` — extend the `switch(sectionId)` block in
  `apiPatchConfigSection` with a new `case "agents":` that writes
  `agents.active` and `agents.profiles.*` into the loaded config and
  validates via `AgentProfilesConfigSchema` before persisting. Without
  this case, PATCH returns 404 today; M19 must add the case AND its
  validation. The `default:` arm stays for unknown sections.
- `kanban/server.ts:1407-1562` (`apiGetConfigSections`) — extend the
  `sections` builder to emit one `"agents"` section with two fields
  surfaced read-only in v1: `active` (text, current `agents.active`
  value) and `profiles` (textarea, JSON-stringified read-only view).
  Profile CRUD via the section editor is out of scope for M19; it
  lands in M20 alongside the sidebar UI.
- `kanban/server.ts:1040-1056` (`preferred` agent selection at session
  create) — change the order: read `agents.active` from
  `.ok/openkan.json` first; if set AND the active profile's `binary` is
  resolvable on PATH AND that profile's `kind` matches a value in
  `knownAgents`, use it. Otherwise fall back to today's logic
  (`preferred || "mike" || knownAgents[0]`). Reads happen under the
  existing `withWrite` lock so dispatch + config read are consistent;
  no new lock needed.
- `kanban/claude-state.ts` — `readAgents()` is unchanged this
  milestone; it still reads `.claude/agents/` on disk. The profile
  read happens in `kanban/server.ts` at dispatch time as described
  above. `claude-state.ts` is touched only if a future milestone adds
  Claude-specific profile fields.
- `bin/openkan.ts` — `cmdOnboard` stub that prints
  "onboard wired in M20" and exits 0; `cmdMcp` stub that prints
  "mcp wired in M21" and exits 1. Both are dispatched-table entries
  so the harness recognizes them; both ship as no-op stubs.
- `tests/m19-profiles.test.mts` — NEW file. ~150 lines, ~7 tests:
  1. Default `.ok/openkan.json` round-trips with `agents.active =
     "claude-code"`; profiles default registered.
  2. Invalid `agents.active` value (no matching profile) is rejected at
     write time.
  3. `kind: "codex-cli"` with `transport: "native"` is rejected.
  4. The `bizar` block is preserved as a synthetic `kind: "bizar"`
     profile by the engine — readers see it; writers don't touch it.
  5. `PATCH /api/config-sections/agents` round-trips a profile edit
     (sets `agents.active = "codex-cli"` with the codex-cli profile
     registered) — previously 404'd; now persists and emits
     `config.changed` SSE.
  6. Session creation reads `agents.active` and uses it when valid;
     falls back to today's logic when the active profile's kind is
     unknown to `knownAgents`. Regression-tested against the existing
     session-create path.
  7. The `default:` switch arm in `apiPatchConfigSection` still
     returns 404 for unknown sections (no over-broad acceptance).

Acceptance criteria:

- [ ] `npm run check` exit 0.
- [ ] `node --test --experimental-strip-types tests/*.test.mts tests/*.test.mjs` exits 0.
- [ ] No new test file increases the count of **failing** tests.
  Baseline on `main@7b566a3` (verified 2026-09-04 by orchestrator
  post-M19 merge with fresh `npm install`): **438 tests, 438 pass,
  0 fail at main HEAD before M19; 452 tests, 452 pass, 0 fail after
  M19's 14-test addition.** M19 ships 14 new tests in
  `tests/m19-profiles.test.mts`, all passing. No existing failing
  tests; regression floor is zero-tolerance.
- [ ] `openkan onboard` exists as a stub that exits 0 and prints a
  hint.
- [ ] `openkan mcp` exists as a stub that exits 1 with "not yet wired".
- [ ] Schema validators reject the three negative cases above.
- [ ] `bizar` block survives a round-trip read/write of
  `.ok/openkan.json` (no migration this milestone).
- [ ] No new dependencies; no `package.json` change.
- [ ] `apiPatchConfigSection`'s `default:` arm still returns 404 for
  unknown sections (regression).

Non-goals (explicit):

- **No baseline failing tests exist on `main@7b566a3` (438/438/0
  at clean main HEAD; 452/452/0 after M19).** M19 must keep that
  zero-tolerance regression floor across all four milestones;
  introducing or leaving any failure is out of scope.
- No real `cmdOnboard` flow; no real `cmdMcp`. Both are stubs.
- No profile-aware session dispatcher beyond reading `agents.active`
  at session-create time. Multi-agent live dispatch (M23) is
  deferred.
- No MCP tools/resources registered yet (M21).
- No skill rewrite (M22).
- No Streamable HTTP transport (M24).

Reversibility: a single revert restores the prior state; the
`agents.profiles` block in `.ok/openkan.json` is additive on disk and
the engine tolerates its absence.

## 6. Phased milestones (Shape A)

| | Milestone | Surface | Approx. work |
|---|---|---|---|
| **M19** | Agent profiles (schema + active dispatch) | `agents.profiles`, validators, `/api/config-sections/agents` | 1 bounded task above |
| **M20** | `openkan onboard` (interactive + non-interactive) | `cmdOnboard`, settings sidebar "Agents" section | 1 bounded task |
| **M21** | MCP stdio server (full tool/resource surface) | `cmdMcp`, MCP tool registry, `--install-mcp` discovery snippets | 1 bounded task |
| **M22** | `openkan` skill rewrite (jargon-free) | `skills/openkan/SKILL.md` body, `references/http-api.md` move | 1 bounded task |
| **M23** | Multi-agent live dispatch (deferred) | profile-aware session start + relay for non-Claude agents | future, post-validation |
| **M24** | Streamable HTTP MCP transport (deferred) | `openkan mcp --transport http` | future, post-M21 |

### M20 — `openkan onboard` (resolved C4)

`openkan onboard` ships as a new file `ok/commands/onboard.ts` plus a
dispatch entry in `bin/openkan.ts`. The state-diff logic is concrete:

- On every entry, `cmdOnboard` reads `.ok/openkan.json` and `.ok/`
  presence via `ok/storage.ts`.
- It builds a `desiredState` from CLI flags (`--profile`, `--port`,
  `--install-relay-hook`, `--install-mcp`, `--seed-starter`,
  `--reset`) and `currentState` from disk.
- The comparison is a single function
  `diffOnboardingState(current, desired): OnboardingDelta[]` in
  `ok/commands/onboard.ts` (net-new file, single owner) that emits
  one `OnboardingDelta` per setting, with `status: "match" | "missing"
  | "drift"`. Re-running the command without flags only renders
  `match` and `missing` items; it does **not** silently overwrite
  `drift` items — the user must explicitly `--reset` or pass the
  flag that conflicts.
- The interactive flow asks **only** about `missing` items, capped at
  3 questions (5 if relay hook is opted in). `drift` items are shown
  as a printed summary; the user chooses per-item whether to keep or
  change.
- `--non-interactive` is the agent-driven path. With `--profile`
  supplied, it writes defaults and exits 0. Without `--profile`, it
  exits 2 with a usage hint. Idempotent: a second run with no flags
  reports `match` for everything and exits 0 without touching disk.

### M21 — `openkan mcp` (resolved C3)

`cmdMcp` lives in `bin/openkan.ts` and **auto-starts the OpenKan HTTP
engine** if it is not already running on the configured port:

- On entry, `cmdMcp` reads `agents.active` from `.ok/openkan.json` and
  the configured port (default `7777`).
- It calls `startOrAttach(ctx, opts)` from `kanban/server.ts:2182` (the
  existing helper) which either attaches to a running engine or
  starts one in-process. The MCP server then proxies over loopback
  to `http://127.0.0.1:<port>`.
- If auto-start fails (port already bound by another process,
  permission denied), `cmdMcp` exits 2 with a precise error message
  and `--no-auto-start` is a documented escape hatch for users who
  want to manage the engine themselves.
- `--install-mcp <client>` writes the standard MCP config snippet
  for the named client (`claude-code` writes
  `~/.claude/mcp_servers.json`; `cursor` writes
  `~/.cursor/mcp.json`; etc.). `--print-mcp-config <client>` prints
  the snippet to stdout for CI use.
- Stdio is the **only** transport this milestone. `--transport http`
  is recognized and exits 1 with "deferred to M24" so users get a
  clear signal rather than silent fallback.

Each M19-M22 is one worktree-isolated task; M23/M24 are explicitly
**not in this plan** and require re-decision once M19-M22 are
verified.

## 7. Risks

- **Profile schema lock-in.** If we add a fifth `kind` later, the enum
  rejects unknown values. Mitigation: ship a small `--add-profile
  --kind custom --binary /path/to/x` escape hatch from day one.
- **`openkan mcp` discovery snippets path quirks.** Different MCP
  clients have different config file conventions (`.cursor/mcp.json`,
  `~/.config/claude/mcp_servers.json`, etc.). Mitigation: ship a
  `--print-mcp-config <client>` subcommand for each known client and
  a `--print-mcp-config json` for raw output the user can paste
  anywhere.
- **`openkan` skill rewrite touches a file Claude Code auto-loads.**
  Mitigation: keep the frontmatter `name: openkan` and `description`
  compatible, only change body text and command examples. Skill body
  edits do not affect install/load behavior. See resolved C5 above:
  preflight audit runs before M22 lands.
- **Bizar compat block becomes inconsistent** if a user removes it.
  Mitigation: `openkan doctor` flags a missing `bizar` block as a
  warning, not an error — explicit opt-in.
- **Agent-driven onboarding must be idempotent.** Re-running must not
  clobber. Tested by the M20 acceptance via the `diffOnboardingState`
  contract.
- **MCP stdio lifecycle when the engine is unreachable.**
  `cmdMcp` auto-starts via `startOrAttach`; `--no-auto-start` is a
  documented escape hatch. Failures exit 2 with a precise message.
  Tested by the M21 acceptance.

### Resolved C6 — settings sidebar split (M19 vs M20)

M19 ships the **API** only: `GET /api/config-sections` returns the
new `"agents"` section with `active` (text, editable) and `profiles`
(textarea, read-only JSON). `PATCH /api/config-sections/agents`
validates and writes. The settings sidebar **UI** for the section
lands in M20 alongside `cmdOnboard` — `web/settings.js` gains a new
section renderer. M19 does not modify `web/settings.js`. This keeps
the API/UI changes independently revertable.

### Resolved C7 — YAGNI / four-milestone separability

The four milestones are separable in three concrete ways:

1. **Distinct test files.** M19 adds `tests/m19-profiles.test.mts`;
   M20 adds `tests/m20-onboard.test.mts`; M21 adds
   `tests/m21-mcp-stdio.test.mts`; M22 adds
   `tests/m22-skill-rewrite.test.mts`. Each file is independent.
2. **Distinct rollback surface.** M19 rolls back by removing
   `agents.profiles` from `.ok/openkan.json` and the `case "agents":`
   arm; M20 by removing `cmdOnboard` and the settings renderer; M21
   by removing `cmdMcp`; M22 by restoring the legacy `SKILL.md`
   from git.
3. **Independent value delivery.** M19 alone delivers "agent profile
   switching" with a settings UI stub. M20 alone delivers "guided
   onboarding" without MCP. M21 alone delivers "MCP transport" with
   a manual discovery step. M22 alone delivers "jargon-free
   workflow guide." None of the four requires the others to ship.

A weekend-delivery version that bundles all four is technically
possible but loses the rollback granularity above. The plan keeps
the four split to preserve the rollback boundary.

## 8. Approval boundaries (HITL floor)

This plan touches the seven-category floor as follows:

- **Public API breakage:** none — additive surface only.
- **Destructive operation:** none in M19-M22. Schema rejects unknown
  values rather than mutating them.
- **Auth / security:** none.
- **Migration:** none this milestone — Bizar block stays.
- **Compliance / PII:** none — local-only.
- **Production incident:** n/a — local tool.
- **Irreversible destruction:** none.

Push, PR, release, deploy, credential, public-exposure surfaces all
remain under the existing hooks gate; nothing this plan changes
that floor.

## 9. Stop condition

Plan-only. The orchestrator persists this spec and the typed handoff
JSON at `docs/specs/ralplan/agent-profiles-and-mcp.handoff.json`,
records the run identity, and does **not** invoke any implementation
skill. M19 dispatch is gated on user approval after spec review.
