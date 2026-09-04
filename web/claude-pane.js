// OpenKan — native Claude control plane (Phase 4).
// Three sub-views: Subagents, Teams, Workflows. Sticky live activity footer
// streams events from /api/claude/events (SSE primary) with a 5s polling
// fallback via /api/claude/activity?since=<iso>. Reconnect backoff:
// 1s → 2s → 5s (capped).
//
// Public API: window.OpenKanClaude = { mount(root), unmount() }.
(() => {
  "use strict";

  /* ----------------------------------------------------------------------
   * Constants
   * -------------------------------------------------------------------- */
  const MAX_ACTIVITY = 200;       // virtual-list cap for activity footer
  const POLL_INTERVAL_MS = 5000;  // polling cadence on SSE failure
  const RECONNECT_STEPS_MS = [1000, 2000, 5000];
  const TSK_REGEX = /tsk-[A-Za-z0-9_-]+/g;

  /* ----------------------------------------------------------------------
   * Small helpers
   * -------------------------------------------------------------------- */
  const esc = (v) => String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

  const escAttr = (v) => esc(v);

  const clampActivity = (items) => (
    items.length <= MAX_ACTIVITY ? items : items.slice(items.length - MAX_ACTIVITY)
  );

  // Relative time formatter. Falls back to "—" for missing/invalid input.
  function relativeTime(iso) {
    if (!iso) return "—";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "—";
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
    const wk = Math.floor(day / 7);
    if (wk < 5) return `${wk}w ago`;
    return new Date(iso).toLocaleDateString();
  }

  // Status mapping. Reuses --status-red for errored; coral only on active.
  function statusKind(record) {
    if (!record) return "idle";
    if (record.errored || record.state === "errored" || record.state === "failed") return "errored";
    if (record.active || record.state === "active" || record.state === "running") return "active";
    const lastSeen = record.lastSeen || record.ts || record.updatedAt;
    if (lastSeen) {
      const since = Date.now() - new Date(lastSeen).getTime();
      if (!Number.isNaN(since) && since >= 0 && since < 60_000) return "recent";
    }
    return "idle";
  }

  // Transcript link: tolerate both {transcriptUrl} and {transcriptPath} shapes.
  function transcriptHref(team) {
    if (!team) return null;
    if (typeof team.transcriptUrl === "string" && team.transcriptUrl) {
      return { href: team.transcriptUrl };
    }
    if (typeof team.transcriptPath === "string" && team.transcriptPath) {
      const path = team.transcriptPath;
      const normalized = path.startsWith("/") ? path : `/${path}`;
      return { href: `file://${normalized}` };
    }
    if (typeof team.transcript === "string" && /^((https?|file):\/\/|\/)/.test(team.transcript)) {
      const t = team.transcript;
      return { href: /^([a-z]+:|\/)/.test(t) ? t : `/${t}` };
    }
    return null;
  }

  /* ----------------------------------------------------------------------
   * State
   * -------------------------------------------------------------------- */
  const state = {
    root: null,
    mounted: false,
    snapshot: null,
    view: "subagents",
    agents: [],
    teams: [],
    workflows: [],
    skills: [],
    commands: [],
    hooks: [],
    modelRouter: null,
    projects: [],
    serverTs: null,
    activity: [],
    lastEventTs: null,
    filter: { agentId: null, kind: null },
    live: { source: "offline", reconnectAttempt: 0 },
    poll: { timer: null, inFlight: false },
    evt: null,
  };

  /* ----------------------------------------------------------------------
   * Network
   * -------------------------------------------------------------------- */
  function api() {
    return window.OpenKanAPI?.api || null;
  }

  async function fetchSnapshot() {
    const a = api();
    if (!a) return null;
    const data = await a("GET", "/api/claude/snapshot");
    return data && typeof data === "object" ? data : null;
  }

  async function fetchActivity(since) {
    const a = api();
    if (!a) return [];
    const path = since
      ? `/api/claude/activity?since=${encodeURIComponent(since)}`
      : "/api/claude/activity";
    let data;
    try {
      data = await a("GET", path);
    } catch (_err) {
      return [];
    }
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.events)) return data.events;
    return [];
  }

  /* ----------------------------------------------------------------------
   * Live stream
   * -------------------------------------------------------------------- */
  function labelForStatus(kind) {
    if (kind === "live") return "Live";
    if (kind === "polling") return "Polling (5s)";
    if (kind === "connecting") return "Connecting…";
    return "Offline";
  }

  function setConnectionStatus(kind) {
    state.live.source = kind;
    const node = state.root?.querySelector("#claude-status");
    if (!node) return;
    node.dataset.status = kind;
    node.innerHTML =
      `<span class="claude-pane-status-dot claude-pane-status-${esc(kind)}" aria-hidden="true"></span>` +
      `<span class="claude-pane-status-text">${esc(labelForStatus(kind))}</span>`;
  }

  function pushEvent(event) {
    if (!event || !event.ts) return;
    if (state.lastEventTs) {
      const incoming = new Date(event.ts).getTime();
      const last = new Date(state.lastEventTs).getTime();
      if (!Number.isNaN(incoming) && !Number.isNaN(last) && incoming <= last) return;
    }
    state.lastEventTs = event.ts;
    state.activity.push(event);
    state.activity = clampActivity(state.activity);
    renderActivity({ fresh: true });
  }

  function handleSsePayload(payload) {
    let data;
    try {
      data = typeof payload.data === "string" ? JSON.parse(payload.data) : payload.data;
    } catch (_err) {
      return;
    }
    if (!data) return;
    if (Array.isArray(data)) {
      for (const e of data) pushEvent(e);
    } else {
      pushEvent(data);
    }
  }

  function stopEventSource() {
    if (state.evt) {
      try { state.evt.close(); } catch (_err) { /* ignore */ }
      state.evt = null;
    }
  }

  function stopPolling() {
    if (state.poll.timer) {
      clearInterval(state.poll.timer);
      state.poll.timer = null;
    }
  }

  async function pollTick() {
    if (state.poll.inFlight) return;
    state.poll.inFlight = true;
    try {
      const events = await fetchActivity(state.lastEventTs || undefined);
      if (Array.isArray(events)) {
        for (const e of events) pushEvent(e);
      }
    } catch (_err) {
      /* swallow; next tick will retry */
    } finally {
      state.poll.inFlight = false;
    }
  }

  function startPolling() {
    if (state.poll.timer) return;
    setConnectionStatus("polling");
    pollTick();
    state.poll.timer = setInterval(pollTick, POLL_INTERVAL_MS);
  }

  function scheduleReconnect() {
    const attempt = state.live.reconnectAttempt;
    const delay = RECONNECT_STEPS_MS[Math.min(attempt, RECONNECT_STEPS_MS.length - 1)];
    state.live.reconnectAttempt = attempt + 1;
    setConnectionStatus("connecting");
    setTimeout(() => {
      if (state.mounted) connectLive();
    }, delay);
  }

  function connectLive() {
    if (!state.mounted) return;
    stopEventSource();
    stopPolling();
    setConnectionStatus("connecting");
    let sse;
    try {
      sse = new EventSource("/api/claude/events");
    } catch (_err) {
      startPolling();
      return;
    }
    state.evt = sse;
    let opened = false;
    sse.addEventListener("open", () => {
      opened = true;
      state.live.reconnectAttempt = 0;
      setConnectionStatus("live");
      // Drain any events that landed while we were disconnected.
      if (state.lastEventTs) {
        fetchActivity(state.lastEventTs).then((events) => {
          if (Array.isArray(events)) for (const e of events) pushEvent(e);
        }).catch(() => { /* ignore */ });
      }
    });
    sse.addEventListener("message", handleSsePayload);
    sse.addEventListener("error", () => {
      if (state.evt !== sse) return;
      stopEventSource();
      if (opened) {
        // Was streaming; backoff then retry.
        scheduleReconnect();
      } else {
        // Never opened; fall back to polling immediately.
        startPolling();
      }
    });
  }

  /* ----------------------------------------------------------------------
   * Snapshot ingestion
   * -------------------------------------------------------------------- */
  function ingestSnapshot(snap) {
    state.snapshot = snap || {};
    state.agents = Array.isArray(snap?.agents) ? snap.agents : [];
    state.teams = Array.isArray(snap?.teams) ? snap.teams : [];
    state.workflows = Array.isArray(snap?.workflows) ? snap.workflows : [];
    state.skills = Array.isArray(snap?.skills) ? snap.skills : [];
    state.commands = Array.isArray(snap?.commands) ? snap.commands : [];
    state.hooks = Array.isArray(snap?.hooks) ? snap.hooks : [];
    state.modelRouter = snap?.modelRouter || null;
    state.projects = Array.isArray(snap?.projects) ? snap.projects : [];
    state.serverTs = snap?.serverTs || null;
  }

  /* ----------------------------------------------------------------------
   * Renderers
   * -------------------------------------------------------------------- */
  function renderHeader() {
    const agents = state.agents.length;
    const teams = state.teams.length;
    const workflows = state.workflows.length;
    return `
      <header class="claude-pane-header">
        <div class="claude-pane-header-meta">
          <span class="claude-pane-eyebrow">Native Claude control plane</span>
          <h2 class="claude-pane-title">Claude</h2>
          <p class="claude-pane-subtitle">
            Bizar + Claude Code · ${agents} agents · ${teams} teams · ${workflows} workflows
          </p>
        </div>
        <div class="claude-pane-header-actions">
          <span id="claude-status" class="claude-pane-status" data-status="offline" role="status" aria-live="polite">
            <span class="claude-pane-status-dot claude-pane-status-offline" aria-hidden="true"></span>
            <span class="claude-pane-status-text">Offline</span>
          </span>
          <button type="button" class="claude-pane-btn" data-claude-action="refresh">Refresh</button>
        </div>
      </header>
    `;
  }

  function renderSubnav() {
    const counts = {
      subagents: state.agents.length,
      teams: state.teams.length,
      workflows: state.workflows.length,
    };
    const tab = (key, label) => `
      <button type="button"
              class="claude-pane-subtab${state.view === key ? " active" : ""}"
              data-claude-subtab="${escAttr(key)}"
              role="tab"
              aria-selected="${state.view === key ? "true" : "false"}">
        <span class="claude-pane-subtab-label">${esc(label)}</span>
        <span class="claude-pane-subtab-count">${counts[key]}</span>
      </button>
    `;
    return `
      <nav class="claude-pane-subnav" role="tablist" aria-label="Claude sub-views">
        ${tab("subagents", "Subagents")}
        ${tab("teams", "Teams")}
        ${tab("workflows", "Workflows")}
      </nav>
      ${renderFilterChips()}
    `;
  }

  function renderFilterChips() {
    const active = new Set(state.agents.map((a) => a.id || a.name).filter(Boolean));
    const chips = [];
    if (state.filter.agentId) {
      chips.push(
        `<button type="button" class="claude-pane-chip active" data-claude-chip="agentId" data-claude-chip-clear="1">
           <span class="claude-pane-chip-x" aria-hidden="true">×</span>
           <span class="claude-pane-chip-text">Agent: ${esc(state.filter.agentId)}</span>
         </button>`
      );
    }
    if (state.filter.kind) {
      chips.push(
        `<button type="button" class="claude-pane-chip active" data-claude-chip="kind" data-claude-chip-clear="1">
           <span class="claude-pane-chip-x" aria-hidden="true">×</span>
           <span class="claude-pane-chip-text">Kind: ${esc(state.filter.kind)}</span>
         </button>`
      );
    }
    const allKinds = new Set();
    for (const a of state.agents) if (a.kind) allKinds.add(a.kind);
    const kindRow = state.filter.kind ? "" :
      Array.from(allKinds).slice(0, 8).map((k) =>
        `<button type="button" class="claude-pane-chip" data-claude-chip="kind" data-claude-chip-value="${escAttr(k)}">${esc(k)}</button>`
      ).join("");
    const agentRow = state.filter.agentId ? "" :
      Array.from(active).slice(0, 12).map((id) =>
        `<button type="button" class="claude-pane-chip" data-claude-chip="agentId" data-claude-chip-value="${escAttr(id)}">${esc(id)}</button>`
      ).join("");
    const filterRow =
      chips.length === 0 && !kindRow && !agentRow
        ? `<span class="claude-pane-chip-empty-hint">No filters applied.</span>`
        : `
          ${chips.join("")}
          ${kindRow ? `<div class="claude-pane-chip-row" role="group" aria-label="Filter by kind">${kindRow}</div>` : ""}
          ${agentRow ? `<div class="claude-pane-chip-row" role="group" aria-label="Filter by agent">${agentRow}</div>` : ""}
        `;
    return `<div class="claude-pane-filter-bar">${filterRow}</div>`;
  }

  function renderEmpty(message) {
    return `<div class="claude-pane-empty"><p>${esc(message)}</p></div>`;
  }

  function renderSubagents() {
    if (!state.agents.length) return renderEmpty("No agents registered yet.");
    const rows = state.agents.filter((a) => {
      const id = a.id || a.name || "";
      if (state.filter.agentId && id !== state.filter.agentId) return false;
      if (state.filter.kind && a.kind !== state.filter.kind) return false;
      return true;
    });
    if (!rows.length) return renderEmpty("No agents match the current filter.");

    const html = rows.map((agent) => {
      const id = agent.id || agent.name || "agent";
      const desc = String(agent.description || "");
      const subTasks = desc.match(TSK_REGEX) || [];
      const status = statusKind(agent);
      const lastSeen = relativeTime(agent.lastSeen || agent.ts || agent.updatedAt);
      const kind = agent.kind || "agent";
      return `
        <div class="claude-pane-agent-row" data-agent-id="${escAttr(id)}" role="row">
          <div class="claude-pane-agent-name" role="cell">
            <span class="claude-pane-status-dot claude-pane-status-${escAttr(status)}" aria-hidden="true"></span>
            <span class="claude-pane-agent-title">${esc(agent.name || id)}</span>
            <span class="claude-pane-agent-kind">${esc(kind)}</span>
          </div>
          <div class="claude-pane-agent-desc" role="cell">${esc(desc)}</div>
          <div class="claude-pane-agent-tasks" role="cell">
            ${subTasks.length
              ? subTasks.map((t) => `<span class="claude-pane-task-chip">${esc(t)}</span>`).join("")
              : '<span class="claude-pane-task-chip claude-pane-task-chip-empty">none</span>'}
          </div>
          <div class="claude-pane-agent-status" role="cell">
            <span class="claude-pane-pill claude-pane-pill-${escAttr(status)}">
              <span class="claude-pane-status-dot claude-pane-status-${escAttr(status)}" aria-hidden="true"></span>
              <span class="claude-pane-pill-label">${esc(status)}</span>
            </span>
            <span class="claude-pane-agent-lastseen">${esc(lastSeen)}</span>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="claude-pane-agent-grid" role="grid" aria-label="Subagents">
        <div class="claude-pane-agent-row claude-pane-agent-row-head" role="row">
          <div role="columnheader" class="claude-pane-agent-name">Name</div>
          <div role="columnheader" class="claude-pane-agent-desc">Description</div>
          <div role="columnheader" class="claude-pane-agent-tasks">Tasks</div>
          <div role="columnheader" class="claude-pane-agent-status">Status</div>
        </div>
        ${html}
      </div>
    `;
  }

  function renderTeams() {
    if (!state.teams.length) return renderEmpty("No teams registered yet.");
    const cards = state.teams.map((team) => {
      const id = team.id || team.name || "team";
      const transcript = transcriptHref(team);
      const status = statusKind(team);
      const lastSeen = relativeTime(team.lastSeen || team.ts || team.updatedAt);
      const memberCount = Number.isFinite(team.memberCount)
        ? team.memberCount
        : Array.isArray(team.members) ? team.members.length : null;
      const transcriptBtn = transcript
        ? `<a class="claude-pane-btn claude-pane-btn-primary" href="${escAttr(transcript.href)}" target="_blank" rel="noopener noreferrer">View transcript</a>`
        : `<span class="claude-pane-btn claude-pane-btn-disabled" aria-disabled="true">No transcript</span>`;
      return `
        <article class="claude-pane-team-card">
          <header class="claude-pane-team-card-head">
            <h3 class="claude-pane-team-card-title">${esc(team.name || id)}</h3>
            <span class="claude-pane-pill claude-pane-pill-${escAttr(status)}">
              <span class="claude-pane-status-dot claude-pane-status-${escAttr(status)}" aria-hidden="true"></span>
              <span class="claude-pane-pill-label">${esc(status)}</span>
            </span>
          </header>
          <p class="claude-pane-team-meta">${esc(id)} · ${esc(lastSeen)}</p>
          <p class="claude-pane-team-desc">${esc(team.description || "")}</p>
          <footer class="claude-pane-team-card-foot">
            ${transcriptBtn}
            <span class="claude-pane-team-size">${esc(memberCount ?? "?")} members</span>
          </footer>
        </article>
      `;
    }).join("");
    return `<div class="claude-pane-team-grid">${cards}</div>`;
  }

  function renderWorkflows() {
    if (!state.workflows.length) return renderEmpty("No workflows registered yet.");
    const cards = state.workflows.map((wf) => {
      const id = wf.id || wf.name || "workflow";
      const status = statusKind(wf);
      const lastSeen = relativeTime(wf.lastSeen || wf.ts || wf.updatedAt);
      const phases = Array.isArray(wf.phases) ? wf.phases : [];
      const phaseList = phases.length
        ? phases.map((p) => {
            const ps = statusKind(p);
            return `
              <li class="claude-pane-workflow-phase">
                <span class="claude-pane-pill claude-pane-pill-${escAttr(ps)}">
                  <span class="claude-pane-status-dot claude-pane-status-${escAttr(ps)}" aria-hidden="true"></span>
                  <span class="claude-pane-pill-label">${esc(p.name || p.id || "phase")}</span>
                </span>
                ${p.description ? `<span class="claude-pane-workflow-phase-desc">${esc(p.description)}</span>` : ""}
              </li>
            `;
          }).join("")
        : '<li class="claude-pane-workflow-phase claude-pane-workflow-phase-empty">No phases defined.</li>';
      return `
        <article class="claude-pane-workflow-card">
          <header class="claude-pane-workflow-card-head">
            <h3 class="claude-pane-workflow-card-title">${esc(wf.name || id)}</h3>
            <span class="claude-pane-pill claude-pane-pill-${escAttr(status)}">
              <span class="claude-pane-status-dot claude-pane-status-${escAttr(status)}" aria-hidden="true"></span>
              <span class="claude-pane-pill-label">${esc(status)}</span>
            </span>
          </header>
          <p class="claude-pane-workflow-meta">${esc(id)} · ${esc(lastSeen)}</p>
          <ol class="claude-pane-workflow-phases">${phaseList}</ol>
        </article>
      `;
    }).join("");
    return `<div class="claude-pane-workflow-grid">${cards}</div>`;
  }

  function renderActivity(opts = {}) {
    const node = state.root?.querySelector("#claude-pane-activity-list");
    if (!node) return;
    if (!state.activity.length) {
      node.innerHTML = `<div class="claude-pane-activity-empty">No activity yet.</div>`;
      return;
    }
    const window = 50;
    const slice = state.activity.slice(-window).reverse();
    const lastEvent = state.activity[state.activity.length - 1];
    const html = slice.map((evt) => {
      const fresh = opts.fresh && evt === lastEvent;
      const cls = `claude-pane-activity-row${fresh ? " is-fresh" : ""}`;
      const time = esc(relativeTime(evt.ts));
      const kind = esc(evt.kind || "event");
      const actor = esc(evt.agent || evt.actor || "—");
      const msg = esc(evt.message || evt.summary || "");
      return `
        <div class="${cls}">
          <span class="claude-pane-activity-time">${time}</span>
          <span class="claude-pane-activity-kind">${kind}</span>
          <span class="claude-pane-activity-actor">${actor}</span>
          <span class="claude-pane-activity-msg">${msg}</span>
        </div>
      `;
    }).join("");
    node.innerHTML = html;
    const counter = state.root.querySelector("#claude-pane-activity-count");
    if (counter) counter.textContent = `${state.activity.length} events`;
  }

  function render() {
    if (!state.root) return;
    let body;
    if (state.view === "teams") body = renderTeams();
    else if (state.view === "workflows") body = renderWorkflows();
    else body = renderSubagents();

    state.root.innerHTML = `
      <div class="claude-pane">
        ${renderHeader()}
        ${renderSubnav()}
        <main class="claude-pane-main" role="tabpanel" data-claude-view="${escAttr(state.view)}">
          ${body}
        </main>
        <footer class="claude-pane-activity" aria-label="Live activity">
          <header class="claude-pane-activity-header">
            <span class="claude-pane-activity-title">Live activity</span>
            <span id="claude-pane-activity-count" class="claude-pane-activity-meta" aria-live="polite">0 events</span>
          </header>
          <div id="claude-pane-activity-list" class="claude-pane-activity-list"></div>
        </footer>
      </div>
    `;
    setConnectionStatus(state.live.source);
    renderActivity();
    bindEvents();
  }

  /* ----------------------------------------------------------------------
   * Event bindings
   * -------------------------------------------------------------------- */
  function bindEvents() {
    if (!state.root) return;
    state.root.querySelectorAll("[data-claude-subtab]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const next = e.currentTarget.dataset.claudeSubtab;
        if (next && next !== state.view) {
          state.view = next;
          render();
        }
      });
    });
    state.root.querySelectorAll("[data-claude-chip]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const node = e.currentTarget;
        const key = node.dataset.claudeChip;
        if (!(key in state.filter)) return;
        if (node.dataset.claudeChipClear) {
          state.filter[key] = null;
        } else {
          state.filter[key] = node.dataset.claudeChipValue || null;
        }
        render();
      });
    });
    state.root.querySelectorAll("[data-claude-action='refresh']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const snap = await fetchSnapshot();
          if (snap) ingestSnapshot(snap);
          render();
        } catch (_err) {
          /* status pill already reflects connectivity */
        }
      });
    });
  }

  /* ----------------------------------------------------------------------
   * Lifecycle
   * -------------------------------------------------------------------- */
  async function mount(root) {
    if (state.root === root && state.mounted) return;
    if (state.root && state.root !== root) unmount();
    state.root = root;
    state.mounted = true;
    root.innerHTML = `<div class="claude-pane-loading">Loading Claude snapshot…</div>`;
    let snap = null;
    try {
      snap = await fetchSnapshot();
    } catch (_err) {
      snap = null;
    }
    ingestSnapshot(snap || {});
    // Seed activity via REST so the footer isn't blank before SSE connects.
    try {
      const events = await fetchActivity(undefined);
      if (Array.isArray(events) && events.length) {
        for (const e of events) state.activity.push(e);
        state.activity = clampActivity(state.activity);
        const last = state.activity[state.activity.length - 1];
        if (last && last.ts) state.lastEventTs = last.ts;
      }
    } catch (_err) { /* ignore */ }
    render();
    connectLive();
  }

  function unmount() {
    state.mounted = false;
    stopEventSource();
    stopPolling();
    if (state.root) {
      try { state.root.innerHTML = ""; } catch (_err) { /* ignore */ }
    }
    state.root = null;
  }

  window.OpenKanClaude = { mount, unmount };
})();
