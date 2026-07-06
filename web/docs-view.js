// OpenKan — Docs tab (left file tree + right viewer).
// window.OpenKanDocs = { mount(rootEl, opts), unmount() }
//
// Renders the project's docs/ folder as a collapsible file tree on the left
// and the selected file's content on the right. Uses the server endpoints:
//   GET /api/docs                       → { entries: DocEntry[] }
//   GET /api/docs/<relPath>?raw=0|1     → { path, html, rendered, raw,
//                                          mtime, size, blocks }
//
// The tree renders once on mount; clicking a file refetches its content. The
// selected file is mirrored into the URL hash (`#tab=docs&doc=<path>`) so
// reloads restore the open document.

(() => {
  "use strict";

  const { api } = window.OpenKanAPI;

  // SVG icons (kept inline so we don't pull in a sprite sheet).
  const ICON_FILE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 1.5h7l3 3v10H3z"/><path d="M10 1.5v3h3"/></svg>';
  const ICON_DIR = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.4h5.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z"/></svg>';

  // ─── Per-mount state ──────────────────────────────────────────────────────
  /** @type {{
   *   rootEl: HTMLElement|null,
   *   treeEl: HTMLElement|null,
   *   filePathEl: HTMLElement|null,
   *   contentEl: HTMLElement|null,
   *   openRawEl: HTMLAnchorElement|null,
   *   newFileBtn: HTMLButtonElement|null,
   *   entries: any[],
   *   activePath: string,
   *   loading: boolean,
   * }|null} */
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

  function escapeAttr(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function basename(p) {
    if (!p) return "";
    const parts = String(p).split("/");
    return parts[parts.length - 1] || String(p);
  }

  function dirname(p) {
    if (!p) return "";
    const idx = String(p).lastIndexOf("/");
    return idx < 0 ? "" : String(p).slice(0, idx);
  }

  function joinPath(a, b) {
    if (!a) return b || "";
    if (!b) return a;
    if (a.endsWith("/")) return `${a}${b}`;
    return `${a}/${b}`;
  }

  // ─── Hash <-> state ───────────────────────────────────────────────────────
  function readDocFromHash() {
    const raw = (window.location.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(raw);
    return params.get("doc") || "";
  }
  function writeDocToHash(docPath) {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    params.set("tab", "docs");
    if (docPath) params.set("doc", docPath);
    else params.delete("doc");
    const next = `#${params.toString()}`;
    if (window.location.hash !== next) {
      const url = window.location.pathname + window.location.search + next;
      try { window.history.replaceState(null, "", url); } catch {}
    }
  }

  // ─── Tree rendering ───────────────────────────────────────────────────────
  // Recursive entry render. `entries` is the array returned by /api/docs; we
  // expect each entry to look like:
  //   { name, path, type: "file"|"dir", children?: DocEntry[] }
  function renderTree(entries, depth) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const list = el("ul", "docs-tree-nested");
    if (depth === 0) list.classList.add("root");
    list.setAttribute("role", "group");
    for (const entry of entries) {
      list.append(renderEntry(entry, depth));
    }
    return list;
  }

  function renderEntry(entry, depth) {
    const isDir = entry.type === "dir" || Array.isArray(entry.children);
    const li = el("li", `docs-tree-item ${isDir ? "is-dir" : "is-file"}`);
    li.setAttribute("role", "treeitem");
    if (isDir) {
      const det = el("details", "docs-tree-dir");
      // Auto-open top-level entries so the user sees content immediately.
      if (depth < 1) det.open = true;
      const sum = el("summary", "docs-tree-row");
      sum.append(el("span", "docs-tree-icon", { html: ICON_DIR }));
      sum.append(el("span", "docs-tree-label-text", { text: entry.name || entry.path }));
      det.append(sum);
      if (Array.isArray(entry.children) && entry.children.length > 0) {
        const inner = renderTree(entry.children, depth + 1);
        if (inner) det.append(inner);
      }
      li.append(det);
    } else {
      const row = el("button", "docs-tree-row docs-tree-file", {
        type: "button",
        title: entry.path,
        "data-path": entry.path,
      });
      if (state?.activePath && entry.path === state.activePath) {
        row.classList.add("active");
      }
      row.append(el("span", "docs-tree-icon", { html: ICON_FILE }));
      row.append(el("span", "docs-tree-label-text", { text: entry.name || entry.path }));
      row.addEventListener("click", () => loadFile(entry.path));
      li.append(row);
    }
    return li;
  }

  // ─── File loading ─────────────────────────────────────────────────────────
  async function loadFile(docPath) {
    if (!state) return;
    if (state.activePath === docPath) return;
    state.activePath = docPath;
    writeDocToHash(docPath);
    // Re-paint active state in the tree.
    for (const row of state.treeEl.querySelectorAll(".docs-tree-file")) {
      row.classList.toggle("active", row.getAttribute("data-path") === docPath);
    }
    state.filePathEl.textContent = `/docs/${docPath}`;
    state.openRawEl.href = `/api/docs/${encodeURI(docPath)}?raw=1`;
    state.openRawEl.hidden = false;
    state.contentEl.innerHTML = '<div class="docs-loading">Loading…</div>';
    try {
      const data = await api("GET", `/api/docs/${encodeURI(docPath)}?raw=0`);
      // Server now returns { path, html, rendered, raw, mtime, size, blocks }.
      // We accept either `html` or `rendered` for back-compat with the legacy
      // endpoint that only returned { html }.
      const html = typeof data === "string"
        ? data
        : (data?.html ?? data?.rendered ?? "");
      if (!html) {
        state.contentEl.innerHTML = '<div class="docs-empty">No content.</div>';
        return;
      }
      // Server is expected to return sanitized HTML. If the response shape
      // ever changes (e.g. { content: "...mdx text..." }), we can re-render
      // here with a markdown renderer.
      state.contentEl.innerHTML = html;
      state.contentEl.scrollTop = 0;
    } catch (err) {
      state.contentEl.innerHTML = "";
      const card = el("div", "docs-error-card");
      card.append(el("div", "docs-error-title", { text: "Failed to load file" }));
      card.append(el("div", "docs-error-message", { text: err?.message || String(err) }));
      state.contentEl.append(card);
    }
  }

  // ─── Initial tree fetch ───────────────────────────────────────────────────
  async function loadTree() {
    if (!state) return;
    state.treeEl.innerHTML = '<li class="docs-tree-empty">Loading…</li>';
    try {
      const data = await api("GET", "/api/docs");
      const entries = Array.isArray(data?.entries) ? data.entries
                    : Array.isArray(data?.tree)    ? data.tree
                    : Array.isArray(data)           ? data
                    : [];
      state.entries = entries;
      state.treeEl.innerHTML = "";
      const tree = renderTree(entries, 0);
      if (!tree || tree.children.length === 0) {
        state.treeEl.innerHTML = "";
        state.treeEl.append(el("li", "docs-tree-empty", {
          text: "No docs yet. Click + New file to start.",
        }));
        return;
      }
      state.treeEl.append(tree);
    } catch (err) {
      state.treeEl.innerHTML = "";
      const msg = el("li", "docs-tree-empty");
      msg.append(el("div", null, { text: "Docs endpoint unavailable." }));
      msg.append(el("div", "docs-error-sub", { text: err?.message || String(err) }));
      state.treeEl.append(msg);
    }
  }

  // ─── "+ New file" affordance ──────────────────────────────────────────────
  // v1 just prompts for a path and confirms with the user; a future server
  // endpoint (POST /api/docs) will create the file. Until that lands, the
  // prompt explains the limitation.
  function onNewFile() {
    const path = window.prompt("New doc path (relative to docs/, e.g. 'design/auth.mdx'):", "");
    if (!path) return;
    const safe = String(path).trim().replace(/^\/+/, "").replace(/\.\.+/g, "");
    if (!safe) return;
    alert(`File creation isn't wired up to the server yet — "${safe}" will not be saved. This is a v1 placeholder.`);
  }

  // ─── Mount / unmount ──────────────────────────────────────────────────────
  function mount(rootEl, opts = {}) {
    if (!rootEl) throw new Error("docs-view: rootEl is required");
    unmount();
    const treeEl = rootEl.querySelector("#docs-tree-list") || el("ul", "docs-tree-list");
    if (!treeEl.id) treeEl.id = "docs-tree-list";
    const filePathEl = rootEl.querySelector("#docs-file-path") || el("span");
    const contentEl = rootEl.querySelector("#docs-content") || el("article");
    const openRawEl = rootEl.querySelector("#docs-open-raw") || el("a");
    const newFileBtn = rootEl.querySelector("#docs-new-file-btn") || el("button");
    state = {
      rootEl,
      treeEl,
      filePathEl,
      contentEl,
      openRawEl,
      newFileBtn,
      entries: [],
      activePath: "",
      loading: false,
    };
    // Wire the "+ New file" button exactly once.
    if (!newFileBtn.dataset.bound) {
      newFileBtn.addEventListener("click", onNewFile);
      newFileBtn.dataset.bound = "1";
    }
    // Load the tree; if the URL hash has a `doc=…` param, restore that file.
    loadTree().then(() => {
      const initial = opts.initialDoc || readDocFromHash();
      if (initial) loadFile(initial);
    });
  }

  function unmount() {
    state = null;
  }

  // External hook: when the URL hash changes (e.g. user pastes a
  // `#tab=docs&doc=foo.mdx` URL into the address bar), pick the change up.
  window.addEventListener("hashchange", () => {
    if (!state) return;
    const doc = readDocFromHash();
    if (doc && doc !== state.activePath) loadFile(doc);
  });

  window.OpenKanDocs = { mount, unmount };
})();