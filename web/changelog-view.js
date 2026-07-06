// OpenKan — Changelog tab (M10).
// window.OpenKanChangelog = { mount(rootEl), unmount() }
//
// Pulls events from /api/changelog and renders a vertical timeline, newest
// first. Filter by kind prefix, by date range. Infinite scroll loads 50 at
// a time. Clicking a taskId opens the task in the Tasks tab.

(() => {
  "use strict";

  const { api } = window.OpenKanAPI;

  const PAGE_SIZE = 50;
  const KIND_FILTERS = [
    { id: "all",      label: "all" },
    { id: "task",     label: "task.*" },
    { id: "agent",    label: "agent.*" },
    { id: "settings", label: "settings.*" },
    { id: "git",      label: "git.*" },
  ];

  // State per-mount
  let state = null;

  function el(tag, cls, props = {}) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") e.textContent = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    return e;
  }

  function relativeTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const delta = Date.now() - t;
    const sec = Math.floor(delta / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
    return new Date(iso).toLocaleDateString();
  }

  function kindToBucket(kind) {
    if (!kind) return "other";
    const k = String(kind).toLowerCase();
    if (k.startsWith("task")) return "task";
    if (k.startsWith("agent")) return "agent";
    if (k.startsWith("settings") || k === "kanban.organized") return "settings";
    if (k.startsWith("git")) return "git";
    return "other";
  }

  // The server only supports a single `kind=` filter, not prefix-based
  // groups. For prefix filters (task.*, agent.*, ...) we fetch all events
  // and filter client-side. For "all" we still ask the server for a
  // paginated window.
  function passesKindFilter(eventKind, filterKind) {
    if (!filterKind || filterKind === "all") return true;
    return kindToBucket(eventKind) === filterKind;
  }

  function initialsFor(name) {
    if (!name) return "?";
    const parts = String(name).trim().split(/[\s@]+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Deterministic color from a string. Same approach as in task-view.js.
  function colorFor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue} 60% 45%)`;
  }

  function buildSummary(events) {
    const byKind = {};
    for (const e of events) {
      const bucket = kindToBucket(e.kind);
      byKind[bucket] = (byKind[bucket] || 0) + 1;
    }
    const total = events.length;
    const ordered = ["task", "agent", "settings", "git", "other"]
      .map((k) => ({ k, n: byKind[k] || 0 }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    const max = ordered.reduce((m, x) => Math.max(m, x.n), 0) || 1;

    const wrap = el("div", "changelog-summary");
    wrap.append(el("div", "changelog-summary-title", { text: `Last 30 days — ${total} event${total === 1 ? "" : "s"}` }));

    const bars = el("div", "changelog-summary-bars");
    if (total === 0) {
      bars.append(el("div", "changelog-empty", { text: "No events recorded yet." }));
    } else {
      for (const { k, n } of ordered) {
        const row = el("div", "changelog-summary-row");
        row.append(
          el("span", "bar-label", { text: k }),
          (() => {
            const track = el("div", "bar-track");
            const fill = el("div", "bar-fill");
            fill.style.width = `${(n / max) * 100}%`;
            track.append(fill);
            return track;
          })(),
          el("span", "bar-count", { text: String(n) }),
        );
        bars.append(row);
      }
    }
    wrap.append(bars);
    return wrap;
  }

  function buildFilterRow() {
    const row = el("div", "changelog-filter-row");

    row.append(el("span", "filter-bar-label", { text: "kind" }));
    for (const k of KIND_FILTERS) {
      const btn = el("button", null, { type: "button", text: k.label });
      if (state.filter.kind === k.id) btn.classList.add("active");
      btn.addEventListener("click", () => {
        if (state.filter.kind === k.id) return;
        state.filter.kind = k.id;
        // Re-mount: clear data and reload.
        state.events = [];
        state.offset = 0;
        state.hasMore = true;
        rebuildTimeline();
        loadMore({ reset: true });
      });
      row.append(btn);
    }

    // "Completed only" toggle — server-side filter (?completedOnly=true).
    // When active, only `task.completed`-type events come back; if the
    // server doesn't recognize the flag we fall back to client-side
    // filtering in loadMore().
    const completedBtn = el("button", "completed-toggle", {
      type: "button",
      "aria-pressed": state.filter.completedOnly ? "true" : "false",
    });
    completedBtn.append(
      el("span", "dot"),
      document.createTextNode("Completed only"),
    );
    completedBtn.title = "Show only task events with a completion status";
    completedBtn.addEventListener("click", () => {
      state.filter.completedOnly = !state.filter.completedOnly;
      completedBtn.setAttribute("aria-pressed", state.filter.completedOnly ? "true" : "false");
      resetAndReload();
    });
    row.append(completedBtn);

    // Date range
    const wrap = el("span", "date-range");
    const from = el("input", null, { type: "date", "aria-label": "From date" });
    from.value = state.filter.from || "";
    from.addEventListener("change", () => {
      state.filter.from = from.value || "";
      resetAndReload();
    });
    const to = el("input", null, { type: "date", "aria-label": "To date" });
    to.value = state.filter.to || "";
    to.addEventListener("change", () => {
      state.filter.to = to.value || "";
      resetAndReload();
    });
    wrap.append(" from ", from, " to ", to);
    row.append(wrap);

    const clearBtn = el("button", null, { type: "button", text: "Clear dates" });
    clearBtn.addEventListener("click", () => {
      state.filter.from = "";
      state.filter.to = "";
      from.value = "";
      to.value = "";
      resetAndReload();
    });
    row.append(clearBtn);

    return row;
  }

  function resetAndReload() {
    state.events = [];
    state.offset = 0;
    state.hasMore = true;
    state.timeline.innerHTML = "";
    state.loadingMsg = el("div", "changelog-empty", { text: "Loading…" });
    state.timeline.append(state.loadingMsg);
    loadMore({ reset: true });
  }

  async function loadMore({ reset = false } = {}) {
    if (!state || !state.hasMore || state.loading) return;
    state.loading = true;

    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(state.offset));
      if (state.filter.from) params.set("since", `${state.filter.from}T00:00:00`);
      if (state.filter.to) params.set("until", `${state.filter.to}T23:59:59`);
      if (state.filter.completedOnly) params.set("completedOnly", "true");

      const data = await api("GET", `/api/changelog?${params.toString()}`);
      const events = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];
      const total = typeof data?.total === "number" ? data.total : events.length;

      // Apply client-side kind filter when filtering by prefix group.
      const filteredEvents = passesKindFilter(null, "all") || state.filter.kind === "all"
        ? events
        : events.filter((e) => passesKindFilter(e.kind, state.filter.kind));

      if (reset) {
        state.events = filteredEvents;
        if (state.loadingMsg?.parentNode) state.loadingMsg.remove();
        state.timeline.innerHTML = "";
      } else {
        state.events.push(...filteredEvents);
      }
      state.offset += events.length;
      state.hasMore = state.offset < total && events.length > 0;

      // Append rendered entries
      const rendered = Number(state.timeline.dataset.count || 0);
      for (const e of state.events.slice(rendered)) {
        state.timeline.append(renderEntry(e));
      }
      state.timeline.dataset.count = String(state.events.length);

      // Toggle load-more button
      if (state.loadMoreBtn) state.loadMoreBtn.remove();
      if (state.hasMore) {
        const btn = el("button", "changelog-load-more", { type: "button", text: "Load more" });
        btn.addEventListener("click", () => loadMore());
        state.loadMoreBtn = btn;
        state.rootEl.append(btn);
      }

      // Empty state
      if (state.events.length === 0 && !state.hasMore) {
        if (!state.timeline.querySelector(".changelog-empty")) {
          state.timeline.append(el("div", "changelog-empty", { text: "No events match the current filters." }));
        }
      }
    } catch (err) {
      // Server may not implement the endpoint yet (M10 still landing).
      // Show a friendly empty state so the tab still works.
      if (state.timeline) {
        state.timeline.innerHTML = "";
        state.timeline.append(el("div", "changelog-empty", {
          text: `Changelog unavailable: ${err.message}`,
        }));
      }
      state.hasMore = false;
    } finally {
      state.loading = false;
    }
  }

  function renderEntry(e) {
    const entry = el("article", "changelog-entry");

    const head = el("div", "changelog-entry-head");
    head.append(el("span", "changelog-time", {
      text: relativeTime(e.ts),
      title: e.ts,
    }));
    head.append(el("span", `changelog-kind-chip kind-${kindToBucket(e.kind)}`, {
      text: e.kind || "?",
      title: e.kind,
    }));

    if (e.author) {
      const author = el("span", "changelog-author");
      const av = el("span", "avatar-circle avatar-sm");
      const seed = String(e.author);
      av.style.setProperty("--avatar-bg", colorFor(seed));
      av.textContent = initialsFor(seed);
      author.append(av, e.author);
      head.append(author);
    }
    entry.append(head);

    entry.append(el("div", "changelog-summary-line", { text: e.summary || "" }));

    if (e.payload && Object.keys(e.payload).length > 0) {
      const toggle = el("button", "changelog-details-toggle", { type: "button", text: "▸ payload" });
      const pre = el("pre", "changelog-payload", { text: JSON.stringify(e.payload, null, 2) });
      pre.hidden = true;
      toggle.addEventListener("click", () => {
        pre.hidden = !pre.hidden;
        toggle.textContent = pre.hidden ? "▸ payload" : "▾ payload";
      });
      entry.append(toggle, pre);
    }

    if (e.taskId) {
      const open = el("button", "changelog-open-task", { type: "button", text: "open task →" });
      open.addEventListener("click", () => {
        // Switch to Tasks tab, then open the task view.
        if (window.OpenKanTabs) window.OpenKanTabs.activate("tasks");
        // Defer slightly so the task view is visible before we mount it.
        setTimeout(() => window.OpenKanTaskView?.open(e.taskId), 30);
      });
      entry.append(open);
    }
    return entry;
  }

  async function loadSummary() {
    if (!state) return;
    try {
      const data = await api("GET", "/api/changelog/summary?days=30");
      const byKind = data?.byKind || {};
      // Convert byKind map (real kind names) into our 5 buckets for the bars.
      const buckets = {};
      for (const [k, v] of Object.entries(byKind)) {
        const b = kindToBucket(k);
        buckets[b] = (buckets[b] || 0) + v;
      }
      const total = Object.values(byKind).reduce((a, b) => a + b, 0);
      const fake = [];
      const ordered = ["task", "agent", "settings", "git", "other"]
        .map((k) => ({ k, n: buckets[k] || 0 }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n);
      const max = ordered.reduce((m, x) => Math.max(m, x.n), 0) || 1;
      const wrap = el("div", "changelog-summary");
      wrap.append(el("div", "changelog-summary-title", { text: `Last 30 days — ${total} event${total === 1 ? "" : "s"}` }));
      if (total === 0) {
        wrap.append(el("div", "changelog-empty", { text: "No events recorded yet." }));
      } else {
        const bars = el("div", "changelog-summary-bars");
        for (const { k, n } of ordered) {
          const row = el("div", "changelog-summary-row");
          row.append(
            el("span", "bar-label", { text: k }),
            (() => {
              const track = el("div", "bar-track");
              const fill = el("div", "bar-fill");
              fill.style.width = `${(n / max) * 100}%`;
              track.append(fill);
              return track;
            })(),
            el("span", "bar-count", { text: String(n) }),
          );
          bars.append(row);
        }
        wrap.append(bars);
      }
      state.summaryEl.replaceWith(wrap);
      state.summaryEl = wrap;
    } catch {
      // Fallback: try to derive from the events we already loaded.
      const wrap = buildSummary(state.events);
      state.summaryEl.replaceWith(wrap);
      state.summaryEl = wrap;
    }
  }

  function rebuildTimeline() {
    state.rootEl.innerHTML = "";
    state.summaryEl = el("div", "changelog-summary");
    state.rootEl.append(state.summaryEl);
    state.rootEl.append(buildFilterRow());
    state.timeline = el("div", "changelog-timeline");
    state.rootEl.append(state.timeline);
    state.rootEl.append(state.loadingMsg || el("div", "changelog-empty", { text: "Loading…" }));
  }

  function mount(rootEl) {
    if (!rootEl) throw new Error("changelog-view: rootEl is required");
    unmount();
    state = {
      rootEl,
      events: [],
      offset: 0,
      hasMore: true,
      loading: false,
      filter: { kind: "all", from: "", to: "", completedOnly: false },
      timeline: null,
      summaryEl: null,
      loadMoreBtn: null,
      loadingMsg: null,
    };
    rebuildTimeline();
    loadSummary();
    loadMore({ reset: true });
  }

  function unmount() {
    state = null;
  }

  window.OpenKanChangelog = { mount, unmount };
})();