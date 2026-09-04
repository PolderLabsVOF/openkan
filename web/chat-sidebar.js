// OpenKan — chat sidebar (right-rail chat orchestrator).
//
// Mounts a fixed-position aside on the right edge of the viewport with:
//   - A hero title "What should we work on?" shown only on empty sessions.
//   - A scrollable transcript that renders each turn as a single bubble
//     (right-aligned coral pill for user; plain left-aligned text for
//     assistant / system) with compact tool-use chips between turns.
//     While the assistant is streaming, a muted italic "Working" line
//     sits below the bubble and disappears when the turn completes.
//   - A composer footer: single rounded bar with attach / textarea /
//     model pill / mic / send (or abort while streaming) inline.
//   - A tabs row: Project / Files / Plugins / Get desktop app (link).
//     Activity footer still exists as a slide-in section but is no
//     longer a tab.
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
    // Cached `/api/chat/picker-options` payload (model list + efforts + perms).
    pickerOptions: null,
    // Currently-open popover id (or null). Only one popover at a time.
    popoverId: null,
    // Currently-open tab name (project / files / plugins / activity). null
    // when no tab is active. Activity uses activityOpen instead of a popover.
    activeTab: null,
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

      <!-- Hidden selectors. The legacy visible chip / header sub-sections
           have been removed; the <select>s are still mounted (hidden) so
           populateSelectors() and sendTurn() can read/write session +
           model + effort + permission state. -->
      <div hidden>
        <span class="chat-sidebar-meta" id="chat-sidebar-meta">—</span>
        <select id="chat-select-session" data-chat-select="session"></select>
        <select id="chat-select-model" data-chat-select="model"></select>
        <select id="chat-select-effort" data-chat-select="effort"></select>
        <select id="chat-select-permission" data-chat-select="permissionMode"></select>
      </div>

      <!-- Hero: visible only when the active session has zero messages. -->
      <div class="chat-sidebar__hero chat-sidebar-hero" id="chat-sidebar-hero">
        <h2 class="chat-sidebar__hero-title">What should we work on?</h2>
      </div>

      <!-- Scrollable transcript of bubbles + tool chips. -->
      <section class="chat-sidebar__transcript chat-sidebar-transcript" id="chat-sidebar-transcript"
               aria-live="polite" aria-label="Chat transcript"></section>
      <button type="button" class="chat-sidebar-new-messages" id="chat-sidebar-new-messages"
              hidden>↓ New messages</button>

      <!-- Disclaimer shown above the composer once a session has any messages. -->
      <p class="chat-sidebar__disclaimer" id="chat-sidebar-disclaimer" hidden>
        Workspace data isn't used to train models.
      </p>

      <!-- Composer: rounded input bar — attach / input / model pill / mic / send. -->
      <footer class="chat-sidebar__composer chat-sidebar-composer">
        <button type="button" class="chat-sidebar__composer-attach" data-chat-action="open-attach-menu"
                aria-label="More options" aria-haspopup="true" aria-expanded="false" title="More options">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
          </svg>
        </button>
        <textarea id="chat-sidebar-input" class="chat-sidebar__composer-input"
                  rows="1" placeholder="Work on anything…" aria-label="Compose message"></textarea>
        <button type="button" class="chat-sidebar__composer-model" data-chat-action="open-model-picker"
                aria-label="Choose model" aria-haspopup="true" aria-expanded="false" title="Model / effort / permissions">
          <span class="chat-sidebar__composer-model-label" id="chat-sidebar-model-label">Default</span>
          <svg class="chat-sidebar__chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button type="button" class="chat-sidebar__composer-mic" data-chat-action="mic"
                aria-label="Voice input" title="Coming soon" disabled>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0V4A2.5 2.5 0 0 0 8 1.5zM3 8a5 5 0 0 0 10 0M8 13v2.5"
                  fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button type="button" id="chat-sidebar-send" class="chat-sidebar__composer-send chat-send"
                data-chat-action="send" aria-label="Send" title="Send (Enter)">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 8h10.5M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button type="button" id="chat-sidebar-abort" class="chat-sidebar__composer-abort chat-abort"
                data-chat-action="abort" hidden aria-label="Abort" title="Abort">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="2" y="2" width="10" height="10" rx="1.5" fill="currentColor" />
          </svg>
        </button>
      </footer>

      <!-- Tabs row. Project / Files / Plugins / Get desktop app (CTA link). -->
      <nav class="chat-sidebar__tabs" data-chat-tabs role="tablist" aria-label="Sidebar shortcuts">
        <button type="button" class="chat-sidebar__tabs-tab" data-tab="project"
                role="tab" aria-selected="false" title="Project">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.5 5h13v8.5h-13z M1.5 5l1.5-2h5l1.5 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
          <span>Project</span>
        </button>
        <button type="button" class="chat-sidebar__tabs-tab" data-tab="files"
                role="tab" aria-selected="false" title="Files">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 1.5h5l3.5 3.5v9.5h-8.5z M8 1.5v3.5h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
          <span>Files</span>
        </button>
        <button type="button" class="chat-sidebar__tabs-tab" data-tab="plugins"
                role="tab" aria-selected="false" title="Plugins">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 1.5v5h-3.5v3h3.5v5h3v-5h3v-3h-3v-5z" fill="currentColor" />
          </svg>
          <span>Plugins</span>
        </button>
        <button type="button" class="chat-sidebar__tabs-tab chat-sidebar__tabs-tab--link" data-tab="desktop-app"
                role="link" aria-selected="false" title="Get desktop app">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12v8H2z M5 12h6 M2 7h12 M8 1.5L11 4 H5z"
                  fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          </svg>
          <span>Get desktop app</span>
        </button>
      </nav>

      <!-- Activity footer (slide-in when activity tab is active). -->
      <section class="chat-sidebar__activity chat-sidebar-activity" id="chat-sidebar-activity"
               aria-label="Activity" hidden>
        <div id="chat-sidebar-claude-root"></div>
      </section>

      <!-- Popovers. Created lazily by ensurePopover(); the mount is here so
           they share the sidebar's stacking context. -->
      <div id="chat-sidebar-popover-mount"></div>
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

    // Sync the visible chip + pill labels with the underlying <select>
    // state. Hidden <select>s are still written above for back-compat with
    // sendTurn() and persistence; the chip / pill are pure presentation.
    updateSessionChip();
    updateModelPill();
    syncHeroState();
  }

  function updateSessionChip() {
    if (!state.root) return;
    const label = state.root.querySelector("#chat-sidebar-session-title");
    if (!label) return;
    const cur = (state.sessions || []).find((s) => s.id === state.currentSessionId);
    label.textContent = cur?.title || cur?.id || "New session";
  }

  function updateModelPill() {
    if (!state.root) return;
    const label = state.root.querySelector("#chat-sidebar-model-label");
    if (!label) return;
    const raw = state.selectors.model || "default";
    label.textContent = raw === "default" ? "Default" : String(raw).replace(/^.*?\//, "");
  }

  /** Toggle the "What should we work on?" hero + ChatGPT-style disclaimer
   *  based on transcript state. The CSS rule
   *  .chat-sidebar--has-messages .chat-sidebar__disclaimer shows the
   *  disclaimer whenever the class is set, so no per-node hidden flag is
   *  needed. */
  function syncHeroState() {
    if (!state.root) return;
    const has = Array.isArray(state.transcript) && state.transcript.length > 0;
    state.root.classList.toggle("chat-sidebar--has-messages", has);
  }

  /* ----------------------------------------------------------------------
   * Bubble rendering
   * -------------------------------------------------------------------- */
  function bubbleHTML(turn) {
    const role = turn.role || "assistant";
    const errorLine = turn.error
      ? `<div class="chat-bubble-error">${esc(turn.error)}</div>` : "";
    if (role === "user") {
      const status = turn.__status || (turn.status && turn.status !== "ok" ? turn.status : "sent");
      return `
        <div class="chat-bubble-row chat-bubble-row-user">
          <div class="chat-bubble chat-bubble-user" data-ts="${esc(turn.ts || "")}" data-status="${esc(status)}">
            <div class="chat-bubble-body">${esc(turn.content || "")}</div>
          </div>
          ${errorLine}
        </div>
      `;
    }
    if (role === "system") {
      const status = turn.status || "ok";
      return `
        <div class="chat-bubble-row chat-bubble-row-system">
          <div class="chat-bubble chat-bubble-system" data-ts="${esc(turn.ts || "")}" data-status="${esc(status)}">
            <div class="chat-bubble-body">${esc(turn.content || "")}</div>
            ${errorLine}
          </div>
        </div>
      `;
    }
    // Assistant bubble. Body is filled by renderTranscript via async
    // markdown rendering; the empty placeholder lets us stream into it
    // incrementally without re-parsing markdown each tick. The
    // [data-bubble-body] marker is the streaming hook used by appendToken
    // and finalizeLiveBubble — keep it.
    return `
      <div class="chat-bubble-row chat-bubble-row-assistant">
        <div class="chat-bubble chat-bubble-assistant" data-ts="${esc(turn.ts || "")}" data-status="${esc(turn.status || "ok")}">
          <div class="chat-bubble-body chat-bubble-body-stream" data-bubble-body></div>
          ${errorLine}
        </div>
      </div>
    `;
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
    syncHeroState();
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
        ensureStreamingIndicator();
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
    removeStreamingIndicator();
  }

  /**
   * Streaming "Working" indicator — a single muted italic line appended
   * to the transcript while the assistant turn is in flight. Hidden when
   * the turn completes (via finalizeLiveBubble) or when the transcript is
   * re-rendered.
   */
  function ensureStreamingIndicator() {
    const transcript = state.root?.querySelector("#chat-sidebar-transcript");
    if (!transcript) return;
    if (transcript.querySelector(":scope > .chat-bubble-streaming-indicator")) return;
    const node = document.createElement("div");
    node.className = "chat-bubble-streaming-indicator";
    node.setAttribute("aria-live", "polite");
    node.textContent = "Working";
    transcript.appendChild(node);
  }

  function removeStreamingIndicator() {
    const transcript = state.root?.querySelector("#chat-sidebar-transcript");
    if (!transcript) return;
    const node = transcript.querySelector(":scope > .chat-bubble-streaming-indicator");
    if (node) node.remove();
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
    if (!dup) {
      state.transcript.push(turn);
      syncHeroState();
    }
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

    // Drag-drop: dropped files are routed through the M1 import endpoint.
    state.root.addEventListener("dragover", (e) => { e.preventDefault(); });
    state.root.addEventListener("drop", async (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      e.preventDefault();
      const a = api();
      if (!a) return;
      for (const file of files) {
        try {
          const text = await file.text();
          await a("POST", "/api/import", { body: { content: text, filename: file.name } });
        } catch (_err) { /* ignore */ }
      }
      await refreshSessions();
    });
  }

  /** Global click-away: close any open popover when the user clicks
   *  outside the sidebar's interactive elements. Registered on mount. */
  function bindGlobalDismiss() {
    document.addEventListener("mousedown", (e) => {
      if (!state.root || !state.popoverId) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (state.root.contains(target)) return;
      closePopover();
    });
    document.addEventListener("keydown", (e) => {
      if (!state.popoverId) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closePopover();
      }
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
    const tabBtn = t.closest("[data-tab]");
    if (tabBtn) {
      const name = tabBtn.getAttribute("data-tab");
      if (name) { openTab(name); return; }
    }
    const action = t.closest("[data-chat-action]")?.getAttribute("data-chat-action");
    if (action === "send") void onSend();
    else if (action === "abort") void onAbort();
    else if (action === "new") { closePopover(); void onNewSession(); }
    else if (action === "archive") { closePopover(); void onArchive(); }
    else if (action === "toggle-activity") { closePopover(); toggleActivity(); setActiveTab(state.activityOpen ? "activity" : null); }
    else if (action === "open-model-picker") { void openModelPicker(); return; }
    else if (action === "open-attach-menu") { openAttachMenu(); return; }
    else if (action === "open-session-menu") { openSessionMenu(); return; }
    else if (action === "import-file") { void onImportFileClick(); return; }
    else if (action === "add-to-planning") { void onAddToPlanningClick(); return; }
    else if (action === "pick-session") {
      const id = t.closest("[data-session-id]")?.getAttribute("data-session-id");
      if (id) { onPickSessionClick(id); return; }
    }
    else if (action === "close-attach") { closePopover(); return; }
    else if (action === "open-project-picker") { onOpenProjectPicker(); return; }
    else if (action === "open-docs") { onOpenDocs(); return; }
    else if (action === "toggle-docs-pane") { onToggleDocsPane(); return; }
    else if (action === "m1-import") { onM1Import(); return; }
    else if (action === "planning-cli") { onPlanningCli(); return; }
    else if (action === "agents-catalog") { onAgentsCatalog(); return; }
    else if (action === "list-sessions") { onListSessions(); return; }
    else if (action === "mic") {
      // Voice input is a placeholder; surfacing as a toast is the lightest
      // way to confirm the click landed without shipping a half-working
      // speech-recognition path.
      try { window.dispatchEvent(new CustomEvent("openkan:toast", { detail: { kind: "info", message: "Voice input is coming soon." } })); } catch (_err) { /* ignore */ }
      return;
    }
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
    if (section) {
      section.hidden = !state.activityOpen;
      section.classList.toggle("chat-sidebar__activity--open", state.activityOpen);
    }
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
   * Popovers (model picker, attach menu, session list, tab popovers)
   *
   * Popovers are siblings of the composer inside `#chat-sidebar-popover-mount`.
   * They are absolutely positioned via inline `top` / `left` derived from
   * the trigger element's `getBoundingClientRect()` and clamped to the
   * sidebar's visible bounds. Only one popover is open at a time; opening
   * a new one closes the previous.
   * -------------------------------------------------------------------- */

  /** Lazily create a popover container. Returns the element. */
  function ensurePopover(id, className) {
    if (!state.root) return null;
    const mount = state.root.querySelector("#chat-sidebar-popover-mount");
    if (!mount) return null;
    let node = mount.querySelector(`#${id}`);
    if (!node) {
      node = document.createElement("div");
      node.id = id;
      node.className = `chat-sidebar__popover ${className || ""}`.trim();
      node.hidden = true;
      node.setAttribute("role", "dialog");
      mount.appendChild(node);
    }
    return node;
  }

  /** Close any open popover. */
  function closePopover() {
    if (!state.root) return;
    const mount = state.root.querySelector("#chat-sidebar-popover-mount");
    if (!mount) return;
    for (const node of mount.querySelectorAll(".chat-sidebar__popover")) {
      node.hidden = true;
    }
    // Reset aria-expanded on any trigger we opened.
    for (const trigger of state.root.querySelectorAll("[data-popover-open='1']")) {
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("data-popover-open");
    }
    state.popoverId = null;
  }

  /** Anchor an already-built popover to a trigger element. */
  function anchorPopover(popover, trigger) {
    if (!popover || !trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const sidebarRect = state.root?.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    // Default: open downward beneath the trigger, left-aligned.
    let top = triggerRect.bottom + 6;
    let left = triggerRect.left;
    if (sidebarRect) {
      // Clamp horizontally inside the sidebar.
      const maxLeft = sidebarRect.right - popRect.width - 8;
      if (left > maxLeft) left = Math.max(sidebarRect.left + 8, maxLeft);
      if (left < sidebarRect.left + 4) left = sidebarRect.left + 4;
      // Clamp vertically so the popover stays inside the viewport.
      const maxBottom = window.innerHeight - 8;
      if (top + popRect.height > maxBottom) {
        // Open upward if there's no room below.
        top = Math.max(8, triggerRect.top - popRect.height - 6);
      }
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("data-popover-open", "1");
  }

  /* ----------------------------------------------------------------------
   * Model picker popover
   * Three sections: Model, Effort, Permissions.
   * -------------------------------------------------------------------- */

  async function fetchPickerOptions() {
    if (state.pickerOptions) return state.pickerOptions;
    const a = api();
    if (!a) return null;
    try {
      const data = await a("GET", "/api/chat/picker-options");
      if (!data || !Array.isArray(data.models)) return null;
      state.pickerOptions = data;
      return data;
    } catch (_err) {
      return null;
    }
  }

  async function openModelPicker() {
    if (!state.root) return;
    const trigger = state.root.querySelector(".chat-sidebar__composer-model");
    if (!trigger) return;
    const popover = ensurePopover("chat-sidebar-model-popover");
    if (!popover) return;
    if (state.popoverId === popover.id) {
      closePopover();
      return;
    }
    closePopover();
    const opts = await fetchPickerOptions();
    const models = (opts?.models || state.models.map((id) => ({ id, label: id })));
    const efforts = opts?.efforts || EFFORT_OPTIONS;
    const perms = opts?.permissionModes || PERMISSION_OPTIONS;

    const modelId = state.selectors.model || "default";
    const effort = state.selectors.effort || "high";
    const perm = state.selectors.permissionMode || "default";

    popover.innerHTML = `
      <section class="chat-sidebar__popover-section" data-section="model">
        <h3 class="chat-sidebar__popover-heading">Model</h3>
        <ul class="chat-sidebar__popover-list">
          ${modelRadio("default", "Default", modelId === "default")}
          ${models.map((m) => modelRadio(m.id, m.label || m.id, m.id === modelId)).join("")}
        </ul>
      </section>
      <section class="chat-sidebar__popover-section" data-section="effort">
        <h3 class="chat-sidebar__popover-heading">Effort</h3>
        <ul class="chat-sidebar__popover-list">
          ${efforts.map((e) => effortRadio(e, e, e === effort)).join("")}
        </ul>
      </section>
      <section class="chat-sidebar__popover-section" data-section="perms">
        <h3 class="chat-sidebar__popover-heading">Permissions</h3>
        <ul class="chat-sidebar__popover-list">
          ${perms.map((p) => permRadio(p, p, p === perm)).join("")}
        </ul>
      </section>
    `;
    state.popoverId = popover.id;
    // Render before measuring so getBoundingClientRect is accurate.
    anchorPopover(popover, trigger);
    popover.addEventListener("change", onPickerChange);
  }

  function modelRadio(value, label, checked) {
    return `
      <li>
        <label class="${checked ? "is-active" : ""}">
          <input type="radio" name="chat-picker-model" value="${esc(value)}" ${checked ? "checked" : ""} />
          <span>${esc(label)}</span>
        </label>
      </li>`;
  }
  function effortRadio(value, label, checked) {
    return `
      <li>
        <label class="${checked ? "is-active" : ""}">
          <input type="radio" name="chat-picker-effort" value="${esc(value)}" ${checked ? "checked" : ""} />
          <span>${esc(label)}</span>
        </label>
      </li>`;
  }
  function permRadio(value, label, checked) {
    return `
      <li>
        <label class="${checked ? "is-active" : ""}">
          <input type="radio" name="chat-picker-perm" value="${esc(value)}" ${checked ? "checked" : ""} />
          <span>${esc(label)}</span>
        </label>
      </li>`;
  }

  function onPickerChange(e) {
    if (!state.root) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const name = t.name;
    const value = t.value;
    if (name === "chat-picker-model") {
      state.selectors = { ...state.selectors, model: value };
    } else if (name === "chat-picker-effort") {
      state.selectors = { ...state.selectors, effort: value };
    } else if (name === "chat-picker-perm") {
      state.selectors = { ...state.selectors, permissionMode: value };
    } else {
      return;
    }
    saveJSON(STORAGE_KEYS.selectors, state.selectors);
    populateSelectors();
    closePopover();
  }

  /* ----------------------------------------------------------------------
   * + attach menu — New session / Import / Add to planning / Cancel.
   * -------------------------------------------------------------------- */

  function openAttachMenu() {
    if (!state.root) return;
    const trigger = state.root.querySelector(".chat-sidebar__composer-attach");
    if (!trigger) return;
    const popover = ensurePopover("chat-sidebar-attach-popover", "chat-sidebar__attach-menu");
    if (!popover) return;
    if (state.popoverId === popover.id) {
      closePopover();
      return;
    }
    closePopover();
    popover.innerHTML = `
      <button type="button" data-chat-action="new" data-attach="1">＋ New session</button>
      <button type="button" data-chat-action="import-file" data-attach="1">⇪ Import from file</button>
      <button type="button" data-chat-action="add-to-planning" data-attach="1">▦ Add to planning</button>
      <button type="button" data-chat-action="close-attach" data-attach="1">Cancel</button>
    `;
    state.popoverId = popover.id;
    anchorPopover(popover, trigger);
  }

  async function importFromFile() {
    const a = api();
    if (!a) return;
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".md,.mdx,.markdown,.txt,.json";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        const res = await a("POST", "/api/import", {
          body: { content: text, filename: file.name },
        });
        closePopover();
        if (res && res.ok) await refreshSessions();
      }, { once: true });
      input.click();
    } catch (_err) {
      closePopover();
    }
  }

  async function addToPlanning() {
    const a = api();
    if (!a) { closePopover(); return; }
    const composer = state.root?.querySelector("#chat-sidebar-input");
    const message = (composer?.value || "").trim();
    if (!message) {
      try { composer?.focus(); } catch (_err) { /* ignore */ }
      closePopover();
      return;
    }
    try {
      const title = message.split("\n")[0].slice(0, 80) || "Untitled task";
      await a("POST", "/api/planning/tasks", { body: { title, body: message } });
    } catch (_err) { /* ignore */ }
    closePopover();
  }

  /* ----------------------------------------------------------------------
   * Session chip menu — quick switcher + New session.
   * -------------------------------------------------------------------- */

  function openSessionMenu() {
    if (!state.root) return;
    const trigger = state.root.querySelector(".chat-sidebar__session-chip");
    if (!trigger) return;
    const popover = ensurePopover("chat-sidebar-session-popover");
    if (!popover) return;
    if (state.popoverId === popover.id) {
      closePopover();
      return;
    }
    closePopover();
    const items = [`<button type="button" data-chat-action="new" data-attach="1">＋ New session</button>`]
      .concat((state.sessions || []).slice(0, 20).map((s) =>
        `<button type="button" data-chat-action="pick-session" data-session-id="${esc(s.id)}" data-attach="1">${esc(s.title || s.id)}</button>`,
      ));
    popover.innerHTML = items.join("");
    state.popoverId = popover.id;
    anchorPopover(popover, trigger);
  }

  /* ----------------------------------------------------------------------
   * Tab popovers — Project / Files / Plugins.
   * -------------------------------------------------------------------- */

  function openTab(tab) {
    if (!state.root) return;
    if (state.activeTab === tab) {
      closeTab();
      return;
    }
    // "Get desktop app" is a CTA — open the releases page in a new tab
    // rather than toggling a popover. It is not a real tab state.
    if (tab === "desktop-app") {
      try {
        window.open("https://github.com/PolderLabsVOF/openkan/releases", "_blank", "noopener,noreferrer");
      } catch (_err) { /* ignore */ }
      return;
    }
    closeTab();
    const popover = ensurePopover(`chat-sidebar-tab-${tab}-popover`);
    if (!popover) return;
    if (tab === "project") {
      popover.innerHTML = `
        <h3 class="chat-sidebar__popover-heading">Project</h3>
        <button type="button" data-chat-action="open-project-picker" data-attach="1">Switch project…</button>
        <button type="button" data-chat-action="list-sessions" data-attach="1">List sessions in this project</button>
      `;
    } else if (tab === "files") {
      popover.innerHTML = `
        <h3 class="chat-sidebar__popover-heading">Files</h3>
        <button type="button" data-chat-action="open-docs" data-attach="1">Open documentation browser</button>
        <button type="button" data-chat-action="toggle-docs-pane" data-attach="1">Toggle docs pane</button>
      `;
    } else if (tab === "plugins") {
      popover.innerHTML = `
        <h3 class="chat-sidebar__popover-heading">Plugins</h3>
        <button type="button" data-chat-action="m1-import" data-attach="1">M1 import</button>
        <button type="button" data-chat-action="planning-cli" data-attach="1">Planning CLI</button>
        <button type="button" data-chat-action="agents-catalog" data-attach="1">Agents catalog</button>
      `;
    } else {
      return;
    }
    const trigger = state.root.querySelector(`.chat-sidebar__tabs-tab[data-tab="${tab}"]`);
    state.popoverId = popover.id;
    anchorPopover(popover, trigger);
    setActiveTab(tab);
  }

  function closeTab() {
    setActiveTab(null);
    if (state.root) {
      const mount = state.root.querySelector("#chat-sidebar-popover-mount");
      if (mount) {
        for (const node of mount.querySelectorAll('[id^="chat-sidebar-tab-"]')) {
          node.hidden = true;
        }
      }
    }
    if (state.popoverId && state.popoverId.startsWith("chat-sidebar-tab-")) {
      state.popoverId = null;
    }
  }

  function setActiveTab(name) {
    state.activeTab = name;
    if (!state.root) return;
    for (const tab of state.root.querySelectorAll(".chat-sidebar__tabs-tab")) {
      const isActive = tab.getAttribute("data-tab") === name;
      tab.classList.toggle("chat-sidebar__tabs-tab--active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    }
  }

  async function onImportFileClick() { await importFromFile(); }
  async function onAddToPlanningClick() { await addToPlanning(); }
  function onPickSessionClick(id) { closePopover(); void onPickSession(id); }
  function onOpenProjectPicker() {
    // Best-effort: open the path picker (if loaded) or focus the docs
    // browser command. The action is fire-and-forget.
    try { window.OpenKanPathPicker?.open?.(); } catch (_err) { /* ignore */ }
    closePopover();
  }
  function onOpenDocs() {
    try { window.dispatchEvent(new CustomEvent("openkan:open-docs")); } catch (_err) { /* ignore */ }
    closePopover();
  }
  function onToggleDocsPane() {
    try { window.dispatchEvent(new CustomEvent("openkan:toggle-docs-pane")); } catch (_err) { /* ignore */ }
    closePopover();
  }
  function onM1Import() { void importFromFile(); }
  function onPlanningCli() {
    try { window.dispatchEvent(new CustomEvent("openkan:open-planning-cli")); } catch (_err) { /* ignore */ }
    closePopover();
  }
  function onAgentsCatalog() {
    try { window.dispatchEvent(new CustomEvent("openkan:open-agents-catalog")); } catch (_err) { /* ignore */ }
    closePopover();
  }
  function onListSessions() {
    closePopover();
    openSessionMenu();
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
    bindGlobalDismiss();
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
    syncHeroState();
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
      try { closePopover(); } catch (_err) { /* ignore */ }
      try { state.root.remove(); } catch (_err) { /* ignore */ }
      state.root = null;
    }
    state.mounted = false;
    state.open = false;
    state.transcript = [];
    state.renderedCache.clear();
    state.pickerOptions = null;
    state.popoverId = null;
    state.activeTab = null;
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
