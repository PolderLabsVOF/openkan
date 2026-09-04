# COMMIT-HINTS

Suggested commit boundaries for the chat sidebar work (Karen #1 base +
Karen #2 refinements). Each commit is one logical operation and stays
green on its own.

1. **Backend: streaming subprocess + tool-use JSONL schema**
   - `kanban/chat.ts` — switch `sendTurn` to `--output-format stream-json
     --verbose`, add NDJSON parser + `TurnState`, add `toolUseLabel`,
     `parseStreamLine`, `applyStreamEvent`, `assembleAssistantTurn`,
     extend `ChatTurn.toolUses`, add per-session SSE channel + dispatcher.
   - `tests/chat.test.mts` — update fake claude fixture to emit NDJSON when
     `--output-format stream-json` is set.
   - `kanban/server.ts` — register `handleChatRequest` under
     `/api/chat/*`.

2. **Backend tests: streaming + tool-use coverage**
   - `tests/chat-tools.test.mts` (new) — `toolUseLabel` parameterized,
     TurnState assembly from NDJSON, parseStreamLine, SSE fan-out
     ordering, JSONL round-trip with `toolUses`, legacy JSONL
     backwards-compat.

3. **Frontend: bubble layout + inline selectors + tool chips**
   - `web/chat-sidebar.js` — restructure (header holds session selector
     only, composer has inline pill selectors + send/abort), bubble
     rendering for user/assistant/system, status indicators, copy/retry,
     auto-resize composer with IME guard, per-session SSE
     `chat.text-delta` / `chat.tool-use` / `chat.tool-result` /
     `chat.message-done` consumers, "↓ New messages" pill,
     chip expand/collapse with keyboard support, Cmd/Ctrl+K capture-phase
     focus-composer handler, on-pick-session restores selectors from last
     turn.
   - `web/style.css` — bubble styles (coral-tinted via `color-mix`,
     paper-on-ink assistant, muted system), avatar dots, hover
     timestamps + copy/retry, status dots, tool chips (started →
     streaming → completed → failed → aborted), inline pill selectors,
     slide-in animation, prefers-reduced-motion overrides, code-block
     left coral border, "↓ New messages" pill.
   - `web/index.html` — topbar `💬` button + `chat-sidebar.js` script
     tag (loaded BEFORE `keyboard.js` so capture-phase Cmd/Ctrl+K
     registers first).
   - `web/app.js` — `OpenKanChatSidebar.mount(document.body)` on init.

4. **Docs: CHAT-SIDEBAR rewrite**
   - `docs/CHAT-SIDEBAR.md` — replace with new layout description, "Tool
     activity" section, stream-event table, JSONL schema (incl. legacy
     compat note), updated test inventory.

Verification after each commit:
- `node --experimental-strip-types --test tests/chat.test.mts
   tests/chat-tools.test.mts`
- `npm run typecheck`
- `npm run check`
- `npm run e2e`
- manual: `node bin/openkan.mjs start` → `curl /api/chat/selectors`
  and `curl -X POST /api/chat/send` → expect `toolUses` array (possibly
  empty) on the assistant turn.
