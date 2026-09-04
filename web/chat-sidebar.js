// OpenKan — chat sidebar (right-rail chat orchestrator).
//
// Mounts a fixed-position aside on the right edge of the viewport with:
//   - A header that holds only the session selector, a session count meta,
//     and action buttons (new / archive / activity).
//   - A scrollable transcript that renders each turn as a chat bubble
//     (right-aligned user / left-aligned assistant / centred system) with
//     a stack of compact tool-use chips between the user bubble and the
//     assistant bubble.
//   - A composer footer that contains a textarea and inline pill-style
//     selectors (model / effort / permission mode) plus a send / abort
//     button.
//   - Cmd/Ctrl+K focuses the composer when the sidebar is open.
//
// Persistence: the last-selected session id and selector state are written
// to `localStorage` under `ok.chat.*` keys and restored on mount.
//
// Public API: window.OpenKanChatSidebar = { mount, unmount, toggle, open,
// close, isOpen }.
//
(() => {
  "use strict";

  /* ----------------------------------------------------------------------
   * Constants & helpers
   * -------------------------------------------------------------------- */
  const STORAGE_KEYS = {
    lastSession: "ok.chat.lastSession",
    open: "ok.chat.open",
    selectors: "ok.chat.selectors",
  };
  const DEFAULT_SELECTORS = Object.freeze({
    model: "default",
    effort: "high",
    permissionMode: "default",
  });
  const EFFORT_OPTIONS = ["low", "medium", "high", "max"];
  const PERMISSION_OPTIONS = [
    "accept-edits", "default", "plan", "bypass-permissions",
  ];

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function loadJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_err) { return null; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (_err) { /* quota / disabled — ignore */ }
  }
  function loadString(key) {
    try { return localStorage.getItem(key) || ""; } catch (_err) { return ""; }
  }
  function saveString(key, value) {
    try { localStorage.setItem(key, value); } catch (_err) { /* ignore */ }
  }

  function relativeTime(iso) {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const diffMs = Date.now() - then;
    if (diffMs < 1000) return "just now";
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function basename(p) {
    if (!p) return "";
    const norm = String(p).replace(/\\/g, "/");
    const idx = norm.lastIndexOf("/");
    return idx === -1 ? norm : norm.slice(idx + 1);
  }

  function truncate(s, max) {
    if (!s) return "";
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + "…";
  }

  // ToolUseRecord -> human label. Mirrors `toolUseLabel` on the server so
  // chips render identically whether streamed live or replayed from JSONL.
  function toolUseLabel(tool) {
    const input = (tool && tool.input) || {};
    const file = typeof input.file_path === "string" ? input.file_path : "";
    const cmd = typeof input.command === "string" ? input.command : "";
    const q = typeof input.query === "string" ? input.query
      : typeof input.pattern === "string" ? input.pattern : "";
    const url = typeof input.url === "string" ? input.url : "";
    const sub = typeof input.subagent_type === "string" ? input.subagent_type : "";
    switch (tool.name) {
      case "Read": return `Reading ${basename(file) || "file"}`;
      case "Write": return `Writing ${basename(file) || "file"}`;
      case "Edit": return `Editing ${basename(file) || "file"}`;
      case "Bash": return `Running ${truncate(cmd.replace(/\s+/g, " ").trim(), 60)}`;
      case "Grep": return `Searching for "${truncate(q, 40)}"`;
      case "Glob": return `Finding ${truncate(typeof input.pattern === "string" ? input.pattern : "", 60)}`;
      case "WebFetch": return `Fetching ${truncate(url, 60)}`;
      case "WebSearch": return `Searching the web for "${truncate(q, 40)}"`;
      case "Agent":
      case "Task": return `Delegating to ${sub || "subagent"}`;
      default: return `Using ${tool.name}`;
    }
  }

  /* ----------------------------------------------------------------------
   * Module state
   * -------------------------------------------------------------------- */
  const state = {
    mounted: false,
    open: false,
    root: null,
    sessions: [],
    currentSessionId: "",
    selectors: { ...DEFAULT_SELECTORS },
    transcript: [],     // ChatTurn[]
    models: [],
    inFlight: false,
    activityOpen: false,
    sse: null,
    abortController: null,
    renderedCache: new Map(),
    // True when the user has scrolled up and we suppressed auto-scroll.
    scrolledUp: false,
    // True when the live stream is appending tokens into the bubble — used
    // to skip re-rendering the bubble per token.
    liveBubble: null,
    liveChips: null,
  };

  /* ----------------------------------------------------------------------
   * Network helpers
   * -------------------------------------------------------------------- */
  function api() { return window.OpenKanAPI?.api; }
  async function fetchSessions() {
    const a = api();
    if (!a) return [];
    try {
      const data = await a("GET", "/api/chat/sessions");
      return Array.isArray(data?.sessions) ? data.sessions : [];
    } catch (_err) { return []; }
  }
  async function fetchSession(id) {
    const a = api();
    if (!a || !id) return null;
    try {
      return await a("GET", `/api/chat/sessions/${encodeURIComponent(id)}`);
    } catch (_err) { return null; }
  }
  async function fetchModels() {
    const a = api();
    if (!a) return [];
    try {
      const data = await a("GET", "/api/claude/model-router");
      if (Array.isArray(data?.models)) return data.models.map((m) => typeof m === "string" ? m : (m.id || m.name || "")).filter(Boolean);
      if (Array.isArray(data)) return data.map((m) => typeof m === "string" ? m : (m.id || m.name || "")).filter(Boolean);
      return [];
    } catch (_err) { return []; }
  }
  async function abortSession(sessionId) {
    const a = api();
    if (!a || !sessionId) return;
    try { await a("POST", `/api/chat/sessions/${encodeURIComponent(sessionId)}/abort`); }
    catch (_err) { /* swallow */ }
  }
  async function deleteSession(sessionId) {
    const a = api();
    if (!a || !sessionId) return;
    try { await a("DELETE", `/api/chat/sessions/${encodeURIComponent(sessionId)}`); }
    catch (_err) { /* swallow */ }
  }
  async function renderMarkdown(text) {
    if (!text) return "";
    if (state.renderedCache.has(text)) return state.renderedCache.get(text);
    const a = api();
    if (!a) return esc(text);
    try {
      const html = await a("POST", "/api/chat/render-markdown", { markdown: text });
      state.renderedCache.set(text, html);
      return html;
    } catch (_err) {
      return `<pre>${esc(text)}</pre>`;
    }
  }

  /* ----------------------------------------------------------------------
   * DOM construction
   *
   * Layout:
   *   <aside>
   *     <button handle>
   *     <header>          (session selector only + actions)
   *     <section bubbles> (scrollable transcript of bubbles + chips)
   *     <footer composer> (textarea + inline pill selectors + send)
   *     <section activity>(hidden claude-pane mount)
   *   </aside>
   * -------------------------------------------------------------------- */
  function buildShell() {
    const aside = document.createElement("aside");
    aside.id = "chat-sidebar";
    aside.className = "chat-sidebar";
    aside.setAttribute("aria-label", "Chat orchestrator");
    aside.setAttribute("role", "complementary");
    aside.hidden = true;
    aside.innerHTML = `
      <button type="button" class="chat-sidebar-handle" data-chat-toggle
              aria-label="Toggle chat sidebar" aria-expanded="false" title="Toggle chat (Alt+C)">
        <span aria-hidden="true">‹</span>
      </button>
      <header class="chat-sidebar-header">
        <div class="chat-sidebar-title-row">
          <span class="chat-sidebar-title">Chat</span>
          <span class="chat-sidebar-meta" id="chat-sidebar-meta">—</span>
        </div>
        <div class="chat-sidebar-session-row">
          <label class="chat-select-wrap chat-select-wrap-grow">
            <span class="chat-select-label">Session</span>
            <select id="chat-select-session" data-chat-select="session"></select>
          </label>
          <div class="chat-sidebar-actions">
            <button type="button" class="chat-icon-btn" data-chat-action="new"
                    title="Start a new session">+ New</button>
            <button type="button" class="chat-icon-btn" data-chat-action="archive"
                    title="Archive the current session">Archive</button>
            <button type="button" class="chat-icon-btn" data-chat-action="toggle-activity"
                    title="Toggle activity footer">Activity</button>
          </div>
        </div>
      </header>
      <section class="chat-sidebar-transcript" id="chat-sidebar-transcript"
               aria-live="polite" aria-label="Chat transcript"></section>
      <button type="button" class="chat-sidebar-new-messages" id="chat-sidebar-new-messages"
              hidden>↓ New messages</button>
      <footer class="chat-sidebar-composer">
        <textarea id="chat-sidebar-input" rows="1"
                  placeholder="Message Claude Code…"
                  aria-label="Compose message"></textarea>
        <div class="chat-sidebar-composer-actions">
          <label class="chat-select-wrap chat-pill">
            <span class="chat-pill-label">Model</span>
            <select id="chat-select-model" data-chat-select="model"></select>
          </label>
          <label class="chat-select-wrap chat-pill">
            <span class="chat-pill-label">Effort</span>
            <select id="chat-select-effort" data-chat-select="effort"></select>
          </label>
          <label class="chat-select-wrap chat-pill">
            <span class="chat-pill-label">Permissions</span>
            <select id="chat-select-permission" data-chat-select="permissionMode"></select>
          </label>
          <button type="button" class="chat-icon-btn chat-send" id="chat-sidebar-send"
                  data-chat-action="send" aria-label="Send message" title="Send (Enter)">⏎</button>
          <button type="button" class="chat-icon-btn chat-abort" id="chat-sidebar-abort"
                  data-chat-action="abort" hidden aria-label="Abort turn" title="Abort">■</button>
        </div>
      </footer>
      <section class="chat-sidebar-activity" id="chat-sidebar-activity"
               aria-label="Activity" hidden>
        <div id="chat-sidebar-claude-root"></div>
      </section>
    `;
    document.body.appendChild(aside);
    return aside;
  }

  function populateSelectors() {
    if (!state.root) return;
    const sessionSel = state.root.querySelector("#chat-select-session");
    const modelSel = state.root.querySelector("#chat-select-model");
    const effortSel = state.root.querySelector("#chat-select-effort");
    const permSel = state.root.querySelector("#chat-select-permission");

    if (sessionSel) {
      const opts = [`<option value="__new__">+ New session</option>`]
        .concat(state.sessions.map((s) =>
          `<option value="${esc(s.id)}">${esc(s.title || s.id)}</option>`,
        ));
      sessionSel.innerHTML = opts.join("");
      sessionSel.value = state.currentSessionId || "__new__";
    }

    if (modelSel) {
      const opts = state.models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
      modelSel.innerHTML = opts || `<option value="default">default</option>`;
      modelSel.value = state.selectors.model || "default";
    }
    if (effortSel) {
      effortSel.innerHTML = EFFORT_OPTIONS.map((e) =>
        `<option value="${e}">${e}</option>`).join("");
      effortSel.value = state.selectors.effort || "high";
    }
    if (permSel) {
      permSel.innerHTML = PERMISSION_OPTIONS.map((p) =>
        `<option value="${p}">${p}</option>`).join("");
      permSel.value = state.selectors.permissionMode || "default";
    }
  }

  /* ----------------------------------------------------------------------
   * Bubble rendering
   * -------------------------------------------------------------------- */
  function bubbleHTML(turn) {
    const role = turn.role || "assistant";
    const stamp = turn.ts ? `<time class="chat-bubble-time" datetime="${esc(turn.ts)}">${esc(relativeTime(turn.ts))}</time>` : "";
    const errorLine = turn.error
      ? `<div class="chat-bubble-error">${esc(turn.error)}</div>` : "";
    if (role === "user") {
      const status = turn.__status || (turn.status && turn.status !== "ok" ? turn.status : "sent");
      return `
        <div class="chat-bubble-row chat-bubble-row-user">
          <div class="chat-bubble-stack">
            <div class="chat-bubble chat-bubble-user" data-ts="${esc(turn.ts || "")}" data-status="${esc(status)}">
              <span class="chat-bubble-dot" aria-hidden="true"></span>
              <div class="chat-bubble-body">${esc(turn.content || "")}</div>
              <span class="chat-bubble-status" aria-label="message status: ${esc(status)}">${statusDot(status)}</span>
            </div>
            ${stamp}
          </div>
        </div>
      `;
    }
    if (role === "system") {
      const status = turn.status || "ok";
      return `
        <div class="chat-bubble-row chat-bubble-row-system">
          <div class="chat-bubble chat-bubble-system" data-ts="${esc(turn.ts || "")}" data-status="${esc(status)}">
            <span class="chat-bubble-dot" aria-hidden="true"></span>
            <div class="chat-bubble-body">${esc(turn.content || "")}</div>
            ${errorLine}
          </div>
        </div>
      `;
    }
    // Assistant bubble. Body is filled by renderTranscript via async
    // markdown rendering; the empty placeholder lets us stream into it
    // incrementally without re-parsing markdown each tick.
    const copyBtn = `<button type="button" class="chat-bubble-copy" data-chat-copy="${esc(turn.ts || "")}" title="Copy message" aria-label="Copy message" hidden>⧉</button>`;
    const retryBtn = turn.status === "error"
      ? `<button type="button" class="chat-bubble-retry" data-chat-retry="${esc(turn.ts || "")}" title="Retry" aria-label="Retry" hidden>↻</button>` : "";
    return `
      <div class="chat-bubble-row chat-bubble-row-assistant">
        <div class="chat-bubble-stack">
          <div class="chat-bubble chat-bubble-assistant" data-ts="${esc(turn.ts || "")}" data-status="${esc(turn.status || "ok")}">
            <span class="chat-bubble-dot" aria-hidden="true"></span>
            <div class="chat-bubble-body chat-bubble-body-stream" data-bubble-body></div>
            ${copyBtn}
            ${retryBtn}
          </div>
          ${errorLine}
          ${stamp}
        </div>
      </div>
    `;
  }

  function statusDot(status) {
    if (status === "sending") return `<span class="chat-status-dot chat-status-sending" aria-hidden="true"></span>`;
    if (status === "failed") return `<span class="chat-status-dot chat-status-failed" aria-hidden="true" title="failed">⚠</span>`;
    return `<span class="chat-status-dot chat-status-sent" aria-hidden="true"></span>`;
  }

  function chipHTML(tool) {
    const label = esc(toolUseLabel(tool));
    const status = tool.status || "started";
    const idAttr = esc(tool.id || "");
    const dotCls = `chat-chip-dot chat-chip-dot-${esc(status)}`;
    return `
      <div class="chat-chip" data-chip-id="${idAttr}" data-chip-status="${esc(status)}" tabindex="0" role="button" aria-expanded="false">
        <span class="${dotCls}" aria-hidden="true"></span>
        <span class="chat-chip-label">${label}</span>
        <span class="chat-chip-tail" aria-hidden="true">▾</span>
        <div class="chat-chip-details" hidden>
          <pre class="chat-chip-input">${esc(JSON.stringify(tool.input || {}, null, 2))}</pre>
          ${tool.resultPreview ? `<pre class="chat-chip-result">${esc(tool.resultPreview)}</pre>` : ""}
        </div>
      </div>
    `;
  }

  function chipsHTML(turn) {
    const toolUses = Array.isArray(turn.toolUses) ? turn.toolUses : [];
    if (toolUses.length === 0) return "";
    return `<div class="chat-chips" data-chips-for="${esc(turn.ts || "")}">
      ${toolUses.map(chipHTML).join("")}
    </div>`;
  }

  /* ----------------------------------------------------------------------
   * Transcript rendering
   * -------------------------------------------------------------------- */
  async function renderTranscript() {
    const node = state.root?.querySelector("#chat-sidebar-transcript");
    if (!node) return;
    if (state.transcript.length === 0) {
      node.innerHTML = `<div class="chat-empty">No messages yet. Type below and press Enter to send.</div>`;
      hideNewMessagesPill();
      return;
    }
    // Build a flat list of HTML fragments: chips (for assistant turns) then
    // the bubble. Order is chips → bubble for assistant turns; user/system
    // turns render just the bubble.
    const parts = [];
    for (const turn of state.transcript) {
      const role = turn.role || "assistant";
      if (role === "assistant") parts.push(chipsHTML(turn));
      parts.push(bubbleHTML(turn));
    }
    const wasNearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    node.innerHTML = parts.join("");
    if (wasNearBottom) {
      node.scrollTop = node.scrollHeight;
    } else {
      state.scrolledUp = true;
    }

    // Hydrate assistant bubbles with markdown rendering (skip chips — they
    // are static).
    const assistantNodes = node.querySelectorAll(".chat-bubble-assistant [data-bubble-body]");
    for (const el of assistantNodes) {
      const turnTs = el.closest(".chat-bubble")?.getAttribute("data-ts");
      const turn = state.transcript.find((t) => (t.ts || "") === turnTs);
      if (!turn) continue;
      const html = await renderMarkdown(turn.content || "");
      el.innerHTML = html;
    }
  }

  /* ----------------------------------------------------------------------
   * Live SSE for new turns + streamed events
   * -------------------------------------------------------------------- */
  function startLive() {
    if (state.sse || typeof window.EventSource !== "function") return;
    try {
      // Subscribe to the GLOBAL event stream for chat.turn rollups (every
      // session) so the sidebar can react when a different session finishes
      // a turn. Per-session streams (text-delta / tool-use / tool-result /
      // message-done) are wired in startSessionStream below.
      const src = new EventSource("/api/chat/events");
      src.addEventListener("chat.turn", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data?.sessionId && data.sessionId === state.currentSessionId) {
            const { userTurn, assistantTurn } = data;
            // Drop the optimistic placeholder turn (matched by messageId
            // when present, otherwise by ts+role+content).
            state.transcript = state.transcript.filter((t) => {
              if (userTurn?.messageId && t.messageId === userTurn.messageId) return false;
              return !(t.ts === userTurn?.ts && t.role === "user" && t.content === userTurn.content);
            });
            appendTurnIfNew(userTurn);
            appendTurnIfNew(assistantTurn);
            state.inFlight = false;
            updateAbortButton();
            void renderTranscript();
            hideNewMessagesPill();
          }
        } catch (_err) { /* ignore */ }
      });
      src.addEventListener("chat.session-archived", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data?.sessionId === state.currentSessionId) state.currentSessionId = "";
        } catch (_err) { /* ignore */ }
      });
      src.onerror = () => { /* let EventSource auto-reconnect */ };
      state.sse = src;
    } catch (_err) {
      state.sse = null;
    }
  }

  function startSessionStream() {
    stopSessionStream();
    if (!state.currentSessionId || typeof window.EventSource !== "function") return;
    try {
      const sid = state.currentSessionId;
      const src = new EventSource(`/api/chat/sessions/${encodeURIComponent(sid)}/events`);
      const transcript = state.root?.querySelector("#chat-sidebar-transcript");
      const appendToken = (text) => {
        if (!text) return;
        const bubble = transcript?.querySelector(".chat-bubble-row-assistant:last-child .chat-bubble-body");
        if (!bubble) return;
        // Stream into the last text block — DO NOT re-render markdown per
        // token; the final render runs at message-done time.
        if (bubble.dataset.streaming === "1") {
          bubble.append(text);
        } else {
          bubble.textContent = text;
          bubble.dataset.streaming = "1";
        }
        // Auto-scroll if user is near the bottom.
        maybeAutoScroll(transcript);
      };
      src.addEventListener("chat.text-delta", (e) => {
        try {
          const data = JSON.parse(e.data);
          appendToken(data?.text || "");
        } catch (_err) { /* ignore */ }
      });
      src.addEventListener("chat.tool-use", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.id) return;
          state.liveChips = state.liveChips || [];
          // Skip if we already have this chip id (defensive — the server
          // can fan the same event twice across channels).
          if (state.liveChips.some((c) => c.id === data.id)) return;
          state.liveChips.push({
            id: data.id,
            name: data.name,
            input: data.input || {},
            status: data.status || "started",
          });
          renderLiveChips();
        } catch (_err) { /* ignore */ }
      });
      src.addEventListener("chat.tool-input-delta", (_e) => {
        // Streaming input is purely visual; we keep the chip in "started"
        // state and let tool-result transition it to completed/failed.
      });
      src.addEventListener("chat.tool-result", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.id) return;
          const chip = (state.liveChips || []).find((c) => c.id === data.id);
          if (chip) {
            chip.status = data.isError ? "failed" : "completed";
            chip.resultPreview = typeof data.content === "string"
              ? data.content.slice(0, 200)
              : (Array.isArray(data.content) ? data.content.map((c) => c.text || "").join("").slice(0, 200) : "");
            chip.isError = !!data.isError;
          }
          renderLiveChips();
        } catch (_err) { /* ignore */ }
      });
      src.addEventListener("chat.message-done", (_e) => {
        // Finalise streaming bubble — re-render markdown now that content
        // is complete, and reset live state.
        finalizeLiveBubble();
      });
      state.sessionSse = src;
    } catch (_err) {
      state.sessionSse = null;
    }
  }

  function stopSessionStream() {
    if (state.sessionSse) {
      try { state.sessionSse.close(); } catch (_err) { /* ignore */ }
      state.sessionSse = null;
    }
    state.liveChips = null;
    state.liveBubble = null;
  }

  function renderLiveChips() {
    if (!state.root) return;
    const transcript = state.root.querySelector("#chat-sidebar-transcript");
    if (!transcript) return;
    // Insert a chip-stack container before the last assistant bubble (if
    // any). If no assistant bubble yet, we attach one to a freshly created
    // empty bubble row at the bottom so the chips have a sibling.
    let row = transcript.querySelector(".chat-bubble-row-assistant:last-child");
    if (!row) return;
    let chipsNode = row.parentElement?.querySelector(":scope > .chat-chips-live");
    const list = state.liveChips || [];
    if (list.length === 0) {
      if (chipsNode) chipsNode.remove();
      return;
    }
    if (!chipsNode) {
      chipsNode = document.createElement("div");
      chipsNode.className = "chat-chips chat-chips-live";
      row.parentElement?.insertBefore(chipsNode, row);
    }
    chipsNode.innerHTML = list.map(chipHTML).join("");
    bindChipClicks(chipsNode);
    maybeAutoScroll(transcript);
  }

  function finalizeLiveBubble() {
    if (!state.root) return;
    const transcript = state.root.querySelector("#chat-sidebar-transcript");
    const bubble = transcript?.querySelector(".chat-bubble-row-assistant:last-child .chat-bubble-body");
    if (bubble && bubble.dataset.streaming === "1") {
      const text = bubble.textContent || "";
      // Render markdown now that the stream is final.
      renderMarkdown(text).then((html) => {
        bubble.innerHTML = html;
        bubble.removeAttribute("data-streaming");
      });
    }
  }

  function maybeAutoScroll(node) {
    if (!node) return;
    if (state.scrolledUp) {
      showNewMessagesPill();
      return;
    }
    node.scrollTop = node.scrollHeight;
  }

  function showNewMessagesPill() {
    const pill = state.root?.querySelector("#chat-sidebar-new-messages");
    if (pill) pill.hidden = false;
  }
  function hideNewMessagesPill() {
    const pill = state.root?.querySelector("#chat-sidebar-new-messages");
    if (pill) pill.hidden = true;
    state.scrolledUp = false;
  }

  /** Append a turn only if we have not already received it. */
  function appendTurnIfNew(turn) {
    if (!turn) return;
    const dup = state.transcript.find((t) => {
      if (turn.messageId && t.messageId) return t.messageId === turn.messageId;
      return t.ts === turn.ts && t.role === turn.role
        && (t.content || "") === (turn.content || "");
    });
    if (!dup) state.transcript.push(turn);
  }
  function stopLive() {
    if (state.sse) {
      try { state.sse.close(); } catch (_err) { /* ignore */ }
      state.sse = null;
    }
    stopSessionStream();
  }

  /* ----------------------------------------------------------------------
   * Chip expand/collapse
   * -------------------------------------------------------------------- */
  function bindChipChips() {
    if (!state.root) return;
    const transcript = state.root.querySelector("#chat-sidebar-transcript");
    if (!transcript) return;
    bindChipClicks(transcript);
  }
  function bindChipClicks(scope) {
    if (!scope) return;
    const chips = scope.querySelectorAll(".chat-chip");
    for (const chip of chips) {
      if (chip.dataset.bound === "1") continue;
      chip.dataset.bound = "1";
      const toggle = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        const details = chip.querySelector(".chat-chip-details");
        const expanded = chip.getAttribute("aria-expanded") === "true";
        if (expanded) {
          if (details) details.hidden = true;
          chip.setAttribute("aria-expanded", "false");
        } else {
          if (details) details.hidden = false;
          chip.setAttribute("aria-expanded", "true");
        }
      };
      chip.addEventListener("click", toggle);
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") toggle(e);
        else if (e.key === "Escape") {
          const details = chip.querySelector(".chat-chip-details");
          if (details) details.hidden = true;
          chip.setAttribute("aria-expanded", "false");
        }
      });
    }
  }

  /* ----------------------------------------------------------------------
   * Event handlers
   * -------------------------------------------------------------------- */
  function bindEvents() {
    if (!state.root) return;
    state.root.addEventListener("click", onClick);
    state.root.addEventListener("change", onChange);
    state.root.addEventListener("keydown", onKeyDown);
    state.root.addEventListener("input", onInput);

    const newMsg = state.root.querySelector("#chat-sidebar-new-messages");
    if (newMsg) newMsg.addEventListener("click", () => {
      const transcript = state.root?.querySelector("#chat-sidebar-transcript");
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
      hideNewMessagesPill();
    });

    const transcript = state.root.querySelector("#chat-sidebar-transcript");
    if (transcript) transcript.addEventListener("scroll", () => {
      const distance = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      state.scrolledUp = distance > 80;
      if (!state.scrolledUp) hideNewMessagesPill();
    });
  }

  function onClick(e) {
    if (!state.root) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const handle = t.closest("[data-chat-toggle]");
    if (handle) {
      toggle();
      return;
    }
    // Bubble copy / retry buttons: delegate before action buttons.
    const copy = t.closest("[data-chat-copy]");
    if (copy) { copyToClipboard(copy.getAttribute("data-chat-copy")); return; }
    const retry = t.closest("[data-chat-retry]");
    if (retry) { void retryLastTurn(); return; }
    const action = t.closest("[data-chat-action]")?.getAttribute("data-chat-action");
    if (action === "send") void onSend();
    else if (action === "abort") void onAbort();
    else if (action === "new") void onNewSession();
    else if (action === "archive") void onArchive();
    else if (action === "toggle-activity") toggleActivity();
  }

  function onChange(e) {
    if (!state.root) return;
    const sel = e.target?.closest?.("[data-chat-select]");
    if (!sel) return;
    const key = sel.getAttribute("data-chat-select");
    const val = sel.value;
    if (key === "session") {
      void onPickSession(val);
      return;
    }
    if (key === "model" || key === "effort" || key === "permissionMode") {
      state.selectors = { ...state.selectors, [key]: val };
      saveJSON(STORAGE_KEYS.selectors, state.selectors);
    }
  }

  function onKeyDown(e) {
    if (!state.root) return;
    if (e.target?.id === "chat-sidebar-input") {
      // IME composition guard — do not send mid-composition.
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      } else if (e.key === "Escape") {
        e.preventDefault();
        (e.target).blur?.();
      }
      return;
    }
    // Escape inside the transcript collapses any open chip.
    if (e.key === "Escape") {
      const open = state.root.querySelectorAll('.chat-chip[aria-expanded="true"]');
      for (const c of open) {
        const details = c.querySelector(".chat-chip-details");
        if (details) details.hidden = true;
        c.setAttribute("aria-expanded", "false");
      }
    }
  }

  function onInput(_e) {
    if (!state.root) return;
    autoResize();
  }

  function autoResize() {
    if (!state.root) return;
    const ta = state.root.querySelector("#chat-sidebar-input");
    if (!ta) return;
    // Reset to a single line, then expand up to ~6 lines. Past that we
    // let the textarea scroll internally.
    ta.style.height = "auto";
    const lineHeight = 18; // approximate; matches CSS line-height
    const maxH = lineHeight * 6;
    const next = Math.min(ta.scrollHeight, maxH);
    ta.style.height = next + "px";
    ta.style.overflowY = ta.scrollHeight > maxH ? "auto" : "hidden";
  }

  /** Capture-phase Cmd/Ctrl+K handler — focuses the composer when the
   *  sidebar is open. Registered at load time (before keyboard.js attaches
   *  its own listener, which fires on the same node afterwards). Calling
   *  stopImmediatePropagation prevents keyboard.js from opening the
   *  command palette when the user is in chat mode. */
  function onGlobalKey(e) {
    const isMod = e.metaKey || e.ctrlKey;
    if (!isMod) return;
    const k = (e.key || "").toLowerCase();
    if (k !== "k") return;
    if (!state.open || !state.mounted) return;
    const composer = state.root?.querySelector("#chat-sidebar-input");
    if (!composer) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    composer.focus();
    try { composer.setSelectionRange(composer.value.length, composer.value.length); } catch (_err) { /* ignore */ }
  }
  // Register at load time so we win the registration-order tiebreaker
  // against keyboard.js (which attaches its own capture-phase listener
  // later in the page load sequence).
  window.addEventListener("keydown", onGlobalKey, { capture: true });

  async function copyToClipboard(ts) {
    const turn = state.transcript.find((t) => t.ts === ts);
    if (!turn) return;
    try { await navigator.clipboard.writeText(turn.content || ""); } catch (_err) { /* ignore */ }
  }

  async function retryLastTurn() {
    // Re-submit the last user turn (if any) using the current selectors.
    const lastUser = [...state.transcript].reverse().find((t) => t.role === "user");
    if (!lastUser) return;
    if (!state.root) return;
    const input = state.root.querySelector("#chat-sidebar-input");
    if (input) input.value = lastUser.content || "";
    void onSend();
  }

  async function onSend() {
    if (!state.root) return;
    const input = state.root.querySelector("#chat-sidebar-input");
    if (!input) return;
    const message = (input.value || "").trim();
    if (!message || state.inFlight) return;

    state.inFlight = true;
    updateAbortButton();
    input.value = "";
    autoResize();

    // Optimistic local-only user turn so the UI shows it immediately.
    // The HTTP response (or SSE) will deliver the canonical turn; the dedup
    // helper in appendTurnIfNew keeps the transcript from double-counting.
    const localTs = new Date().toISOString();
    state.transcript.push({
      role: "user",
      content: message,
      ts: localTs,
      model: state.selectors.model,
      effort: state.selectors.effort,
      permissionMode: state.selectors.permissionMode,
      __status: "sending",
    });
    state.liveChips = [];
    await renderTranscript();
    startSessionStream();

    state.abortController = new AbortController();
    try {
      const a = api();
      if (!a) throw new Error("API not ready");
      const result = await a(
        "POST",
        "/api/chat/send",
        {
          sessionId: state.currentSessionId || undefined,
          message,
          model: state.selectors.model,
          effort: state.selectors.effort,
          permissionMode: state.selectors.permissionMode,
        },
        { signal: state.abortController.signal },
      );
      if (result?.sessionId) {
        state.currentSessionId = result.sessionId;
        saveString(STORAGE_KEYS.lastSession, state.currentSessionId);
      }
      // Drop the optimistic local turn (last one we pushed) so the
      // canonical one from the server replaces it via appendTurnIfNew.
      state.transcript = state.transcript.filter((t) => t.ts !== localTs);
      appendTurnIfNew(result?.userTurn);
      appendTurnIfNew(result?.assistantTurn);
      await renderTranscript();
      bindChipChips();
      await refreshSessions();
    } catch (err) {
      appendTurnIfNew({
        role: "system",
        content: `(send failed: ${(err && err.message) || "unknown error"})`,
        ts: new Date().toISOString(),
        status: "error",
        error: (err && err.message) || String(err),
      });
      await renderTranscript();
    } finally {
      state.inFlight = false;
      state.abortController = null;
      updateAbortButton();
      stopSessionStream();
    }
  }

  async function onAbort() {
    if (!state.currentSessionId) return;
    await abortSession(state.currentSessionId);
    if (state.abortController) state.abortController.abort();
  }

  async function onNewSession() {
    state.currentSessionId = "";
    saveString(STORAGE_KEYS.lastSession, "");
    state.transcript = [];
    populateSelectors();
    stopSessionStream();
    await renderTranscript();
  }

  async function onArchive() {
    if (!state.currentSessionId) return;
    await deleteSession(state.currentSessionId);
    state.currentSessionId = "";
    state.transcript = [];
    saveString(STORAGE_KEYS.lastSession, "");
    stopSessionStream();
    await refreshSessions();
    populateSelectors();
    await renderTranscript();
  }

  async function onPickSession(value) {
    if (value === "__new__") return onNewSession();
    state.currentSessionId = value;
    saveString(STORAGE_KEYS.lastSession, value);
    const data = await fetchSession(value);
    if (data && Array.isArray(data.turns)) {
      state.transcript = data.turns;
      // Restore selectors from the most recent assistant turn when
      // available so the composer matches the saved session state.
      const lastAssistant = [...data.turns].reverse().find((t) => t.role === "assistant");
      if (lastAssistant) {
        if (lastAssistant.model) state.selectors.model = lastAssistant.model;
        if (lastAssistant.effort) state.selectors.effort = lastAssistant.effort;
        if (lastAssistant.permissionMode) state.selectors.permissionMode = lastAssistant.permissionMode;
        saveJSON(STORAGE_KEYS.selectors, state.selectors);
      }
      populateSelectors();
      await renderTranscript();
      bindChipChips();
    }
    startSessionStream();
  }

  function updateAbortButton() {
    if (!state.root) return;
    const send = state.root.querySelector("#chat-sidebar-send");
    const abort = state.root.querySelector("#chat-sidebar-abort");
    if (state.inFlight) {
      if (send) send.hidden = true;
      if (abort) abort.hidden = false;
    } else {
      if (send) send.hidden = false;
      if (abort) abort.hidden = true;
    }
  }

  function toggleActivity() {
    if (!state.root) return;
    state.activityOpen = !state.activityOpen;
    const section = state.root.querySelector("#chat-sidebar-activity");
    if (section) section.hidden = !state.activityOpen;
    if (state.activityOpen) {
      const target = state.root.querySelector("#chat-sidebar-claude-root");
      if (target && window.OpenKanClaude && window.OpenKanClaude.mount) {
        window.OpenKanClaude.mount(target);
      }
    } else if (window.OpenKanClaude && window.OpenKanClaude.unmount) {
      window.OpenKanClaude.unmount();
    }
  }

  /* ----------------------------------------------------------------------
   * Open / close + mount
   * -------------------------------------------------------------------- */
  function open() {
    if (!state.root) return;
    state.root.hidden = false;
    state.open = true;
    state.root.querySelector(".chat-sidebar-handle")?.setAttribute("aria-expanded", "true");
    saveString(STORAGE_KEYS.open, "1");
    autoResize();
  }
  function close() {
    if (!state.root) return;
    state.root.hidden = true;
    state.open = false;
    state.root.querySelector(".chat-sidebar-handle")?.setAttribute("aria-expanded", "false");
    saveString(STORAGE_KEYS.open, "0");
  }
  function toggle() { state.open ? close() : open(); }
  function isOpen() { return state.open; }

  async function refreshSessions() {
    if (!state.root) return;
    state.sessions = await fetchSessions();
    populateSelectors();
    const meta = state.root.querySelector("#chat-sidebar-meta");
    if (meta) {
      meta.textContent = state.sessions.length === 0
        ? "no sessions"
        : `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`;
    }
  }

  async function mount(rootEl) {
    if (state.mounted) return;
    state.root = buildShell();
    state.mounted = true;
    state.open = loadString(STORAGE_KEYS.open) === "1";
    state.selectors = { ...DEFAULT_SELECTORS, ...(loadJSON(STORAGE_KEYS.selectors) || {}) };
    state.currentSessionId = loadString(STORAGE_KEYS.lastSession);
    state.models = await fetchModels();
    populateSelectors();
    bindEvents();
    if (state.open) open();
    autoResize();
    startLive();
    await refreshSessions();
    if (state.currentSessionId) {
      const data = await fetchSession(state.currentSessionId);
      if (data && Array.isArray(data.turns)) {
        state.transcript = data.turns;
      } else {
        state.currentSessionId = "";
        saveString(STORAGE_KEYS.lastSession, "");
      }
    }
    await renderTranscript();
    bindChipChips();
    startSessionStream();
  }

  function unmount() {
    if (!state.mounted) return;
    stopLive();
    if (window.OpenKanClaude && window.OpenKanClaude.unmount) {
      try { window.OpenKanClaude.unmount(); } catch (_err) { /* ignore */ }
    }
    if (state.abortController) {
      try { state.abortController.abort(); } catch (_err) { /* ignore */ }
      state.abortController = null;
    }
    if (state.root) {
      try { state.root.remove(); } catch (_err) { /* ignore */ }
      state.root = null;
    }
    state.mounted = false;
    state.open = false;
    state.transcript = [];
    state.renderedCache.clear();
  }

  // The topbar toggle button: if it exists before mount, wire its click to
  // toggle(); if not, the app can call `OpenKanChatSidebar.toggle()` directly.
  function wireTopbarToggle() {
    const btn = document.getElementById("chat-sidebar-toggle-btn");
    if (!btn) return;
    btn.addEventListener("click", () => toggle());
  }

  // Auto-wire when DOM is ready (chat-sidebar.js is loaded after the body
  // element so the topbar button is already parsed).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireTopbarToggle, { once: true });
  } else {
    wireTopbarToggle();
  }

  window.OpenKanChatSidebar = { mount, unmount, toggle, open, close, isOpen };
})();
