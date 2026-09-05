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
    width: "ok.chat.width",
    draft: "ok.chat.draft",
  };
  const DEFAULT_SELECTORS = Object.freeze({
    agent: "openkan",
    model: "default",
    effort: "high",
    permissionMode: "bypassPermissions",
  });
  const EFFORT_OPTIONS = ["low", "medium", "high", "max"];
  const PERMISSION_OPTIONS = [
    "bypassPermissions", "acceptEdits", "auto", "manual", "dontAsk", "plan",
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

  // Session selection and chat selectors belong to a workspace, not the
  // browser globally. The server is authoritative for transcript storage;
  // this only remembers the last session to reopen for each project.
  function projectStorageKey(key) {
    return `${key}:${state.projectScope || "workspace"}`;
  }

  async function resolveProjectScope() {
    const a = api();
    if (!a) return "workspace";
    try {
      const data = await a("GET", "/api/project");
      const active = data?.active;
      const identity = active?.id || active?.root;
      return identity ? encodeURIComponent(String(identity)) : "workspace";
    } catch (_err) {
      return "workspace";
    }
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
    requestEpoch: 0,
    dismissController: null,
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
    liveActivity: [],
    // Task references staged in the composer by board drag-and-drop.
    taskMentions: new Map(),
    // Completion marks are allowed one entrance only; rendered history stays still.
    completedMotionTs: new Set(),
    // Cached `/api/chat/picker-options` payload (model list + efforts + perms).
    pickerOptions: null,
    // Currently-open popover id (or null). Only one popover at a time.
    popoverId: null,
    // Currently-open tab name (project / files / plugins / activity). null
    // when no tab is active. Activity uses activityOpen instead of a popover.
    activeTab: null,
    width: 460,
    resizing: false,
    // Set before reading session-specific localStorage values in mount().
    projectScope: "workspace",
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
      <div class="chat-sidebar__resize-handle" data-chat-resize role="separator" aria-orientation="vertical"
           aria-label="Resize chat sidebar" aria-valuemin="320" aria-valuemax="640" aria-valuenow="460" tabindex="0"></div>

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

      <header class="chat-sidebar__topbar">
        <button type="button" class="chat-sidebar__session-chip" data-chat-action="open-session-menu"
                aria-haspopup="true" aria-expanded="false" title="Switch session">
          <span class="chat-sidebar__session-kicker">Chat</span>
          <span class="chat-sidebar__session-chip-title" id="chat-sidebar-session-title">New chat</span>
          <svg class="chat-sidebar__session-chip-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button type="button" class="chat-sidebar__new-chat" data-chat-action="new" aria-label="Start a new chat" title="New chat">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.25v11.5M2.25 8h11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
          <span>New chat</span>
        </button>
      </header>

      <div class="chat-sidebar__workspace-tools" aria-label="Chat shortcuts">
        <span class="chat-sidebar__workspace-label">Workspace assistant</span>
        <div class="chat-sidebar__quick-prompts" role="group" aria-label="Suggested prompts">
          <button type="button" data-chat-prompt="Plan the next best task for this project.">Plan next task</button>
          <button type="button" data-chat-prompt="Summarize the current project state and blockers.">Summarize</button>
          <button type="button" data-chat-prompt="Review the current changes and identify risks.">Review changes</button>
          <button type="button" data-chat-prompt="What should I work on next?">Suggest work</button>
        </div>
      </div>

      <div class="chat-sidebar__hero chat-sidebar-hero" id="chat-sidebar-hero">
        <div class="chat-sidebar__hero-mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24">
            <path d="M5 5.5h14v10.75H9.25L5 20.5V5.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            <path d="M8.5 10h7M8.5 13.5h4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </div>
        <h2 class="chat-sidebar__hero-title">What should we work on?</h2>
        <p class="chat-sidebar__hero-copy">Ask about this project, plan a task, or start a focused coding session.</p>
      </div>

      <section class="chat-sidebar__transcript chat-sidebar-transcript" id="chat-sidebar-transcript"
               aria-label="Chat transcript" tabindex="0"></section>
      <button type="button" class="chat-sidebar-new-messages" id="chat-sidebar-new-messages"
              hidden>Jump to latest ↓</button>

      <footer class="chat-sidebar__composer chat-sidebar-composer">
        <div class="chat-sidebar__composer-surface">
          <div class="chat-sidebar__mention-tray" id="chat-sidebar-mention-tray" hidden aria-live="polite" aria-label="Task references"></div>
          <textarea id="chat-sidebar-input" class="chat-sidebar__composer-input"
                    rows="1" placeholder="Ask about this project…" aria-label="Message OpenKan" aria-describedby="chat-sidebar-input-help"></textarea>
          <div class="chat-sidebar__composer-footer">
            <button type="button" class="chat-sidebar__composer-agent" data-chat-action="open-agent-picker"
                    aria-label="Choose agent" aria-haspopup="true" aria-expanded="false" title="Choose an agent for this conversation">
              <span id="chat-sidebar-agent-label">OpenKan</span>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 4 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
            </button>
            <button type="button" class="chat-sidebar__composer-attach" data-chat-action="open-attach-menu"
                    aria-label="Add context or start a new chat" aria-haspopup="true" aria-expanded="false" title="Add context">
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M9 2.25v13.5M2.25 9h13.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </button>
            <button type="button" class="chat-sidebar__composer-model" data-chat-action="open-model-picker"
                    aria-label="Choose model" aria-haspopup="true" aria-expanded="false" title="Choose model">
              <span class="chat-sidebar__composer-model-label" id="chat-sidebar-model-label">Default</span>
              <svg class="chat-sidebar__chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button type="button" class="chat-sidebar__composer-model chat-sidebar__composer-effort" data-chat-action="open-effort-picker"
                    aria-label="Choose reasoning effort" aria-haspopup="true" aria-expanded="false" title="Reasoning effort">
              <span class="chat-sidebar__composer-model-label" id="chat-sidebar-effort-label">High effort</span>
              <svg class="chat-sidebar__chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <span class="chat-sidebar__send-hint" aria-hidden="true">Enter to send</span>
            <button type="button" id="chat-sidebar-send" class="chat-sidebar__composer-send chat-send"
                    data-chat-action="send" aria-label="Send message" title="Send message">
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M9 14.75V3.25M4.75 7.5 9 3.25l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button type="button" id="chat-sidebar-abort" class="chat-sidebar__composer-abort chat-abort"
                    data-chat-action="abort" hidden aria-label="Stop generating" title="Stop generating">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
            </button>
          </div>
        </div>
        <div class="chat-sidebar__input-help" id="chat-sidebar-input-help"><span>Shift + Enter for a new line</span><span>Drop a task to reference it</span></div>
        <p class="chat-sidebar__feedback" id="chat-sidebar-feedback" role="status" hidden></p>
        <p class="chat-sidebar__disclaimer" id="chat-sidebar-disclaimer">Review important changes before applying them.</p>
      </footer>

      <section class="chat-sidebar__activity chat-sidebar-activity" id="chat-sidebar-activity"
               aria-label="Activity" hidden>
        <div id="chat-sidebar-claude-root"></div>
      </section>
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
    label.textContent = cur?.title || cur?.id || "New chat";
  }

  function updateModelPill() {
    if (!state.root) return;
    const label = state.root.querySelector("#chat-sidebar-model-label");
    if (!label) return;
    const raw = state.selectors.model || "default";
    label.textContent = raw === "default" ? "Default" : String(raw).replace(/^.*?\//, "");
    const agentLabel = state.root.querySelector("#chat-sidebar-agent-label");
    if (agentLabel) agentLabel.textContent = state.selectors.agent === "openkan" ? "OpenKan" : state.selectors.agent === "default" ? "Claude Code" : state.selectors.agent;
    const effortLabel = state.root.querySelector("#chat-sidebar-effort-label");
    if (effortLabel) effortLabel.textContent = `${String(state.selectors.effort || "high").replace(/^./, (c) => c.toUpperCase())} effort`;
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
  function formatTurnTime(ts) {
    const date = new Date(ts || "");
    return Number.isNaN(date.getTime()) ? "Now" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function bubbleMetaHTML(turn) {
    const label = turn.role === "user" ? "You" : turn.role === "assistant" ? (turn.agent === "openkan" ? "OpenKan" : !turn.agent || turn.agent === "default" ? "Claude Code" : turn.agent) : "OpenKan";
    const copy = turn.role !== "system"
      ? `<button type="button" class="chat-copy-button" data-chat-copy="${esc(turn.ts || "")}" aria-label="Copy ${esc(label)} message" title="Copy message">⧉</button>`
      : "";
    return `<div class="chat-bubble-meta ${turn.role === "assistant" ? "chat-bubble-meta-assistant" : ""}">${turn.role === "assistant" ? copy : ""}<span>${esc(label)} · ${formatTurnTime(turn.ts)}</span>${turn.role !== "assistant" ? copy : ""}</div>`;
  }
  function bubbleHTML(turn) {
    const role = turn.role || "assistant";
    const errorLine = turn.error
      ? `<div class="chat-bubble-error">${esc(turn.error)}</div>` : "";
    if (role === "user") {
      const status = turn.__status || (turn.status && turn.status !== "ok" ? turn.status : "sent");
      return `
        <div class="chat-bubble-row chat-bubble-row-user">
          <div class="chat-bubble chat-bubble-user" data-ts="${esc(turn.ts || "")}" data-status="${esc(status)}">
            ${bubbleMetaHTML(turn)}
            ${taskReferenceBannersHTML(turn)}
            ${turn.content ? `<div class="chat-bubble-body">${esc(turn.content)}</div>` : ""}
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
            ${bubbleMetaHTML(turn)}
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
          ${bubbleMetaHTML(turn)}
          <div class="chat-bubble-body chat-bubble-body-stream" data-bubble-body></div>
          ${errorLine}
        </div>
      </div>
    `;
  }

  function taskReferenceBannersHTML(turn) {
    const tasks = Array.isArray(turn.taskMentions) ? turn.taskMentions : [];
    if (!tasks.length) return "";
    return `<div class="chat-task-reference-banners" aria-label="Referenced tasks">${tasks.map((task) => {
      const id = typeof task?.id === "string" ? task.id : "task";
      const title = typeof task?.title === "string" ? task.title : "";
      return `<span class="chat-task-reference-banner" title="${esc(title || id)}"><span aria-hidden="true">↗</span> Task #${esc(id.replace(/^tsk-/, "").slice(0, 6))}</span>`;
    }).join("")}</div>`;
  }

  function toolInput(tool) {
    return tool && tool.input && typeof tool.input === "object" ? tool.input : {};
  }

  function toolFilePath(tool) {
    const input = toolInput(tool);
    for (const key of ["file_path", "filePath", "path", "target_path", "targetPath"]) {
      if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
    }
    return "";
  }

  function toolCommand(tool) {
    const command = toolInput(tool).command;
    return typeof command === "string" ? command.trim() : "";
  }

  function deletedPathsFromCommand(command) {
    if (!command) return [];
    const deleted = [];
    const matcher = /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|unlink)\s+((?:-[\w-]+\s+)*(?:"[^"]+"|'[^']+'|[^\s;&|]+)(?:\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+))*)/g;
    for (const match of command.matchAll(matcher)) {
      const tokens = match[1].match(/"[^"]+"|'[^']+'|[^\s]+/g) || [];
      for (const token of tokens) {
        if (!token.startsWith("-")) deleted.push(token.replace(/^(?:"|')|(?:"|')$/g, ""));
      }
    }
    return [...new Set(deleted)];
  }

  function activityInfo(tool) {
    const name = String(tool?.name || "");
    const file = toolFilePath(tool);
    const command = toolCommand(tool);
    const deleted = name === "Delete" || name === "Remove" ? (file ? [file] : []) : deletedPathsFromCommand(command);
    if (name === "Read") return { kind: "read", verb: "Read", label: `Read ${basename(file) || "file"}`, file, deleted: [] };
    if (name === "Write") return { kind: "created", verb: "Created", label: `Created ${basename(file) || "file"}`, file, deleted: [] };
    if (name === "Edit" || name === "MultiEdit") return { kind: "changed", verb: "Changed", label: `Changed ${basename(file) || "file"}`, file, deleted: [] };
    if (name === "Delete" || name === "Remove") return { kind: "deleted", verb: "Deleted", label: `Deleted ${basename(file) || "file"}`, file, deleted };
    if (name === "Bash") return { kind: "command", verb: "Ran", label: `Ran ${truncate(command.replace(/\s+/g, " "), 76) || "command"}`, command, deleted };
    if (name === "Grep" || name === "Glob") return { kind: "search", verb: "Searched", label: toolUseLabel(tool), file: "", deleted: [] };
    if (name === "Agent" || name === "Task") return { kind: "agent", verb: "Delegated", label: toolUseLabel(tool), file: "", deleted: [] };
    return { kind: "other", verb: "Used", label: toolUseLabel(tool), file: "", deleted: [] };
  }

  function activityIcon(kind) {
    const icons = {
      read: '<path d="M3.5 4.5A2.5 2.5 0 0 1 6 2h6.5v12H6a2.5 2.5 0 0 0-2.5 2.5v-12Z"/><path d="M12.5 2H14a2.5 2.5 0 0 1 2.5 2.5v12A2.5 2.5 0 0 0 14 14h-1.5"/>',
      created: '<path d="M4 2.5h6L14 6v9.5H4z"/><path d="M10 2.5V6h4M9 8.5v5M6.5 11h5"/>',
      changed: '<path d="m4 13.5 1.3-3.8L12.8 2.2a1.5 1.5 0 0 1 2.1 2.1l-7.5 7.5L4 13.5Z"/><path d="m11.7 3.3 2.1 2.1"/>',
      deleted: '<path d="M4.5 5.5h9M7 5.5v-2h4v2M6 7.5v6M9 7.5v6M12 7.5v6M5 5.5l.7 10h6.6l.7-10"/>',
      command: '<path d="m4 5 3 3-3 3M9 12h4"/>',
      search: '<circle cx="8" cy="8" r="4.5"/><path d="m11.5 11.5 3 3"/>',
      agent: '<path d="M5 13.5 3.5 15V5.5A2.5 2.5 0 0 1 6 3h6a2.5 2.5 0 0 1 2.5 2.5v5A2.5 2.5 0 0 1 12 13H7l-2 2Z"/><path d="M7 7.5h.01M10 7.5h.01M13 7.5h.01"/>',
      other: '<path d="M8 2.5v11M2.5 8h11"/>',
    };
    return `<svg class="chat-activity-row__icon" viewBox="0 0 18 18" aria-hidden="true">${icons[kind] || icons.other}</svg>`;
  }

  function activityDetailLines(tool, info) {
    const lines = [];
    if (tool?.source === "subagent") lines.push(`<li><span>Agent</span><code>Subagent</code></li>`);
    if (info.file) lines.push(`<li><span>File</span><code title="${esc(info.file)}">${esc(info.file)}</code></li>`);
    for (const deleted of info.deleted || []) lines.push(`<li><span>Deleted</span><code title="${esc(deleted)}">${esc(deleted)}</code></li>`);
    if (info.command) lines.push(`<li><span>Command</span><code>${esc(info.command)}</code></li>`);
    if (tool?.resultPreview) lines.push(`<li class="chat-activity-row__output"><span>${tool.isError ? "Error" : "Output"}</span><pre>${esc(tool.resultPreview)}</pre></li>`);
    if (!lines.length) lines.push(`<li><span>Activity</span><code>${esc(toolUseLabel(tool))}</code></li>`);
    return lines.join("");
  }

  function chipHTML(tool) {
    const info = activityInfo(tool);
    const status = tool.status || "started";
    const completed = status === "completed";
    return `<details class="chat-activity-row chat-activity-row--${esc(info.kind)}" data-chip-id="${esc(tool.id || "")}" data-chip-status="${esc(status)}">
      <summary>
        ${activityIcon(info.kind)}
        <span class="chat-activity-row__label">${tool.source === "subagent" ? `Subagent · ${esc(info.label)}` : esc(info.label)}</span>
        <span class="chat-activity-row__status">${completed ? "done" : status === "failed" ? "failed" : "working"}</span>
        <svg class="chat-activity-row__chevron" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="m4 5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </summary>
      <ul class="chat-activity-row__details">${activityDetailLines(tool, info)}</ul>
    </details>`;
  }

  function activityCounts(tools) {
    const counts = { read: 0, created: 0, changed: 0, deleted: 0, command: 0 };
    for (const tool of tools) {
      const info = activityInfo(tool);
      if (Object.hasOwn(counts, info.kind)) counts[info.kind] += 1;
      counts.deleted += (info.deleted || []).length;
    }
    return counts;
  }

  function plural(count, singular) { return `${count} ${singular}${count === 1 ? "" : "s"}`; }

  function activitySummaryHTML(turn) {
    if (turn.role !== "assistant" && turn.role !== "system") return "";
    const tools = Array.isArray(turn.toolUses) ? turn.toolUses : [];
    if (!turn.durationMs && !tools.length) return "";
    const seconds = Math.max(1, Math.round((turn.durationMs || 0) / 1000));
    const counts = activityCounts(tools);
    const countBits = [
      counts.read && plural(counts.read, "file read"),
      counts.created && plural(counts.created, "file created"),
      counts.changed && plural(counts.changed, "file changed"),
      counts.deleted && plural(counts.deleted, "file deleted"),
      counts.command && plural(counts.command, "command run"),
    ].filter(Boolean);
    const reasoning = typeof turn.reasoning === "string" ? turn.reasoning.trim() : "";
    const reasoningDetail = reasoning
      ? `<div class="chat-reasoning-output"><strong>Thought process</strong><pre>${esc(reasoning)}</pre></div>`
      : `<span class="chat-reasoning-unavailable">No provider-visible thought summary was emitted.</span>`;
    const completion = window.OpenKanChatMotion?.render?.({ phase: "complete", label: "Completed" }) || "";
    return `<details class="chat-activity-summary"><summary><span class="chat-activity-completion" data-chat-completion="${esc(turn.ts || "")}">${completion}</span><span class="chat-activity-summary__title">Thought for ${seconds}s</span>${countBits.length ? `<span class="chat-activity-summary__counts">${esc(countBits.join(" · "))}</span>` : ""}<svg class="chat-activity-summary__chevron" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="m4 5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></summary><div class="chat-activity-details">${reasoningDetail}</div></details>`;
  }

  function chipsHTML(turn) {
    const toolUses = Array.isArray(turn.toolUses) ? turn.toolUses : [];
    if (toolUses.length === 0) return "";
    return `<div class="chat-chips chat-activity-feed" data-chips-for="${esc(turn.ts || "")}">${toolUses.map(chipHTML).join("")}</div>`;
  }

  /* ----------------------------------------------------------------------
   * Transcript rendering
   * -------------------------------------------------------------------- */
  async function renderTranscript({ completionTs = "" } = {}) {
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
      if (role === "assistant" || role === "system") { parts.push(activitySummaryHTML(turn)); if (role === "assistant") parts.push(chipsHTML(turn)); }
      parts.push(bubbleHTML(turn));
    }
    const wasNearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    // Rendering replaces the transcript DOM. Stop any former terminal cue
    // first so an orphaned GSAP timeline cannot survive the replacement.
    node.querySelectorAll("[data-chat-status-motion]").forEach((motion) => window.OpenKanChatMotion?.stop?.(motion));
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
      // Put plain text on screen before the asynchronous markdown round-trip.
      // This guarantees a completed response is visible even if markdown
      // rendering is slow or unavailable.
      el.textContent = turn.content || "(No text returned)";
      const html = await renderMarkdown(turn.content || "");
      el.innerHTML = html || esc(turn.content || "(No text returned)");
    }
    if (!state.scrolledUp) node.scrollTop = node.scrollHeight;
    // A completed mark plays only for the newly-finished assistant turn.
    // Historical turns render in their settled state instead of re-running.
    if (completionTs && !state.completedMotionTs.has(completionTs)) {
      const completion = [...node.querySelectorAll("[data-chat-completion]")]
        .find((mark) => mark.dataset.chatCompletion === completionTs);
      if (completion) {
        state.completedMotionTs.add(completionTs);
        window.OpenKanChatMotion?.animate?.(completion);
      }
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
            const userAdded = appendTurnIfNew(userTurn);
            const assistantAdded = appendTurnIfNew(assistantTurn);
            state.inFlight = false;
            removeStreamingIndicator();
            updateAbortButton();
            // Both the project and session SSE streams may report this rollup.
            // Re-render only when it changed the canonical transcript.
            if (userAdded || assistantAdded) void renderTranscript({ completionTs: assistantAdded ? (assistantTurn?.ts || "") : "" });
            removeStreamingIndicator();
            stopSessionStream();
            composerFeedback("Response complete.");
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
        let bubble = transcript?.querySelector(".chat-bubble-row-assistant:last-child .chat-bubble-body");
        if (!bubble && transcript) {
          const row = document.createElement("div");
          row.className = "chat-bubble-row chat-bubble-row-assistant";
          row.innerHTML = `<div class="chat-bubble chat-bubble-assistant" data-ts="live" data-status="streaming"><div class="chat-bubble-meta"><span>Claude Code · responding</span></div><div class="chat-bubble-body chat-bubble-body-stream" data-bubble-body></div></div>`;
          transcript.appendChild(row);
          bubble = row.querySelector("[data-bubble-body]");
        }
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
      src.addEventListener("chat.status", (e) => {
        try { updateLiveStatus(JSON.parse(e.data)); } catch (_err) { /* ignore */ }
      });
      src.addEventListener("chat.activity", (e) => {
        try {
          const event = JSON.parse(e.data);
          state.liveActivity = [...(state.liveActivity || []), event].slice(-80);
          renderLiveActivity();
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
          const label = toolUseLabel({ name: data.name, input: data.input || {} });
          updateLiveStatus({
            phase: data.name === "WebSearch" ? "searching" : "tool",
            label,
          });
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
          // A tool result does not necessarily produce text immediately. Do
          // not leave "Searching the web" (or another finished operation)
          // rendered until Claude emits its next response token.
          syncLiveToolStatus();
        } catch (_err) { /* ignore */ }
      });
      src.addEventListener("chat.message-done", (_e) => {
        // Finalise streaming bubble — re-render markdown now that content
        // is complete, and reset live state.
        finalizeLiveBubble();
        removeStreamingIndicator();
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
    state.liveActivity = [];
    state.liveBubble = null;
    // A session can close after its final tool result but before a text
    // delta or message-done event reaches this EventSource. Terminal cleanup
    // must never retain the last tool label.
    removeStreamingIndicator();
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
    // While work is live, show only the current operation. The full audit is
    // rendered from the persisted assistant turn once the prompt settles.
    const current = [...list].reverse().find((tool) => tool.status === "started" || tool.status === "streaming");
    if (!current) { chipsNode.remove(); return; }
    chipsNode.innerHTML = chipHTML(current);
    maybeAutoScroll(transcript);
  }

  function currentLiveTool() {
    return [...(state.liveChips || [])].reverse().find((tool) => (
      tool.status === "started" || tool.status === "streaming"
    ));
  }

  function syncLiveToolStatus() {
    const activeTool = currentLiveTool();
    if (activeTool) {
      updateLiveStatus({
        phase: activeTool.name === "WebSearch" ? "searching" : "tool",
        label: toolUseLabel(activeTool),
      });
      return;
    }
    // Claude continues reasoning after a tool completes. This intentionally
    // replaces the completed operation rather than exposing noisy internals.
    updateLiveStatus({ phase: "thinking", label: "Thinking" });
  }

  function activityRaw(event) { return event?.raw && typeof event.raw === "object" ? event.raw : {}; }
  function activityTool(event) {
    const raw = activityRaw(event);
    const block = raw.content_block && typeof raw.content_block === "object" ? raw.content_block : {};
    const messageContent = Array.isArray(raw.message?.content) ? raw.message.content : [];
    const messageTool = messageContent.find((part) => part && typeof part === "object" && part.type === "tool_use") || {};
    return {
      id: block.id || messageTool.id || raw.tool_use_id || raw.toolUseId || "",
      name: block.name || messageTool.name || raw.tool_name || raw.mcp_tool_name || raw.name || "",
      input: block.input || messageTool.input || raw.tool_input || raw.toolInput || {},
      type: block.type || messageTool.type || "",
    };
  }
  function activityParentId(event) {
    const raw = activityRaw(event);
    return event?.parentToolUseId || raw.parent_tool_use_id || raw.parentToolUseId || raw.message?.parent_tool_use_id || raw.message?.parentToolUseId || "";
  }
  function activityPreview(event) {
    const raw = activityRaw(event);
    const delta = raw.delta && typeof raw.delta === "object" ? raw.delta : {};
    const block = raw.content_block && typeof raw.content_block === "object" ? raw.content_block : {};
    const content = Array.isArray(raw.message?.content) ? raw.message.content : [];
    const text = [
      delta.thinking, delta.text, block.thinking, block.text, block.content,
      ...content.filter((part) => part && typeof part === "object").map((part) => part.thinking || part.text),
      raw.last_assistant_message, raw.summary,
    ].find((value) => typeof value === "string" && value.trim());
    return typeof text === "string" ? truncate(text.replace(/\s+/g, " ").trim(), 180) : "";
  }
  function isForwardedTranscript(event) {
    const raw = activityRaw(event);
    // Full assistant/user snapshots carry the useful child transcript. Do
    // not render token-level deltas as rows; they would create a noisy wall
    // of blocks while streaming.
    return Boolean(activityParentId(event)) && ["assistant", "user"].includes(String(raw.type || "").toLowerCase());
  }
  function activityLabel(event) {
    const raw = activityRaw(event);
    const tool = activityTool(event);
    const hook = raw.hook_event_name || raw.hookEventName;
    if (hook === "SubagentStart") return `Started ${raw.agent_type || raw.agentType || "subagent"}`;
    if (hook === "SubagentStop") return `Completed ${raw.agent_type || raw.agentType || "subagent"}`;
    if (tool.name === "Agent" || tool.name === "Task") return `Delegating to ${tool.input?.subagent_type || tool.input?.subagentType || "subagent"}`;
    if (tool.name) return toolUseLabel({ name: tool.name, input: tool.input || {} });
    if (isForwardedTranscript(event)) return activityPreview(event) ? "Subagent update" : "Subagent working";
    if (raw.subtype === "api_retry") return `Retrying API request (${raw.attempt || 1}/${raw.max_retries || "?"})`;
    return [event?.type, event?.subtype].filter(Boolean).join(" · ") || "Agent activity";
  }
  function isImportantActivity(event) {
    const raw = activityRaw(event);
    const tool = activityTool(event);
    const type = String(event?.type || raw.type || "").toLowerCase();
    const subtype = String(event?.subtype || raw.subtype || "").toLowerCase();
    // Forwarded assistant snapshots are often emitted per token. They are
    // intentionally excluded from live UI; completed turns retain the real
    // tool/file audit instead of transient thought fragments.
    if (isForwardedTranscript(event)) return false;
    // Hook records and native tool boundaries convey meaningful lifecycle
    // changes; intermediate text/thinking deltas remain excluded.
    if (tool.type === "tool_use" || tool.type === "tool_result" || tool.name) return true;
    if (raw.hook_event_name || raw.hookEventName || raw.mcp_server_name || raw.mcp_tool_name) return true;
    if (subtype.includes("retry") || subtype.includes("hook") || subtype.includes("team") || subtype.includes("workflow") || subtype.includes("agent") || subtype.includes("mcp")) return true;
    return type === "system" || type === "error";
  }
  function nativeActivityGroups(events) {
    const groups = new Map();
    const roots = new Map();
    for (const event of events) {
      const tool = activityTool(event);
      if ((tool.name === "Agent" || tool.name === "Task") && tool.id) {
        roots.set(tool.id, `subagent:${tool.id}`);
        groups.set(`subagent:${tool.id}`, {
          id: `subagent:${tool.id}`,
          title: String(tool.input?.subagent_type || tool.input?.subagentType || "Subagent"),
          state: "running",
          parentId: activityParentId(event) && roots.get(activityParentId(event)) || null,
          events: [],
        });
      }
    }
    for (const event of events) {
      const raw = activityRaw(event);
      const tool = activityTool(event);
      const parent = activityParentId(event);
      const hook = raw.hook_event_name || raw.hookEventName;
      const key = (tool.name === "Agent" || tool.name === "Task") && tool.id && roots.get(tool.id)
        ? roots.get(tool.id)
        : parent
        ? (roots.get(parent) || `subagent:${parent}`)
        : hook === "SubagentStart" || hook === "SubagentStop"
          ? `hook:${raw.agent_id || raw.agentId || raw.agent_type || raw.agentType || "subagent"}`
          : "coordinator";
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          title: key === "coordinator" ? "Coordinator" : String(raw.agent_type || raw.agentType || "Subagent"),
          state: hook === "SubagentStop" ? "completed" : "running",
          parentId: null,
          events: [],
        });
      }
      const group = groups.get(key);
      if (hook === "SubagentStop") group.state = "completed";
      if (hook === "SubagentStart") group.state = "running";
      if (tool.name === "Agent" || tool.name === "Task") group.state = "running";
      group.events.push(event);
    }
    return [...groups.values()].filter((group) => group.events.length > 0);
  }
  function nativeActivityTreeHTML(groups) {
    const byParent = new Map();
    for (const group of groups) {
      const parent = group.parentId && groups.some((candidate) => candidate.id === group.parentId) ? group.parentId : "root";
      byParent.set(parent, [...(byParent.get(parent) || []), group]);
    }
    const renderGroup = (group, depth) => `<details class="chat-native-agent" data-native-depth="${depth}" open><summary><span class="chat-native-agent-state chat-native-agent-state--${esc(group.state)}"></span><strong>${esc(group.title)}</strong><span>${group.state === "completed" ? "completed" : "working"} · ${group.events.length}</span></summary><div>${group.events.slice(-3).map(nativeActivityEventHTML).join("")}${(byParent.get(group.id) || []).map((child) => renderGroup(child, depth + 1)).join("")}</div></details>`;
    return (byParent.get("root") || []).map((group) => renderGroup(group, 0)).join("");
  }
  function nativeActivityEventHTML(event) {
    const tool = activityTool(event);
    if (tool.name) return chipHTML({ ...tool, status: "completed" });
    const preview = activityPreview(event);
    const raw = activityRaw(event);
    const hook = raw.hook_event_name || raw.hookEventName;
    const label = activityLabel(event);
    return `<details class="chat-activity-row chat-activity-row--agent chat-native-event"><summary>${activityIcon("agent")}<span class="chat-activity-row__label">${esc(label)}</span><span class="chat-activity-row__status">${hook === "SubagentStop" ? "done" : "working"}</span><svg class="chat-activity-row__chevron" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="m4 5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>${preview ? `<div class="chat-native-event__detail">${esc(preview)}</div>` : ""}</details>`;
  }
  function renderLiveActivity() {
    const transcript = state.root?.querySelector("#chat-sidebar-transcript");
    if (!transcript) return;
    let node = transcript.querySelector(":scope > .chat-live-activity");
    if (!node) { node = document.createElement("details"); node.className = "chat-live-activity"; node.open = true; transcript.appendChild(node); }
    const events = (state.liveActivity || []).filter(isImportantActivity);
    if (events.length === 0) { node?.remove(); return; }
    const latest = events.at(-1);
    const groups = nativeActivityGroups(events);
    const subagentCount = groups.filter((group) => group.id !== "coordinator").length;
    const motion = window.OpenKanChatMotion?.render?.({
      phase: latest?.type,
      label: activityLabel(latest),
      name: activityTool(latest).name,
    }) || "";
    node.innerHTML = `<summary><span class="chat-live-activity-motion">${motion}</span><span>Native activity${subagentCount ? ` · ${subagentCount} subagent${subagentCount === 1 ? "" : "s"}` : ""}</span><span>${events.length}</span></summary><div class="chat-live-activity-list chat-native-activity-tree">${nativeActivityTreeHTML(groups)}</div>`;
    window.OpenKanChatMotion?.animateWithin?.(node);
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
    transcript?.querySelector(":scope > .chat-live-activity")?.remove();
  }

  /**
   * Streaming "Working" indicator — a single muted italic line appended
   * to the transcript while the assistant turn is in flight. Hidden when
   * the turn completes (via finalizeLiveBubble) or when the transcript is
   * re-rendered.
   */
  function updateLiveStatus(status = {}) {
    const transcript = state.root?.querySelector("#chat-sidebar-transcript");
    if (!transcript) return;
    let node = transcript.querySelector(":scope > .chat-bubble-streaming-indicator");
    if (!node) {
      node = document.createElement("div");
      node.className = "chat-bubble-streaming-indicator";
      node.setAttribute("aria-live", "polite");
      transcript.appendChild(node);
    }
    const label = status.label || (status.phase === "tool" ? "Using a tool" : "Thinking");
    const motion = window.OpenKanChatMotion?.render?.(status) || "";
    if (node.dataset.statusLabel === label) return;
    node.querySelectorAll("[data-chat-status-motion]").forEach(mark => window.OpenKanChatMotion?.stop?.(mark));
    node.dataset.statusLabel = label;
    node.innerHTML = `${motion}<span>${esc(label)}</span>`;
    window.OpenKanChatMotion?.animateWithin?.(node);
    maybeAutoScroll(transcript);
  }
  function ensureStreamingIndicator() { updateLiveStatus({ phase: "thinking", label: "Writing response" }); }
  function removeStreamingIndicator() {
    const transcript = state.root?.querySelector("#chat-sidebar-transcript");
    const node = transcript?.querySelector(":scope > .chat-bubble-streaming-indicator");
    if (node) {
      node.querySelectorAll?.("[data-chat-status-motion]").forEach((motion) => window.OpenKanChatMotion?.stop?.(motion));
      node.remove();
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
    if (dup) return false;
    state.transcript.push(turn);
    syncHeroState();
    return true;
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
   * Task references from board drag-and-drop
   * -------------------------------------------------------------------- */
  function normaliseDroppedTask(value) {
    const candidate = value?.task || value;
    if (!candidate || typeof candidate.id !== "string" || !candidate.id.trim()) return null;
    return {
      id: candidate.id.trim(),
      title: typeof candidate.title === "string" ? candidate.title.trim() : "Untitled task",
      column: typeof candidate.column === "string" ? candidate.column : "",
    };
  }

  function readDraggedTask(event) {
    const transfer = event?.dataTransfer;
    const types = Array.from(transfer?.types || []);
    for (const type of ["application/x-openkan-task", "text/x-openkan-task", "application/json"]) {
      if (types.length && !types.includes(type)) continue;
      try {
        const parsed = JSON.parse(transfer?.getData(type) || "");
        const task = normaliseDroppedTask(parsed);
        if (task) return task;
      } catch (_err) { /* try the next portable representation */ }
    }
    return normaliseDroppedTask(window.OpenKanActiveTaskDrag);
  }

  function taskMentionToken(taskId) { return `@task(${taskId})`; }

  function renderTaskMentionTray() {
    const tray = state.root?.querySelector("#chat-sidebar-mention-tray");
    const input = state.root?.querySelector("#chat-sidebar-input");
    if (!tray || !input) return;
    const active = [...state.taskMentions.values()];
    tray.hidden = active.length === 0;
    tray.replaceChildren();
    for (const task of active) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-sidebar__mention-chip";
      chip.dataset.chatRemoveMention = task.id;
      chip.title = `Remove task reference: ${task.title}`;
      chip.setAttribute("aria-label", `Remove task reference: ${task.title}`);
      const prefix = document.createElement("span");
      prefix.className = "chat-sidebar__mention-chip-prefix";
      prefix.textContent = "Task";
      const title = document.createElement("span");
      title.className = "chat-sidebar__mention-chip-title";
      title.textContent = `#${task.id.replace(/^tsk-/, "").slice(0, 6)}`;
      const remove = document.createElement("span");
      remove.className = "chat-sidebar__mention-chip-remove";
      remove.setAttribute("aria-hidden", "true");
      remove.textContent = "×";
      chip.append(prefix, title, remove);
      tray.append(chip);
    }
  }

  function insertTaskMention(task) {
    const input = state.root?.querySelector("#chat-sidebar-input");
    if (!input || !task?.id) return;
    // References belong to the compact tray. Keeping the composer text
    // untouched means a drop never injects a long, surprising prompt line.
    state.taskMentions.set(task.id, task);
    renderTaskMentionTray();
    saveDraft(); updateAbortButton();
    input.focus();
    state.root?.classList.add("chat-sidebar--task-dropped");
    setTimeout(() => state.root?.classList.remove("chat-sidebar--task-dropped"), 520);
  }

  function removeTaskMention(taskId) {
    const input = state.root?.querySelector("#chat-sidebar-input");
    if (!input || !taskId) return;
    state.taskMentions.delete(taskId);
    renderTaskMentionTray();
    saveDraft(); updateAbortButton();
    input.focus();
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

    // A board card is copied into chat as a reference. We deliberately
    // support custom, JSON, and in-page payloads: browser engines vary in
    // which drag MIME types are readable before the final drop event.
    state.root.addEventListener("dragenter", (e) => {
      if (readDraggedTask(e)) state.root.classList.add("chat-sidebar--task-drop");
    });
    state.root.addEventListener("dragleave", (e) => {
      if (!state.root.contains(e.relatedTarget)) state.root.classList.remove("chat-sidebar--task-drop");
    });
    state.root.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      if (readDraggedTask(e)) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        state.root.classList.add("chat-sidebar--task-drop");
      }
    });
    state.root.addEventListener("drop", (e) => {
      const task = readDraggedTask(e);
      if (!task) return;
      e.preventDefault();
      e.stopPropagation();
      state.root.classList.remove("chat-sidebar--task-drop");
      insertTaskMention(task);
    });
    state.root.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      composerFeedback("File attachments are not supported here. Paste text into your message, or reference a task.");
    });

  }

  /** Global click-away: close any open popover when the user clicks
   *  outside the sidebar's interactive elements. Registered on mount. */
  function bindGlobalDismiss() {
    state.dismissController?.abort();
    state.dismissController = new AbortController();
    const options = { signal: state.dismissController.signal };
    document.addEventListener("pointerdown", (e) => {
      if (!state.root || !state.popoverId) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const popover = state.root.querySelector(`#${CSS.escape(state.popoverId)}`);
      const trigger = state.root.querySelector("[data-popover-open='1']");
      if (popover?.contains(target) || trigger?.contains(target)) return;
      closePopover();
    }, options);
    document.addEventListener("keydown", (e) => {
      if (!state.popoverId) return;
      if (e.key === "Escape") {
        e.preventDefault();
        const trigger = state.root?.querySelector("[data-popover-open=\'1\']");
        closePopover(); trigger?.focus();
      }
    }, options);
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
    const mention = t.closest("[data-chat-remove-mention]");
    if (mention) { removeTaskMention(mention.getAttribute("data-chat-remove-mention")); return; }
    const prompt = t.closest("[data-chat-prompt]");
    if (prompt) {
      const input = state.root.querySelector("#chat-sidebar-input");
      if (input) {
        input.value = prompt.getAttribute("data-chat-prompt") || "";
        input.focus();
        autoResize(); saveDraft(); updateAbortButton();
      }
      return;
    }
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
    else if (action === "open-agent-picker") { openAgentPicker(); return; }
    else if (action === "open-model-picker") { void openModelPicker(); return; }
    else if (action === "open-effort-picker") { void openEffortPicker(); return; }
    else if (action === "reference-task") { void openTaskReferencePicker(); return; }
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
      saveJSON(projectStorageKey(STORAGE_KEYS.selectors), state.selectors);
    }
  }

  function onKeyDown(e) {
    if (!state.root) return;
    if (e.target?.matches?.("[data-chat-resize]")) {
      const step = e.shiftKey ? 48 : 16;
      if (e.key === "ArrowLeft") { e.preventDefault(); setSidebarWidth(state.width + step); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); setSidebarWidth(state.width - step); return; }
      if (e.key === "Home") { e.preventDefault(); setSidebarWidth(320); return; }
      if (e.key === "End") { e.preventDefault(); setSidebarWidth(640); return; }
    }
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

  function draftKey() { return `${projectStorageKey(STORAGE_KEYS.draft)}:${state.currentSessionId || "new"}`; }
  function saveDraft() {
    const input = state.root?.querySelector("#chat-sidebar-input");
    if (input) saveJSON(draftKey(), { text: input.value, tasks: [...state.taskMentions.values()] });
  }
  function restoreDraft() {
    const draft = loadJSON(draftKey());
    const input = state.root?.querySelector("#chat-sidebar-input");
    if (input) input.value = typeof draft?.text === "string" ? draft.text : "";
    state.taskMentions = new Map((Array.isArray(draft?.tasks) ? draft.tasks : []).map(normaliseDroppedTask).filter(Boolean).map(task => [task.id, task]));
    renderTaskMentionTray(); autoResize(); updateAbortButton();
  }
  function composerFeedback(message = "", error = false) {
    const node = state.root?.querySelector("#chat-sidebar-feedback");
    if (!node) return;
    node.textContent = message; node.hidden = !message;
    node.classList.toggle("is-error", error);
  }
  function onInput(e) {
    if (!state.root || e.target?.id !== "chat-sidebar-input") return;
    autoResize(); saveDraft(); updateAbortButton();
  }

  function autoResize() {
    if (!state.root) return;
    const ta = state.root.querySelector("#chat-sidebar-input");
    if (!ta) return;
    // Reset to a single line, then expand up to ~6 lines. Past that we
    // let the textarea scroll internally.
    ta.style.height = "auto";
    const maxH = Math.min(200, window.innerHeight * .25);
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
    if (k !== "l" || !e.shiftKey) return;
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
    try { await navigator.clipboard.writeText(turn.content || ""); composerFeedback("Message copied."); } catch (_err) { composerFeedback("Could not copy. Select the message text and copy it manually.", true); }
  }

  async function retryLastTurn() {
    // Re-submit the last user turn (if any) using the current selectors.
    const lastUser = [...state.transcript].reverse().find((t) => t.role === "user");
    if (!lastUser) return;
    if (!state.root) return;
    const input = state.root.querySelector("#chat-sidebar-input");
    if (state.inFlight) return;
    if (input) input.value = lastUser.content || "";
    state.taskMentions = new Map((lastUser.taskMentions || []).map(task => [task.id, task]));
    void onSend();
  }

  async function onSend() {
    if (!state.root) return;
    const input = state.root.querySelector("#chat-sidebar-input");
    if (!input) return;
    const message = (input.value || "").trim();
    const taskMentions = [...state.taskMentions.values()];
    const selectors = { ...state.selectors };
    if ((!message && taskMentions.length === 0) || state.inFlight) return;

    const epoch = ++state.requestEpoch;
    let accepted = false;
    composerFeedback();
    state.inFlight = true;
    updateAbortButton();
    input.value = "";
    state.taskMentions.clear();
    saveDraft();
    renderTaskMentionTray();
    autoResize();

    // Optimistic local-only user turn so the UI shows it immediately.
    // The HTTP response (or SSE) will deliver the canonical turn; the dedup
    // helper in appendTurnIfNew keeps the transcript from double-counting.
    const localTs = new Date().toISOString();
    state.transcript.push({
      role: "user",
      content: message,
      taskMentions,
      ts: localTs,
      agent: selectors.agent,
      model: selectors.model,
      effort: selectors.effort,
      permissionMode: selectors.permissionMode,
      __status: "sending",
    });
    state.liveChips = [];
    state.scrolledUp = false;
    await renderTranscript();
    updateLiveStatus({ phase: "thinking", label: "Starting Claude Code" });

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
          taskMentions,
          agent: selectors.agent,
      model: selectors.model,
          effort: selectors.effort,
          permissionMode: selectors.permissionMode,
        },
        { signal: state.abortController.signal },
      );
      if (epoch !== state.requestEpoch) return;
      if (result?.sessionId) {
        state.currentSessionId = result.sessionId;
        saveString(projectStorageKey(STORAGE_KEYS.lastSession), state.currentSessionId);
        // A newly created session could not subscribe before its ID existed.
        // Subscribe as soon as the server acknowledges it, while the turn runs.
        startSessionStream();
        saveDraft();
      }
      if (result?.accepted) {
        accepted = true;
        state.transcript = state.transcript.filter((t) => t.ts !== localTs);
        appendTurnIfNew(result.userTurn);
        await renderTranscript();
        updateLiveStatus({ phase: "thinking", label: "Claude is thinking" });
        void pollForCompletion(state.currentSessionId);
      } else {
        state.transcript = state.transcript.filter((t) => t.ts !== localTs);
        appendTurnIfNew(result?.userTurn);
        appendTurnIfNew(result?.assistantTurn);
        await renderTranscript();
        removeStreamingIndicator();
      }
      bindChipChips();
      await refreshSessions();
    } catch (err) {
      if (epoch !== state.requestEpoch) return;
      state.transcript = state.transcript.filter(turn => turn.ts !== localTs);
      input.value = input.value ? `${message}\n\n${input.value}` : message;
      for (const task of taskMentions) state.taskMentions.set(task.id, task);
      saveDraft(); renderTaskMentionTray(); autoResize();
      removeStreamingIndicator();
      composerFeedback(`Message not sent. ${err?.message || "Check your connection"}. Your draft is preserved.`, true);
      await renderTranscript();
    } finally {
      if (epoch === state.requestEpoch) {
        if (!accepted) state.inFlight = false;
        state.abortController = null;
        updateAbortButton();
        input.focus();
      }
    }
  }

  async function pollForCompletion(sessionId) {
    const epoch = state.requestEpoch;
    for (let attempt = 0; attempt < 360 && sessionId === state.currentSessionId && epoch === state.requestEpoch && state.inFlight; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, attempt < 24 ? 750 : 5000));
      if (epoch !== state.requestEpoch || !state.inFlight) return;
      const data = await fetchSession(sessionId);
      if (epoch !== state.requestEpoch || sessionId !== state.currentSessionId) return;
      const last = data?.turns?.at?.(-1);
      if (last?.role === "assistant" || last?.role === "system") {
        state.transcript = data.turns;
        state.inFlight = false;
        updateAbortButton(); removeStreamingIndicator();
        await renderTranscript({ completionTs: last.ts || "" });
        bindChipChips(); stopSessionStream();
        return;
      }
    }
  }

  async function onAbort() {
    if (!state.currentSessionId || !state.inFlight) return;
    composerFeedback("Stopping the agent…");
    try {
      await api()("POST", `/api/chat/sessions/${encodeURIComponent(state.currentSessionId)}/abort`);
      composerFeedback("Stop requested. Waiting for the agent to finish.");
    } catch (error) { composerFeedback(`Could not stop: ${error.message}. Try Stop again.`, true); }
  }

  async function onNewSession() {
    if (state.inFlight) return;
    saveDraft(); ++state.requestEpoch;
    state.currentSessionId = "";
    saveString(projectStorageKey(STORAGE_KEYS.lastSession), "");
    state.transcript = [];
    restoreDraft(); composerFeedback();
    populateSelectors();
    stopSessionStream();
    await renderTranscript();
  }

  async function onArchive() {
    if (!state.currentSessionId || state.inFlight) return;
    saveDraft();
    await deleteSession(state.currentSessionId);
    state.currentSessionId = "";
    state.transcript = [];
    saveString(projectStorageKey(STORAGE_KEYS.lastSession), "");
    stopSessionStream();
    await refreshSessions();
    populateSelectors();
    await renderTranscript();
  }

  async function onPickSession(value) {
    if (state.inFlight) return;
    saveDraft(); ++state.requestEpoch;
    if (value === "__new__") return onNewSession();
    state.currentSessionId = value;
    saveString(projectStorageKey(STORAGE_KEYS.lastSession), value);
    restoreDraft(); composerFeedback();
    const epoch = state.requestEpoch;
    state.transcript = [];
    await renderTranscript();
    const data = await fetchSession(value);
    if (epoch !== state.requestEpoch) return;
    if (!data) composerFeedback("Could not load this chat. Choose it again to retry.", true);
    if (data && Array.isArray(data.turns)) {
      state.transcript = data.turns;
      state.inFlight = data.running === true;
      // Restore selectors from the most recent assistant turn when
      // available so the composer matches the saved session state.
      const lastAssistant = [...data.turns].reverse().find((t) => t.role === "assistant");
      if (lastAssistant) {
        if (lastAssistant.agent) state.selectors.agent = lastAssistant.agent;
        if (lastAssistant.model) state.selectors.model = lastAssistant.model;
        if (lastAssistant.effort) state.selectors.effort = lastAssistant.effort;
        if (lastAssistant.permissionMode) state.selectors.permissionMode = lastAssistant.permissionMode;
        saveJSON(projectStorageKey(STORAGE_KEYS.selectors), state.selectors);
      }
      populateSelectors();
      await renderTranscript();
      bindChipChips();
    }
    startSessionStream(); updateAbortButton();
    if (state.inFlight) { updateLiveStatus({ label: "Agent is working" }); void pollForCompletion(value); }
  }

  function updateAbortButton() {
    if (!state.root) return;
    const send = state.root.querySelector("#chat-sidebar-send");
    const abort = state.root.querySelector("#chat-sidebar-abort");
    const input = state.root.querySelector("#chat-sidebar-input");
    if (send) send.disabled = state.inFlight || (!input?.value.trim() && state.taskMentions.size === 0);
    if (abort) abort.disabled = !state.currentSessionId;
    for (const button of state.root.querySelectorAll('[data-chat-action="new"], [data-chat-action="open-session-menu"]')) {
      button.disabled = state.inFlight;
      button.title = state.inFlight ? "Stop the current response before switching chats" : "";
    }
    if (input) input.placeholder = state.inFlight ? "Draft your next message…" : "Ask about this project…";
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

  /** Anchor an already-built popover within the sidebar's coordinate space. */
  function anchorPopover(popover, trigger) {
    const sidebarRect = state.root?.getBoundingClientRect();
    if (!popover || !trigger || !sidebarRect) return;
    popover.hidden = false;
    const triggerRect = trigger.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const inset = 8;
    let left = triggerRect.left - sidebarRect.left;
    let top = triggerRect.bottom - sidebarRect.top + 6;
    left = Math.max(inset, Math.min(left, sidebarRect.width - popRect.width - inset));
    if (top + popRect.height > sidebarRect.height - inset) {
      top = Math.max(inset, triggerRect.top - sidebarRect.top - popRect.height - 6);
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("data-popover-open", "1");
  }

  /* ----------------------------------------------------------------------
   * Separate model and effort pickers. Compact controls are faster to scan
   * and avoid mixing a model choice with independent reasoning settings.
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

  function openAgentPicker() {
    const trigger = state.root?.querySelector(".chat-sidebar__composer-agent");
    const popover = ensurePopover("chat-sidebar-agent-popover");
    if (!trigger || !popover) return;
    if (state.popoverId === popover.id) { closePopover(); return; }
    closePopover();
    const agents = state.pickerOptions?.agents || [
      { id: "openkan", label: "OpenKan", description: "Planning, structure, and project management" },
      { id: "default", label: "Claude Code", description: "General-purpose assistant" },
    ];
    popover.innerHTML = `<section class="chat-sidebar__popover-section"><h3 class="chat-sidebar__popover-heading">Agent</h3><p class="chat-sidebar__popover-note">Choose who handles your next message. Model and effort are separate settings.</p><ul class="chat-sidebar__popover-list">${agents.map(agent => `<li><label class="${agent.id === state.selectors.agent ? "is-active" : ""}"><input type="radio" name="chat-picker-agent" value="${esc(agent.id)}" ${agent.id === state.selectors.agent ? "checked" : ""} /><span class="chat-agent-option"><strong>${esc(agent.label)}</strong><small>${esc(agent.description)}</small></span></label></li>`).join("")}</ul></section>`;
    state.popoverId = popover.id; anchorPopover(popover, trigger);
    popover.addEventListener("change", onPickerChange);
    popover.querySelector("input:checked, input")?.focus();
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
    const opts = state.pickerOptions;
    const models = [...new Map([...(opts?.models?.length ? opts.models : state.models.map(id => ({ id, label: id }))), ...(state.selectors.model !== "default" ? [{ id: state.selectors.model, label: state.selectors.model }] : [])].filter(model => model.id !== "default").map(model => [model.id, model])).values()];
    const modelId = state.selectors.model || "default";

    popover.innerHTML = `
      <section class="chat-sidebar__popover-section" data-section="model">
        <h3 class="chat-sidebar__popover-heading">Model</h3>
        <ul class="chat-sidebar__popover-list">
          ${modelRadio("default", "Default", modelId === "default")}
          ${models.map((m) => modelRadio(m.id, m.label || m.id, m.id === modelId)).join("")}
        </ul>
      </section>
    `;
    state.popoverId = popover.id;
    // Render before measuring so getBoundingClientRect is accurate.
    anchorPopover(popover, trigger);
    popover.addEventListener("change", onPickerChange);
    popover.querySelector("input:checked, input, button")?.focus();
  }

  async function openEffortPicker() {
    if (!state.root) return;
    const trigger = state.root.querySelector(".chat-sidebar__composer-effort");
    const popover = ensurePopover("chat-sidebar-effort-popover");
    if (!trigger || !popover) return;
    if (state.popoverId === popover.id) { closePopover(); return; }
    closePopover();
    const opts = state.pickerOptions;
    const effort = state.selectors.effort || "high";
    popover.innerHTML = `<section class="chat-sidebar__popover-section"><h3 class="chat-sidebar__popover-heading">Reasoning effort</h3><p class="chat-sidebar__popover-note">Higher effort gives the agent more time to reason before responding.</p><ul class="chat-sidebar__popover-list">${(opts?.efforts || EFFORT_OPTIONS).map((e) => effortRadio(e, e, e === effort)).join("")}</ul></section>`;
    state.popoverId = popover.id;
    anchorPopover(popover, trigger);
    popover.addEventListener("change", onPickerChange);
    popover.querySelector("input:checked, input, button")?.focus();
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
    if (name === "chat-picker-agent") {
      state.selectors = { ...state.selectors, agent: value };
    } else if (name === "chat-picker-model") {
      state.selectors = { ...state.selectors, model: value };
    } else if (name === "chat-picker-effort") {
      state.selectors = { ...state.selectors, effort: value };
    } else if (name === "chat-picker-perm") {
      state.selectors = { ...state.selectors, permissionMode: value };
    } else {
      return;
    }
    saveJSON(projectStorageKey(STORAGE_KEYS.selectors), state.selectors);
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
      <button type="button" data-chat-action="new" data-attach="1">New chat</button>
      <button type="button" data-chat-action="reference-task" data-attach="1">Reference a task…</button>
      <button type="button" data-chat-action="add-to-planning" data-attach="1">Create task from draft…</button>
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
    const message = state.root?.querySelector("#chat-sidebar-input")?.value.trim();
    closePopover();
    if (!message) { composerFeedback("Write a task description in the message box first."); state.root?.querySelector("#chat-sidebar-input")?.focus(); return; }
    window.OpenKanCreateTask?.openFromChat?.(message);
  }

  async function openTaskReferencePicker() {
    const popover = ensurePopover("chat-sidebar-tasks-popover");
    const trigger = state.root?.querySelector(".chat-sidebar__composer-attach");
    if (!popover || !trigger) return;
    closePopover(); state.popoverId = popover.id;
    popover.innerHTML = '<p class="chat-sidebar__popover-note">Loading tasks…</p>';
    anchorPopover(popover, trigger);
    try {
      const board = await api()("GET", "/api/board");
      if (state.popoverId !== popover.id) return;
      const tasks = (board.tasks || []).filter(task => !task.archived);
      popover.innerHTML = '<label class="chat-task-search">Reference a task<input type="search" placeholder="Search tasks…" aria-label="Search tasks to reference" /></label><div data-task-results></div>';
      const results = popover.querySelector("[data-task-results]");
      const render = (query = "") => {
        results.replaceChildren();
        const matches = tasks.filter(task => `${task.title} ${task.id}`.toLowerCase().includes(query.toLowerCase()));
        if (!matches.length) { results.textContent = "No matching tasks."; return; }
        for (const task of matches) {
          const button = document.createElement("button");
          button.type = "button"; button.className = "chat-task-option";
          button.textContent = task.title; button.title = task.id;
          button.addEventListener("click", () => { insertTaskMention(task); closePopover(); });
          results.append(button);
        }
      };
      render(); anchorPopover(popover, trigger);
      const search = popover.querySelector("input");
      search.addEventListener("input", () => render(search.value)); search.focus();
    } catch (error) {
      if (state.popoverId === popover.id) popover.textContent = `Could not load tasks: ${error.message}. Close and try again.`;
    }
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
    const items = [`<button type="button" data-chat-action="new" data-attach="1">New chat</button>`]
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

  function sidebarWidthFor(value) {
    const available = Math.max(320, window.innerWidth - 360);
    return Math.round(Math.max(320, Math.min(value, Math.min(640, available))));
  }

  function setSidebarWidth(value, persist = true) {
    state.width = sidebarWidthFor(value);
    document.documentElement.style.setProperty("--chat-sidebar-width", `${state.width}px`);
    const handle = state.root?.querySelector("[data-chat-resize]");
    if (handle) handle.setAttribute("aria-valuenow", String(state.width));
    if (persist) saveString(STORAGE_KEYS.width, String(state.width));
  }

  function beginResize(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    state.resizing = true;
    document.body.classList.add("chat-sidebar-resizing");
    try { handle.setPointerCapture?.(event.pointerId); } catch (_err) { /* ignore */ }
    const resize = (move) => setSidebarWidth(move.clientX);
    const finish = () => {
      state.resizing = false;
      document.body.classList.remove("chat-sidebar-resizing");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  }

  /* ----------------------------------------------------------------------
   * Open / close + mount
   * -------------------------------------------------------------------- */
  function open() {
    if (!state.root) return;
    state.root.hidden = false;
    state.open = true;
    document.body.classList.add("chat-sidebar-open");
    saveString(STORAGE_KEYS.open, "1");
    autoResize();
  }
  function close() {
    if (!state.root) return;
    state.root.hidden = true;
    state.open = false;
    document.body.classList.remove("chat-sidebar-open");
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
    state.projectScope = await resolveProjectScope();
    // Chat mode owns the main canvas, so it must not inherit a previously
    // closed task-mode rail. `attachWorkspaceMode()` runs before mount(),
    // therefore this is the authoritative point to reconcile the state.
    state.open = document.body.classList.contains("workspace-mode-chat")
      || loadString(STORAGE_KEYS.open) === "1";
    state.selectors = { ...DEFAULT_SELECTORS, ...(loadJSON(projectStorageKey(STORAGE_KEYS.selectors)) || {}) };
    const permissionAliases = { "bypass-permissions": "bypassPermissions", "accept-edits": "acceptEdits", default: "bypassPermissions" };
    state.selectors.permissionMode = permissionAliases[state.selectors.permissionMode] || state.selectors.permissionMode || "bypassPermissions";
    state.currentSessionId = loadString(projectStorageKey(STORAGE_KEYS.lastSession));
    [state.models, state.pickerOptions] = await Promise.all([fetchModels(), fetchPickerOptions()]);
    populateSelectors();
    bindEvents();
    bindGlobalDismiss();
    const savedWidth = Number.parseInt(loadString(STORAGE_KEYS.width), 10);
    setSidebarWidth(Number.isFinite(savedWidth) ? savedWidth : state.width, false);
    const resizeHandle = state.root.querySelector("[data-chat-resize]");
    resizeHandle?.addEventListener("pointerdown", beginResize);
    if (state.open) open();
    autoResize();
    startLive();
    await refreshSessions();
    if (state.currentSessionId) {
      const data = await fetchSession(state.currentSessionId);
      if (data && Array.isArray(data.turns)) {
        state.transcript = data.turns;
        state.inFlight = data.running === true;
      } else {
        state.currentSessionId = "";
        saveString(projectStorageKey(STORAGE_KEYS.lastSession), "");
      }
    }
    await renderTranscript();
    bindChipChips();
    syncHeroState();
    restoreDraft();
    startSessionStream();
    if (state.inFlight) { updateLiveStatus({ label: "Agent is working" }); void pollForCompletion(state.currentSessionId); }
  }

  function unmount() {
    if (!state.mounted) return;
    saveDraft(); ++state.requestEpoch; state.inFlight = false;
    state.dismissController?.abort();
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
    document.body.classList.remove("chat-sidebar-open", "chat-sidebar-resizing");
    state.mounted = false;
    state.open = false;
    state.transcript = [];
    state.taskMentions.clear();
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

  async function mentionTask(task) {
    if (!state.mounted) await mount(document.body);
    open(); insertTaskMention(normaliseDroppedTask(task));
    composerFeedback("Task referenced. Add a question or send it to discuss this task.");
  }
  window.OpenKanChatSidebar = { mount, unmount, toggle, open, close, isOpen, mentionTask };
})();
