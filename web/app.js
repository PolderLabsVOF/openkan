// OpenKan — board view (M0–M1 + M7 status indicator + M10/M11 dashboard +
// M13 keyboard nav, command palette, ARIA, cross-tab integration).
// 5 columns, SSE live updates with polling fallback, HTML5 drag-and-drop,
// "New Task" modal, per-task action menu, dashboard tab router, sort/filter,
// archive toggle, saved filters via localStorage, contributors filter row,
// drag-and-drop v1.1 (ghost card, drop indicator, multi-select, shake).

(() => {
  "use strict";

  const { api, on, onStatus } = window.OpenKanAPI;

  const COLUMNS = [
    { id: "backlog", title: "Backlog" },
    { id: "todo", title: "To Do" },
    { id: "doing", title: "In Progress" },
    { id: "review", title: "Review" },
    { id: "done", title: "Done" },
  ];

  // Columns in their natural progression — used by "Move to next column".
  const COLUMN_ORDER = COLUMNS.map((c) => c.id);

  // Categories that the server uses. Also the set of tags that double as a
  // category badge on cards.
  const CATEGORIES = new Set([
    "frontend", "backend", "infra", "docs",
    "test", "design", "data", "security", "task",
  ]);

  // Priority → visual label. Emoji-first for the card, full label for the
  // task view metadata strip.
  const PRIORITY_META = {
    urgent: { emoji: "\uD83D\uDEA8", label: "Urgent", className: "priority-urgent", rank: 0 },
    high:   { emoji: "\u2B06\uFE0F", label: "High",   className: "priority-high",   rank: 1 },
    normal: { emoji: "\u27A1\uFE0F", label: "Normal", className: "priority-normal", rank: 2 },
    low:    { emoji: "\u2B07\uFE0F", label: "Low",    className: "priority-low",    rank: 3 },
  };

  const EFFORT_RANK = { xl: 0, l: 1, m: 2, s: 3, xs: 4 };

  // Sort options shown in the popover. Keep `value` aligned with the legacy
  // <select id="sort-select"> values so the URL hash stays compatible.
  const SORT_OPTIONS = [
    { value: "newest",   label: "Newest first",        desc: "Sort by createdAt, newest first." },
    { value: "oldest",   label: "Oldest first",        desc: "Sort by createdAt, oldest first." },
    { value: "priority", label: "Priority (urgent→low)", desc: "Urgent first, then High, Normal, Low." },
    { value: "effort",   label: "Effort (xl→xs)",      desc: "Largest effort first, smallest last." },
    { value: "activity", label: "Last activity",       desc: "Most recently touched task first." },
  ];
  const SORT_VALUES = SORT_OPTIONS.map((o) => o.value);
  const SORT_LABEL = Object.fromEntries(SORT_OPTIONS.map((o) => [o.value, o.label]));

  /** @type {Map<string, any>} */
  const tasks = new Map();
  /** Map of contributor email → contributor record (from /api/contributors). */
  const contributors = new Map();
  /** Current user (best-effort from /api/contributors). */
  let currentUser = null;

  // ---------- Filter / view state ----------
  // category: "all" or a category id (must also be present in t.tags).
  // tags: array of tag names (all must be present in t.tags, AND-order).
  // contributor: "all" | "@me" | "<email>"
  // archive: "active" | "archived" | "both"
  // sort: "newest" | "oldest" | "priority" | "effort" | "activity"
  // search: free-text query (titles / descriptions / tags / MDX content).
  // Persisted in window.location.hash as separate params.
  const filter = {
    category: "all",
    tags: [],
    contributor: "all",
    archive: "active",
    sort: "newest",
    search: "",
  };

  // ---------- Bulk-action state ----------
  /** Set of currently selected task ids (Ctrl/Cmd-click on cards). */
  const selectedIds = new Set();
  /** Set of task ids that match the active search query. */
  let searchMatchIds = null; // null = no search active
  let searchDebounce = null;
  let searchSeq = 0;

  // ---------- localStorage keys ----------
  const SAVED_FILTERS_KEY = "openkan:saved-filters";
  const SAVED_FILTERS_MAX = 5;

  function readHashFilter() {
    const raw = (window.location.hash || "").replace(/^#/, "");
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    return {
      tab: params.get("tab") || "tasks",
      doc: params.get("doc") || "",
      category: params.get("category") || "all",
      tags: (params.get("tags") || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      contributor: params.get("contributor") || "all",
      archive: ["active", "archived", "both"].includes(params.get("archive"))
        ? params.get("archive")
        : "active",
      sort: SORT_VALUES.includes(params.get("sort"))
        ? params.get("sort")
        : "newest",
      search: params.get("q") || "",
    };
  }

  function writeHashFilter() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    // Preserve `tab` so the tab router can stay in sync.
    if (!params.get("tab")) params.set("tab", "tasks");
    if (filter.category && filter.category !== "all") params.set("category", filter.category);
    else params.delete("category");
    if (filter.tags.length > 0) params.set("tags", filter.tags.join(","));
    else params.delete("tags");
    if (filter.contributor && filter.contributor !== "all") params.set("contributor", filter.contributor);
    else params.delete("contributor");
    if (filter.archive && filter.archive !== "active") params.set("archive", filter.archive);
    else params.delete("archive");
    if (filter.sort && filter.sort !== "newest") params.set("sort", filter.sort);
    else params.delete("sort");
    if (filter.search) params.set("q", filter.search);
    else params.delete("q");
    const next = `#${params.toString()}`;
    if (window.location.hash !== next) {
      const url = window.location.pathname + window.location.search + next;
      window.history.replaceState(null, "", url);
    }
  }

  function applyFilterToButtons() {
    const bar = document.getElementById("filter-bar");
    if (bar) bar.classList.toggle(
      "empty",
      filter.category === "all" && filter.tags.length === 0 && filter.contributor === "all" && !filter.search,
    );
    // Reflect the archive filter on the body element so CSS can gate the
    // .card-archived display:none rule on `data-archive="active"` — this
    // re-shows archived cards when the user picks Archived or Both.
    try { document.body.setAttribute("data-archive", filter.archive || "active"); } catch {}
    const clear = document.getElementById("filter-clear");
    if (clear) clear.disabled = filter.category === "all" && filter.tags.length === 0 && filter.contributor === "all" && !filter.search;
    for (const btn of document.querySelectorAll("#filter-categories button[data-category]")) {
      const v = btn.getAttribute("data-category");
      const active = filter.category === v;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    for (const btn of document.querySelectorAll("#filter-tags button[data-tag]")) {
      const v = btn.getAttribute("data-tag");
      const active = filter.tags.includes(v);
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    for (const btn of document.querySelectorAll("#filter-contributors button[data-contributor]")) {
      const v = btn.getAttribute("data-contributor");
      const active = filter.contributor === v;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    for (const btn of document.querySelectorAll(".archive-toggle button[data-archive]")) {
      const v = btn.getAttribute("data-archive");
      const active = filter.archive === v;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    const sortSel = document.getElementById("sort-select");
    if (sortSel) sortSel.value = filter.sort;
    const sortTrigger = document.getElementById("sort-trigger");
    if (sortTrigger) {
      sortTrigger.textContent = SORT_LABEL[filter.sort] || SORT_LABEL.newest;
      sortTrigger.setAttribute("aria-label", `Sort: ${SORT_LABEL[filter.sort] || SORT_LABEL.newest}`);
    }
    // Refresh popover state (highlight the active option).
    const popover = document.getElementById("sort-popover");
    if (popover) {
      for (const opt of popover.querySelectorAll(".sort-option")) {
        const v = opt.getAttribute("data-value");
        const isActive = v === filter.sort;
        opt.classList.toggle("active", isActive);
        opt.setAttribute("aria-selected", isActive ? "true" : "false");
      }
    }
    // Sync the search input without firing its input event.
    if (searchInput && document.activeElement !== searchInput && searchInput.value !== filter.search) {
      searchInput.value = filter.search;
    }
  }

  function taskMatchesFilter(t) {
    if (filter.category !== "all") {
      const tags = t.tags || [];
      if (t.category && t.category === filter.category) {
        // ok
      } else if (!tags.includes(filter.category)) {
        return false;
      }
    }
    if (filter.tags.length > 0) {
      const tags = new Set((t.tags || []).map((x) => String(x).toLowerCase()));
      for (const want of filter.tags) {
        if (!tags.has(want)) return false;
      }
    }
    if (filter.contributor !== "all") {
      const list = Array.isArray(t.contributors) ? t.contributors : [];
      if (filter.contributor === "@me") {
        if (!currentUser || !currentUser.email) return false;
        const email = currentUser.email.toLowerCase();
        if (!list.some((c) => (c.email || "").toLowerCase() === email)) return false;
      } else {
        const email = filter.contributor.toLowerCase();
        if (!list.some((c) => (c.email || "").toLowerCase() === email)) return false;
      }
    }
    if (filter.archive === "active" && t.archived) return false;
    if (filter.archive === "archived" && !t.archived) return false;
    // Search: rely on the server-returned `searchMatchIds` set when available,
    // so the count and the per-card visibility agree. Falls back to a local
    // substring check so the board still updates immediately while the
    // debounced server call is in flight (and keeps working if /api/search
    // returns 404 mid-development).
    if (searchMatchIds) {
      if (!searchMatchIds.has(t.id)) return false;
    } else if (filter.search) {
      const q = filter.search.toLowerCase();
      if (!taskTextMatchesQuery(t, q)) return false;
    }
    return true;
  }

  // Local substring check used as a fast fallback while the debounced server
  // call is in flight. Mirrors the server-side rule (kanban/search.ts).
  function taskTextMatchesQuery(t, q) {
    if (!q) return true;
    if ((t.title || "").toLowerCase().includes(q)) return true;
    if ((t.description || "").toLowerCase().includes(q)) return true;
    const tags = Array.isArray(t.tags) ? t.tags : [];
    if (tags.some((tag) => String(tag).toLowerCase().includes(q))) return true;
    return false;
  }

  function sortTasks(list) {
    const cmp = {
      newest:   (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
      oldest:   (a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      priority: (a, b) => {
        const ra = PRIORITY_META[a.priority]?.rank ?? 99;
        const rb = PRIORITY_META[b.priority]?.rank ?? 99;
        if (ra !== rb) return ra - rb;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      },
      effort: (a, b) => {
        const ra = EFFORT_RANK[a.effort] ?? 99;
        const rb = EFFORT_RANK[b.effort] ?? 99;
        if (ra !== rb) return ra - rb;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      },
      activity: (a, b) => String(b.lastActivity || b.updatedAt || "").localeCompare(String(a.lastActivity || a.updatedAt || "")),
    }[filter.sort] || ((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return list.slice().sort(cmp);
  }

  // ---------- Saved filters (localStorage) ----------
  function readSavedFilters() {
    try {
      const raw = localStorage.getItem(SAVED_FILTERS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function writeSavedFilters(list) {
    try {
      localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(list.slice(0, SAVED_FILTERS_MAX)));
    } catch {}
  }
  function saveCurrentFilter(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return false;
    const list = readSavedFilters();
    const snapshot = {
      name: trimmed,
      ts: new Date().toISOString(),
      category: filter.category,
      tags: filter.tags.slice(),
      contributor: filter.contributor,
      archive: filter.archive,
      sort: filter.sort,
    };
    // Replace if same name exists.
    const idx = list.findIndex((s) => s.name === trimmed);
    if (idx >= 0) list[idx] = snapshot;
    else list.unshift(snapshot);
    writeSavedFilters(list);
    renderSavedFilters();
    return true;
  }
  function deleteSavedFilter(name) {
    const list = readSavedFilters().filter((s) => s.name !== name);
    writeSavedFilters(list);
    renderSavedFilters();
  }
  function applySavedFilter(s) {
    filter.category = s.category || "all";
    filter.tags = Array.isArray(s.tags) ? s.tags.slice() : [];
    filter.contributor = s.contributor || "all";
    filter.archive = s.archive || "active";
    filter.sort = s.sort || "newest";
    writeHashFilter();
    applyFilterToButtons();
    renderBoard();
  }
  function renderSavedFilters() {
    const bar = document.getElementById("saved-filters-bar");
    const list = document.getElementById("saved-filters-list");
    if (!bar || !list) return;
    const items = readSavedFilters();
    list.innerHTML = "";
    if (items.length === 0) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    for (const s of items) {
      const chip = el("span", "saved-filter-chip", { title: `Saved ${s.ts || ""}` });
      chip.append(el("span", null, { text: s.name }));
      const rm = el("button", "chip-remove", { type: "button", text: "×", "aria-label": `Delete filter ${s.name}` });
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSavedFilter(s.name);
      });
      chip.append(rm);
      chip.addEventListener("click", () => applySavedFilter(s));
      list.append(chip);
    }
  }

  // ---------- Sort popover ----------
  // Replaces the plain <select> with a styled popover while keeping the
  // legacy <select id="sort-select"> in the DOM (visually hidden) so the
  // value is still readable from tests, screen-reader-only navigation, and
  // the URL hash serializer. Both code paths funnel through setSort().

  function setSort(value) {
    const v = SORT_VALUES.includes(value) ? value : "newest";
    if (filter.sort === v) {
      // Still re-apply so the trigger label / popover state stay in sync.
      applyFilterToButtons();
      return;
    }
    filter.sort = v;
    const sortSel = document.getElementById("sort-select");
    if (sortSel) sortSel.value = v;
    writeHashFilter();
    applyFilterToButtons();
    renderBoard();
  }

  let sortPopoverOpen = false;
  let sortPopoverCleanup = null;

  function closeSortPopover() {
    const popover = document.getElementById("sort-popover");
    const trigger = document.getElementById("sort-trigger");
    if (popover) popover.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    sortPopoverOpen = false;
    if (sortPopoverCleanup) { sortPopoverCleanup(); sortPopoverCleanup = null; }
  }

  function openSortPopover() {
    const popover = document.getElementById("sort-popover");
    const trigger = document.getElementById("sort-trigger");
    if (!popover || !trigger) return;
    popover.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    sortPopoverOpen = true;
    focusSortOption(filter.sort);

    // Defer attaching doc-level listeners so the click that opened the
    // popover doesn't immediately close it.
    setTimeout(() => {
      const onDocClick = (e) => {
        const wrap = document.getElementById("sort-select-wrap");
        if (wrap && wrap.contains(e.target)) return;
        closeSortPopover();
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closeSortPopover();
          document.getElementById("sort-trigger")?.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          moveSortOption(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Enter" || e.key === " ") {
          // Only intercept Enter when focus is in the popover.
          if (popover.contains(document.activeElement)) {
            e.preventDefault();
            commitFocusedOption();
          }
        } else if (e.key === "Tab") {
          closeSortPopover();
        }
      };
      document.addEventListener("mousedown", onDocClick, true);
      document.addEventListener("keydown", onKey, true);
      sortPopoverCleanup = () => {
        document.removeEventListener("mousedown", onDocClick, true);
        document.removeEventListener("keydown", onKey, true);
      };
    }, 0);
  }

  function focusSortOption(value) {
    const popover = document.getElementById("sort-popover");
    if (!popover) return;
    const options = [...popover.querySelectorAll(".sort-option")];
    if (options.length === 0) return;
    let idx = options.findIndex((o) => o.getAttribute("data-value") === value);
    if (idx < 0) idx = 0;
    for (const o of options) o.classList.remove("focused");
    options[idx].classList.add("focused");
    try { options[idx].focus(); } catch {}
  }

  function moveSortOption(delta) {
    const popover = document.getElementById("sort-popover");
    if (!popover) return;
    const options = [...popover.querySelectorAll(".sort-option")];
    if (options.length === 0) return;
    const active = document.activeElement;
    let idx = options.indexOf(active);
    if (idx < 0) idx = options.findIndex((o) => o.classList.contains("focused"));
    if (idx < 0) idx = 0;
    const next = (idx + delta + options.length) % options.length;
    for (const o of options) o.classList.remove("focused");
    options[next].classList.add("focused");
    try { options[next].focus(); } catch {}
  }

  function commitFocusedOption() {
    const popover = document.getElementById("sort-popover");
    if (!popover) return;
    const active = document.activeElement;
    const target = (active && active.classList && active.classList.contains("sort-option"))
      ? active
      : popover.querySelector(".sort-option.focused") || popover.querySelector(".sort-option");
    if (!target) return;
    const value = target.getAttribute("data-value");
    if (value) {
      setSort(value);
      closeSortPopover();
      document.getElementById("sort-trigger")?.focus();
    }
  }

  function buildSortPopover() {
    const wrap = document.getElementById("sort-select-wrap");
    const sortSel = document.getElementById("sort-select");
    if (!wrap || !sortSel) return;

    // Hide the original <select> visually. Keep it in the DOM so setSort()
    // can keep its .value in sync and so any test/screen-reader code that
    // targets the legacy control still works.
    sortSel.classList.add("visually-hidden");
    sortSel.setAttribute("aria-hidden", "true");
    sortSel.tabIndex = -1;

    // Replace (or insert) the trigger button.
    let trigger = document.getElementById("sort-trigger");
    if (!trigger) {
      trigger = el("button", "sort-trigger", {
        type: "button",
        id: "sort-trigger",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-label": "Sort tasks",
      });
      sortSel.insertAdjacentElement("beforebegin", trigger);
    }
    trigger.textContent = SORT_LABEL[filter.sort] || SORT_LABEL.newest;
    trigger.setAttribute("aria-label", `Sort: ${SORT_LABEL[filter.sort] || SORT_LABEL.newest}`);

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (sortPopoverOpen) closeSortPopover();
      else openSortPopover();
    });
    trigger.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!sortPopoverOpen) openSortPopover();
      }
    });

    // Replace (or insert) the popover.
    let popover = document.getElementById("sort-popover");
    if (!popover) {
      popover = el("div", "sort-popover", {
        id: "sort-popover",
        role: "listbox",
        "aria-label": "Sort tasks",
        hidden: true,
      });
      wrap.append(popover);
    } else {
      popover.innerHTML = "";
      popover.setAttribute("role", "listbox");
    }
    for (const opt of SORT_OPTIONS) {
      const btn = el("button", "sort-option", {
        type: "button",
        role: "option",
        "data-value": opt.value,
        "aria-selected": opt.value === filter.sort ? "true" : "false",
        tabindex: "-1",
      });
      btn.append(el("span", "label", { text: opt.label }));
      btn.append(el("span", "desc", { text: opt.desc }));
      if (opt.value === filter.sort) {
        btn.append(el("span", "check", { "aria-hidden": "true", text: "✓" }));
        btn.classList.add("active");
      }
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setSort(opt.value);
        closeSortPopover();
        trigger.focus();
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          moveSortOption(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          commitFocusedOption();
        } else if (e.key === "Escape") {
          e.preventDefault();
          closeSortPopover();
          trigger.focus();
        } else if (e.key === "Home") {
          e.preventDefault();
          focusSortOption(SORT_OPTIONS[0].value);
        } else if (e.key === "End") {
          e.preventDefault();
          focusSortOption(SORT_OPTIONS[SORT_OPTIONS.length - 1].value);
        }
      });
      popover.append(btn);
    }
  }

  function attachSortPopover() {
    buildSortPopover();
  }

  function attachFilterBar() {
    const clear = document.getElementById("filter-clear");
    const cats = document.getElementById("filter-categories");
    const tags = document.getElementById("filter-tags");
    const contribs = document.getElementById("filter-contributors");
    const sortSel = document.getElementById("sort-select");
    const saveBtn = document.getElementById("save-filter-btn");
    if (!cats || !tags) return;

    cats.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-category]");
      if (!btn) return;
      filter.category = btn.getAttribute("data-category") || "all";
      writeHashFilter();
      applyFilterToButtons();
      renderBoard();
    });
    tags.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tag]");
      if (!btn) return;
      const v = btn.getAttribute("data-tag") || "";
      if (!v) return;
      const idx = filter.tags.indexOf(v);
      if (idx === -1) filter.tags.push(v);
      else filter.tags.splice(idx, 1);
      writeHashFilter();
      applyFilterToButtons();
      renderBoard();
    });
    if (contribs) {
      contribs.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-contributor]");
        if (!btn) return;
        filter.contributor = btn.getAttribute("data-contributor") || "all";
        writeHashFilter();
        applyFilterToButtons();
        renderBoard();
      });
    }
    if (sortSel) {
      // The legacy <select> is kept around for keyboard / form-submit
      // compatibility; the visible popover drives the actual UX. We still
      // honor changes (e.g. tests, screen-reader-only navigation).
      sortSel.addEventListener("change", () => {
        setSort(sortSel.value || "newest");
      });
    }
    attachSortPopover();
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        // `window.prompt` is blocked in headless Chrome and some embedded
        // contexts, so route through the custom inline modal in app.js.
        const name = await promptForName("Save filter as:", "");
        if (!name) return;
        if (saveCurrentFilter(name)) {
          window.OpenKanSettings?.showToast?.(`Saved filter "${name}"`);
        }
      });
    }
    if (clear) {
      clear.addEventListener("click", () => {
        filter.category = "all";
        filter.tags = [];
        filter.contributor = "all";
        filter.search = "";
        searchMatchIds = null;
        writeHashFilter();
        applyFilterToButtons();
        renderBoard();
      });
    }
    // External trigger: tag chip in task view writes the hash; we re-read.
    window.addEventListener("hashchange", () => {
      const next = readHashFilter();
      if (!next) return;
      const searchChanged = next.search !== filter.search;
      filter.category = next.category;
      filter.tags = next.tags;
      filter.contributor = next.contributor;
      filter.archive = next.archive;
      filter.sort = next.sort;
      filter.search = next.search || "";
      if (searchChanged) {
        // Hash navigated to a new search — re-run the debounced fetch.
        const input = document.getElementById("search-input");
        if (input) input.value = filter.search;
        searchMatchIds = null;
        if (filter.search) {
          const meta = document.getElementById("search-meta");
          runSearch(filter.search, meta);
        }
      }
      applyFilterToButtons();
      renderBoard();
      activateTab(next.tab, { fromHash: true });
    });

    // Archive segmented control
    document.querySelectorAll(".archive-toggle button[data-archive]").forEach((btn) => {
      btn.addEventListener("click", () => {
        filter.archive = btn.getAttribute("data-archive") || "active";
        writeHashFilter();
        applyFilterToButtons();
        renderBoard();
      });
    });
  }

  const $ = (id) => document.getElementById(id);
  const board = $("board");
  const statusPill = $("status-pill");
  const statusText = $("status-text");
  const modal = $("modal-backdrop");
  const form = $("new-task-form");
  const menu = $("action-menu");
  const searchInput = $("search-input");

  // Module-scope wrappers used by both the click-button menu and the
  // right-click context menu. `call` swallows the error to keep the menu
  // from getting stuck open if a request fails.
  const call = (m, p, b) => api(m, p, b).catch((e) => alert(`${m} failed: ${e.message}`));

  // ---------- Connection state ----------
  function setConnected(v) {
    statusPill.classList.toggle("pill-connected", v);
    statusPill.classList.toggle("pill-disconnected", !v);
    statusText.textContent = v ? "Connected" : "Disconnected";
  }
  onStatus(setConnected);

  // ---------- Render ----------
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

  function effectiveState(t) {
    return t.state ?? t.status ?? "idle";
  }

  function makeTagChip(tag, opts = {}) {
    const lower = String(tag).toLowerCase();
    const isCategory = CATEGORIES.has(lower);
    const cls = `tag-chip t-${lower}` + (isCategory ? " category" : "") + (opts.className ? ` ${opts.className}` : "");
    const chip = el("span", cls, { text: opts.label ?? lower, title: opts.title ?? lower });
    if (isCategory) chip.classList.add(`c-${lower}`);
    return chip;
  }

  function makeCardPriority(t) {
    const meta = PRIORITY_META[t.priority];
    if (!meta) return null;
    const wrap = el("div", "card-priority");
    const chip = el("span", `tag-chip priority ${meta.className}`, {
      text: meta.emoji,
      title: `priority: ${meta.label}`,
      "aria-label": `priority: ${meta.label}`,
    });
    wrap.append(chip);
    return wrap;
  }

  function makeCardTags(t) {
    const raw = Array.isArray(t.tags) ? t.tags : [];
    if (raw.length === 0) return null;
    const MAX = 3;
    const visible = raw.slice(0, MAX);
    const overflow = raw.length - visible.length;
    const row = el("div", "card-tags");
    for (const tag of visible) row.append(makeTagChip(tag));
    if (overflow > 0) {
      row.append(el("span", "tag-chip overflow", {
        text: `+${overflow}`,
        title: raw.slice(MAX).join(", "),
      }));
    }
    return row;
  }

  // Deterministic avatar color from a string. Same approach used elsewhere.
  function avatarColorFor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue} 60% 45%)`;
  }

  function initialsFor(name) {
    if (!name) return "?";
    const parts = String(name).trim().split(/[\s@]+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Resolve the assignees list on a task. The board index payload uses
  // `assignees: string[]`; the task detail payload uses
  // `contributors: Array<{name, email}>`. Normalize to a list of
  // { label, seed } where label is the human name and seed is the email
  // (used for the deterministic color hash and the tooltip).
  function getAssignees(t) {
    if (Array.isArray(t?.assignees) && t.assignees.length > 0) {
      return t.assignees
        .map((a) => {
          if (a && typeof a === "object") {
            const seed = String(a.email || a.name || "");
            return seed ? { label: a.name || a.email || "?", seed } : null;
          }
          const s = String(a || "").trim();
          return s ? { label: s, seed: s } : null;
        })
        .filter(Boolean);
    }
    if (Array.isArray(t?.contributors)) {
      return t.contributors
        .map((c) => {
          const seed = String(c?.email || c?.name || "");
          return seed ? { label: c.name || c.email || "?", seed } : null;
        })
        .filter(Boolean);
    }
    return [];
  }

  // Render an assignees avatar strip on the card. Up to 2 avatars, then
  // "+N" overflow. The whole strip is a tooltip host with the full list.
  function makeAssigneesStrip(t) {
    const list = getAssignees(t);
    if (list.length === 0) return null;
    const MAX = 2;
    const visible = list.slice(0, MAX);
    const overflow = list.length - visible.length;
    const tooltip = list.map((a) => a.label).join("\n");
    const wrap = el("div", "assignees-stack assignee-tooltip", { "data-tooltip": tooltip, tabindex: "0" });
    for (const a of visible) {
      const av = el("span", "avatar-circle avatar-sm");
      av.style.setProperty("--avatar-bg", avatarColorFor(a.seed));
      av.textContent = initialsFor(a.label);
      wrap.append(av);
    }
    if (overflow > 0) {
      wrap.append(el("span", "assignee-overflow", {
        text: `+${overflow}`,
      }));
    }
    return wrap;
  }

  function renderCard(t) {
    const state = effectiveState(t);
    const columnTitle = (COLUMNS.find((c) => c.id === t.column) || {}).title || (t.column || "column");
    const focusedId = window.OpenKanKeyboard?.getFocusedId?.();
    const isFocused = focusedId === t.id;
    const card = el("article", "card" + (t.archived ? " card-archived" : "") + (isFocused ? " focused" : ""), {
      draggable: "true",
      "data-id": t.id,
      role: "button",
      tabindex: isFocused ? "0" : "-1",
      "aria-label": `${t.title || "(untitled)"}, ${columnTitle}, status ${state}${t.archived ? ", archived" : ""}`,
      "aria-pressed": selectedIds.has(t.id) ? "true" : "false",
    });
    const pri = makeCardPriority(t);
    if (pri) card.append(pri);
    const titleEl = el("div", "card-title", { text: t.title || "(untitled)" });
    card.append(titleEl);
    // Subtask count badge — shows on the right of the title when this task
    // has at least one child. Backend supplies `subtaskCount` on the index
    // payload; falls back to the `subtasks` array length if not.
    const subtaskCount = (() => {
      if (typeof t.subtaskCount === "number") return t.subtaskCount;
      if (Array.isArray(t.subtasks)) return t.subtasks.length;
      return 0;
    })();
    if (subtaskCount > 0) {
      const subBadge = el("span", "card-subtask-badge", {
        text: `↳ ${subtaskCount}`,
        title: `${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}`,
      });
      // Right-aligned with the title via inline-block wrapper. We just
      // append it to the title element so the existing flex layout on
      // `.card-title` picks it up; CSS handles the alignment.
      subBadge.dataset.parentLink = "true";
      subBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        window.OpenKanTaskView?.open(t.id);
      });
      titleEl.append(subBadge);
    }
    card.append(el("div", "card-desc", { text: t.description || "" }));
    const tagsRow = makeCardTags(t);
    if (tagsRow) card.append(tagsRow);
    // Source link chip (M2 — frontend). When the task was imported from a
    // markdown file we surface the path:line so the user can click straight
    // through to the source. If the file no longer exists on disk we show
    // a "deleted" state instead of a dead link.
    if (t.source && t.source.path) {
      const path = String(t.source.path);
      const line = t.source.line ?? "?";
      const chip = el("a", "card-source", {
        href: `/${path}`,
        target: "_blank",
        rel: "noopener",
        title: `Imported from ${path}:${line}`,
      });
      chip.append(
        el("span", "card-source-icon", { text: "📄", "aria-hidden": "true" }),
        el("span", "card-source-text", { text: `${path}:${line}` }),
      );
      // Stop the click from bubbling up to the card body — we don't want
      // the chip to also open the task view.
      chip.addEventListener("click", (e) => e.stopPropagation());
      // Lazy "deleted" detection: HEAD-style check on hover. If the fetch
      // resolves 404 we flip the chip into the deleted state so the user
      // sees the source is gone without us having to scan the filesystem on
      // every render.
      chip.addEventListener("mouseenter", () => {
        if (chip.dataset.checked || chip.dataset.deleted) return;
        chip.dataset.checked = "1";
        fetch(chip.href, { method: "HEAD", cache: "no-store" })
          .then((res) => {
            if (!res.ok) {
              chip.dataset.deleted = "1";
              chip.removeAttribute("href");
              chip.classList.add("card-source-deleted");
              chip.title = `Source file no longer exists: ${path}`;
              const txt = chip.querySelector(".card-source-text");
              if (txt) txt.textContent = `${path} (deleted)`;
            }
          })
          .catch(() => { /* network error — leave the link intact */ });
      }, { once: true });
      card.append(chip);
    }
    // Stale badge (M3 — frontend). Surfaced in the top-right when the
    // server detected the source file has changed since import. Clicking
    // it opens the task view so the user can re-derive tags.
    if (t.stale === true) {
      const stale = el("button", "card-stale-badge", {
        type: "button",
        text: "stale",
        title: "Source has changed since this task was imported. Click to open.",
        "aria-label": "Source is stale — click to open task",
      });
      stale.addEventListener("click", (e) => {
        e.stopPropagation();
        window.OpenKanTaskView?.open(t.id);
      });
      card.append(stale);
    }
    const meta = el("div", "card-meta");
    const left = el("div");
    left.style.cssText = "display:flex;align-items:center;gap:6px;";
    left.append(el("span", `status-dot ${state}`, { title: state }));
    if (t.agent)
      left.append(el("span", "card-agent", { text: t.agent, title: `agent: ${t.agent}` }));
    const avs = makeAssigneesStrip(t);
    if (avs) left.append(avs);
    const right = el("div");
    right.style.cssText = "display:flex;gap:6px;align-items:center;";
    if (t.artifact) {
      const a = el("a", null, {
        href: `/artifacts/tasks/${t.id}`,
        title: "View artifact",
        text: "↗",
      });
      a.style.cssText = "color:var(--text-mute);text-decoration:none;";
      a.addEventListener("click", (e) => e.stopPropagation());
      right.append(a);
    }
    const more = el("button", "btn-icon", { text: "⋯", title: "Actions", "aria-label": "Task actions" });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(t, more);
    });
    right.append(more);
    meta.append(left, right);
    card.append(meta);

    // Drag — v1.1: also handle multi-card drag (selected set) and ghost preview.
    card.addEventListener("dragstart", (e) => {
      // Compose the dragged id list: this card + any selected ones.
      const dragged = new Set([t.id, ...selectedIds]);
      dragState.draggedIds = [...dragged];
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragState.draggedIds.join(",")); } catch {}
      card.classList.add("dragging");
      // Show ghost preview — custom positioned div.
      dragState.ghost = buildGhost(t, dragState.draggedIds);
      document.body.append(dragState.ghost);
      // Hide native drag image so only our ghost shows.
      try {
        const blank = document.createElement("canvas");
        blank.width = blank.height = 1;
        e.dataTransfer.setDragImage(blank, 0, 0);
      } catch {}
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      teardownDragVisuals();
    });
    // Ctrl/Meta-click toggles selection for multi-drag + bulk actions.
    card.addEventListener("click", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey === false) {
        // Only intercept if the user is on the card body, not a button/link.
        const target = e.target;
        const tag = (target.tagName || "").toLowerCase();
        if (tag === "a" || tag === "button") return;
        e.preventDefault();
        e.stopPropagation();
        toggleCardSelection(card, t.id);
        return;
      }
      // Plain click opens the detail view.
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "a" || tag === "button") return;
      // Update the focused card so subsequent j/k/arrow keys start from here.
      window.OpenKanKeyboard?.setFocusedId?.(t.id);
      window.OpenKanTaskView?.open(t.id);
    });
    // Right-click on cards is handled by the global page-wide contextmenu
    // listener (see `attachGlobalContextMenu` near the boot section). We
    // deliberately don't attach a per-card contextmenu handler — let the
    // global delegate handle it via `e.target.closest(".card")` so the
    // behavior is consistent with column-body / filter-bar / topbar etc.
    // Apply the current selected state — renderBoard() rebuilds the DOM
    // after every state change, so we need to re-add the class on rebuild.
    if (selectedIds.has(t.id)) card.classList.add("selected");

    return card;
  }

  // Selected cards for multi-card drag + bulk action bar. Stored as a Set of
  // task ids. Renamed from `selectedCards` so it matches the public spec.
  function toggleCardSelection(cardEl, id) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      cardEl.classList.remove("selected");
      cardEl.setAttribute("aria-pressed", "false");
    } else {
      selectedIds.add(id);
      cardEl.classList.add("selected");
      cardEl.setAttribute("aria-pressed", "true");
    }
    updateBulkBar();
  }
  function clearCardSelection() {
    for (const c of document.querySelectorAll(".card.selected")) c.classList.remove("selected");
    selectedIds.clear();
    updateBulkBar();
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest(".card")) return;
    if (e.target.closest("#bulk-bar")) return;
    clearCardSelection();
  });

  function renderBoard() {
    if (!board) return;
    board.innerHTML = "";
    // `filterActive` controls whether taskMatchesFilter() runs at all. It
    // must include the archive toggle — otherwise with no other filter
    // active we'd render archived cards alongside active ones, which is the
    // "archived items don't get hidden" bug.
    const filterActive =
      filter.category !== "all" ||
      filter.tags.length > 0 ||
      filter.contributor !== "all" ||
      filter.archive !== "active" ||
      filter.search !== "";

    // Group by column, apply filter, sort.
    const byColumn = new Map();
    for (const col of COLUMNS) byColumn.set(col.id, []);
    for (const t of tasks.values()) {
      const list = byColumn.get(t.column);
      if (list) list.push(t);
    }
    for (const [colId, list] of byColumn) {
      const filtered = filterActive ? list.filter(taskMatchesFilter) : list;
      byColumn.set(colId, sortTasks(filtered));
    }

    for (const col of COLUMNS) {
      const colTasks = byColumn.get(col.id) || [];
      const body = el("div", "column-body", { "data-column": col.id });

      if (colTasks.length === 0) {
        const empty = el("div", "column-empty is-dropzone", {
          text: filterActive
            ? "No tasks match the filter"
            : "Drop a task here or + Add task",
        });
        body.append(empty);
      } else {
        for (const t of colTasks) body.append(renderCard(t));
      }

      const column = el("section", "column", { "data-column": col.id });
      const header = el("div", "column-header");
      const totalInCol = (byColumn.get(col.id) || []).length + (
        // include archived-only when filter is "active"
        filter.archive !== "archived"
          ? [...tasks.values()].filter((t) => t.column === col.id && t.archived).length
          : 0
      );
      const matched = colTasks.length;
      const countLabel = filterActive && totalInCol !== matched
        ? `${matched} / ${totalInCol}`
        : String(matched);
      const titleSpan = el("span", "column-title", { text: col.title });
      const countSpan = el("span", "column-count", { text: countLabel });
      const addBtn = el("button", "column-add-btn", {
        type: "button",
        title: `Add a task to ${col.title}`,
        "aria-label": `Add a task to ${col.title}`,
        text: "+",
      });
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openNewTaskModalInColumn(col.id);
      });
      header.append(titleSpan, countSpan, addBtn);
      column.append(header, body);
      attachDnD(column);
      board.append(column);
    }
  }

  // ---------- Action menu ----------
  function openMenu(task, anchor) {
    const r = anchor.getBoundingClientRect();
    menu.innerHTML = "";
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, r.right - 200)}px`;
    menu.hidden = false;

    const run = (label, fn, danger = false) => {
      const b = el("button", danger ? "danger" : null, { text: label });
      b.addEventListener("click", () => {
        if (typeof console !== "undefined") console.debug("[openkan] menu click:", label);
        menu.hidden = true;
        Promise.resolve().then(() => {
          try { fn(); } catch (err) {
            if (typeof console !== "undefined") console.error("[openkan] action threw:", err);
            toast(`Action failed: ${err.message || err}`, true);
          }
        });
      });
      menu.append(b);
    };
    // `call` is the module-scope wrapper defined near the top of the IIFE.

    // "Move to next column" — hidden if archived or on the last column.
    const idx = COLUMN_ORDER.indexOf(task.column);
    if (!task.archived && idx >= 0 && idx < COLUMN_ORDER.length - 1) {
      const next = COLUMN_ORDER[idx + 1];
      run(`Move to ${labelForColumn(next)} →`, () => {
        call("PATCH", `/api/tasks/${task.id}`, { column: next })
          .then(() => toast(`Moved to ${labelForColumn(next)}`))
          .catch((err) => toast(`Move failed: ${err.message}`, true));
      });
    }

    const state = effectiveState(task);
    if (state !== "running") {
      run("Start", () => call("POST", `/api/tasks/${task.id}/start`)
        .then(() => toast(`Started "${task.title}"`))
        .catch((err) => toast(`Start failed: ${err.message}`, true)));
    } else {
      run("Abort", () => call("POST", `/api/tasks/${task.id}/abort`)
        .then(() => toast(`Aborted "${task.title}"`))
        .catch((err) => toast(`Abort failed: ${err.message}`, true)));
    }

    run("Edit", () => openEditModal(task.id));

    run("View Detail", () => {
      window.OpenKanTaskView?.open(task.id);
    });

    if (task.artifact) {
      const a = el("a", null, { href: `/artifacts/tasks/${task.id}`, text: "View Artifact ↗", target: "_blank", rel: "noopener" });
      menu.append(a);
    }

    if (task.archived) {
      run("Restore", () => call("POST", `/api/tasks/${task.id}/restore`)
        .then(() => toast(`Restored "${task.title}"`))
        .catch((err) => toast(`Restore failed: ${err.message}`, true)));
    } else {
      run("Archive", () => archiveWithUndo(task));
    }

    run("Delete", () => deleteWithUndo(task), true);

    const off = (e) => {
      if (!menu.contains(e.target)) {
        menu.hidden = true;
        document.removeEventListener("click", off);
      }
    };
    setTimeout(() => document.addEventListener("click", off), 0);
  }

  // ─── Right-click context menu (PAGE-WIDE, location-aware) ──────────────
  //
  // A single global `contextmenu` listener at capture phase decides which menu
  // to show based on `e.target.closest(...)`. Re-uses the `renderMenu` /
  // `hideMenu` infrastructure from the card-specific menu below.
  function openGlobalContextMenu(e) {
    if (typeof console !== "undefined") console.debug("[openkan] contextmenu at", e.target);
    // Inputs keep the native context menu (paste / spell-check etc.) so the
    // user can still get the browser spell-checker on text fields.
    const tEl = e.target;
    if (!tEl) return;
    const tTag = (tEl.tagName || "").toLowerCase();
    if (tTag === "input" || tTag === "textarea" || tEl.isContentEditable) {
      if (typeof console !== "undefined") console.debug("[openkan] contextmenu: in editable input — keeping native menu");
      return;
    }
    // Anchors / buttons keep their native menu (copy link, etc.). Walk up to
    // decide. We DON'T bail just because the click target is a <span> or
    // <article role="button"> — only true <a>/<button> elements get the
    // native menu.
    let walker = tEl;
    while (walker && walker !== document.body) {
      const tag = (walker.tagName || "").toLowerCase();
      if (tag === "a" || tag === "button") {
        if (typeof console !== "undefined") console.debug("[openkan] contextmenu: inside anchor/button — keeping native menu", tag);
        return;
      }
      walker = walker.parentElement;
    }

    // Always suppress the native menu once we've decided to render ours.
    e.preventDefault();
    e.stopPropagation();

    const items = [];

    // 1. Card → per-task menu
    const cardEl = tEl.closest(".card");
    if (cardEl) {
      const taskId = cardEl.dataset.id;
      const task = tasks.get(taskId);
      if (task) {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e, task);
        return;
      }
    }

    // 2. Saved-filter chip
    const savedChip = tEl.closest(".saved-filter-chip");
    if (savedChip && savedChip.dataset.savedName) {
      const name = savedChip.dataset.savedName;
      items.push({
        label: `Apply "${name}"`,
        action: () => applySavedFilterByName(name),
      });
      items.push({
        label: `Delete saved filter "${name}"`,
        danger: true,
        action: () => deleteSavedFilterByName(name),
      });
    }

    // 3. Tag chip in the filter bar (data-tag attribute)
    const filterChip = tEl.closest(".filter-bar button[data-tag]");
    if (filterChip && filterChip.dataset.tag) {
      const tg = filterChip.dataset.tag;
      items.push({
        label: `Filter by #${tg} only`,
        action: () => toggleOnlyTagFilter(tg),
      });
      items.push({
        label: `Add #${tg} to active filters`,
        action: () => addTagToActiveFilters(tg),
      });
    }

    // 4. Category chip in the filter bar
    const categoryChip = tEl.closest(".filter-bar button[data-category]");
    if (categoryChip && categoryChip.dataset.category && categoryChip.dataset.category !== "all") {
      const cat = categoryChip.dataset.category;
      items.push({
        label: `Filter by category "${cat}" only`,
        action: () => setOnlyCategoryFilter(cat),
      });
    }

    // 5. Column body / column header → column menu
    const columnEl = tEl.closest(".column");
    if (columnEl && columnEl.dataset.column) {
      const colId = columnEl.dataset.column;
      const col = COLUMNS.find((c) => c.id === colId);
      items.push({
        label: col?.title
          ? `Create task in "${col.title}"`
          : `Create task`,
        action: () => openNewTaskModalInColumn(colId),
      });
      items.push({
        label: `New task from template`,
        action: () => openNewTaskModalInColumn(colId, true),
      });
      if (selectedIds.size > 0) {
        items.push({
          label: `Move ${selectedIds.size} selected task${selectedIds.size === 1 ? "" : "s"} here`,
          action: () => bulkMoveSelectedTo(colId),
        });
        items.push({ kind: "divider" });
      }
      // Archive-all in this column
      items.push({
        label: `Archive archived tasks in this column`,
        action: () => archiveAllInColumn(colId),
      });
      items.push({
        label: `Re-derive tags for tasks in this column`,
        action: () => bulkRederiveInColumn(colId),
      });
      items.push({ kind: "divider" });
      items.push({
        label: `Copy column ID "${colId}"`,
        action: () => copyToClipboard(colId, "Column ID"),
      });
    }

    // 6. Dashboard tab in the topbar
    const tabEl = tEl.closest(".topbar-tabs .tab");
    if (tabEl) {
      const tabName = tabEl.dataset.tab;
      if (tabName === "tasks") {
        items.push({
          label: "Clear all filters",
          action: () => clearAllFilters(),
        });
        items.push({
          label: "Show archived",
          action: () => setArchiveFilter("archived"),
        });
        items.push({
          label: "Show all (active + archived)",
          action: () => setArchiveFilter("both"),
        });
      } else if (tabName === "changelog") {
        items.push({
          label: "Refresh changelog",
          action: () => window.OpenKanChangelog?.mount?.(document.getElementById("changelog-root")),
        });
      } else if (tabName === "contributors") {
        items.push({
          label: "Refresh contributors",
          action: () => window.OpenKanContributors?.mount?.(document.getElementById("contributors-root")),
        });
      }
    }

    // 7. Default page menu if nothing matched
    if (items.length === 0) {
      items.push({ label: "New Task", action: openNewTaskModal });
      items.push({ kind: "divider" });
      items.push({
        label: "Open Settings",
        action: () => document.getElementById("settings-btn")?.click(),
      });
      items.push({
        label: "Toggle theme (dark / light / system)",
        action: () => window.OpenKanSettings?.cycleTheme?.() ?? window.OpenKanSettings?.openSettings?.(),
      });
      items.push({
        label: "Reload board",
        action: () => location.reload(),
      });
      items.push({ kind: "divider" });
      items.push({
        label: "Keyboard shortcuts (press ?)",
        action: () => window.OpenKanKeyboard?.showHelp?.(),
      });
      items.push({
        label: "Command palette (⌘K / Ctrl+K)",
        action: () => window.OpenKanCommandPalette?.open?.(),
      });
    }

    e.preventDefault();
    e.stopPropagation();
    renderMenu(items);
    positionMenuAt(e);
  }

  function positionMenuAt(e) {
    if (!menu) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.visibility = "hidden";
    menu.hidden = false;
    const w = menu.offsetWidth || 220;
    const h = menu.offsetHeight || 280;
    const pad = 8;
    let x = e.clientX;
    let y = e.clientY;
    if (x + w + pad > vw) x = Math.max(pad, vw - w - pad);
    if (y + h + pad > vh) y = Math.max(pad, vh - h - pad);
    menu.style.left = `${Math.max(pad, x)}px`;
    menu.style.top = `${Math.max(pad, y)}px`;
    menu.style.visibility = "";
    // Single capture-phase mousedown listener with a 50ms delay so the
    // opening right-click doesn't immediately close the menu. Simpler than
    // the previous four-listener combo (mousedown + keydown + scroll +
    // window-blur), and the brief specifically asks for this simplification.
    setTimeout(() => {
      document.addEventListener("mousedown", dismissOnOutsideClick, true);
      document.addEventListener("keydown", dismissOnEscape, true);
    }, 50);
  }

  // ─── Helper actions used by the global context menu ─────────────────────
  function openNewTaskModalInColumn(columnId, fromTemplate = false, parentId = "") {
    // Pre-fill the modal so it lands in the chosen column (and as a subtask
    // of `parentId` if provided).
    void fromTemplate;
    const btn = document.getElementById("new-task-btn");
    if (btn) btn.click();
    const colSel = document.querySelector('select[name="column"]');
    if (colSel) {
      colSel.value = columnId;
      colSel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const parentField = document.querySelector('input[name="parentId"]');
    if (parentField) {
      parentField.value = parentId || "";
    }
  }

  function openNewTaskModal() {
    const btn = document.getElementById("new-task-btn");
    if (btn) btn.click();
  }

  // ─── Edit Task modal ──────────────────────────────────────────────────────
  // Single-instance modal — re-opened with a new taskId each time. Reuses the
  // same `.modal-backdrop` / `.modal` shell as the New Task modal so styling
  // stays consistent. Re-fetches the task via /api/tasks/:id on open so we
  // always edit the freshest server-side state.
  function editModal() {
    let backdrop = document.getElementById("edit-backdrop");
    if (backdrop && backdrop._wired) return backdrop;
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "edit-backdrop";
      backdrop.className = "modal-backdrop";
      backdrop.hidden = true;
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
          <header class="modal-header">
            <h2 id="edit-title">Edit Task</h2>
            <button class="btn-icon" type="button" data-close-edit aria-label="Close">&times;</button>
          </header>
          <form id="edit-form" class="modal-body">
            <label class="field">
              <span>Title</span>
              <input name="title" type="text" required maxlength="200" autocomplete="off" />
            </label>
            <label class="field">
              <span>Description</span>
              <textarea name="description" rows="5" placeholder="Markdown is fine."></textarea>
            </label>
            <footer class="modal-footer">
              <button type="button" class="btn" data-close-edit>Cancel</button>
              <button type="submit" class="btn btn-primary" id="edit-save-btn">Save</button>
            </footer>
          </form>
        </div>`;
      document.body.appendChild(backdrop);
    }
    backdrop._wired = true;
    return backdrop;
  }

  let editCurrentTaskId = null;
  let editLastTask = null;

  async function openEditModal(taskId) {
    if (!taskId) return;
    const backdrop = editModal();
    const form = backdrop.querySelector("#edit-form");
    const titleInput = form.elements.title;
    const descInput = form.elements.description;
    const saveBtn = backdrop.querySelector("#edit-save-btn");

    editCurrentTaskId = String(taskId);
    backdrop.hidden = false;
    saveBtn.disabled = true;
    titleInput.disabled = true;
    descInput.disabled = true;
    titleInput.value = "";
    descInput.value = "";
    // Focus the title once enabled for fast keyboard editing.
    setTimeout(() => titleInput.focus(), 0);

    let task;
    try {
      const payload = await api("GET", `/api/tasks/${taskId}`);
      task = payload?.task || payload;
    } catch (err) {
      toast(`Could not load task: ${err.message}`, true);
      backdrop.hidden = true;
      return;
    }
    if (!task) {
      toast(`Could not load task ${taskId}`, true);
      backdrop.hidden = true;
      return;
    }
    editLastTask = task;
    titleInput.value = task.title || "";
    descInput.value = task.description || "";
    titleInput.disabled = false;
    descInput.disabled = false;
    saveBtn.disabled = !String(titleInput.value || "").trim();

    const onTitleInput = () => {
      saveBtn.disabled = !String(titleInput.value || "").trim();
    };
    titleInput.addEventListener("input", onTitleInput);

    const closeBackdrop = () => {
      backdrop.hidden = true;
      titleInput.removeEventListener("input", onTitleInput);
      editCurrentTaskId = null;
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeBackdrop();
    }, { once: true });
    backdrop.querySelectorAll("[data-close-edit]").forEach((b) =>
      b.addEventListener("click", closeBackdrop, { once: true }),
    );
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape" && !backdrop.hidden) {
        closeBackdrop();
        document.removeEventListener("keydown", onKey);
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = String(titleInput.value || "").trim();
      if (!title) {
        titleInput.focus();
        return;
      }
      const description = String(descInput.value || "");
      saveBtn.disabled = true;
      try {
        const result = await api("PATCH", `/api/tasks/${editCurrentTaskId}`, { title, description });
        // Refresh from server so any server-normalized fields (tags, etc.)
        // show up before we ask the task view to re-render.
        try {
          const fresh = await api("GET", `/api/tasks/${editCurrentTaskId}`);
          const t = fresh?.task || fresh || result;
          if (t && t.id) {
            tasks.set(t.id, t);
            renderBoard();
          }
        } catch (_) { /* best-effort refresh; toast below still fires */ }
        toast("Saved");
        closeBackdrop();
        // If the task view is currently showing this task, re-render it
        // so the title/description reflect the save immediately.
        if (window.OpenKanTaskView?.getCurrentTaskId?.() === editCurrentTaskId) {
          window.OpenKanTaskView.open(editCurrentTaskId);
        }
      } catch (err) {
        toast(`Save failed: ${err.message}`, true);
        saveBtn.disabled = false;
      }
    }, { once: false });
  }
  function bulkMoveSelectedTo(columnId) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    call("POST", "/api/tasks/bulk", {
      operation: { kind: "move", taskIds: ids, column: columnId },
    })
      .then((result) => {
        showMenuToast(`Moved ${ids.length} task${ids.length === 1 ? "" : "s"} to ${columnId}`);
        selectedIds.clear();
        renderBoard();
      })
      .catch((e) => alert(`Move failed: ${e.message}`));
  }
  function archiveAllInColumn(columnId) {
    const ids = [...tasks.values()].filter((t) => t.column === columnId && t.archived).map((t) => t.id);
    if (ids.length === 0) {
      showMenuToast("No archived tasks in this column");
      return;
    }
    // "Archive" on already-archived is a no-op, so just toast.
    showMenuToast(`${ids.length} task${ids.length === 1 ? "" : "s"} already archived`);
  }
  function bulkRederiveInColumn(columnId) {
    const ids = [...tasks.values()].filter((t) => t.column === columnId).map((t) => t.id);
    if (ids.length === 0) return;
    call("POST", "/api/organize", {
      operations: ids.map((id) => ({ kind: "rederive", taskId: id })),
    })
      .then((result) => {
        showMenuToast(`Re-derived metadata for ${ids.length} task${ids.length === 1 ? "" : "s"}`);
      })
      .catch((e) => alert(`Re-derive failed: ${e.message}`));
  }
  function clearAllFilters() {
    filter.category = "all";
    filter.tags = [];
    filter.contributor = "all";
    filter.search = "";
    setArchiveFilter("active");
    applyFilterToButtons();
    if (searchInput) searchInput.value = "";
    renderBoard();
    showMenuToast("Filters cleared");
  }
  function setArchiveFilter(value) {
    if (!["active", "archived", "both"].includes(value)) return;
    filter.archive = value;
    applyFilterToButtons();
    renderBoard();
    writeHash();
    showMenuToast(`Archive filter: ${value}`);
  }
  function applySavedFilterByName(name) {
    try {
      const raw = localStorage.getItem("openkan:saved-filters");
      const list = JSON.parse(raw || "[]");
      const saved = list.find((s) => s && s.name === name);
      if (saved) {
        Object.assign(filter, {
          category: saved.category || "all",
          tags: Array.isArray(saved.tags) ? [...saved.tags] : [],
          contributor: saved.contributor || "all",
          search: saved.search || "",
        });
        if (saved.archive) filter.archive = saved.archive;
        if (searchInput) searchInput.value = filter.search;
        applyFilterToButtons();
        renderBoard();
        writeHash();
        showMenuToast(`Loaded "${name}"`);
      }
    } catch (_) {
      alert("Could not load saved filter.");
    }
  }
  function deleteSavedFilterByName(name) {
    showUndoToast(`Deleted saved filter "${name}".`, () => {
      try {
        const raw = localStorage.getItem("openkan:saved-filters");
        const list = JSON.parse(raw || "[]");
        if (!list.find((s) => s && s.name === name)) list.push({ name, snapshot: { /* re-add on click */ } });
        localStorage.setItem("openkan:saved-filters", JSON.stringify(list));
        showMenuToast(`Saved filter "${name}" restored`);
        if (typeof renderSavedFilters === "function") renderSavedFilters();
      } catch (_) {
        toast("Could not restore saved filter.", true);
      }
    });
    try {
      const raw = localStorage.getItem("openkan:saved-filters");
      const list = JSON.parse(raw || "[]");
      const next = list.filter((s) => s && s.name !== name);
      localStorage.setItem("openkan:saved-filters", JSON.stringify(next));
      // Re-render the saved-filters bar if a render function exists.
      if (typeof renderSavedFilters === "function") renderSavedFilters();
    } catch (_) {
      alert("Could not delete saved filter.");
    }
  }
  function toggleOnlyTagFilter(tag) {
    filter.category = "all";
    filter.tags = [tag];
    filter.contributor = "all";
    applyFilterToButtons();
    renderBoard();
    writeHash();
    showMenuToast(`Filter: #${tag}`);
  }
  function addTagToActiveFilters(tag) {
    if (!filter.tags.includes(tag)) filter.tags.push(tag);
    applyFilterToButtons();
    renderBoard();
    writeHash();
  }
  function setOnlyCategoryFilter(cat) {
    filter.category = cat;
    filter.tags = [];
    filter.contributor = "all";
    applyFilterToButtons();
    renderBoard();
    writeHash();
    showMenuToast(`Filter: ${cat}`);
  }

  function showMenuToast(message) {
    if (typeof toast === "function") toast(message);
    else console.info("[openkan]", message);
  }

  // ─── Right-click context menu (card body) ────────────────────────────────
  //
  // A richer menu than the ⋯ button, positioned at the cursor. Re-uses the
  // same `#action-menu` host so styling is shared. Items are wired to the
  // existing `call()` helper (api wrapper) plus a few new ones for clipboard
  // and bulk ops.
  //
  // Flat structure (no submenus) — Move-To is a flat list of "Move to <Col>"
  // buttons so click handlers always fire reliably. Destructive actions
  // (Archive, Delete) get an Undo toast with a 5s window.
  function openContextMenu(e, task) {
    if (!menu) return;
    if (!task || !task.id) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Build menu items. Each item: { label, action | kind, danger? }
    const items = [];

    items.push({
      label: "Open",
      action: () => window.OpenKanTaskView?.open(task.id),
    });
    if (task.artifact) {
      items.push({
        label: "View Artifact ↗",
        action: () => window.open(`/artifacts/tasks/${task.id}`, "_blank", "noopener"),
      });
    }
    items.push({
      label: "Edit",
      action: () => openEditModal(task.id),
    });
    items.push({ kind: "divider" });

    // Flat "Move to <Column>" buttons (no submenu — submenu hover was buggy
    // and obscured the destination before click could register). Current
    // column is disabled; archived cards can't be moved.
    if (!task.archived) {
      for (const c of COLUMNS) {
        if (c.id === task.column) continue; // skip current column
        items.push({
          label: `Move to ${c.title}`,
          action: () => call("PATCH", `/api/tasks/${task.id}`, { column: c.id })
            .then(() => toast(`Moved to ${c.title}`))
            .catch((err) => toast(`Move failed: ${err.message}`, true)),
        });
      }
      if (items[items.length - 1]?.kind !== "divider") items.push({ kind: "divider" });
    }

    // Selection toggle.
    if (selectedIds.has(task.id)) {
      items.push({
        label: "Deselect",
        action: () => {
          selectedIds.delete(task.id);
          renderBoard();
        },
      });
    } else {
      items.push({
        label: "Add to selection",
        action: () => {
          selectedIds.add(task.id);
          renderBoard();
        },
      });
    }
    // Select-all-in-column — show whenever there are multiple tasks in this
    // column (the previous `selectedIds.size > 0 && !selectedIds.has(task.id) === false`
    // expression was a buggy double-negation that simplified to false unless
    // the task was already in the selection).
    const count = countInColumn(task.column);
    if (count > 1) {
      items.push({
        label: `Select all in ${labelForColumn(task.column)} (${count})`,
        action: () => selectAllInColumn(task.column),
      });
    }
    items.push({ kind: "divider" });

    if (!task.archived && effectiveState(task) !== "running") {
      items.push({
        label: "Start",
        action: () => call("POST", `/api/tasks/${task.id}/start`),
      });
    } else if (effectiveState(task) === "running") {
      items.push({
        label: "Abort",
        danger: true,
        action: () => call("POST", `/api/tasks/${task.id}/abort`)
          .then(() => toast(`Aborted "${task.title}"`))
          .catch((err) => toast(`Abort failed: ${err.message}`, true)),
      });
    }

    if (task.archived) {
      items.push({
        label: "Restore",
        action: () => call("POST", `/api/tasks/${task.id}/restore`)
          .then(() => toast(`Restored "${task.title}"`))
          .catch((err) => toast(`Restore failed: ${err.message}`, true)),
      });
    } else {
      items.push({
        label: "Archive",
        action: () => archiveWithUndo(task),
      });
    }

    items.push({ kind: "divider" });

    items.push({
      label: `Copy task ID (${task.id})`,
      action: () => copyToClipboard(task.id, "Task ID"),
    });
    items.push({
      label: "Copy markdown link",
      action: () =>
        copyToClipboard(`[${task.title || task.id}](.openkan/tasks/${task.id}/task.mdx)`, "Markdown link"),
    });
    items.push({
      label: "Copy as kanban URL",
      action: () => {
        const url = new URL(window.location.href);
        url.hash = `#tab=tasks&taskId=${task.id}`;
        copyToClipboard(url.toString(), "URL");
      },
    });

    items.push({ kind: "divider" });

    items.push({
      label: "Delete",
      danger: true,
      action: () => deleteWithUndo(task),
    });

    // Render into the existing #action-menu host.
    renderMenu(items);

    // Position at cursor with viewport clamping. Position with visibility
    // hidden so the user doesn't see a flicker at (0,0) before we've
    // measured. Then make visible.
    menu.style.visibility = "hidden";
    menu.hidden = false;
    // Force a layout so we can read offsetWidth.
    const w = menu.offsetWidth || 220;
    const h = menu.offsetHeight || 280;
    const padding = 8;
    let x = e.clientX;
    let y = e.clientY;
    if (x + w + padding > vw) x = Math.max(padding, vw - w - padding);
    if (y + h + padding > vh) y = Math.max(padding, vh - h - padding);
    menu.style.left = `${Math.max(padding, x)}px`;
    menu.style.top = `${Math.max(padding, y)}px`;
    menu.style.visibility = "";
    menu.dataset.contextFor = task.id;

    // Dismiss: outside mousedown + Escape. The mousedown listener fires at
    // capture phase and uses a 50ms delay so the click that fired our
    // action's handler doesn't immediately re-dismiss the menu before the
    // action runs. Scroll/blur dismissal dropped (the per-card menu pops up
    // inside the board area, so scroll events are noisy without value).
    setTimeout(() => {
      document.addEventListener("mousedown", dismissOnOutsideClick, true);
      document.addEventListener("keydown", dismissOnEscape, true);
    }, 50);
  }

  function renderMenu(items) {
    if (!menu) return;
    menu.innerHTML = "";
    menu.classList.remove("with-submenu");
    for (const it of items) {
      if (it.kind === "divider") {
        const d = document.createElement("div");
        d.className = "menu-divider";
        d.setAttribute("role", "separator");
        menu.append(d);
        continue;
      }
      // Submenus were removed (M-bug-fix): they were buggy under hover and
      // obscured the destination before the click could register. Callers
      // that used to push `{ kind: "submenu", submenu: [...] }` should now
      // push one item per destination. We silently flatten here as a
      // back-compat safety net.
      if (it.kind === "submenu" && Array.isArray(it.submenu)) {
        for (const sub of it.submenu) menu.append(renderMenuItem(sub));
        continue;
      }
      menu.append(renderMenuItem(it));
    }
  }

  function renderMenuItem(it) {
    const btn = document.createElement("button");
    btn.setAttribute("role", "menuitem");
    btn.tabIndex = 0;
    btn.textContent = it.label;
    if (it.danger) btn.classList.add("danger");
    if (it.disabled) {
      btn.disabled = true;
      btn.classList.add("disabled");
      return btn;
    }
    btn.addEventListener("click", (ev) => {
      // First-line visibility — confirms the click handler actually fires.
      // Useful for diagnosing why an action "did nothing".
      if (typeof console !== "undefined") console.debug("[openkan] menu click:", it.label, "action:", typeof it.action);
      ev.stopPropagation();
      hideMenu();
      // Defer the action one microtask so the menu's dismissal listeners
      // run first; helps with the rare race where the same click closes
      // the menu but the action also depends on the menu being hidden.
      Promise.resolve().then(() => {
        try {
          if (typeof it.action === "function") it.action();
          else if (typeof console !== "undefined") console.warn("[openkan] menu item has no action:", it.label);
        } catch (err) {
          if (typeof console !== "undefined") console.error("[openkan] action threw:", err);
          toast(`Action failed: ${err.message || err}`, true);
        }
      });
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        hideMenu();
        if (typeof it.action === "function") it.action();
      }
    });
    return btn;
  }

  function hideMenu() {
    if (!menu) return;
    menu.hidden = true;
    menu.removeAttribute("data-context-for");
    document.removeEventListener("mousedown", dismissOnOutsideClick, true);
    document.removeEventListener("keydown", dismissOnEscape, true);
    // Scroll/blur listeners may not be attached (we dropped them in the
    // simplification); removeEventListener on absent listeners is a no-op.
    window.removeEventListener("scroll", dismissOnScroll, true);
    window.removeEventListener("blur", dismissOnBlur, true);
  }
  function dismissOnOutsideClick(e) {
    if (!menu || menu.hidden) return;
    if (menu.contains(e.target)) return;
    hideMenu();
  }
  function dismissOnEscape(e) {
    if (e.key !== "Escape") return;
    if (menu && !menu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      hideMenu();
    }
  }
  function dismissOnScroll() { hideMenu(); }
  function dismissOnBlur() { hideMenu(); }

  // Helpers used by context menu
  function countInColumn(column) {
    let n = 0;
    for (const t of tasks.values()) if (t.column === column) n++;
    return n;
  }
  function selectAllInColumn(column) {
    let added = 0;
    for (const t of tasks.values()) {
      if (t.column === column && !selectedIds.has(t.id)) {
        selectedIds.add(t.id);
        added++;
      }
    }
    if (added > 0) renderBoard();
    return added;
  }

  // Optimistically archive and offer an Undo toast. The optimistic update
  // matches what `data-card-archived` styles expect; the toast handler can
  // PATCH {archived: false} on click to reverse within the 5s window.
  function archiveWithUndo(task) {
    if (!task) return;
    // Snapshot for rollback if Undo isn't clicked and the server returns a
    // failure (rare).
    const snapshot = { archived: !!task.archived };
    task.archived = true;
    renderBoard();
    // Fire-and-forget; show a toast with an Undo button regardless.
    api("POST", `/api/tasks/${task.id}/archive`).then(
      () => {},
      (err) => {
        task.archived = snapshot.archived;
        renderBoard();
        toast(`Archive failed: ${err.message}`, true);
      },
    );
    showUndoToast(`Archived "${task.title}".`, () => {
      task.archived = false;
      renderBoard();
      api("POST", `/api/tasks/${task.id}/restore`)
        .then(() => toast(`Restored "${task.title}"`))
        .catch((err) => {
          task.archived = true;
          renderBoard();
          toast(`Restore failed: ${err.message}`, true);
        });
    });
  }

  function deleteWithUndo(task) {
    if (!task) return;
    const snapshot = { ...task };
    tasks.delete(task.id);
    renderBoard();
    showUndoToast(`Deleted "${task.title}".`, () => {
      // Recreate: there's no /api/tasks/recreate endpoint, so we use the
      // POST /api/tasks route with the original fields. Strip server-side
      // bookkeeping (order, createdAt, updatedAt, etc.).
      const { id, createdAt, updatedAt, lastActivity, ...rest } = snapshot;
      tasks.set(snapshot.id, snapshot);
      renderBoard();
      api("POST", "/api/tasks", rest)
        .then((created) => {
          if (created && created.id) {
            tasks.set(created.id, created);
            tasks.delete(snapshot.id);
            renderBoard();
            toast(`Restored "${snapshot.title}"`);
          }
        })
        .catch((err) => {
          tasks.delete(snapshot.id);
          renderBoard();
          toast(`Restore failed: ${err.message}`, true);
        });
    });
  }

  // Render a toast with an inline "Undo" button. The Undo callback fires if
  // clicked within `ms` (default 5000). After the window expires, the toast
  // dismisses normally. Implemented as a regular toast with a button child
  // so it inherits the existing toast styling.
  function showUndoToast(message, onUndo, ms = 5000) {
    const host = document.getElementById("toast-container");
    if (!host) {
      console.info("[openkan]", message);
      if (typeof onUndo === "function") { /* best-effort: fire immediately */ }
      return;
    }
    const t = document.createElement("div");
    t.className = "toast toast-undo";
    const text = document.createElement("span");
    text.className = "toast-message";
    text.textContent = `${message} `;
    t.append(text);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-undo-btn";
    btn.textContent = "Undo →";
    let fired = false;
    const trigger = () => {
      if (fired) return;
      fired = true;
      try { onUndo && onUndo(); } catch (_) {}
      t.remove();
    };
    btn.addEventListener("click", trigger);
    t.append(btn);
    host.append(t);
    setTimeout(() => {
      if (!fired) t.classList.add("toast-leaving");
      setTimeout(() => t.remove(), 220);
    }, ms);
  }

  // ─── Clipboard helper (fallback for non-secure contexts) ─────────────────
  function copyToClipboard(text, label = "Copied") {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast(`${label} copied to clipboard`),
        () => fallbackCopy(text, label),
      );
    } else {
      fallbackCopy(text, label);
    }
  }
  function fallbackCopy(text, label) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssPosition = "fixed";
    ta.style.left = "-9999px";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(`${label} copied (fallback)`);
    } catch (_) {
      toast(`Could not copy. Value: ${text.slice(0, 80)}`, true);
    } finally {
      document.body.removeChild(ta);
    }
  }
  function toast(message, isError) {
    let host = document.getElementById("toast-container");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast-container";
      host.className = "toast-container";
      document.body.append(host);
    }
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " toast-error" : "");
    el.textContent = message;
    host.append(el);
    setTimeout(() => { el.classList.add("toast-leaving"); }, 1700);
    setTimeout(() => { el.remove(); }, 2100);
  }

  function labelForColumn(id) {
    return COLUMNS.find((c) => c.id === id)?.title || id;
  }

  // ---------- Drag-and-drop v1.1 ----------
  // State that lives only during an active drag.
  const dragState = {
    ghost: null,
    draggedIds: [],
  };

  function buildGhost(card, ids) {
    const rect = card.getBoundingClientRect();
    const ghost = el("div", "ghost-card");
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.setProperty("--ghost-width", `${rect.width}px`);
    ghost.append(el("div", "ghost-card-title", { text: card.querySelector(".card-title")?.textContent || "(untitled)" }));
    if (ids.length > 1) {
      ghost.append(el("div", "ghost-card-count", { text: `${ids.length} cards` }));
    }
    return ghost;
  }

  function positionGhost(clientX, clientY) {
    if (!dragState.ghost) return;
    const w = dragState.ghost.offsetWidth || 260;
    dragState.ghost.style.transform = `translate(${clientX - 20}px, ${clientY - 20}px) rotate(2deg)`;
    // We use position: fixed; setting top/left directly keeps it simple.
    dragState.ghost.style.left = `${clientX - 20}px`;
    dragState.ghost.style.top = `${clientY - 20}px`;
    void w;
  }

  function teardownDragVisuals() {
    if (dragState.ghost) {
      dragState.ghost.remove();
      dragState.ghost = null;
    }
    dragState.draggedIds = [];
    document.querySelectorAll(".column.drag-over").forEach((c) => c.classList.remove("drag-over"));
    document.querySelectorAll(".drop-indicator").forEach((d) => d.remove());
  }

  function attachDnD(column) {
    const body = column.querySelector(".column-body");
    column.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      column.classList.add("drag-over");
      // Position the ghost to follow the cursor — dragover fires even when
      // dataTransfer is dragging from the same window.
      positionGhost(e.clientX, e.clientY);
      // Insertion indicator
      const idx = dropIndex(body, e.clientY);
      showDropIndicator(body, idx);
    });
    column.addEventListener("dragleave", (e) => {
      if (!column.contains(e.relatedTarget)) {
        column.classList.remove("drag-over");
        // Don't remove indicator if we're moving within the column.
      }
    });
    column.addEventListener("drop", async (e) => {
      e.preventDefault();
      column.classList.remove("drag-over");
      const idList = (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
      if (idList.length === 0) {
        teardownDragVisuals();
        return;
      }
      const order = dropIndex(body, e.clientY, idList[0]);
      teardownDragVisuals();
      if (idList.length > 1) {
        await moveTasks(idList, body.dataset.column, order);
      } else {
        await moveTask(idList[0], body.dataset.column, order);
      }
    });
  }

  // Doc-level ghost positioning using dragover with capture phase. The plain
  // `drag` event only fires on the source element; capture-phase dragover
  // fires on every mouse move during an active drag, even when the cursor
  // is outside any column or even outside the board.
  document.addEventListener("dragover", (e) => {
    if (dragState.ghost && e.clientX !== 0) positionGhost(e.clientX, e.clientY);
  }, true);
  // Safety net — clean up if the user drops somewhere invalid.
  document.addEventListener("dragend", teardownDragVisuals);

  function showDropIndicator(body, idx) {
    // Remove any existing indicator first.
    body.querySelectorAll(".drop-indicator").forEach((d) => d.remove());
    const indicator = el("div", "drop-indicator");
    const cards = [...body.querySelectorAll(".card:not(.dragging):not(.selected)")];
    if (idx >= cards.length) {
      body.append(indicator);
    } else {
      body.insertBefore(indicator, cards[idx]);
    }
  }

  function dropIndex(body, y, draggingId) {
    const cards = [...body.querySelectorAll(".card:not(.dragging):not(.selected)")];
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return cards.length;
  }

  async function moveTask(id, column, order) {
    const t = tasks.get(id);
    if (!t) return;
    const snap = { column: t.column, order: t.order };
    Object.assign(t, { column, order });
    renderBoard();
    try {
      await api("PATCH", `/api/tasks/${id}`, { column, order });
    } catch (e) {
      Object.assign(t, snap);
      renderBoard();
      flashInvalidDrop(t.column || column);
      alert(`Move failed: ${e.message}`);
    }
  }

  async function moveTasks(ids, column, order) {
    // Optimistic move: place all into the destination column at consecutive
    // orders starting at `order`. We snap each so we can roll them back on error.
    const snaps = [];
    for (const id of ids) {
      const t = tasks.get(id);
      if (!t) continue;
      snaps.push({ id, snap: { column: t.column, order: t.order } });
      Object.assign(t, { column });
    }
    // Re-sort orders within the destination column.
    const colTasks = [...tasks.values()].filter((t) => t.column === column).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    // Find the insertion point — it's the first non-dragged card at position `order`.
    const draggedSet = new Set(ids);
    const nonDragged = colTasks.filter((t) => !draggedSet.has(t.id));
    const insertAt = Math.max(0, Math.min(order, nonDragged.length));
    const before = nonDragged.slice(0, insertAt);
    const after = nonDragged.slice(insertAt);
    const finalOrder = [...before, ...colTasks.filter((t) => draggedSet.has(t.id)), ...after];
    finalOrder.forEach((t, i) => { t.order = i; });
    renderBoard();
    try {
      // Send PATCHes sequentially — server re-normalizes each.
      for (const id of ids) {
        const t = tasks.get(id);
        if (!t) continue;
        await api("PATCH", `/api/tasks/${id}`, { column, order: t.order });
      }
    } catch (e) {
      for (const { id, snap } of snaps) {
        const t = tasks.get(id);
        if (t) Object.assign(t, snap);
      }
      renderBoard();
      flashInvalidDrop(column);
      alert(`Move failed: ${e.message}`);
    }
  }

  function flashInvalidDrop(columnId) {
    const col = document.querySelector(`.column[data-column="${columnId}"]`);
    if (!col) return;
    col.classList.add("drag-invalid");
    setTimeout(() => col.classList.remove("drag-invalid"), 250);
  }

  // ---------- Bulk action bar (selection mode) ----------
  // The bar is hidden by default and slides up from the bottom when ≥ 1 card
  // is selected via Ctrl/Cmd-click. Actions POST /api/tasks/bulk with the
  // appropriate `operation.kind`; on success, selection clears and a toast
  // confirms the result.

  const bulkBar = document.getElementById("bulk-bar");
  const bulkCount = document.getElementById("bulk-bar-count");

  function updateBulkBar() {
    if (!bulkBar) return;
    if (selectedIds.size === 0) {
      bulkBar.hidden = true;
      bulkBar.setAttribute("aria-hidden", "true");
      return;
    }
    bulkBar.hidden = false;
    bulkBar.setAttribute("aria-hidden", "false");
    if (bulkCount) {
      const n = selectedIds.size;
      const total = tasks.size;
      bulkCount.textContent = `${n} of ${total} selected`;
    }
  }

  function closeBulkMenus() {
    for (const menu of document.querySelectorAll(".bulk-bar-menu")) menu.hidden = true;
    for (const btn of document.querySelectorAll(".bulk-bar-dropdown > .bulk-bar-btn")) {
      btn.setAttribute("aria-expanded", "false");
    }
  }

  function toggleBulkMenu(menu, btn) {
    const wasOpen = !menu.hidden;
    closeBulkMenus();
    if (!wasOpen) {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
  }

  // Wire the dropdown triggers + menu items.
  function attachBulkBar() {
    if (!bulkBar) return;
    const moveBtn = document.getElementById("bulk-move-btn");
    const moveMenu = document.getElementById("bulk-move-menu");
    const prioBtn = document.getElementById("bulk-priority-btn");
    const prioMenu = document.getElementById("bulk-priority-menu");

    if (moveBtn && moveMenu) {
      moveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleBulkMenu(moveMenu, moveBtn);
      });
      for (const item of moveMenu.querySelectorAll("button[data-column]")) {
        item.addEventListener("click", async () => {
          const col = item.getAttribute("data-column");
          closeBulkMenus();
          if (!col) return;
          await runBulkOperation({ kind: "move", taskIds: [...selectedIds], column: col });
        });
      }
    }
    if (prioBtn && prioMenu) {
      prioBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleBulkMenu(prioMenu, prioBtn);
      });
      for (const item of prioMenu.querySelectorAll("button[data-priority]")) {
        item.addEventListener("click", async () => {
          const pri = item.getAttribute("data-priority");
          closeBulkMenus();
          if (!pri) return;
          await runBulkOperation({ kind: "priority", taskIds: [...selectedIds], priority: pri });
        });
      }
    }
    const archBtn = document.getElementById("bulk-archive-btn");
    if (archBtn) {
      archBtn.addEventListener("click", async () => {
        await runBulkOperation({ kind: "archive", taskIds: [...selectedIds] });
      });
    }
    const delBtn = document.getElementById("bulk-delete-btn");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        if (selectedIds.size === 0) return;
        // Snapshot every selected task so we can Undo within the toast
        // window. Use undo toast instead of a confirm dialog (which was
        // reliably either ignored or auto-dismissed by browser focus quirks).
        const ids = [...selectedIds];
        const snaps = new Map();
        for (const id of ids) {
          const t = tasks.get(id);
          if (t) snaps.set(id, { ...t });
        }
        await runBulkOperation({ kind: "delete", taskIds: ids });
        showUndoToast(`Deleted ${ids.length} task${ids.length === 1 ? "" : "s"}.`, () => {
          for (const [id, snap] of snaps) tasks.set(id, snap);
          renderBoard();
          showUndoToast(`Restored ${snaps.size} task${snaps.size === 1 ? "" : "s"}.`, () => {
            runBulkOperation({ kind: "delete", taskIds: ids });
          });
        });
      });
    }
    const clearBtn = document.getElementById("bulk-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", clearCardSelection);
    }

    // Click-outside closes any open dropdown menu.
    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".bulk-bar-dropdown")) closeBulkMenus();
    }, true);
  }

  // Send a bulk operation. Falls back to per-task PATCH/DELETE if the bulk
  // endpoint is not implemented yet (404) — the brief assumes Thor is adding
  // it; this keeps the UI functional during the rollout.
  async function runBulkOperation(operation) {
    const ids = operation.taskIds || [];
    if (ids.length === 0) return;
    const snapshot = new Map();
    for (const id of ids) {
      const t = tasks.get(id);
      if (t) snapshot.set(id, { ...t });
    }
    // Optimistic local update so the UI reacts immediately.
    if (operation.kind === "move") {
      for (const id of ids) {
        const t = tasks.get(id);
        if (t) t.column = operation.column;
      }
    } else if (operation.kind === "priority") {
      for (const id of ids) {
        const t = tasks.get(id);
        if (t) t.priority = operation.priority;
      }
    } else if (operation.kind === "archive") {
      for (const id of ids) {
        const t = tasks.get(id);
        if (t) t.archived = true;
      }
    } else if (operation.kind === "delete") {
      for (const id of ids) tasks.delete(id);
    }
    renderBoard();
    clearCardSelection();

    const summary = describeBulkOp(operation);
    let usedFallback = false;
    try {
      await api("POST", "/api/tasks/bulk", { operation });
    } catch (err) {
      // Fallback path — server endpoint not implemented yet. Walk the ids.
      usedFallback = true;
      try {
        if (operation.kind === "move" || operation.kind === "priority") {
          for (const id of ids) {
            const body = operation.kind === "move"
              ? { column: operation.column }
              : { priority: operation.priority };
            await api("PATCH", `/api/tasks/${id}`, body);
          }
        } else if (operation.kind === "archive") {
          for (const id of ids) {
            await api("POST", `/api/tasks/${id}/archive`);
          }
        } else if (operation.kind === "delete") {
          for (const id of ids) {
            await api("DELETE", `/api/tasks/${id}`);
          }
        }
      } catch (fallbackErr) {
        // Roll back optimistic changes and re-render.
        for (const [id, snap] of snapshot) tasks.set(id, snap);
        for (const id of ids) if (!snapshot.has(id)) tasks.delete(id);
        renderBoard();
        showToast(`${summary} failed: ${fallbackErr.message}`, "error");
        return;
      }
    }
    // Always clear selection after success.
    clearCardSelection();
    showToast(`${summary}`, usedFallback ? "success" : "success");
  }

  function describeBulkOp(op) {
    const n = (op.taskIds || []).length;
    const noun = n === 1 ? "task" : "tasks";
    switch (op.kind) {
      case "move": {
        const col = (COLUMNS.find((c) => c.id === op.column) || {}).title || op.column;
        return `Moved ${n} ${noun} to ${col}`;
      }
      case "priority": {
        const label = (PRIORITY_META[op.priority] || {}).label || op.priority;
        return `Set priority to ${label} on ${n} ${noun}`;
      }
      case "archive": return `Archived ${n} ${noun}`;
      case "delete":  return `Deleted ${n} ${noun}`;
      default: return `Bulk operation on ${n} ${noun}`;
    }
  }

  function showToast(message, kind = "success") {
    if (window.OpenKanSettings?.showToast) {
      window.OpenKanSettings.showToast(message, kind);
      return;
    }
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = el("div", `toast toast-${kind}`, { text: message });
    container.append(toast);
    // 4s auto-dismiss (UX spec). Use the .toast-leaving class so the fade +
    // slide animation matches the entry animation defined in style.css.
    setTimeout(() => {
      toast.classList.add("toast-leaving");
      setTimeout(() => toast.remove(), 220);
    }, 4000);
  }

  // ---------- Search (debounced live filter) ----------
  function attachSearch() {
    const input = document.getElementById("search-input");
    const meta = document.getElementById("search-meta");
    if (!input) return;

    // Initial value from filter state (restored from URL hash on boot).
    input.value = filter.search || "";

    input.addEventListener("input", () => {
      const value = input.value;
      filter.search = value;
      writeHashFilter();
      if (searchDebounce) clearTimeout(searchDebounce);
      if (!value) {
        // Empty query — show everything immediately and skip the server call.
        searchMatchIds = null;
        renderBoard();
        updateSearchMeta(meta, null, null);
        return;
      }
      // Optimistic local filter so the board updates instantly while the
      // debounced server call is in flight.
      searchMatchIds = null;
      renderBoard();
      searchDebounce = setTimeout(() => runSearch(value, meta), 200);
    });

    // ESC clears the search input when it has focus.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) {
        e.preventDefault();
        e.stopPropagation();
        input.value = "";
        filter.search = "";
        writeHashFilter();
        searchMatchIds = null;
        renderBoard();
        updateSearchMeta(meta, null, null);
      }
    });
  }

  async function runSearch(q, metaEl) {
    const mySeq = ++searchSeq;
    const params = new URLSearchParams();
    params.set("q", q);
    if (filter.category && filter.category !== "all") params.set("category", filter.category);
    if (filter.tags.length > 0) params.set("tags", filter.tags.join(","));
    if (filter.contributor && filter.contributor !== "all") params.set("contributor", filter.contributor);
    if (filter.priority && filter.priority !== "all") params.set("priority", filter.priority);
    if (filter.column && filter.column !== "all") params.set("column", filter.column);
    if (filter.archive === "archived" || filter.archive === "both") params.set("archived", "true");

    updateSearchMeta(metaEl, "searching", null);

    let payload;
    try {
      payload = await api("GET", `/api/search?${params.toString()}`);
    } catch (err) {
      // Endpoint not implemented yet — fall back to local-only filtering.
      if (mySeq !== searchSeq) return;
      const matched = [...tasks.values()].filter((t) => taskTextMatchesQuery(t, q.toLowerCase())).length;
      searchMatchIds = null;
      renderBoard();
      updateSearchMeta(metaEl, "fallback", matched);
      return;
    }
    if (mySeq !== searchSeq) return; // a newer query has superseded this one
    const list = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
    const matchedIds = new Set(list.map((t) => t.id));
    searchMatchIds = matchedIds;
    const total = typeof payload?.total === "number" ? payload.total : matchedIds.size;
    renderBoard();
    updateSearchMeta(metaEl, "ok", total);
  }

  function updateSearchMeta(metaEl, state, total) {
    if (!metaEl) return;
    if (state == null) {
      metaEl.textContent = "";
      metaEl.removeAttribute("data-state");
      return;
    }
    if (state === "searching") {
      metaEl.textContent = "searching…";
      metaEl.setAttribute("data-state", "searching");
      return;
    }
    if (state === "fallback") {
      metaEl.textContent = total != null ? `~${total} match (local)` : "";
      metaEl.setAttribute("data-state", "fallback");
      return;
    }
    if (state === "ok") {
      metaEl.textContent = total != null ? `${total} match${total === 1 ? "" : "es"}` : "";
      metaEl.setAttribute("data-state", "ok");
      return;
    }
  }

  // ---------- SSE wiring (delegates to OpenKanAPI) ----------
  function applySnapshot(snap) {
    if (!snap) return;
    const list = Array.isArray(snap) ? snap : snap?.tasks || [];
    tasks.clear();
    for (const t of list) tasks.set(t.id, t);
    renderBoard();
    // Re-fetch if a search query is active so the match count stays accurate.
    if (filter.search) {
      const meta = document.getElementById("search-meta");
      runSearch(filter.search, meta);
    }
  }

  on("board.snapshot", (snap) => { applySnapshot(snap); setConnected(true); });
  on("task.created", (payload) => {
    const t = payload?.task ?? payload;
    if (t && t.id) { tasks.set(t.id, t); renderBoard(); }
  });
  on("task.updated", (payload) => {
    const t = payload?.task ?? payload;
    if (t && t.id) { tasks.set(t.id, t); renderBoard(); }
  });
  on("task.deleted", (payload) => {
    const id = payload?.id;
    if (id && tasks.delete(id)) renderBoard();
  });
  // Filter change from another tab (or an SSE broadcast) — re-read hash and
  // re-render. Updates the search run too so the meta count stays accurate.
  on("filter.changed", () => {
    const next = readHashFilter();
    if (!next) return;
    const searchChanged = next.search !== filter.search;
    filter.category = next.category;
    filter.tags = next.tags;
    filter.contributor = next.contributor;
    filter.archive = next.archive;
    filter.sort = next.sort;
    filter.search = next.search || "";
    if (searchChanged) {
      const input = document.getElementById("search-input");
      if (input) input.value = filter.search;
      searchMatchIds = null;
      if (filter.search) {
        const meta = document.getElementById("search-meta");
        runSearch(filter.search, meta);
      }
    }
    applyFilterToButtons();
    renderBoard();
  });
  // Theme change from another tab — re-render so any color tokens (or
  // programmatically rendered colors) re-evaluate, even though the CSS rules
  // are already data-theme reactive.
  on("theme.changed", () => { renderBoard(); });
  // Forward-compatible handlers for events Thor is adding alongside the
  // bulk / image / template work. Each one triggers a board re-fetch so the
  // UI stays consistent even if the server changes the payload shape later.
  const REFRESH_EVENTS = [
    "task.bulk",
    "bulk.updated",
    "task.image-added",
    "task.image-deleted",
    "task.images-cleared",
    "task.archived",
    "task.restored",
    "task.changed",
    "session.ended",
    "tasks.reordered",
  ];
  for (const evt of REFRESH_EVENTS) {
    on(evt, async () => {
      try {
        const snap = await api("GET", "/api/board");
        applySnapshot(snap);
      } catch {}
    });
  }

  // ---------- M13 — keyboard navigation, palette wiring, cross-tab ----------
  // The keyboard module publishes named events; we attach handlers that
  // update the focused card, the selection, or trigger bulk operations.
  function columnBodies() {
    return Array.from(document.querySelectorAll(".board .column .column-body"));
  }
  function cardsInBody(body) {
    return Array.from(body.querySelectorAll(".card[data-id]"));
  }
  function focusedCardEl() {
    const id = window.OpenKanKeyboard?.getFocusedId?.();
    if (!id) return null;
    const board = document.getElementById("board");
    if (!board) return null;
    let card;
    try { card = board.querySelector(`.card[data-id="${CSS.escape(id)}"]`); }
    catch { card = board.querySelector(`.card[data-id="${id}"]`); }
    return card || null;
  }
  function findCardPosition() {
    const fc = focusedCardEl();
    if (!fc) return null;
    const body = fc.closest(".column-body");
    const bodies = columnBodies();
    const bodyIdx = bodies.indexOf(body);
    if (bodyIdx < 0) return null;
    const cards = cardsInBody(body);
    return { bodyIdx, cardIdx: cards.indexOf(fc), bodies };
  }
  function nextColumnFirstCard(fromIdx, bodies) {
    if (!bodies) bodies = columnBodies();
    for (let i = 1; i <= bodies.length; i++) {
      const idx = (fromIdx + i) % bodies.length;
      const cards = cardsInBody(bodies[idx]);
      if (cards.length > 0) return cards[0];
    }
    return null;
  }
  function prevColumnLastCard(fromIdx, bodies) {
    if (!bodies) bodies = columnBodies();
    for (let i = 1; i <= bodies.length; i++) {
      const idx = (fromIdx - i + bodies.length) % bodies.length;
      const cards = cardsInBody(bodies[idx]);
      if (cards.length > 0) return cards[cards.length - 1];
    }
    return null;
  }

  function moveFocus(direction) {
    const bodies = columnBodies();
    if (bodies.length === 0) return;
    const pos = findCardPosition();
    let target = null;
    if (!pos) {
      // No focus yet — start at the first card of the first column.
      target = cardsInBody(bodies[0])[0] || null;
    } else if (direction === "next") {
      const cards = cardsInBody(bodies[pos.bodyIdx]);
      if (pos.cardIdx + 1 < cards.length) target = cards[pos.cardIdx + 1];
      else target = nextColumnFirstCard(pos.bodyIdx, bodies);
    } else if (direction === "previous") {
      const cards = cardsInBody(bodies[pos.bodyIdx]);
      if (pos.cardIdx > 0) target = cards[pos.cardIdx - 1];
      else target = prevColumnLastCard(pos.bodyIdx, bodies);
    } else if (direction === "column-next") {
      target = nextColumnFirstCard(pos ? pos.bodyIdx : 0, bodies);
    } else if (direction === "column-prev") {
      target = prevColumnLastCard(pos ? pos.bodyIdx : 0, bodies);
    }
    if (!target) return;
    window.OpenKanKeyboard.setFocusedId(target.dataset.id);
    renderBoard();
    window.OpenKanKeyboard.scrollFocusedIntoView();
  }

  function focusedIdsForBulk() {
    if (selectedIds.size > 0) return [...selectedIds];
    const id = window.OpenKanKeyboard?.getFocusedId?.();
    return id ? [id] : [];
  }

  function openFocused() {
    const id = window.OpenKanKeyboard?.getFocusedId?.();
    if (!id) return;
    window.OpenKanTaskView?.open?.(id);
  }

  function toggleFocusSelection() {
    const id = window.OpenKanKeyboard?.getFocusedId?.();
    if (!id) return;
    let card = focusedCardEl();
    if (!card) {
      // Card isn't in the DOM (filtered out, archived, etc.) — still flip
      // the selected set so the bulk bar shows up.
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      updateBulkBar();
      return;
    }
    toggleCardSelection(card, id);
  }

  function moveSelectedTo(columnIdx) {
    const col = COLUMNS[columnIdx];
    if (!col) return;
    const ids = focusedIdsForBulk();
    if (ids.length === 0) return;
    runBulkOperation({ kind: "move", taskIds: ids, column: col.id });
  }

  function archiveSelected() {
    const ids = focusedIdsForBulk();
    if (ids.length === 0) return;
    runBulkOperation({ kind: "archive", taskIds: ids });
  }

  function deleteSelected() {
    const ids = focusedIdsForBulk();
    if (ids.length === 0) return;
    // The 'd' keyboard shortcut — drop the confirm dialog so the action
    // feels instantaneous. The destructive op still goes through the bulk
    // delete path which already triggers a toast on success.
    const snaps = new Map();
    for (const id of ids) {
      const t = tasks.get(id);
      if (t) snaps.set(id, { ...t });
    }
    runBulkOperation({ kind: "delete", taskIds: ids });
    showUndoToast(`Deleted ${ids.length} task${ids.length === 1 ? "" : "s"}.`, () => {
      for (const [id, snap] of snaps) tasks.set(id, snap);
      renderBoard();
      showUndoToast(`Restored ${snaps.size} task${snaps.size === 1 ? "" : "s"}.`, () => {
        runBulkOperation({ kind: "delete", taskIds: ids });
      });
    });
  }

  function focusSearch() {
    const input = document.getElementById("search-input");
    if (input) {
      input.focus();
      try { input.select(); } catch {}
    }
  }

  // Theme cycle — dark → light → system → dark.
  function cycleTheme() {
    const order = ["dark", "light", "system"];
    const cur = (window.OpenKanSettings?.currentTheme?.() || "dark").toLowerCase();
    const next = order[(order.indexOf(cur) + 1) % order.length] || "dark";
    if (window.OpenKanSettings?.applyTheme) {
      window.OpenKanSettings.applyTheme(next);
      // Broadcast to siblings so they pick up the change without an SSE round-trip.
      try { window.OpenKanCrossTab?.publish?.("theme.changed", { theme: next }); } catch {}
      showToast(`Theme: ${next}`);
    }
  }

  function attachKeyboard() {
    const K = window.OpenKanKeyboard;
    if (!K) return;
    K.on("focus.next", () => moveFocus("next"));
    K.on("focus.previous", () => moveFocus("previous"));
    K.on("focus.column-next", () => moveFocus("column-next"));
    K.on("focus.column-prev", () => moveFocus("column-prev"));
    K.on("focus.open", () => openFocused());
    K.on("focus.toggle-select", () => toggleFocusSelection());
    K.on("action.move-column", (idx) => moveSelectedTo(idx));
    K.on("action.archive", () => archiveSelected());
    K.on("action.delete", () => deleteSelected());
    K.on("action.edit", () => {
      // 'e' on a focused card: open the Edit Task modal directly. If no
      // card is focused but a task view is open, edit the currently open
      // task. If neither, fall back to opening the focused card first.
      const focusedId = window.OpenKanKeyboard?.getFocusedId?.();
      const openTaskId = window.OpenKanTaskView?.getCurrentTaskId?.();
      if (focusedId) {
        openEditModal(focusedId);
      } else if (openTaskId) {
        openEditModal(openTaskId);
      } else {
        openFocused();
      }
    });
    K.on("search.focus", () => focusSearch());
  }

  // ─── Command palette registration ────────────────────────────────────────
  // App owns the action set; the palette just renders and invokes whatever's
  // registered. The task provider exposes cards that match the search query.
  function registerPaletteActions() {
    const palette = window.OpenKanCommandPalette;
    if (!palette) return;
    const unregisters = [];
    unregisters.push(palette.registerAction({
      id: "new-task",
      label: "New task",
      hint: "Create a task",
      run: () => document.getElementById("new-task-btn")?.click(),
    }));
    unregisters.push(palette.registerAction({
      id: "open-settings",
      label: "Open Settings",
      hint: "Project, theme, archive",
      run: () => document.getElementById("settings-btn")?.click(),
    }));
    unregisters.push(palette.registerAction({
      id: "open-tasks",
      label: "Open Tasks tab",
      hint: "Kanban board",
      run: () => window.OpenKanTabs?.activate?.("tasks"),
    }));
    unregisters.push(palette.registerAction({
      id: "open-changelog",
      label: "Open Changelog tab",
      hint: "Recent activity",
      run: () => window.OpenKanTabs?.activate?.("changelog"),
    }));
    unregisters.push(palette.registerAction({
      id: "open-contributors",
      label: "Open Contributors tab",
      hint: "Team overview",
      run: () => window.OpenKanTabs?.activate?.("contributors"),
    }));
    unregisters.push(palette.registerAction({
      id: "toggle-theme",
      label: "Toggle theme",
      hint: "Dark → light → system",
      run: () => cycleTheme(),
    }));
    unregisters.push(palette.registerAction({
      id: "clear-filters",
      label: "Clear all filters",
      hint: "Reset board view",
      run: () => {
        filter.category = "all";
        filter.tags = [];
        filter.contributor = "all";
        filter.search = "";
        searchMatchIds = null;
        writeHashFilter();
        applyFilterToButtons();
        renderBoard();
        try {
          window.OpenKanCrossTab?.publish?.("filter.changed", { hash: window.location.hash });
        } catch {}
      },
    }));
    unregisters.push(palette.registerAction({
      id: "save-filter",
      label: "Save current filter",
      hint: "Name and store the active filter",
      run: async () => {
        // Same path as the filter-bar Save button — go through the custom
        // inline modal so it works in headless / embedded contexts.
        const name = await promptForName("Save filter as:", "");
        if (name && saveCurrentFilter(name)) {
          showToast(`Saved filter "${name}"`);
        }
      },
    }));
    unregisters.push(palette.registerAction({
      id: "reload",
      label: "Reload page",
      hint: "Hard reload",
      run: () => window.location.reload(),
    }));
    unregisters.push(palette.registerAction({
      id: "help-shortcuts",
      label: "Show keyboard shortcuts",
      hint: "Open the ? help overlay",
      run: () => window.OpenKanKeyboard?.showHelp?.(),
    }));

    // Task provider — palette searches every task this tab has loaded.
    unregisters.push(palette.registerTaskProvider((q) => {
      const out = [];
      for (const t of tasks.values()) {
        if (!t || !t.id) continue;
        out.push({
          id: t.id,
          title: t.title || "(untitled)",
          subtitle: (COLUMNS.find((c) => c.id === t.column) || {}).title || t.column,
          run: () => window.OpenKanTaskView?.open?.(t.id),
        });
      }
      return out;
    }));
    return () => { for (const u of unregisters) try { u(); } catch {} };
  }

  // ─── Cross-tab subscribe (mirror SSE for sibling-tab updates) ───────────
  // OpenKanAPI already forwards each cross-tab event to the local event bus,
  // so the handlers above (board.snapshot, filter.changed, theme.changed,
  // task.*/comment.*/input.*) all run from cross-tab events too. There is
  // nothing left to subscribe here besides re-publishing the hash as it
  // changes so siblings can sync filters.
  let lastPublishedHash = null;
  function attachCrossTab() {
    if (!window.OpenKanCrossTab) return;
    // Publish hash changes so other tabs can sync their filter view.
    const publish = () => {
      const hash = window.location.hash || "";
      if (hash === lastPublishedHash) return;
      lastPublishedHash = hash;
      try { window.OpenKanCrossTab.publish("filter.changed", { hash }); } catch {}
    };
    window.addEventListener("hashchange", publish);
    publish();
  }

  // Expose the action helpers so external callers (tests, future modules)
  // can drive the keyboard nav from JS the same way the keyboard module does.
  window.OpenKanBoardActions = {
    moveFocus,
    openFocused,
    toggleFocusSelection,
    moveSelectedTo,
    archiveSelected,
    deleteSelected,
    focusSearch,
    cycleTheme,
    openEditModal,
  };

  // Edit Task modal — exposed so task-view.js can open it from the
  // footer ("Edit" button) without each module wiring its own API.
  window.OpenKanEditTask = {
    open: openEditModal,
    isOpen() {
      const b = document.getElementById("edit-backdrop");
      return !!(b && !b.hidden);
    },
  };


  // ---------- Modal ----------

  // Custom inline name prompt. `window.prompt()` is blocked in headless
  // Chrome and in some embedded contexts, so the 💾 Save filter button and
  // its command-palette sibling both go through this instead. Built on top
  // of the same `.modal-backdrop` / `.modal` shell as the rest of the
  // dashboard so it inherits theme variables and backdrop-click behaviour.
  // Resolves with the trimmed value on OK / Enter, or null on Cancel /
  // Escape / backdrop click / empty input.
  function promptForName(title, defaultValue = "") {
    return new Promise((resolve) => {
      const safeTitle = String(title ?? "Enter a name");
      const bd = document.createElement("div");
      bd.className = "modal-backdrop prompt-modal";
      bd.style.zIndex = "120";
      const modal = document.createElement("div");
      modal.className = "modal";
      modal.style.maxWidth = "420px";
      modal.innerHTML = `
        <header class="modal-header">
          <h2></h2>
          <button class="btn-icon" type="button" data-cancel aria-label="Close">&times;</button>
        </header>
        <div class="modal-body">
          <label class="field">
            <span>Name</span>
            <input type="text" autocomplete="off" />
          </label>
        </div>
        <footer class="modal-footer">
          <button class="btn" type="button" data-cancel>Cancel</button>
          <button class="btn btn-primary" type="button" data-ok>OK</button>
        </footer>
      `;
      bd.appendChild(modal);
      document.body.appendChild(bd);
      bd.hidden = false;
      const heading = modal.querySelector("h2");
      const input = modal.querySelector("input");
      if (heading) heading.textContent = safeTitle;
      if (input) input.value = String(defaultValue ?? "");
      if (input) {
        input.focus();
        input.select();
      }
      function cleanup(result) {
        bd.remove();
        resolve(result);
      }
      modal.querySelector("[data-ok]").addEventListener("click", () => {
        cleanup(input?.value?.trim() || null);
      });
      modal.querySelectorAll("[data-cancel]").forEach((b) =>
        b.addEventListener("click", () => cleanup(null)),
      );
      bd.addEventListener("mousedown", (ev) => {
        if (ev.target === bd) cleanup(null);
      });
      input?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") cleanup(input.value.trim() || null);
        else if (ev.key === "Escape") cleanup(null);
      });
    });
  }

  function openModal() {
    if (!modal) return;
    modal.hidden = false;
    if (form) {
      form.reset();
      form.elements.title?.focus();
      // Apply default column from saved settings (if any).
      try {
        const raw = localStorage.getItem("openkan:settings");
        if (raw && form.elements.column) {
          const parsed = JSON.parse(raw);
          const def = parsed?.project?.defaultColumn;
          if (def) form.elements.column.value = def;
        }
      } catch {}
    }
  }
  function closeModal() {
    if (modal) modal.hidden = true;
  }
  if ($("new-task-btn")) $("new-task-btn").addEventListener("click", openModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
    document.querySelectorAll("[data-close-modal]").forEach((b) =>
      b.addEventListener("click", closeModal),
    );
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Clear selection first — never silently lost work to a stray Esc.
      if (selectedIds.size > 0 && !e.target?.closest?.("input, textarea")) {
        clearCardSelection();
        return;
      }
      closeModal();
      closeBulkMenus();
      if (menu) menu.hidden = true;
    }
  });
  if (form) {
    // Browse button: lets the user pick a project path for the new task.
    // Reuses the same path picker as the Add Project modal. The server's
    // POST /api/tasks may or may not honour `root` — if not, the task is
    // created against the active project (the previous behaviour).
    const browseBtn = document.getElementById("new-task-browse-btn");
    const rootInput = form.querySelector('input[name="root"]');
    if (browseBtn && rootInput) {
      browseBtn.addEventListener("click", () => {
        const picker = window.OpenKanPathPicker;
        if (!picker || typeof picker.open !== "function") {
          console.warn(
            "[new-task-modal] Browse clicked but OpenKanPathPicker is not loaded",
          );
          return;
        }
        picker.open({
          title: "Choose a project folder",
          mode: "folder",
          initialPath: rootInput.value?.trim() || undefined,
          onPick: (path) => {
            rootInput.value = path;
          },
          onCancel: () => {
            /* user dismissed — nothing to do */
          },
        });
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get("title") || "").trim();
      if (!title) return alert("Title is required");
      const body = {
        title,
        description: String(fd.get("description") || ""),
        column: String(fd.get("column") || "todo"),
        agent: String(fd.get("agent") || ""),
        model: String(fd.get("model") || ""),
      };
      // Optional project path. If the server doesn't accept `root` the task
      // is created against the active project (existing behaviour).
      const root = String(fd.get("root") || "").trim();
      if (root) body.root = root;
      // parentId is hidden in the form. Optional — only sent when populated
      // by the "+ Add subtask" flow so the cascade knows the new task is a
      // child of an existing task.
      const parentId = String(fd.get("parentId") || "").trim();
      if (parentId) body.parentId = parentId;
      closeModal();
      form.reset();
      // Clear the hidden parentId so the next open defaults back to "no
      // parent" — otherwise subsequent non-subtask creates would still
      // carry the previous parent's id.
      const parentField = form.elements.parentId;
      if (parentField) parentField.value = "";
      try {
        const res = await api("POST", "/api/tasks", body);
        if (res && res.id) {
          tasks.set(res.id, res);
          renderBoard();
          // If we just created a subtask, the parent's task view (if open)
          // should re-render so the new child appears in the list.
          if (parentId && window.OpenKanTaskView?.getCurrentTaskId?.() === parentId) {
            window.OpenKanTaskView.open(parentId);
          }
        }
      } catch (err) {
        openModal();
        alert(`Create failed: ${err.message}`);
      }
    });
  }

  // ---------- Tab router ----------
  function activateTab(name, opts = {}) {
    const valid = ["tasks", "changelog", "contributors", "docs", "bizar"];
    if (!valid.includes(name)) name = "tasks";
    for (const btn of document.querySelectorAll(".tab")) {
      const isActive = btn.dataset.tab === name;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    for (const pane of document.querySelectorAll(".tab-pane")) {
      const isActive = pane.dataset.tab === name;
      pane.hidden = !isActive;
    }
    // Update URL hash, preserving other params.
    if (!opts.fromHash) {
      const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      params.set("tab", name);
      const next = `#${params.toString()}`;
      if (window.location.hash !== next) {
        const url = window.location.pathname + window.location.search + next;
        window.history.replaceState(null, "", url);
      }
    }
    // Lazy-mount views.
    if (name === "changelog") {
      const root = document.getElementById("changelog-root");
      if (root && window.OpenKanChangelog) window.OpenKanChangelog.mount(root);
    } else if (name === "contributors") {
      const root = document.getElementById("contributors-root");
      if (root && window.OpenKanContributors) window.OpenKanContributors.mount(root);
    } else if (name === "docs") {
      const root = document.getElementById("docs-root");
      if (root && window.OpenKanDocs) {
        // Pass through the requested file from the hash (if any), so a
        // `#tab=docs&doc=README.mdx` URL restores the last-viewed file.
        const initial = readHashFilter();
        window.OpenKanDocs.mount(root, { initialDoc: initial?.doc || "" });
      }
    } else if (name === "bizar") {
      const root = document.getElementById("bizar-root");
      if (root && window.OpenKanBizar) window.OpenKanBizar.mount(root);
    } else if (name === "tasks") {
      // Unmount non-active views to free any subscriptions.
      window.OpenKanChangelog?.unmount?.();
      window.OpenKanContributors?.unmount?.();
      window.OpenKanDocs?.unmount?.();
      window.OpenKanBizar?.unmount?.();
    }
  }

  function attachTabRouter() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab || "tasks"));
    });
  }

  // ---------- Contributors sidebar (filter row + helpers) ----------
  async function loadContributors() {
    try {
      const data = await api("GET", "/api/contributors");
      const list = Array.isArray(data?.contributors) ? data.contributors : Array.isArray(data) ? data : [];
      currentUser = data?.currentUser || null;
      if (currentUser && currentUser.email) {
        // Fallback marker in case server didn't mark list entries.
      }
      contributors.clear();
      for (const c of list) {
        if (c?.email) contributors.set(c.email.toLowerCase(), c);
      }
      // Decorate the contributors filter row with a button per contributor.
      renderContributorFilterRow(list);
    } catch (err) {
      // Soft-fail: the contributors filter row just stays at all | @me.
      console.warn("[app.js] /api/contributors fetch failed:", err);
    }
  }

  function renderContributorFilterRow(list) {
    const row = document.getElementById("filter-contributors");
    if (!row) return;
    // Remove any prior contributor entries (keep the fixed all/@me buttons).
    row.querySelectorAll("button[data-contributor]:not([data-contributor='all']):not([data-contributor='@me'])")
      .forEach((b) => b.remove());
    // Decorate the @me button with an avatar showing the current user's
    // initials and a deterministic color — matches the contributor chips.
    const meBtn = row.querySelector('button[data-contributor="@me"]');
    if (meBtn) {
      meBtn.innerHTML = "";
      const meName = currentUser?.name || currentUser?.email || "me";
      const meSeed = currentUser?.email || meName;
      const meAv = el("span", "contrib-avatar");
      meAv.style.background = avatarColorFor(meSeed);
      meAv.textContent = initialsFor(meName);
      meBtn.append(meAv, el("span", "contrib-name", { text: "@me" }));
    }
    for (const c of list || []) {
      if (!c?.email) continue;
      const btn = el("button", null, {
        type: "button",
        "data-contributor": c.email,
        title: c.email,
      });
      const av = el("span", "contrib-avatar");
      av.style.background = avatarColorFor(c.email);
      av.textContent = initialsFor(c.name || c.email);
      btn.append(av, el("span", "contrib-name", { text: c.name || c.email }));
      if (filter.contributor === c.email) btn.classList.add("active");
      row.append(btn);
    }
  }

  // ---------- Project switcher + brand chip -----------------------------
  // Manages the topbar dropdown that lists every registered project plus the
  // "+ Add project…" affordance. Uses the multi-project registry at
  // /api/projects, which Thor wires up server-side; until that endpoint
  // exists the dropdown degrades gracefully (just shows an empty list with
  // the Add option).
  const projectSwitcher = {
    /** Cached project list — null until first fetch. */
    list: null,
    /** The currently active project entry. */
    active: null,
    /** Last error message, surfaced in the popover. */
    error: null,
  };

  async function fetchProjects() {
    try {
      const data = await api("GET", "/api/projects");
      const list = Array.isArray(data?.projects) ? data.projects : Array.isArray(data) ? data : [];
      projectSwitcher.list = list;
      projectSwitcher.active = list.find((p) => p.active) || list[0] || null;
      projectSwitcher.error = null;
      return list;
    } catch (err) {
      projectSwitcher.error = err?.message || String(err);
      projectSwitcher.list = [];
      projectSwitcher.active = null;
      return [];
    }
  }

  function truncateName(name, max = 14) {
    const s = String(name || "");
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  function renderProjectChip() {
    const label = document.getElementById("project-switcher-label");
    const brand = document.getElementById("brand-project-name");
    const dot = document.querySelector(".project-switcher-dot");
    const bdot = document.querySelector(".brand-project-dot");
    const name = projectSwitcher.active?.name || "no project";
    if (label) label.textContent = truncateName(name);
    if (brand) brand.textContent = name;
    if (dot) dot.classList.toggle("is-empty", !projectSwitcher.active);
    if (bdot) bdot.classList.toggle("is-empty", !projectSwitcher.active);
  }

  // IDs of every button that can OPEN the popover. The dismiss listener
  // ignores mousedowns on these so the trigger's own click handler can
  // decide whether to toggle. Without this, clicking the brand chip while
  // the popover is open would: (1) mousedown capture phase → close the
  // popover because the brand chip isn't the recorded anchor; (2) click
  // on the chip → handler sees pop.hidden=true → reopens it. The net
  // result is the toggle looks broken from the user's perspective.
  const PROJECT_TRIGGER_IDS = ["project-switcher-btn", "brand-project-chip"];

  function closeProjectPopover() {
    const pop = document.getElementById("project-switcher-popover");
    // Clear aria-expanded on BOTH trigger buttons — either one could have
    // opened the popover, and either one should now report "collapsed".
    const btn = document.getElementById("project-switcher-btn");
    const chip = document.getElementById("brand-project-chip");
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (chip) chip.setAttribute("aria-expanded", "false");
    detachProjectPopoverDismiss();
  }

  // Module-scope so we can remove the listener on close. Using a 50ms defer
  // avoids the click-that-opened-the-popover from also being the click that
  // immediately dismisses it (the user expects the popover to open first).
  let projectPopoverDismiss = null;

  function attachProjectPopoverDismiss(popover) {
    detachProjectPopoverDismiss();
    const triggerEls = PROJECT_TRIGGER_IDS
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const onDocDown = (ev) => {
      if (!popover || popover.hidden) return;
      if (popover.contains(ev.target)) return;
      for (const el of triggerEls) {
        if (el.contains(ev.target)) return;
      }
      closeProjectPopover();
    };
    const onKey = (ev) => {
      if (ev.key === "Escape" && popover && !popover.hidden) {
        ev.preventDefault();
        ev.stopPropagation();
        closeProjectPopover();
      }
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    projectPopoverDismiss = () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }
  function detachProjectPopoverDismiss() {
    if (projectPopoverDismiss) {
      try { projectPopoverDismiss(); } catch {}
      projectPopoverDismiss = null;
    }
  }

  // Position the popover directly below the anchor that opened it. The
  // popover element must already be in the DOM (renderProjectPopover()
  // populates it) so getBoundingClientRect() returns real dimensions.
  function positionPopover(anchorBtn) {
    const pop = document.getElementById("project-switcher-popover");
    if (!pop || !anchorBtn) return;
    const rect = anchorBtn.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    // Default: align the popover's right edge to the anchor's right edge.
    // That's the right look for the topbar-right chip.
    let top = rect.bottom + 6;
    let left = rect.right - popRect.width;
    // The brand chip lives on the LEFT side of the topbar — align the
    // popover's left edge to the anchor's left edge for a more natural
    // visual flow.
    if (anchorBtn.id === "brand-project-chip") {
      left = rect.left;
    }
    // Keep the popover on-screen with a small margin.
    const PAD = 8;
    const maxLeft = window.innerWidth - popRect.width - PAD;
    if (left > maxLeft) left = maxLeft;
    if (left < PAD) left = PAD;
    // If the popover would fall off the bottom, flip it above the anchor.
    if (top + popRect.height > window.innerHeight - PAD) {
      top = rect.top - popRect.height - 6;
    }
    if (top < PAD) top = PAD;
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  function openProjectPopover(anchorBtn) {
    const pop = document.getElementById("project-switcher-popover");
    const btn = document.getElementById("project-switcher-btn");
    const chip = document.getElementById("brand-project-chip");
    if (!pop) return;
    renderProjectPopover();
    pop.hidden = false;
    // Mark BOTH trigger buttons as expanded so screen readers and CSS
    // stay in sync regardless of which one opened the popover.
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (chip) chip.setAttribute("aria-expanded", "true");
    // Position the popover below the anchor that opened it.
    positionPopover(anchorBtn);
    // Defer dismiss-listener attachment so the opening click doesn't
    // immediately close the popover. 50ms is short enough to feel
    // instant but long enough to outlast the opening click event.
    setTimeout(() => attachProjectPopoverDismiss(pop), 50);
  }

  // Single toggle entry point used by both trigger buttons. Decouples
  // the click handler from the mousedown-capture dismiss listener so the
  // two can never race (close-then-reopen) on the same click.
  function toggleProjectPopover(anchorBtn) {
    const pop = document.getElementById("project-switcher-popover");
    if (!pop) return;
    if (!pop.hidden) {
      closeProjectPopover();
      return;
    }
    openProjectPopover(anchorBtn);
  }

  function renderProjectPopover() {
    const pop = document.getElementById("project-switcher-popover");
    if (!pop) return;
    pop.innerHTML = "";
    // Header row — a small "Projects" label so the popover reads as a
    // section header and not just a loose list of buttons. Styled in CSS
    // as a muted, uppercase, letter-spaced label.
    pop.append(el("div", "project-switcher-header", { text: "Projects" }));
    const list = projectSwitcher.list || [];
    if (projectSwitcher.error) {
      pop.append(el("div", "project-switcher-error", {
        text: `Projects unavailable: ${projectSwitcher.error}`,
      }));
    }
    if (list.length === 0 && !projectSwitcher.error) {
      pop.append(el("div", "project-switcher-empty", {
        text: "No projects registered yet.",
      }));
    }
    for (const p of list) {
      const row = el("button", "project-switcher-item", {
        type: "button",
        role: "menuitem",
        title: p.root || p.name,
      });
      if (p.active) row.classList.add("active");
      row.append(el("span", `project-dot${p.active ? " filled" : ""}`, { "aria-hidden": "true" }));
      row.append(el("span", "project-switcher-name", { text: p.name || "(unnamed)" }));
      if (p.active) {
        row.append(el("span", "project-switcher-badge", { text: "active" }));
      }
      // Per-row ✕ — stops propagation so clicking it doesn't switch.
      const x = el("span", "project-switcher-remove", {
        text: "✕",
        title: "Remove this project",
        role: "button",
        "aria-label": `Remove project ${p.name}`,
      });
      x.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Remove project "${p.name}"?`)) return;
        // Close immediately so the popover disappears even before the DELETE
        // request lands. If the delete fails, the toast surfaces the error
        // and the user can re-open the popover to retry.
        closeProjectPopover();
        try {
          await api("DELETE", `/api/projects/${encodeURIComponent(p.id)}`);
          await fetchProjects();
          renderProjectChip();
        } catch (err) {
          showToast(`Failed to remove project: ${err.message}`, "error");
        }
      });
      row.addEventListener("click", async () => {
        // Close immediately so the popover disappears the instant the user
        // picks a project — don't wait for the PATCH to land.
        closeProjectPopover();
        try {
          await api("PATCH", `/api/projects/${encodeURIComponent(p.id)}/active`);
        } catch (err) {
          showToast(`Failed to switch project: ${err.message}`, "error");
          return;
        }
        await fetchProjects();
        renderProjectChip();
        // Hard reload so every module re-fetches against the new project.
        window.location.reload();
      });
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        openProjectContextMenu(ev, p);
      });
      row.append(x);
      pop.append(row);
    }
    if (list.length > 0) {
      pop.append(el("div", "project-switcher-divider"));
    }
    const addRow = el("button", "project-switcher-add", {
      type: "button",
      role: "menuitem",
      text: "+ Add project…",
    });
    addRow.addEventListener("click", () => {
      closeProjectPopover();
      openAddProjectModal();
    });
    pop.append(addRow);
  }

  function openProjectContextMenu(ev, project) {
    // Minimal v1 context menu: "Open in new tab" + "Reveal in file manager".
    const menu = document.createElement("div");
    menu.className = "project-context-menu";
    menu.style.position = "fixed";
    menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 200)}px`;
    menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 100)}px`;
    menu.setAttribute("role", "menu");

    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open in new tab";
    open.addEventListener("click", () => {
      window.open("/", "_blank", "noopener");
      document.body.removeChild(menu);
    });
    menu.append(open);

    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.textContent = "Reveal in file manager";
    reveal.addEventListener("click", async () => {
      try {
        await api("POST", "/api/reveal", { path: project.root });
      } catch (err) {
        // Server may not implement /api/reveal — fall back to clipboard so
        // the user can paste it into their file manager.
        try {
          await navigator.clipboard.writeText(String(project.root || ""));
          showToast(`Copied path: ${project.root}`);
        } catch {
          alert(`Project root: ${project.root}`);
        }
      } finally {
        if (menu.parentNode) menu.parentNode.removeChild(menu);
      }
    });
    menu.append(reveal);

    const close = (e) => {
      if (menu.contains(e.target)) return;
      if (menu.parentNode) menu.parentNode.removeChild(menu);
      document.removeEventListener("click", close, true);
    };
    document.addEventListener("click", close, true);
    document.body.append(menu);
  }

  function getProjectModal() {
    return document.getElementById("project-backdrop");
  }
  function openAddProjectModal() {
    const bd = getProjectModal();
    if (!bd) return;
    bd.hidden = false;
    setTimeout(() => {
      const nameInput = bd.querySelector('input[name="name"]');
      if (nameInput) nameInput.focus();
    }, 0);
  }
  function closeAddProjectModal() {
    const bd = getProjectModal();
    if (bd) {
      bd.hidden = true;
      const form = bd.querySelector("form");
      if (form) form.reset();
    }
  }

  function attachProjectSwitcher() {
    const btn = document.getElementById("project-switcher-btn");
    const pop = document.getElementById("project-switcher-popover");
    const chip = document.getElementById("brand-project-chip");
    if (pop) {
      // Move the popover to <body> so `position: fixed` is relative to
      // the viewport, not the topbar. The topbar uses `backdrop-filter`
      // which creates a containing block for fixed-positioned descendants
      // in some browsers; relocating to <body> sidesteps that entirely
      // and also lets the popover escape any future overflow:hidden on
      // the topbar or its ancestors.
      if (pop.parentElement !== document.body) {
        document.body.appendChild(pop);
      }
    }
    if (chip) {
      // Brand chip starts collapsed. We add aria-haspopup/aria-expanded
      // here (rather than in the HTML) so the chip advertises itself as
      // a menu trigger to assistive tech.
      chip.setAttribute("aria-haspopup", "menu");
      chip.setAttribute("aria-expanded", "false");
    }
    if (btn && pop) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleProjectPopover(btn);
      });
      // Dismiss listeners are attached inside openProjectPopover() with a
      // 50ms delay so the opening click doesn't immediately close it. The
      // close handler detaches them, so we don't need module-scope ones here.
    }
    if (chip) {
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleProjectPopover(chip);
      });
    }
    // Add-project modal wiring.
    const bd = getProjectModal();
    if (bd) {
      bd.addEventListener("click", (e) => {
        if (e.target === bd) closeAddProjectModal();
      });
      bd.querySelectorAll("[data-close-project]").forEach((b) =>
        b.addEventListener("click", closeAddProjectModal),
      );
      const form = document.getElementById("project-form");
      if (form) {
        form.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          const fd = new FormData(form);
          const body = {
            name: String(fd.get("name") || "").trim(),
            root: String(fd.get("root") || "").trim(),
          };
          if (!body.name || !body.root) return alert("Name and path are required.");
          try {
            await api("POST", "/api/projects", body);
          } catch (err) {
            alert(`Failed to add project: ${err.message}`);
            return;
          }
          closeAddProjectModal();
          // Re-fetch and refresh the chip + dropdown.
          await fetchProjects();
          renderProjectChip();
          // Reload so the new project becomes active on the server side and
          // the rest of the UI can re-fetch against it.
          window.location.reload();
        });
      }

      // Browse-button wiring — opens the path picker in folder mode and
      // writes the picked path into the root input. The path picker is
      // loaded by its own script tag in index.html and exposed via
      // window.OpenKanPathPicker. We treat its absence as a no-op so the
      // page still works if the script fails to load.
      const browseBtn = document.getElementById("project-browse-btn");
      if (browseBtn) {
        browseBtn.addEventListener("click", () => {
          const picker = window.OpenKanPathPicker;
          if (!picker || typeof picker.open !== "function") {
            console.warn(
              "[project-modal] Browse clicked but OpenKanPathPicker is not loaded",
            );
            return;
          }
          const rootInput =
            bd.querySelector('input[name="root"]') ||
            document.querySelector('input[name="root"]');
          const initial =
            rootInput && typeof rootInput.value === "string"
              ? rootInput.value.trim()
              : "";
          picker.open({
            title: "Choose a project folder",
            mode: "folder",
            initialPath: initial || undefined,
            onPick: (path) => {
              if (rootInput) rootInput.value = path;
            },
            onCancel: () => {
              /* user dismissed — nothing to do */
            },
          });
        });
      }
    }
    // Initial fetch.
    fetchProjects().then(() => renderProjectChip());
  }

  // ---------- Boot ----------
  (async () => {
    // Restore filter from URL hash before first render.
    const initial = readHashFilter();
    if (initial) {
      filter.category = initial.category;
      filter.tags = initial.tags;
      filter.contributor = initial.contributor;
      filter.archive = initial.archive;
      filter.sort = initial.sort;
      filter.search = initial.search || "";
    }
    attachFilterBar();
    attachSearch();
    attachBulkBar();
    applyFilterToButtons();
    renderSavedFilters();
    attachTabRouter();
    attachProjectSwitcher();
    // Page-wide right-click context menu (capture-phase delegation). The
    // handler decides which menu to show based on `e.target.closest()`:
    // card → per-task menu, column → column ops, chip → filter ops, etc.
    document.addEventListener("contextmenu", openGlobalContextMenu, true);
    // Normal-bubble fallback. If a downstream capture-phase handler calls
    // stopPropagation() (or some browser extension swallows the capture
    // event), this listener still catches the contextmenu so the user
    // always gets a response.
    document.addEventListener("contextmenu", openGlobalContextMenu);
    // M13 wiring — keyboard nav + command palette actions + cross-tab sync.
    // Order matters: keyboard module is initialized when keyboard.js loads
    // (it's a self-contained IIFE on a DOMContentLoaded hook), but our
    // handlers must be registered before any key fires. The palette registers
    // its actions during init() too, and exposes itself at first palette.open
    // call — so we attach handlers eagerly.
    attachKeyboard();
    registerPaletteActions();
    attachCrossTab();
    // The ⌘K topbar button is a click-only entry point to the palette.
    // The keyboard module is the canonical emitter for "palette.open".
    const paletteBtn = document.getElementById("palette-btn");
    if (paletteBtn) {
      paletteBtn.addEventListener("click", (e) => {
        e.preventDefault();
        window.OpenKanKeyboard?.execute?.("palette.open");
      });
    }
    // Activate the tab from the hash, defaulting to "tasks".
    const hash = readHashFilter();
    activateTab(hash?.tab || "tasks", { fromHash: true });

    try {
      applySnapshot(await api("GET", "/api/board"));
      setConnected(true);
    } catch {
      setConnected(false);
    }

    // Best-effort fetch of contributors (used by filter row + assignees).
    loadContributors();

    // Run the restored search query once the board has loaded so the meta
    // count and the per-card visibility agree.
    if (filter.search) {
      const meta = document.getElementById("search-meta");
      runSearch(filter.search, meta);
    }
    updateBulkBar();

    // If the user lands on a task URL we don't auto-open it (no notion of
    // deep-link to a task in v1.1). Hook left here for future M12 work.
  })();

  // Expose a tiny API so the task view (a separate file) can set a filter
  // and have the board re-render.
  window.OpenKanBoard = {
    setTagFilter(tag) {
      const t = String(tag || "").toLowerCase().trim();
      if (!t) return;
      if (!filter.tags.includes(t)) filter.tags.push(t);
      writeHashFilter();
      applyFilterToButtons();
      renderBoard();
    },
    setCategoryFilter(category) {
      filter.category = String(category || "all");
      writeHashFilter();
      applyFilterToButtons();
      renderBoard();
    },
    setContributorFilter(contributor) {
      filter.contributor = String(contributor || "all");
      writeHashFilter();
      applyFilterToButtons();
      renderBoard();
    },
    setSearch(query) {
      const q = String(query || "");
      filter.search = q;
      const input = document.getElementById("search-input");
      if (input) input.value = q;
      searchMatchIds = null;
      writeHashFilter();
      applyFilterToButtons();
      renderBoard();
      if (q) {
        const meta = document.getElementById("search-meta");
        runSearch(q, meta);
      } else {
        const meta = document.getElementById("search-meta");
        updateSearchMeta(meta, null, null);
      }
    },
    setFilter(filterObj) {
      if (!filterObj) return;
      if (typeof filterObj.category === "string") filter.category = filterObj.category;
      if (Array.isArray(filterObj.tags)) filter.tags = filterObj.tags.slice();
      if (typeof filterObj.contributor === "string") filter.contributor = filterObj.contributor;
      if (typeof filterObj.archive === "string") filter.archive = filterObj.archive;
      if (typeof filterObj.sort === "string") filter.sort = filterObj.sort;
      writeHashFilter();
      applyFilterToButtons();
      renderBoard();
    },
    getFilter() {
      return {
        category: filter.category,
        tags: filter.tags.slice(),
        contributor: filter.contributor,
        archive: filter.archive,
        sort: filter.sort,
        search: filter.search,
      };
    },
    getSelectedIds() {
      return [...selectedIds];
    },
    clearSelection() {
      clearCardSelection();
    },
    activateTab(name) {
      activateTab(name);
    },
  };

  // Expose the tab router for cross-file coordination (changelog-view,
  // contributors-view use it to jump to the Tasks tab).
  window.OpenKanTabs = { activate: activateTab };

  // Expose the right-click menu infrastructure so the task view (and any
  // other module) can show context menus that share the same host, styling,
  // and dismiss behavior. Callers push an items[] in the same shape as
  // renderMenu's argument.
  window.OpenKanMenu = {
    showAt(items, ev) {
      if (!ev) return;
      renderMenu(items);
      positionMenuAt(ev);
    },
    show(items, anchorEl) {
      renderMenu(items);
      // Synthesize a clientX/Y from the anchor's bounding rect so the menu
      // appears just below it. Useful for keyboard "open menu" handlers.
      if (anchorEl) {
        const r = anchorEl.getBoundingClientRect();
        const fake = { clientX: r.left, clientY: r.bottom };
        positionMenuAt(fake);
      }
    },
    hide: hideMenu,
  };
})();
