// OpenKan — Contributors tab (M10).
// window.OpenKanContributors = { mount(rootEl), unmount() }
//
// Pulls from /api/contributors, /api/tasks-index, /api/changelog.
// Each row is expandable; inside the row we list attributed tasks + last
// 10 events by that author.

(() => {
  "use strict";

  const { api } = window.OpenKanAPI;

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

  function initialsFor(name) {
    if (!name) return "?";
    const parts = String(name).trim().split(/[\s@]+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function colorFor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue} 60% 45%)`;
  }

  function relativeTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const delta = Date.now() - t;
    const sec = Math.floor(delta / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function buildHeader() {
    const header = el("div", "contributors-header");

    header.append(el("span", "filter-bar-label", { text: "Sort" }));
    const sort = el("select", null, { "aria-label": "Sort contributors" });
    for (const opt of [
      { v: "commits", t: "most commits" },
      { v: "recent",  t: "most recent" },
      { v: "name",    t: "by name" },
    ]) {
      const o = el("option", null, { value: opt.v, text: opt.t });
      if (state.sort === opt.v) o.selected = true;
      sort.append(o);
    }
    sort.addEventListener("change", () => {
      state.sort = sort.value;
      renderList();
    });
    header.append(sort);

    const me = state.contributors.find((c) => c.isCurrentUser || c.currentUser);
    if (me) {
      header.append(el("span", "current-user-badge", {
        text: `@me is ${me.name || me.email || "current user"}`,
      }));
    }

    return header;
  }

  function sortContributors(list) {
    const sorted = list.slice();
    if (state.sort === "commits") {
      sorted.sort((a, b) => (b.commits || 0) - (a.commits || 0));
    } else if (state.sort === "recent") {
      sorted.sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
    } else {
      sorted.sort((a, b) => String(a.name || a.email || "").localeCompare(String(b.name || b.email || "")));
    }
    return sorted;
  }

  function renderList() {
    if (!state) return;
    state.listEl.innerHTML = "";
    const sorted = sortContributors(state.contributors);
    if (sorted.length === 0) {
      state.listEl.append(el("div", "contributors-empty", { text: "No contributors yet (no git commits found)." }));
      return;
    }
    for (const c of sorted) {
      state.listEl.append(renderRow(c));
    }
  }

  function renderRow(c) {
    const row = el("article", "contributor-row" + (c.isCurrentUser || c.currentUser ? " is-me" : ""));
    row.dataset.email = c.email || "";

    // Summary line
    const summary = el("div", "contributor-summary");
    const av = el("div", "avatar-circle avatar-lg");
    av.style.setProperty("--avatar-bg", colorFor(c.email || c.name || ""));
    av.textContent = initialsFor(c.name || c.email);
    summary.append(av);

    const meta = el("div", "contributor-meta");
    const nameRow = el("div", "contributor-name");
    nameRow.append(c.name || c.email || "(unknown)");
    if (c.isCurrentUser || c.currentUser) {
      nameRow.append(el("span", "tag-chip", {
        text: "@me",
        title: "current git user",
      }));
    }
    meta.append(nameRow);
    if (c.email && c.name) meta.append(el("div", "contributor-email", { text: c.email }));

    const stats = el("div", "contributor-stats");
    stats.append(
      el("span", null, { text: `${c.commits ?? 0} commit${c.commits === 1 ? "" : "s"}` }),
      el("span", null, { text: `last seen ${relativeTime(c.lastSeen)}` }),
      el("span", null, { text: `${c.activeTasks ?? 0} task${c.activeTasks === 1 ? "" : "s"} active` }),
    );
    meta.append(stats);

    summary.append(meta);

    const expand = el("button", "contributor-expand-btn", { type: "button", text: "show tasks ▾" });
    summary.append(expand);

    row.append(summary);

    // Detail (expanded on click)
    const detail = el("div", "contributor-detail");
    row.append(detail);

    expand.addEventListener("click", async () => {
      const isOpen = row.classList.toggle("expanded");
      expand.textContent = isOpen ? "hide ▴" : "show tasks ▾";
      if (isOpen && !detail.dataset.loaded) {
        detail.dataset.loaded = "1";
        await populateDetail(detail, c);
      }
    });

    return row;
  }

  async function populateDetail(detail, c) {
    detail.innerHTML = '<div class="contributors-empty">Loading…</div>';

    // Tasks attributed to this contributor
    let tasks = [];
    try {
      const idx = await api("GET", "/api/tasks-index");
      const list = Array.isArray(idx?.tasks) ? idx.tasks : Array.isArray(idx) ? idx : [];
      tasks = list.filter((t) => Array.isArray(t.contributors) && t.contributors.some((cc) => sameContributor(cc, c)));
    } catch {
      tasks = [];
    }

    const tasksWrap = el("div");
    tasksWrap.append(el("h4", null, { text: `Tasks (${tasks.length})` }));
    if (tasks.length === 0) {
      tasksWrap.append(el("div", "contributors-empty", { text: "No attributed tasks." }));
    } else {
      const list = el("div", "contributor-tasks");
      for (const t of tasks) {
        const item = el("div", "contributor-task", { "data-id": t.id });
        const dot = el("span", `task-status-dot state-${t.state ?? t.status ?? "idle"}`);
        item.append(dot);
        item.append(el("span", "task-title-text", { text: t.title || "(untitled)" }));
        item.append(el("span", "task-column-text", { text: t.column || "" }));
        item.addEventListener("click", () => {
          if (window.OpenKanTabs) window.OpenKanTabs.activate("tasks");
          setTimeout(() => window.OpenKanTaskView?.open(t.id), 30);
        });
        list.append(item);
      }
      tasksWrap.append(list);
    }
    detail.append(tasksWrap);

    // Mini-timeline of last 10 events
    let events = [];
    try {
      const author = c.email || c.name;
      const params = new URLSearchParams();
      params.set("author", author);
      params.set("limit", "10");
      const data = await api("GET", `/api/changelog?${params.toString()}`);
      events = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];
    } catch {
      events = [];
    }

    const tlWrap = el("div");
    tlWrap.append(el("h4", null, { text: `Recent activity (${events.length})` }));
    if (events.length === 0) {
      tlWrap.append(el("div", "contributors-empty", { text: "No recent events." }));
    } else {
      const tl = el("div", "contributor-timeline");
      for (const e of events) {
        const row = el("div", "contributor-timeline-entry");
        row.append(
          el("span", "entry-time", { text: relativeTime(e.ts), title: e.ts }),
          el("span", "entry-summary", { text: `${e.kind} — ${e.summary || ""}` }),
        );
        tl.append(row);
      }
      tlWrap.append(tl);
    }
    detail.append(tlWrap);

    detail.innerHTML = "";
    detail.append(tasksWrap, tlWrap);
  }

  function sameContributor(cc, c) {
    if (!cc || !c) return false;
    if (c.email && cc.email && String(cc.email).toLowerCase() === String(c.email).toLowerCase()) return true;
    if (c.name && cc.name && cc.name === c.name) return true;
    return false;
  }

  async function mount(rootEl) {
    if (!rootEl) throw new Error("contributors-view: rootEl is required");
    unmount();
    state = {
      rootEl,
      contributors: [],
      sort: "commits",
      listEl: null,
    };

    rootEl.innerHTML = '<div class="contributors-empty">Loading…</div>';

    let contributors = [];
    let currentUser = null;
    try {
      const data = await api("GET", "/api/contributors");
      contributors = Array.isArray(data?.contributors) ? data.contributors : Array.isArray(data) ? data : [];
      currentUser = data?.currentUser || null;
    } catch (err) {
      rootEl.innerHTML = "";
      rootEl.append(el("div", "contributors-empty", {
        text: `Contributors unavailable: ${err.message}`,
      }));
      return;
    }

    if (currentUser) {
      const email = (currentUser.email || "").toLowerCase();
      for (const c of contributors) {
        if (email && (c.email || "").toLowerCase() === email) {
          c.isCurrentUser = true;
        }
      }
      // If we have a current user but no match, surface a synthetic row.
      if (!contributors.some((c) => c.isCurrentUser)) {
        contributors.unshift({
          name: currentUser.name || currentUser.email || "you",
          email: currentUser.email || "",
          commits: 0,
          lastSeen: null,
          activeTasks: 0,
          isCurrentUser: true,
        });
      }
    }

    state.contributors = contributors;
    rootEl.innerHTML = "";
    rootEl.append(buildHeader());
    state.listEl = el("div", "contributors-list");
    rootEl.append(state.listEl);
    renderList();
  }

  function unmount() {
    state = null;
  }

  window.OpenKanContributors = { mount, unmount };
})();