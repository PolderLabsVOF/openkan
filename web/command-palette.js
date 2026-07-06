// OpenKan — command palette (M13).
// window.OpenKanCommandPalette = {
//   open(), close(), isOpen(),
//   registerAction(action),  // returns unregister
//   registerTaskProvider(fn) // returns unregister
// }
//
// Cmd/Ctrl+K opens a centered modal with a fuzzy-search input. The fuzzy
// match is a simple case-insensitive substring score (spec'd below) — not a
// true edit-distance fuzzy match.
//
// Result sources:
//   1. Actions: registered via registerAction({ id, label, hint, run, keys? }).
//      Shown when the query is empty OR starts with ">".
//   2. Tasks: provided on demand by app.js via registerTaskProvider(fn). Shown
//      when the query doesn't match "@" or ">" prefixes and the query matches
//      a task's title/description/tags.
//
// Keyboard:
//   ↑ / ↓ (or Ctrl+P / Ctrl+N)  move highlight
//   Enter                        run the highlighted result
//   Esc                          close (handled by keyboard.js Esc priority)

(() => {
  "use strict";

  /** @type {Array<{id:string,label:string,hint?:string,keys?:string,run:Function,score?:number}>} */
  const actions = [];
  /** @type {Set<(query:string)=>Array<{id:string,title:string,subtitle?:string,run:Function}>>} */
  const taskProviders = new Set();

  /** @type {HTMLDivElement|null} */
  let root = null;
  /** @type {HTMLInputElement|null} */
  let input = null;
  /** @type {HTMLUListElement|null} */
  let list = null;
  /** @type {HTMLDivElement|null} */
  let emptyEl = null;
  /** @type {number} index of the highlighted result, or -1 */
  let highlight = -1;
  /** @type {Array<{label:string,hint?:string,run:Function}>} current rendered results */
  let current = [];
  /** @type {Element|null} previously focused element (restored on close) */
  let prevFocus = null;

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

  // ─── Fuzzy match — case-insensitive substring scoring ────────────────────
  // score = startsWith ? 100 : includes ? 50 : 0
  // Order by score desc, then alphabetical asc for ties.
  function fuzzyScore(haystack, needle) {
    if (!needle) return 1;          // empty query matches everything at base score
    if (!haystack) return 0;
    const h = String(haystack).toLowerCase();
    const n = String(needle).toLowerCase();
    if (!n) return 1;
    if (h.startsWith(n)) return 100;
    if (h.includes(n)) return 50;
    return 0;
  }

  // Build score records for actions, sorted by (score desc, label asc).
  function rankActions(query) {
    const q = (query || "").replace(/^>\s*/, "");
    const out = [];
    for (const a of actions) {
      const score = Math.max(
        fuzzyScore(a.label, q),
        fuzzyScore(a.id, q),
        fuzzyScore(a.hint || "", q),
      );
      if (score <= 0 && q) continue;
      out.push({ ...a, score: q ? score : 1 });
    }
    out.sort((a, b) => (b.score - a.score) || a.label.localeCompare(b.label));
    return out;
  }

  function rankTasks(query) {
    const q = (query || "").replace(/^@\s*/, "");
    if (!q) return [];
    /** @type {Array<{id:string,title:string,subtitle?:string,run:Function,score:number}>} */
    const out = [];
    for (const provider of taskProviders) {
      let list = [];
      try { list = provider(q) || []; } catch { list = []; }
      for (const t of list) {
        if (!t) continue;
        const titleScore = fuzzyScore(t.title || "", q);
        const descScore = fuzzyScore(t.subtitle || "", q);
        const score = Math.max(titleScore, descScore);
        if (score <= 0) continue;
        out.push({ ...t, score });
      }
    }
    out.sort((a, b) => (b.score - a.score) || (a.title || "").localeCompare(b.title || ""));
    return out;
  }

  function isOpen() { return !!root && !root.hidden; }

  function open() {
    if (!root) build();
    if (!root.hidden) return;
    prevFocus = document.activeElement instanceof Element ? document.activeElement : null;
    root.hidden = false;
    input.value = "";
    document.body.classList.add("palette-open");
    setTimeout(() => {
      try { input.focus({ preventScroll: true }); } catch { input.focus(); }
      render("");
    }, 0);
  }

  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove("palette-open");
    if (prevFocus && document.contains(prevFocus)) {
      try { prevFocus.focus({ preventScroll: true }); } catch {}
    }
    prevFocus = null;
  }

  function render(query) {
    if (!list) return;
    list.innerHTML = "";
    const trimmed = (query || "").trim();
    // Mode selection:
    //   - empty / ">" prefix   → actions only
    //   - "@" prefix           → tasks only
    //   - any other query      → actions then tasks (ranked independently,
    //                            then concatenated — matches the spec's "any
    //                            query that matches a task title" while still
    //                            letting users discover actions by name).
    const isActionMode = trimmed === "" || trimmed.startsWith(">");
    const isTaskMode = !isActionMode && trimmed.startsWith("@");
    const ranked = isActionMode
      ? rankActions(query).map((r) => ({ ...r, kind: "action" }))
      : isTaskMode
        ? rankTasks(query).map((r) => ({ ...r, kind: "task" }))
        : [
            ...rankActions(query).map((r) => ({ ...r, kind: "action" })),
            ...rankTasks(query).map((r) => ({ ...r, kind: "task" })),
          ];
    current = ranked.map((r) => ({
      label: r.label || r.title,
      hint: r.hint || r.subtitle,
      run: r.run,
      kind: r.kind,
      id: r.id || r.label || r.title,
    }));
    highlight = current.length > 0 ? 0 : -1;

    if (current.length === 0) {
      emptyEl.textContent = trimmed
        ? "No matching actions or tasks"
        : "Type to search actions and tasks";
      emptyEl.hidden = false;
      list.hidden = true;
      return;
    }
    emptyEl.hidden = true;
    list.hidden = false;
    const MAX_RENDER = 50;
    for (let i = 0; i < Math.min(current.length, MAX_RENDER); i++) {
      const r = current[i];
      const li = el("li", "palette-item", {
        role: "option",
        "data-idx": String(i),
        "aria-selected": i === highlight ? "true" : "false",
        id: `palette-item-${i}`,
      });
      li.append(el("span", "palette-item-label", { text: r.label }));
      if (r.hint) li.append(el("span", "palette-item-hint", { text: r.hint }));
      if (r.kind === "task") li.append(el("span", "palette-item-kind", { text: "Task" }));
      li.addEventListener("click", () => runAt(i));
      li.addEventListener("mousemove", () => setHighlight(i));
      if (i === highlight) li.classList.add("highlighted");
      list.append(li);
    }
    if (current.length > MAX_RENDER) {
      list.append(el("li", "palette-overflow", {
        text: `${current.length - MAX_RENDER} more — refine your query`,
      }));
    }
    setActiveDescendant();
  }

  function setHighlight(i) {
    if (!list) return;
    if (i < 0 || i >= current.length) return;
    if (highlight === i) return;
    const prev = list.querySelector(`[data-idx="${highlight}"]`);
    if (prev) {
      prev.classList.remove("highlighted");
      prev.setAttribute("aria-selected", "false");
    }
    highlight = i;
    const next = list.querySelector(`[data-idx="${i}"]`);
    if (next) {
      next.classList.add("highlighted");
      next.setAttribute("aria-selected", "true");
      // Keep highlighted item in view.
      try { next.scrollIntoView({ block: "nearest" }); } catch {}
    }
    setActiveDescendant();
  }

  function setActiveDescendant() {
    if (!input || !list) return;
    if (highlight < 0) {
      input.setAttribute("aria-activedescendant", "");
    } else {
      input.setAttribute("aria-activedescendant", `palette-item-${highlight}`);
    }
  }

  function runAt(i) {
    const r = current[i];
    if (!r) return;
    close();
    try { r.run(); } catch (e) {
      console.error("[palette] action threw:", e);
    }
  }

  // ─── Input + keyboard wiring ─────────────────────────────────────────────
  function onKeyDown(e) {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") || (e.ctrlKey && e.key === "N")) {
      e.preventDefault();
      setHighlight(highlight + 1 >= current.length ? 0 : highlight + 1);
      return;
    }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") || (e.ctrlKey && e.key === "P")) {
      e.preventDefault();
      setHighlight(highlight - 1 < 0 ? current.length - 1 : highlight - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlight >= 0) runAt(highlight);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setHighlight(current.length - 1);
      return;
    }
  }

  function onInput() {
    render(input.value);
  }

  // ─── Build + boot ────────────────────────────────────────────────────────
  function build() {
    root = el("div", "command-palette", {
      id: "command-palette",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Command palette",
      hidden: true,
    });
    root.tabIndex = -1;

    const dialog = el("div", "command-palette-dialog");
    const searchWrap = el("div", "command-palette-search");
    input = el("input", null, {
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "Type a command or search…",
      "aria-label": "Command palette search",
      "aria-controls": "command-palette-list",
      "aria-autocomplete": "list",
    });
    input.setAttribute("role", "combobox");
    input.id = "command-palette-input";
    searchWrap.append(input);
    dialog.append(searchWrap);

    list = el("ul", "command-palette-list", {
      id: "command-palette-list",
      role: "listbox",
      "aria-labelledby": "command-palette-input",
    });
    dialog.append(list);

    emptyEl = el("div", "command-palette-empty", {
      text: "Type to search actions and tasks",
    });
    dialog.append(emptyEl);

    const footer = el("div", "command-palette-footer");
    footer.append(
      el("span", null, { text: "↑/↓ navigate" }),
      el("span", "dot", { "aria-hidden": "true", text: "·" }),
      el("span", null, { text: "↵ select" }),
      el("span", "dot", { "aria-hidden": "true", text: "·" }),
      el("span", null, { text: "esc close" }),
    );
    dialog.append(footer);

    root.append(dialog);

    // Backdrop closes when clicking outside the dialog.
    root.addEventListener("click", (e) => {
      if (e.target === root) close();
    });

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeyDown);

    document.body.appendChild(root);
  }

  function init() {
    if (!root) build();
    // Wire to the keyboard module — palette.open / palette.close / palette.isOpen.
    if (window.OpenKanKeyboard) {
      window.OpenKanKeyboard.on("palette.open", () => open());
      window.OpenKanKeyboard.on("palette.isOpen", (cb) => {
        if (typeof cb === "function") cb(isOpen());
      });
      // The keyboard module asks isOpen via emit("palette.isOpen", cb).
      // For Esc handling, it calls emit("palette.close") when palette is open.
      window.OpenKanKeyboard.on("palette.close", () => close());
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────
  function registerAction(action) {
    if (!action || !action.id || typeof action.run !== "function") return () => {};
    const item = {
      id: String(action.id),
      label: String(action.label || action.id),
      hint: action.hint ? String(action.hint) : undefined,
      keys: action.keys ? String(action.keys) : undefined,
      run: action.run,
    };
    actions.push(item);
    return () => {
      const idx = actions.indexOf(item);
      if (idx >= 0) actions.splice(idx, 1);
    };
  }

  function registerTaskProvider(fn) {
    if (typeof fn !== "function") return () => {};
    taskProviders.add(fn);
    return () => taskProviders.delete(fn);
  }

  window.OpenKanCommandPalette = {
    open, close, isOpen,
    registerAction, registerTaskProvider,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
