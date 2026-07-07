---
name: openkan
description: Use openkan's kanban tools to manage tasks, edit task titles/descriptions, track subtasks, ask the user structured questions, leave comments on MDX artifacts, filter the changelog by completed work, and embed live TSX previews. Trigger whenever the user mentions a kanban, a task to plan/track/edit, a subtask, a checkbox to import, or wants an interactive UI element embedded in a task.
---

# openkan — MDX Kanban for OpenCode

openkan is a local-only kanban plugin for OpenCode. It runs a five-column board (Backlog, To Do, In Progress, Review, Done) at `http://127.0.0.1:7777/`, backed by MDX artifacts on disk under `.openkan/`. Every task has a rich MDX file the agent writes and the user reads — with inline components for questions, choices, live TSX previews, and block-anchored comments.

No auth, no sync, no cloud. Single-machine, single-user.

## When to use it

Reach for openkan when the user says any of:

- "Add a task / create a task"
- "Plan this work / break this down"
- "I want to track these subtasks"
- "Import these checkboxes from my docs"
- "Ask me a question / let me choose"
- "Show me a preview of this design / component"
- "Leave a comment / review my work"
- "What's on the board?"
- "Move this to Done"
- "Archive this / restore that" (M10)
- "What changed recently?" / "Show me the changelog" (M10)
- "Organize the board / clean up the tasks" (M11)
- "Search for a task / find a task" (M12)
- "Move all these to Review / archive all of these" (M12)
- "Show me the task template / what's in a new task?" (M12)
- "Open this task in a new tab / share a task" (M12)
- "Edit this task / change the title / update the description"
- "Add a subtask / break this into smaller pieces"
- "Show me what was completed / what got done recently"

## The custom tools

openkan registers fifteen tools. Always start with `kanban_view` to see what's already on the board.

### `kanban_view` — read-only listing

Lists all tasks, optionally filtered by column and/or status.

```
kanban_view column="todo" status="idle"
```

### `kanban_add` — create a task from scratch

Use when there is no source document with checkboxes.

```
kanban_add title="Fix the login redirect" description="Users report 404 after SSO login" tags="bug,frontend"
```

The parameters are `title` (required), `description`, `column` (default `todo`), `agent`, and the new `tags` (comma-separated string). Tags are auto-derived from title + description unless you pass them explicitly.

### `kanban_import` — scan docs for checkboxes

Scan `.md` / `.mdx` files for `- [ ]` checkboxes and create one Backlog task per hit. Idempotent — re-running on the same files creates no duplicates.

```
kanban_import include="docs/**" exclude="**/archive/**"
```

Prefer this over `kanban_add` when the user has a roadmap, spec, or any doc with checkboxes.

### `kanban_move` — change column

```
kanban_move taskId="tsk-abc12345" column="doing"
```

### `kanban_start` — dispatch the agent on a task

Creates a linked OpenCode session and sends the task description as the initial prompt. Auto-moves to In Progress.

```
kanban_start taskId="tsk-abc12345" agent="thor"
```

### `kanban_ask` — ask the user a structured question

Sets the task state to `waiting-for-input`. A "Needs you" banner appears in the UI. The user answers; you read the response with `kanban_respond`.

```
kanban_ask taskId="tsk-abc12345" type="choice" question="Which icon set?" options='[{"id":"a","label":"Heroicons"},{"id":"b","label":"Lucide"}]'
```

Types: `ask` (free text), `choice` (radio), `input` (single line), `confirm` (yes/no). Only ask **one question per turn** — the user needs to answer before you continue.

### `kanban_respond` — read the user's answer

```
kanban_respond taskId="tsk-abc12345"
```

Returns the user's response to the last `kanban_ask`. Poll this after asking.

### `kanban_comments` — read comments with block context

```
kanban_comments taskId="tsk-abc12345"
```

Comments are anchored to a specific block in the MDX. You get the block ID, line number, and a line excerpt. Address the user's feedback on that specific block.

### `kanban_preview` — validate a TSX snippet

Dry-runs a TSX snippet before embedding it in the MDX. Returns compiled JS or an error.

```
kanban_preview tsx="<Button label='Click me' onClick={() => respond('ok')} />"
```

See the `<Preview>` section below for what's available in the sandbox.

### `kanban_archive` / `kanban_restore` — toggle the archived flag (M10)

```
kanban_archive taskId="tsk-abc12345"
kanban_restore taskId="tsk-abc12345"
```

Archived tasks are hidden from the board but remain in `tasks/<id>/task.mdx` (git-trackable). Restore brings them back to their last column and order.

### `kanban_changelog` — read the append-only change log (M10)

```
kanban_changelog count=20
kanban_changelog taskId="tsk-abc12345"
```

Returns events from `.openkan/changelog.jsonl` — every state change, move, archive, etc. Use it to debug "what happened to this task?" or to surface activity for a standup.

### `kanban_git_attribution` — git-log attribution for a task (M10)

```
kanban_git_attribution taskId="tsk-abc12345"
```

Returns commits that touched files under `.openkan/tasks/<id>/` and the contributor info from `git log`. The Contributors tab in the dashboard aggregates this across all tasks.

### `kanban_organize` — apply a batch of operations atomically (M11)

```
kanban_organize operations='[
  {"type":"move","taskId":"tsk-aaa","column":"backlog"},
  {"type":"retag","taskId":"tsk-bbb","tags":["bug","frontend"]},
  {"type":"setPriority","taskId":"tsk-ccc","priority":"high"},
  {"type":"archive","taskId":"tsk-ddd"}
]'
```

Applies a batch of operations (move, retag, set priority, set effort, add area, archive) atomically with a single changelog event. Returns a diff of what changed and what was skipped.

### `kanban_search` — full-text + filter search

```
kanban_search "auth"
kanban_search "" column:"doing"
kanban_search "" tags:["bug","security"]
kanban_search "auth" priority:"urgent"
```

Search matches: title, description, tags, assignees, and the full MDX content. See the Search section below for more detail.

### `kanban_bulk` — atomic batch operations

```
kanban_bulk({ kind: "move",        taskIds: ["tsk-a","tsk-b"], column: "review" })
kanban_bulk({ kind: "set-priority", taskIds: ["tsk-a"],         priority: "high" })
kanban_bulk({ kind: "add-tags",    taskIds: ["tsk-a","tsk-b"], tags: ["area:auth"] })
kanban_bulk({ kind: "archive",     taskIds: ["tsk-a","tsk-b","tsk-c"] })
```

All operations are atomic — one `kanban.bulk` changelog event fires regardless of batch size. See the Bulk operations section below.

## The MDX artifact workflow

Every task has a rich MDX artifact at `.openkan/tasks/<id>/task.mdx`. The agent writes to it; the user reads it rendered as HTML in the web UI at `http://127.0.0.1:7777/`.

The frontmatter holds the canonical state. The body holds prose, code blocks, and inline components. Write to the MDX freely — it's the workspace.

### Inline components for user interaction

| Component | Purpose |
|-----------|---------|
| `<Ask question="..." />` | Free-text question |
| `<Choice question="..." options={[{id:"a",label:"A"},{id:"b",label:"B"}]} />` | Radio choice |
| `<Input question="..." />` | Single-line input |
| `<Confirm question="..." />` | Yes/no |
| `<Preview tsx="..." props="..." />` | Live TSX sandbox |

These go directly into the MDX body:

```mdx
## Design feedback

Here's the color palette I'm proposing:

<Preview
  tsx={`<Row>
    <ColorSwatch hex="#1a1a2e" label="Primary" />
    <ColorSwatch hex="#16213e" label="Secondary" />
    <ColorSwatch hex="#0f3460" label="Accent" />
  </Row>`}
/>

<Ask question="Does this palette work for the dashboard?" />
```

## The `<Preview>` sandbox

TSX snippets in `<Preview>` run inside a sandboxed iframe:

- `sandbox="allow-scripts"` — no `allow-same-origin`
- No network access, no parent DOM access, no localStorage
- Max 32 KB of TSX source
- Built-in components (no imports needed): `Button`, `Card`, `Row`, `Column`, `Text`, `Heading`, `Image`, `ColorSwatch`, `Code`
- Helpers: `h(type, props, ...children)` for vanilla hyperscript, `render(element, containerSelector)` to mount, `respond(value)` to post a value back
- **No hooks** — `useState`, `useEffect`, `useRef`, etc. are rejected at compile time. Use plain functions and `respond()`.

Validate before writing to MDX:

```
kanban_preview tsx="<Button label='Submit' onClick={() => respond('submitted')} />"
```

## The waiting-for-input cycle

1. Call `kanban_ask` — the task state flips to `waiting-for-input` and a "Needs you" banner appears in the UI
2. The user answers in the UI; the response is written to `inputs.json` and the task resumes
3. On your next turn, call `kanban_respond <taskId>` to read the response

**Pattern: ask one question → wait → respond → continue.** Don't batch questions. Ask one at a time so the user can give a focused answer.

## Comments

The user can click any block in the rendered MDX to leave an inline comment. Comments are anchored via a content-hash block ID — you see exactly which block the user was reacting to.

```
kanban_comments taskId="tsk-abc12345"
```

Each comment returns:
- `blockId` — the content hash of the block
- `line` — line number in the MDX source
- `excerpt` — first 160 chars of the line
- `text` — the comment
- `resolved` — boolean
- `author` — git user name (or `"user"` / `"agent:<name>"`)
- `createdAt` — ISO timestamp
- `resolvedBy` — git user name who resolved, if any
- `resolvedAt` — ISO timestamp, if resolved

When the user comments on a block, address that specific block. Quote its content. Propose a change to that block.

## Comment authorship

Every comment on a task records who wrote it and when. The agent sees
this through both the API and the file system.

Schema (`tasks/<id>/comments.json`):

```ts
interface Comment {
  id: string;                       // cmt-xxxxxxxx
  taskId: string;
  blockId: string;                  // content-hash block id
  line: number;
  text: string;
  author: string;                   // git user.name; "user" if git unavailable; "agent:<name>" for agent-authored
  createdAt: string;                // ISO
  resolved: boolean;
  resolvedBy?: string;              // git user.name who resolved
  resolvedAt?: string;              // ISO
  resolvedReason?: string;
}
```

How authorship is set:
1. The server runs `git config user.name` (no scope flag — falls through
   local → global → system) at task creation or comment creation time.
2. If git is unavailable, falls back to literal `"user"`.
3. Agents that want to write on behalf of another user pass
   `{ author: "agent:<name>" }` explicitly.

The web UI shows the comment author as an avatar circle (initials, colored
deterministically by name hash), the author name in bold, and the relative
timestamp below. When resolved, the footer shows "✓ resolved by
<author> · <time>".

What the agent sees:
- `kanban_comments <taskId>` returns the comments with author + createdAt.
- Use the author to know which teammate or which agent session left a
  comment.
- Comments also record the `blockId` and `line`, so the agent can
  comment back on the exact block.

## The Docs tab

A fourth tab in the topbar gives a fully interactive file browser for the
project's `docs/` folder (configurable per project). The tree on the left
is a recursive collapsible list of directories and files; the right pane
renders the selected file's MDX/MD content with the same nice typography as
the artifact viewer (full line-height, code blocks, blockquotes, tables).

```
GET /api/docs                    # tree of entries
GET /api/docs/<path>?raw=0       # rendered HTML
GET /api/docs/<path>?raw=1       # raw text (text/plain)
```

`?raw=0` (default for `.md` / `.mdx`) returns sanitized HTML;
`?raw=1` returns the raw file contents as `text/plain`, useful for
copy-paste or showing diffs.

Path safety: any path containing `..` or escaping the docs root is
rejected with 400. The tree walker caps recursion at 4 levels.

When to read docs:
- The user references a section of `README.mdx` or similar in a request.
- You need to understand the project's conventions before making changes.
- The user shares a URL like `#tab=docs&doc=milestones/M7.mdx` — the path
  in the hash is loaded automatically.

Tip: the right-click context menu on a docs file lets you "Open raw"
(in the browser, text/plain) or "Copy as URL" (`?raw=0` link).

## Multi-project support

`openkan` can track multiple projects. Each project has its own
`.openkan/` directory and its own docs folder; the registry of projects
lives at `~/.config/openkan/projects.json` (the user's home config dir).

```
GET    /api/projects                       # list + active
POST   /api/projects  { name, root }       # add (auto-derives id from root basename); becomes active
DELETE /api/projects/:id                  # remove; if active, picks another
PATCH  /api/projects/:id/active            # set active
```

The CLI takes `--project /abs/path` to switch at start time:

```bash
openkan start --project ~/work/my-app
openkan start --project ~/work/other
```

The web UI has a project switcher in the topbar (chip next to the brand
that opens a dropdown). Switching the project reloads the entire UI from
the new project's `.openkan/` and `docs/` trees.

How the registry is stored:
- Path: `~/.config/openkan/projects.json`
- Entries: `{ id, name, root, addedAt, active }`; exactly one is active.
- The CLI `openkan config get activeProject` returns the active project id.

Best practices:
- One project per repo. The plugin tracks tasks and docs for that repo.
- Reuse the same registry across machines by syncing the projects.json
  file. (The registry path is in the user's home dir, not the project.)

## Auto-tagging and categorization

Every task gets derived metadata from its title and description. You can override by writing `#tag` in the title or description.

| Field | Values |
|-------|--------|
| `tags` | `bug`, `feature`, `refactor`, `docs`, `test`, `perf`, `security`, `a11y`, `ux`, `i18n`, `migration`, `deprecation` — plus any `#tag` you write |
| `category` | `frontend`, `backend`, `infra`, `docs`, `test`, `design`, `data`, `security`, `task` |
| `priority` | `urgent` (P0), `high` (P1), `normal`, `low` (P2) |
| `effort` | `xs`, `s`, `m`, `l`, `xl` (or `null`) |

Examples of auto-derivation:

| Title | Tags | Category | Priority |
|-------|------|----------|----------|
| "Fix the XSS vulnerability" | `bug, security` | `security` | `normal` |
| "P0: production outage" | `bug` | `task` | `urgent` |
| "Add dark mode `#ux`" | `feature, ux` | `frontend` | `normal` |
| "Tiny typo in hero" | `docs` | `docs` | `normal` (effort: `xs`) |

The filter bar at the top of the board lets you filter by category and tag chips.

## Source link on imported tasks

When a task is created via `kanban_import` (the checkbox scanner), the
task records its origin:

```ts
{
  source: { path: "docs/roadmap.mdx", line: 42, slug: "auto-kanban-parser" },
  sourceHash: "abc123...",        // sha256 of the source file at import time
  stale: false,                  // becomes true when source file changes
  lastSourceCheck: "2026-07-06T..."
}
```

The task MDX renders a "📄 Source:" line at the top; the web UI shows a
clickable chip. The chip links to the source file with the line number
(when the line number is supported by the file format — most viewers
support it via `file:line` in the URL).

## Drift detection

`fs.watch` on the project's `.openkan/` re-checks each task's
`sourceHash` whenever a file under that path changes. If the hash
diverges, the task is marked `stale: true` and a `task.updated` event
broadcasts to the live UI. A periodic 60-second sweep re-checks
all tasks to catch missed events.

The web UI shows a "Stale" badge on stale cards and a "Re-derive tags"
button in the task view. Re-deriving re-runs `extractMetadata` on the
new content and clears the flag if the hash matches.

## Sanity check

`npm run check` validates the active project's `.openkan/` state.
Use it in CI or as a pre-commit hook to catch:

- **Duplicate task IDs** — two board entries with the same `id`.
- **Missing source paths** — a task with `source.path` whose file
  no longer exists on disk.
- **Stale tasks in Done** — a `done` task with `stale: true` means
  it shipped from a source file that has since changed. Re-derive or
  re-import.
- **Orphaned per-task directories** — a `tasks/<id>/` on disk with no
  matching board entry (data wasn't cleaned up after a delete).

Exit code 0 on clean; non-zero on any error. Warnings don't fail the run.

## The dashboard (M10)

The localhost UI at `http://127.0.0.1:7777/` has three tabs:

- **Tasks** — the five-column kanban board with drag-and-drop, filter bar, and sort dropdown
- **Changelog** — a reverse-chronological feed of every state change, sourced from `.openkan/changelog.jsonl`
- **Contributors** — per-contributor task counts and commit attribution, aggregated from `git log`

The topbar has a settings gear that opens the project settings modal (reads/writes `.openkan/config.json`). Archived tasks are hidden by default; toggle "Show archived" in the filter bar to see them.

The sort dropdown supports: newest, oldest, priority, effort, last activity. Saved filters are persisted in `localStorage` (up to 5).

The UI supports both dark and light themes via `:root[data-theme="light"]`.

## Working with teammates (M10)

Tasks and MDX files are git-tracked under `.openkan/` (`sessions/` is gitignored). The Contributors tab reads `git log` to attribute commits to tasks by path overlap.

To see other people's work, `git pull` — their new task MDX files will appear in the board.

The current user is the `git config user.name / user.email`. Use `@me` in the filter to see only your tasks.

## The changelog (M10)

Every state change (add, move, start, archive, organize, etc.) appends one JSON line to `.openkan/changelog.jsonl`. Read it with `kanban_changelog` or `GET /api/changelog`.

Use the changelog to debug "what happened to this task?" or to surface activity for a standup.

### Filtering the changelog by completion

`GET /api/changelog?completedOnly=true` returns only events that
represent terminal / "done"-like work:

- `task.updated` events whose task is currently in the Done column
- `task.archived`, `task.deleted`, `task.restored` (state transitions)
- `kanban.organized` (batch operations)
- `git.commit-attributed` (someone got a commit attributed)
- `agent.ended` (an agent finished its work)
- `settings.changed` (settings change)

In the web UI, the changelog view has a "Completed only" toggle at the top
that flips the API call. Use this when you want a standup-style summary
of "what got done" rather than every state change.

`completedOnly=false` (the default) returns all events. The toggle is
just a friendly wrapper around that query param.

## Archiving (M10)

`kanban_archive` / `kanban_restore` flip the `archived` flag on a task. Archived tasks are hidden from the board but remain in `tasks/<id>/task.mdx` (git-trackable). Restore brings them back to their last column and order.

## Settings dialog (sections sidebar)

`GET /api/config-sections` returns the full config grouped into sections:

| Section ID      | Label         | Example fields                          |
| --------------- | ------------- | --------------------------------------- |
| `project`       | Project       | defaultAgent, defaultModel, defaultColumn |
| `server`        | Server        | port, host                              |
| `ui`            | UI            | theme, archive toggle default           |
| `sandbox`       | Sandbox       | sandbox.tsxMaxBytes                     |
| `import`        | Import        | import.include, import.exclude          |
| `contributors`  | Contributors  | current git user display                |
| `advanced`      | Advanced      | debug, experimental flags               |

`PATCH /api/config-sections/:sectionId` body `Array<{ key, value }>` persists
the changes. The settings dialog has a left sidebar with all section IDs
as nav links; the right panel shows the fields for the active section.

`GET /api/config` (legacy) returns the flat config object — still
supported for back-compat, but new code should prefer the sections endpoint.

## Organizing the board (M11)

The `/organize` OpenCode slash command delegates to the agent to re-categorize, clean up, and group tasks on the board.

`kanban_organize` applies a batch of operations (move, retag, set priority, set effort, add area, archive) atomically with a single changelog event. Use it for bulk edits:

```
kanban_organize operations='[
  {"type":"retag","taskId":"tsk-abc","tags":["bug","frontend"]},
  {"type":"move","taskId":"tsk-def","column":"backlog"},
  {"type":"setPriority","taskId":"tsk-ghi","priority":"high"}
]'
```

Rules of thumb:
- Don't move tasks in In Progress or Review without reason
- Don't change priority upward (toward urgent) without user signal
- Be conservative — the user can always undo, but avoid unnecessary churn

See the full spec in `docs/milestones/M10.mdx` and `docs/milestones/M11.mdx`.

## Cleaning up board noise

When the board accumulates artifacts from earlier sessions (old
sessions, abandoned tasks, debug notes), do a cleanup pass:

1. Run `/organize` once on the active project — it auto-archives stale,
   cancels-friendly candidates, and groups related tasks.
2. Open the Changelog → "Completed only" toggle to see what's done.
3. Switch the Archive filter to "Both" and review what's hidden by default.
4. Use the search bar (focus with `/` or click the search input) to quickly
   verify a specific task.

`kanban_bulk` lets you do custom passes that the orchestrator can't
auto-detect: e.g. `kanban_bulk({ kind: "archive", taskIds: [...] })` to
batch-archive a set of test tasks, or `kanban_bulk({ kind: "add-tags",
taskIds: [...], tags: ["needs-detail"] })` for tasks that need
descriptions.

After cleanup, the board should show: 1-2 cards in In Progress (active
work), a few in Review (WIP/feedback), and the bulk in Done (shipped).
Backlog and To Do should be near-empty; use them for the next up.

## Editing tasks

The agent can edit an existing task's title and description. PATCH
`/api/tasks/<id>` with `{ title, description }`. Editing triggers
auto-re-derivation of tags, category, priority, and effort from the new
content; explicit tags and category in the request body take precedence.

Title trim is enforced — empty titles return 422. The task's MDX artifact
is rewritten as a side effect of PATCH, so the on-disk `.mdx` always
matches the live title/description. The web UI has an "Edit" button on
the task view that opens a modal pre-filled with the current values.
Keyboard: `e` on a focused card opens the edit modal.

When to use editing:
- You wrote a task title that's slightly wrong.
- The user gave you a description revision that should replace the old one.
- An imported checkbox task needs a clearer description.

When NOT to use editing:
- Bulk updates — use `kanban_bulk` for that.
- Re-tagging without changing the title/description — use `kanban_organize`.

## Inline editing

Most edits in the task view happen **inline**: clicking the title turns it
into a contenteditable `<h1>`; clicking the description area turns it
into a contenteditable `<div>`. The popup-based "Edit" modal is still
available as a fallback in the footer.

Save triggers:
- Blur after 800ms of inactivity
- Enter (Shift+Enter inserts a newline)
- Explicit "Save" button (only when focused and changed)

PATCH `/api/tasks/:id` with `{ title, description }`. The on-disk MDX is
rewritten as a side effect; tags, category, priority, effort are re-derived
from the new content; the live UI refreshes via SSE `task.updated`.

When to use inline edit:
- Quick rewording of a title while you're looking at the task
- Adding a clarifying line to the description in mid-conversation

When NOT to use inline edit:
- Bulk changes — use `kanban_bulk` or `/organize`
- Adding tags without changing text — use `kanban_organize` set-tags

## Subtasks

A task can have subtasks — small follow-up tasks that block a parent's
"done" status. The parent is itself a task; subtasks reference it via
`parentId`.

Hard rule: **no transitive nesting**. A subtask can't have its own
subtasks. Keep the tree shallow so the dashboard doesn't fragment.

```bash
# Create a subtask
curl -X POST -H "Content-Type: application/json" \
  -d '{"title":"Add error banner","parentId":"tsk-abc123"}' \
  http://127.0.0.1:7777/api/tasks
```

The parent's `subtaskIds` is updated automatically. Hitting the parent
task's MDX still works as before; subtasks are listed in the parent's
metadata strip in the web UI.

Cascading behavior:
- Archiving a parent cascades to all subtasks.
- Restoring a parent restores all subtasks.
- Deleting a parent deletes the subtask per-task dirs from disk.

`GET /api/tasks/:id/subtasks` returns the full subtask list. The
`PATCH /api/tasks/:id` endpoint accepts `parentId: null` to un-parent
a task and promote it back to top-level.

## Real-time progress

While the agent is working on a task, every tool call and message part is auto-appended to the task's MDX under `## Agent progress`:

```mdx
## Agent progress
- [2026-07-06 12:34:56] tool: edit_file on src/auth.ts — added login rate-limit
- [2026-07-06 12:35:01] bash — npm test (exit 0)
```

Throttled to one line per second per session. The user sees the timeline live in the task detail view. The board updates automatically — task `state` flips between `running` ↔ `waiting-for-input` ↔ `done` without any explicit `kanban_*` call. The full session transcript remains in `.openkan/sessions/<sid>.mdx` (gitignored).

### What you don't have to do

- You don't need to call `kanban_move` to flip `In Progress` → `Review`; the plugin handles those transitions.
- You don't need to write to the MDX directly to record progress; the plugin appends `## Agent progress` automatically.
- You do need to call `kanban_respond` to read the answer when the user fills in an `<Ask>` / `<Choice>` / `<Input>` / `<Confirm>` you wrote.

## Searching

When the board has 30+ tasks, use search instead of scrolling:

```
kanban_search "auth" -- find tasks mentioning "auth" anywhere
kanban_search "" column:"doing" -- all in-progress tasks
kanban_search "" tags:["bug","security"] -- tasks with both tags
kanban_search "auth" priority:"urgent" -- urgent auth tasks
```

Search matches: title, description, tags, assignees, and the full MDX content. The web UI has a search input in the filter bar — it uses the same endpoint.

## Bulk operations

When you need to do the same thing to many tasks (move a batch to Review, archive a set of stale tasks, add a tag to several at once):

```
kanban_bulk({ kind: "move",        taskIds: ["tsk-a","tsk-b"], column: "review" })
kanban_bulk({ kind: "set-priority", taskIds: ["tsk-a"],         priority: "high" })
kanban_bulk({ kind: "add-tags",    taskIds: ["tsk-a","tsk-b"], tags: ["area:auth"] })
kanban_bulk({ kind: "archive",     taskIds: ["tsk-a","tsk-b","tsk-c"] })
```

All operations are atomic — one `kanban.bulk` changelog event fires regardless of batch size. The web UI exposes the same via **selection mode** (Ctrl/Cmd-click cards to select, then use the floating action bar).

## The MDX template

Every task has a rich MDX artifact. New tasks auto-initialize from the canonical template:

```mdx
---
title: <short title>
id: tsk-xxxxxxxx
column: todo
state: idle
priority: normal
effort: null
tags: []
category: task
assignees: []
createdAt: <iso>
updatedAt: <iso>
---

# <title>

## Goal

{/* One sentence: what does "done" look like for this task? */}

## Context

{/* Background: why this matters, what depends on it, links to related work. */}

## Acceptance criteria

- [ ] {/* Outcome 1 the user can verify */}
- [ ] {/* Outcome 2 */}

## Files to touch

- {/* `path/relative/to/repo.ext` — what changes here */}

## Safety

- Do not modify unrelated files.
- Stop and ask if requirements conflict.
- Fill the agent progress section before moving to Review.

## Agent progress

{/* Timestamped one-liners auto-appended here as you work. */}
```

Get the canonical template at runtime: `GET /api/template` — useful for agents that want to start from a known-good shape.

### Inline components

Inside the MDX you can write:

| Component | When to use |
|---|---|
| `<Ask question="…" />` | A single piece of user input the agent is requesting |
| `<Choice question="…" options="a:Option A,b:Option B" />` | Picking between known options |
| `<Input placeholder="…" label="…" />` | Free-form input (multi-line text) |
| `<Confirm question="…" />` | A yes/no |
| `<Preview tsx="…" props="…" />` | A live UI the user can interact with (sandboxed iframe) |

The first four block the task in `waiting-for-input`. The last renders an interactive TSX widget.

### Frontmatter fields

| Field | Type | Notes |
|---|---|---|
| `title` | string | Required |
| `id` | string | `tsk-xxxxxxxx` (auto-assigned) |
| `column` | enum | backlog, todo, doing, review, done |
| `state` | enum | idle, running, waiting-for-input, done, failed, cancelled |
| `priority` | enum | urgent, high, normal, low |
| `effort` | enum or null | xs, s, m, l, xl |
| `tags` | string[] | Auto-derived + manual `#tag` tokens |
| `category` | enum | frontend, backend, infra, docs, test, design, data, security, task |
| `assignees` | string[] | Git user names |
| `archived` | boolean | Hidden from board when true |

## The artifact viewer (new tab)

Every task's MDX is served at a URL the user can open in a new tab.
Right-click "View Artifact ↗" or navigate directly:

```
GET /artifacts/tasks/<task-id>           # rendered HTML (with theme)
GET /artifacts/tasks/<task-id>?raw=1     # raw MDX
GET /artifacts/tasks/<task-id>?theme=light
```

The artifact is rendered as a fully self-contained HTML page — no
dependency on the kanban app's stylesheet. It includes:

- **Proper page scrolling** — `overflow-y: auto` on body, full viewport height
- **Inlined light + dark theme** — driven by a single `data-theme`
  attribute on `<html>`. Override per-tab via `?theme=light|dark|system`
  or via parent's `localStorage.openkan:theme`
- **Nicer typography** — generous line-height, headings with subtle
  bottom borders, code blocks with rounded corners and separate scroll,
  blockquotes with colored left border, striped table rows, images with
  subtle border + rounded corners
- **"← Back to board" link** at the top
- **Auto theme detection** — `prefers-color-scheme` from the OS as fallback

Use it for sharing a task with someone outside the app, for printing, or
for a focused read-only view without board clutter.

## Patterns and anti-patterns

**DO:**
- Start with `kanban_view` to see existing work before creating tasks
- Prefer `kanban_import` over `kanban_add` when the user has source docs with checkboxes
- Use `kanban_search` when the board has 30+ tasks instead of scrolling
- Use `kanban_bulk` for one-shot batch actions (move, archive, retag several tasks)
- Keep `<Preview>` snippets small and self-contained (no imports, no hooks)
- Ask one question per `kanban_ask` call — let the user answer before asking another
- Use `kanban_preview` to validate TSX before writing it to the MDX
- Address user comments by block, not by task as a whole
- Use `kanban_changelog` to answer "what happened recently?" (M10)
- Use `kanban_organize` for bulk board housekeeping or the `/organize` command (M11)
- Use `PATCH /api/tasks/:id` to fix titles and descriptions when they're slightly wrong
- Use subtasks (`parentId`) to break a large task into independently trackable pieces
- Use `?completedOnly=true` on the changelog for standup-style "what got done" summaries

**DON'T:**
- Modify the user's source MDX silently. Imported tasks are derived state in `.openkan/`
- Bypass the kanban to do work it's tracking. If you created a task, do the work via `kanban_start`
- Ask multiple questions in parallel. The user can only answer one at a time
- Use hooks in `<Preview>` snippets — they won't compile
- Move tasks in In Progress or Review without good reason (M11)
- Change priority upward without user signal (M11)
- Call `kanban_move` for transitions the plugin handles automatically (state flips between `running` ↔ `waiting-for-input` ↔ `done` are managed by the real-time progress system)
- Use individual `kanban_move`/`kanban_archive` calls when `kanban_bulk` or `kanban_organize` can do the same work in one shot
- Nest subtasks deeper than one level — no transitive nesting
- Use `kanban_bulk` or `kanban_organize` for a single title/description tweak — use PATCH instead

## CLI reference

The user can manage the server from the terminal:

```
openkan init              # create .openkan/ in the current project
openkan start             # start the server (default 127.0.0.1:7777)
openkan stop              # graceful shutdown
openkan status            # is it running?
openkan config list       # show settings
openkan config get <key>  # read a setting
openkan config set <key> <value>
openkan logs --follow     # tail server.log
openkan reset --hard      # WARNING: wipes everything
```

All CLI commands share `kanban/server.ts` with the plugin, so file changes you make while the server runs are visible to all open tabs.

## Keyboard control

The dashboard is fully keyboard-controllable. Press `?` at any time to see
the help overlay with all shortcuts.

```
Navigation                          Selection
─────────────────────────────────  ─────────────────────────────────
j / ↓   next card                    space   toggle selection of focused card
k / ↑   previous card                esc     clear selection
h / ←   first card of previous col  cmd+k   command palette
l / →   first card of next col       ?       help overlay
enter   open focused task            /       focus search
                                     tab     between cards, filters, controls

Move selected cards                   Actions
─────────────────────────────────  ─────────────────────────────────
1..5   move to column 1..5           a       archive selected
                                     d       delete selected (confirm)
                                     e       open focused task in edit modal
```

Disabled when typing in an `<input>`, `<textarea>`, or `[contenteditable]`.
Captured at the window level (capture phase) so keys reach the dashboard
even when focus is on a card button.

## Command palette

Press `Cmd+K` (or `Ctrl+K`) to open the command palette. Type to fuzzy-search
across:

- **Actions** — `> ` then a keyword like "new", "settings", "theme", "clear",
  "save", "reload". Examples:
  - `> new` — open the New Task modal
  - `> settings` — open settings
  - `> theme` — toggle theme (dark / light / system)
  - `> clear` — clear all filters
  - `> save` — save current filter
  - `> reload` — reload the board
- **Tasks** — type the title or `#tag` to jump to a task. Examples:
  - `auth` — finds tasks with "auth" in title / description / MDX
  - `#bug` — finds tasks tagged `bug`
  - `@me` — finds tasks assigned to the current user

`↑/↓` (or `Ctrl+N/P`) navigate the result list. `Enter` selects. `Esc` closes.

## Live updates across processes and tabs

The dashboard stays in sync with the disk and with other tabs:

- **Within a tab** — Server-Sent Events push every board change made through
  any HTTP endpoint.
- **Across the file system** — `fs.watch` on `.openkan/` catches changes made
  by hand (`vim task.mdx`), by another agent process, or by a `git pull`.
  The server debounces and self-suppresses its own writes so external edits
  show up but loops are avoided.
- **Across tabs in the browser** — `BroadcastChannel('openkan')` mirrors
  state between tabs. Edit a task in one tab; the other tab sees the update
  without a refresh.

When the disk changes:
- `board.json` edit → `board.changed` SSE event → full `/api/board` refetch.
- `tasks/<id>/task.mdx` edit → `task.mdx.changed` event with `taskId` →
  re-render that task's detail view.
- `comments.json` edit → `task.comment.added` event → comments panel refresh.
- `inputs.json` edit → `task.input.asked` event → "Needs you" banner.
- `changelog.jsonl` append → `changelog.appended` event.

Self-write suppression: the server stamps itself when it writes any of these
files (200ms debounce) and skips broadcasting during that window. So a
mutation via the API doesn't echo back as a "disk changed" event — the SSE
event from the original mutation is enough.

## See also

Example task MDX files are in `skills/openkan/examples/`:

- `simple-task.mdx` — basic task with tags
- `with-ask.mdx` — task using `<Ask>` for input
- `with-choice.mdx` — task with a `<Choice>` component
- `with-preview.mdx` — task embedding a `<Preview>` snippet

See `docs/milestones/M10.mdx` and `docs/milestones/M11.mdx` for the full spec of the dashboard, changelog, archive, organize, and auto-progress features.
