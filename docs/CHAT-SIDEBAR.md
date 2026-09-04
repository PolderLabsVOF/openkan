# OpenKan Chat Sidebar

A right-rail chat orchestrator for Claude Code. Lets you talk to
`claude -p` from inside OpenKan with full session, model, effort, and
permission control, and gives you a live view of every tool call the
assistant makes while it works.

## Quick start

1. Boot OpenKan: `npm run openkan -- start`
2. Click the speech-bubble button in the top-right of the topbar, or press
   `Alt+C`, to open the chat rail.
3. Pick a session from the header selector. Pick a model, effort level,
   and permission mode from the inline pill selectors attached to the
   composer's bottom edge.
4. Type a message and press `Enter`. `Shift+Enter` inserts a newline;
   IME composition events do **not** send mid-composition.
5. While a turn is in flight, click **■** (or the Abort button) to kill
   the running process.
6. Press `Cmd+K` / `Ctrl+K` while the sidebar is open to focus the
   composer.

## What you get

### Layout

The rail is split into three zones:

| Zone          | Contents                                                                 |
| ------------- | ------------------------------------------------------------------------ |
| **Header**    | Session selector + meta (turn count) + `+ New` / `Archive` / `Activity`. |
| **Transcript**| Chat bubbles — user on the right (coral-tinted), assistant on the left   |
|               | (neutral paper), system messages full-width and muted.                    |
| **Composer**  | A single-line-to-six-line textarea + three pill selectors + `⏎` send.    |

User and assistant bubbles both have an avatar dot, an optional timestamp
on hover, a copy button on hover, and a retry button on hover for failed
turns. User bubbles show a status indicator next to the message
(`sending` animated, `sent` static dot, `failed` warning).

### Tool activity

Whenever the assistant calls a tool (Read / Write / Edit / Bash / Grep /
Glob / WebFetch / WebSearch / Agent / …), OpenKan renders a compact chip
stack between the user bubble and the assistant bubble. Each chip shows
the human-readable label of the tool call (e.g. `Reading server.ts`,
`Running npm test`) and its current state:

- **started** — pulsing coral dot while the tool runs.
- **streaming-input** — ellipsis after the label while input JSON
  trickles in.
- **completed** — coral check, label static, `▾` reveal on hover.
- **failed** — warning dot, label suffixed with `— failed`.
- **aborted** — strikethrough label, muted.

Click (or press Enter / Space on a focused) chip to expand inline details
showing the full input JSON plus a 200-char preview of the tool result.
Press Escape to collapse.

### Persistence

Every turn is appended to `.ok/sessions/<sid>.jsonl` with the assembled
text, the ordered list of tool-use blocks, and the selectors in effect.
Sessions persist across reloads; the last-selected session is restored
automatically. The header's `+ New` button starts a fresh session; the
`Archive` button moves the current session to `.ok/sessions/.archived/`.
When you reopen an archived session from history, the composer pills
re-populate from that session's last turn so the next message uses the
same model / effort / permission mode.

### Live activity footer

The `Activity` button expands the same `web/claude-pane.js` view used by
the Claude tab, so you can watch subagents / teams / workflows while
chatting.

### Markdown rendering

Assistant messages are rendered server-side via
`POST /api/chat/render-markdown` (sanitised HTML) — same pipeline as the
rest of the app. Code blocks get a 1 px coral left border and scroll
internally up to 240 px.

### SSE-driven updates

Two complementary channels:

- `GET /api/chat/events` — every chat event in the project (used for the
  global `chat.turn` rollup so multiple tabs stay in sync).
- `GET /api/chat/sessions/<sid>/events` — events scoped to a single
  session. The sidebar subscribes to this so it can stream
  `chat.text-delta` directly into the assistant bubble without re-
  rendering markdown per token, and push `chat.tool-use` / `chat.tool-
  result` / `chat.message-done` events that drive the chip stack and the
  final markdown rehydration.

## HTTP API

All endpoints live under `/api/chat/*` and are registered in
`kanban/chat.ts`.

| Method   | Path                                          | Purpose                              |
| -------- | --------------------------------------------- | ------------------------------------ |
| `GET`    | `/api/chat/sessions`                          | List all sessions (active + archived). |
| `GET`    | `/api/chat/sessions/:sid`                     | Full transcript for one session.     |
| `DELETE` | `/api/chat/sessions/:sid`                     | Archive an active session.           |
| `POST`   | `/api/chat/sessions/:sid/abort`               | Kill the running subprocess.         |
| `GET`    | `/api/chat/sessions/:sid/events`              | Per-session SSE stream (text / tool / message events). |
| `POST`   | `/api/chat/send`                              | Send a user turn; returns the assembled reply. |
| `GET`    | `/api/chat/events`                            | Global SSE stream of every chat event. |
| `GET`    | `/api/chat/selectors`                         | Allowed effort + permission values.  |
| `POST`   | `/api/chat/render-markdown`                   | Server-side markdown rendering.      |

### `POST /api/chat/send`

Request body:

```json
{
  "sessionId": "ses-…",          // optional — omit to start a new session
  "message": "your prompt",
  "model": "default",            // any model from /api/claude/model-router
  "effort": "high",              // low | medium | high | max
  "permissionMode": "default"    // accept-edits | default | plan | bypass-permissions
}
```

Response:

```json
{
  "sessionId": "ses-…",
  "userTurn":      { "ts": "...", "role": "user",      "content": "..." },
  "assistantTurn": { "ts": "...", "role": "assistant", "content": "...",
                     "model": "...", "effort": "...",
                     "permissionMode": "...",
                     "toolUses": [
                       { "id": "tu_1", "name": "Read",
                         "input": { "file_path": "kanban/chat.ts" },
                         "status": "completed",
                         "resultPreview": "…" }
                     ] }
}
```

Errors: `422` for invalid selectors or empty message, `500` for spawn
failure.

## Subprocess model

For each user turn the server spawns:

```
claude -p "<message>" \
       --model <m> \
       --effort <e> \
       --permission-mode <p> \
       --output-format stream-json \
       --verbose
```

`cwd` is the active OpenKan project root. `env` is inherited from the
OpenKan process. The child PID is tracked in an in-process
`Map<sessionId, ChildProcess>`; abort issues `SIGTERM` and falls back to
`SIGKILL` after two seconds.

Override the binary path with `CLAUDE_BIN=/path/to/claude`.

## Tool-use label mapping

`kanban/chat.ts` exports `toolUseLabel(toolUse)` that turns a tool call
into a short human label, e.g.:

| Tool name       | Label                                |
| --------------- | ------------------------------------ |
| `Read`          | `Reading <basename(file_path)>`      |
| `Write`         | `Writing <basename(file_path)>`      |
| `Edit`          | `Editing <basename(file_path)>`      |
| `Bash`          | `Running <command>` (≤ 60 chars)     |
| `Grep`          | `Searching for "<query>"`            |
| `Glob`          | `Finding <pattern>`                  |
| `WebFetch`      | `Fetching <url>`                     |
| `WebSearch`     | `Searching the web for "<query>"`    |
| `Agent`/`Task`  | `Delegating to <subagent_type>`      |
| anything else   | `Using <tool_name>`                  |

The browser mirrors this mapper so chips render identically whether they
arrive via the live stream or are replayed from JSONL on session restore.

## Stream event types

The per-session SSE channel emits the following typed events; the
sidebar subscribes to each and updates the UI without re-rendering
markdown per token.

| Event                       | When                                        | Used for                       |
| --------------------------- | ------------------------------------------- | ------------------------------ |
| `chat.text-delta`           | `content_block_delta` with `text_delta`     | Append into active bubble.     |
| `chat.tool-use`             | `content_block_start` with `tool_use`       | Push a new chip (started).     |
| `chat.tool-input-delta`     | `content_block_delta` with `input_json_delta` | Mark chip as streaming-input. |
| `chat.tool-result`          | `content_block_start` with `tool_result`    | Transition chip → completed / failed. |
| `chat.message-delta`        | `message_delta`                             | Surface `stop_reason`.         |
| `chat.message-done`         | `message_stop`                              | Finalise bubble markdown + reset live state. |
| `chat.turn`                 | Turn boundary                               | Roll-up of `userTurn` + `assistantTurn`. |

## Data layout

- `.ok/sessions/<sid>.jsonl` — one JSON object per line. Each assistant
  turn includes `toolUses: ToolUseRecord[]` (in addition to the legacy
  `content` / `model` / `effort` / `permissionMode` / `messageId` /
  `status` / `error` fields).
- `.ok/sessions/.archived/<sid>.jsonl` — archived transcripts.
- Both directories are covered by the existing `.gitignore` rule
  (`.ok/sessions/`), so user conversations never land in commits.

### Backwards compatibility

Turns written before `toolUses` existed load cleanly: `readSession`
backfills `toolUses: []` for any turn where the field is absent, so the
renderer can iterate without `undefined` checks. Legacy turns render
without chip rows.

## Tests

`tests/chat.test.mts` covers:

- JSONL round-trip (`appendTurn` + `readSession`), including legacy rows
  without `toolUses`.
- Subprocess spawn with selectors, mocked by prepending a fake `claude`
  binary to `$PATH`. The fake fixture detects `--output-format
  stream-json` and emits NDJSON events.
- Abort kills the running subprocess for a session.
- Session list returns active and archived in last-activity order.
- HTTP dispatcher: list / read / archive / abort / send / SSE /
  render-markdown happy and error paths.
- `validateSelectors` enforces effort + permission-mode allowlists.

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
</new_string>