# OpenKan Chat Sidebar

A right-rail chat orchestrator for Claude Code, styled as a focused,
"what should we work on?" interface. Lets you talk to `claude -p` from
inside OpenKan with full session, model, effort, and permission control,
and gives you a live view of every tool call the assistant makes while
it works.

## Quick start

1. Boot OpenKan: `npm run openkan -- start`.
2. Click the speech-bubble button in the top-right of the topbar, or
   press `Alt+C`, to open the chat rail.
3. Type a message and press `Enter`. `Shift+Enter` inserts a newline;
   IME composition events do **not** send mid-composition.
4. While a turn is in flight, click **■** (or the Abort button) to kill
   the running process.
5. Press `Cmd+K` / `Ctrl+K` while the sidebar is open to focus the
   composer.
6. Open the model pill (`Default ▾` on the right of the input bar) to
   pick a model, effort level, or permission mode.
7. Click `+` on the left of the input bar to start a new session,
   import a file, or add to the planning list.

## Layout

```text
┌─────────────────────────────────────────────────┐
│  ← [Session title  ▾]                           │   ← header (collapse + session chip)
│                                                 │
│              What should we work on?            │   ← hero (only when no messages)
│                                                 │
│  ┌─────────────────────────────────────────┐  │
│  │ ╋  Work on anything…           GPT-5 ▾ 🎤 ➤│   ← composer (attach + input + model + mic + send)
│  └─────────────────────────────────────────┘  │
│                                                 │
│  📁 Project  🗂 Files  🔌 Plugins  🖥 Activity  │   ← tabs row
│                                                 │
│  [bubbles + tool chips appear here once user sends]
│                                                 │
└─────────────────────────────────────────────────┘
```

The hero ("What should we work on?") is only visible while the active
session has zero messages. As soon as you send your first message, the
hero is replaced by the scrollable transcript of bubbles and tool chips.

## Header

- **Session chip** — small pill in the top-left showing the current
  session title (or "New session"). Click to open the session list
  popover: `+ New session` plus the 20 most recent sessions. Picking one
  restores that session's transcript and (when available) its last
  model / effort / permission mode.
- **Collapse handle** (`←`) — the absolute-positioned tab on the
  sidebar's left edge. Same toggle as `Alt+C` and the topbar button.

## Composer

The composer is a rounded input bar with five controls:

| Button | Purpose |
| --- | --- |
| `+`            | Open the attach menu (New session / Import / Add to planning). |
| `<textarea>`   | Auto-resizing input (1–6 lines; scrolls internally beyond that). |
| `<model pill>` | Pick the model, effort, and permission mode (see below). |
| `🎤`           | Placeholder for future voice input. Currently disabled with a "Coming soon" toast. |
| `➤`            | Send (Enter). Replaced by `■` while a turn is in flight (click to abort). |

### Keyboard

| Shortcut | Action |
| --- | --- |
| `Enter`                          | Send. |
| `Shift+Enter`                    | Insert a newline. |
| `Esc`                            | Blur the composer / collapse any open chip. |
| `Cmd/Ctrl+K` (sidebar open)      | Focus the composer. |
| `Alt+C`                          | Open / close the chat sidebar. |

IME composition events (Japanese / Chinese / Korean input methods) are
guarded — `Enter` does **not** send while the IME is composing.

## Selectors — model + effort + permissions

Clicking the model pill (right of the input) opens a popover anchored to
the pill, with three sections:

1. **Model** — `Default` plus every model the project's
   `.claude/model-router.json` lists. Labels strip the `provider/`
   prefix so `minimax/MiniMax-M3` displays as `MiniMax-M3`. The list is
   sourced from the server via `GET /api/chat/picker-options` so the
   UI and the routing policy stay in sync.
2. **Effort** — `low`, `medium`, `high`, `max`.
3. **Permissions** — `accept-edits`, `default`, `plan`,
   `bypass-permissions`.

Selecting an option updates `state.selectors` in memory, persists it to
`localStorage` under `ok.chat.selectors`, syncs the visible pill label,
and closes the popover. The values are then sent on the next turn as
`--model`, `--effort`, and `--permission-mode` flags to the Claude
Code binary.

The popover closes on outside-click or `Escape`.

## Tabs row — Project / Files / Plugins / Activity

A row of four icon-and-label tabs sits below the input bar. Clicking a
tab opens a small popover or toggles the activity footer; only one is
active at a time.

- **Project** — popover with "Switch project…" (uses
  `OpenKanPathPicker.open()` if loaded) and "List sessions in this
  project".
- **Files** — popover with "Open documentation browser" and "Toggle
  docs pane". Both fire `openkan:open-docs` /
  `openkan:toggle-docs-pane` events on `window`.
- **Plugins** — popover with "M1 import" (same handler as the attach
  menu's Import), "Planning CLI" (fires `openkan:open-planning-cli`),
  and "Agents catalog" (fires `openkan:open-agents-catalog`).
- **Activity** — toggles the slide-in activity footer that mounts the
  existing `claude-pane.js` (subagent / team / workflow visibility).

The active tab uses the coral accent underline; click the same tab
again to close it.

## + menu — New session / Import / Add to planning

Click `+` on the left of the input bar to open the attach menu:

1. **New session** — `POST /api/chat/sessions` via `OpenKanAPI.api`,
   then refresh the local session list.
2. **Import from file** — opens a native file picker (`.md`, `.mdx`,
   `.markdown`, `.txt`, `.json`). Each file's contents are POSTed to
   `/api/import`. Drag-and-drop a file onto the sidebar to use the same
   endpoint.
3. **Add to planning** — POST the current composer text to
   `/api/planning/tasks` (the equivalent of `ok task add`). The first
   line becomes the title, the full body is preserved.
4. **Cancel** — closes the menu.

The menu closes on outside-click, `Escape`, or selection.

## Bubble and tool chip rendering

User and assistant bubbles both render with an avatar dot, optional
timestamp on hover, a copy button on hover, and a retry button on hover
for failed turns. User bubbles show a status indicator next to the
message (`sending` animated, `sent` static dot, `failed` warning).

Whenever the assistant calls a tool (Read / Write / Edit / Bash / Grep /
Glob / WebFetch / WebSearch / Agent / …), OpenKan renders a compact
chip stack between the user bubble and the assistant bubble. Each chip
shows the human-readable label of the tool call (e.g. `Reading
server.ts`, `Running npm test`) and its current state:

- **started** — pulsing dot, label only.
- **streaming** — pulsing dot, label with chevron (click to expand).
- **completed** — solid dot.
- **failed** — warning dot, label suffixed with `— failed`.

Clicking a chip expands an inline `<pre>` with the tool input and (when
known) the result preview. Press `Esc` to collapse any open chip.

The transcript auto-scrolls to the bottom as new turns arrive. While
scrolled up, a "↓ New messages" pill surfaces at the bottom of the
transcript; clicking it scrolls back to the bottom.

## Activity footer (subagent / team / workflow)

Toggling the **Activity** tab in the tabs row slides in a footer that
mounts `claude-pane.js` (the existing project-level Claude Code
control surface: subagent runs, team plans, workflow status). When the
tab is closed, the footer collapses and `OpenKanClaude.unmount()` is
called to release any active subscriptions.

The transition respects `prefers-reduced-motion: reduce` and disables
the slide-in for that media query.

## Storage

- `ok.chat.open` — `"1"` / `"0"`. Restored on mount so the rail reopens
  where it left off.
- `ok.chat.lastSession` — last-selected session id.
- `ok.chat.selectors` — JSON `{ model, effort, permissionMode }`.

All persistence is local. `.ok/sessions/<sid>.jsonl` is gitignored, so
user / assistant transcripts never leak into commits.

## Stream events

SSE channels:

- `/api/chat/events` — every event in the project.
- `/api/chat/sessions/<sid>/events` — events scoped to a session.

Typed events:

| Event name              | Source                                                       | Effect                                         |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `chat.tool-use`         | `content_block_start` with `tool_use`                        | Add live chip → running.                       |
| `chat.tool-input-delta` | `content_block_delta` for tool_use `input_json_delta`        | Update chip input preview (chunked).           |
| `chat.text-delta`       | `content_block_delta` for `text`                             | Append to live assistant bubble (no re-render). |
| `chat.tool-result`      | `content_block_start` with `tool_result`                     | Transition chip → completed / failed.          |
| `chat.message-done`     | `message_stop`                                               | Finalise streaming bubble (markdown render).   |
| `chat.turn`             | SSE-broadcast after `sendTurn` returns (carries user + assistant turns, including `status` / `error` fields). | Append new turns to transcript and re-render. |

Errors: `422` for invalid selectors or empty message, `500` for spawn
failure.

## HTTP API (selected)

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/api/chat/sessions` | GET | list of session summaries (active + archived, last-activity desc). |
| `/api/chat/sessions/<sid>` | GET | full transcript. |
| `/api/chat/sessions/<sid>` | DELETE | archive. |
| `/api/chat/sessions/<sid>/abort` | POST | kill the running subprocess. |
| `/api/chat/send` | POST | body: `{ message, model?, effort?, permissionMode?, sessionId? }`. |
| `/api/chat/events` | GET | SSE fan-out. |
| `/api/chat/sessions/<sid>/events` | GET | per-session SSE. |
| `/api/chat/selectors` | GET | `{ efforts, permissionModes }` (legacy). |
| `/api/chat/picker-options` | GET | `{ models: [{id, label}], efforts, permissionModes }` sourced from `.claude/model-router.json`. |
| `/api/chat/render-markdown` | POST | sanitised HTML for chat messages. |

## Tests

`tests/chat.test.mts` covers:

- JSONL round-trip (`appendTurn` + `readSession`), including legacy
  rows without `toolUses`.
- Subprocess spawn with selectors, mocked by prepending a fake `claude`
  binary to `$PATH`. The fake fixture detects `--output-format
  stream-json` and emits NDJSON events.
- Abort kills the running subprocess for a session.
- Session list returns active and archived in last-activity order.
- HTTP dispatcher: list / read / archive / abort / send / SSE /
  render-markdown happy and error paths.
- `validateSelectors` enforces effort + permission-mode allowlists.
- `GET /api/chat/picker-options` returns the expected shape.

`tests/chat-tools.test.mts` covers:

- `toolUseLabel` over a 14-row fixture covering every recognised tool.
- Multi-line NDJSON fixture → assembled `TurnState` with text + ordered
  tool uses + tool results.
- `parseStreamLine` ignores empty / non-object payloads; carries
  `delta` + `content_block` into the typed event.
- SSE fan-out ordering: `tool_use → tool_input_delta → tool_result →
  text_delta → message_done`.
- JSONL round-trip with `toolUses` array.
- Legacy JSONL without `toolUses` reads cleanly and surfaces an empty
  `toolUses` array.
- `toPickerLabel` strips `provider/` prefixes consistently.
- `pickerOptions` returns the expected shape from an injected fixture.
