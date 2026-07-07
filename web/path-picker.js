// OpenKan — file/folder path picker modal (M14).
// window.OpenKanPathPicker = { open(opts) }
//
// A small, dependency-free picker that opens over the existing modal layer.
// Built on top of the same `.modal-backdrop` / `.modal` shell as the rest of
// the dashboard so it inherits theme variables, keyboard handling, and the
// backdrop click-to-close behaviour.
//
// API contract (server endpoints are owned by kanban/server.ts):
//   GET /api/home            → { home: string, entries: FsEntry[] }
//   GET /api/fs?path=X&depth=1 → FsEntry (with .children)
//   GET /api/parents?path=X&maxDepth=8 → FsEntry[]
//
// All three are best-effort: a 404 / network failure is shown as an inline
// error inside the picker (not a thrown promise) so the picker stays usable
// in environments where the endpoints aren't deployed yet — the user can
// still type a path and submit it.

(() => {
  "use strict";

  const { api } = window.OpenKanAPI || {};
  if (!api) {
    // Soft fail: surface a console error but don't crash other modules.
    console.error("[path-picker] OpenKanAPI not available — picker is disabled");
    window.OpenKanPathPicker = {
      open() {
        alert("Path picker unavailable: API not loaded.");
      },
    };
    return;
  }

  // ─── State (per-open) ──────────────────────────────────────────────────
  /** @type {HTMLDivElement|null} */ let root = null;
  /** @type {{
   *   title: string, mode: string, onPick: (p:string)=>void, onCancel?: ()=>void,
   *   initialPath?: string, showHidden: boolean, currentPath: string,
   *   selectedPath: string|null, prevFocus: Element|null
   * }|null} */ let ctx = null;

  // ─── DOM helpers ──────────────────────────────────────────────────────
  function el(tag, cls, props = {}) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") e.textContent = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v === null || v === undefined) continue;
      else e.setAttribute(k, String(v));
    }
    return e;
  }

  function setText(node, text) {
    if (node) node.textContent = text == null ? "" : String(text);
  }

  // ─── Build (lazy) ─────────────────────────────────────────────────────
  function build() {
    if (root) return root;
    root = el("div", "modal-backdrop path-picker-backdrop", {
      id: "path-picker-backdrop",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "path-picker-title",
      hidden: true,
    });
    root.tabIndex = -1;

    const modal = el("div", "modal path-picker");
    modal.tabIndex = -1;

    // Header — title + close
    const header = el("header", "modal-header");
    const titleEl = el("h2", null, {
      id: "path-picker-title",
      text: "Select a folder or file",
    });
    const closeBtn = el("button", "btn-icon", {
      type: "button",
      "aria-label": "Close",
      text: "×",
    });
    closeBtn.dataset.closePathPicker = "1";
    header.append(titleEl, closeBtn);
    modal.append(header);

    // Breadcrumb / navigation bar
    const navBar = el("div", "path-picker-nav");
    const upBtn = el("button", "btn-icon path-picker-icon-btn", {
      type: "button",
      "aria-label": "Up one level",
      title: "Up one level",
      text: "↑",
    });
    upBtn.dataset.pathPickerUp = "1";
    const homeBtn = el("button", "btn-icon path-picker-icon-btn", {
      type: "button",
      "aria-label": "Home",
      title: "Home",
      text: "⌂",
    });
    homeBtn.dataset.pathPickerHome = "1";
    const crumbs = el("div", "path-picker-breadcrumbs");
    crumbs.dataset.pathPickerCrumbs = "1";
    crumbs.setAttribute("role", "navigation");
    crumbs.setAttribute("aria-label", "Path breadcrumb");
    const refreshBtn = el("button", "btn-icon path-picker-icon-btn", {
      type: "button",
      "aria-label": "Refresh",
      title: "Refresh",
      text: "↻",
    });
    refreshBtn.dataset.pathPickerRefresh = "1";
    navBar.append(upBtn, homeBtn, crumbs, refreshBtn);
    modal.append(navBar);

    // Layout: tree (left) + form pane (right)
    const layout = el("div", "path-picker-layout");

    // Tree pane
    const treePane = el("aside", "path-picker-tree-pane");
    const treeHeader = el("div", "path-picker-pane-header");
    treeHeader.append(
      el("span", null, { text: "Contents" }),
      (() => {
        const wrap = el("label", "path-picker-hidden-toggle");
        const cb = el("input", null, { type: "checkbox" });
        cb.dataset.pathPickerHiddenToggle = "1";
        wrap.append(cb, " ", el("span", null, { text: "Show hidden" }));
        return wrap;
      })(),
    );
    treePane.append(treeHeader);
    const tree = el("div", "path-picker-tree");
    tree.dataset.pathPickerTree = "1";
    tree.setAttribute("role", "listbox");
    tree.setAttribute("aria-label", "Files and folders");
    treePane.append(tree);
    layout.append(treePane);

    // Form pane (right): free-form path input + actions
    const formPane = el("section", "path-picker-form-pane");
    const formHeader = el("div", "path-picker-pane-header");
    formHeader.append(el("span", null, { text: "Path" }));
    formPane.append(formHeader);

    const pathRow = el("div", "path-picker-input-row");
    const pathInput = el("input", "settings-input", {
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "/absolute/path/to/folder",
      "aria-label": "Path",
    });
    pathInput.dataset.pathPickerInput = "1";
    const goBtn = el("button", "btn btn-sm", {
      type: "button",
      "aria-label": "Go to path",
      title: "Go to path",
      text: "↗ Go",
    });
    goBtn.dataset.pathPickerGo = "1";
    pathRow.append(pathInput, goBtn);
    formPane.append(pathRow);

    const selected = el("div", "path-picker-selected");
    selected.dataset.pathPickerSelected = "1";
    selected.append(
      el("span", "path-picker-selected-label", { text: "Selected:" }),
      el("span", "path-picker-selected-value", {
        text: "(none — pick a folder)",
      }),
    );
    formPane.append(selected);

    const status = el("div", "path-picker-status");
    status.dataset.pathPickerStatus = "1";
    formPane.append(status);

    const footer = el("footer", "modal-footer path-picker-footer");
    const cancelBtn = el("button", "btn", {
      type: "button",
      "data-close-path-picker": "1",
      text: "Cancel",
    });
    const selectBtn = el("button", "btn btn-primary", {
      type: "button",
      text: "Select",
    });
    selectBtn.dataset.pathPickerSelect = "1";
    footer.append(cancelBtn, selectBtn);
    formPane.append(footer);

    layout.append(formPane);
    modal.append(layout);

    root.append(modal);
    document.body.appendChild(root);

    // ─── Event wiring (one-shot, lives for the life of the page) ───────
    root.addEventListener("click", onRootClick);

    // Close button + backdrop click + Cancel — use the data attribute set
    // above so we don't have to keep references to the elements.
    document.addEventListener("keydown", onKeydown);
    return root;
  }

  // ─── Open / close ──────────────────────────────────────────────────────
  /**
   * @param {{
   *   title?: string,
   *   mode?: "folder"|"file"|"any",
   *   initialPath?: string,
   *   showHidden?: boolean,
   *   onPick: (path:string)=>void,
   *   onCancel?: ()=>void,
   * }} opts
   */
  async function open(opts) {
    if (!opts || typeof opts.onPick !== "function") {
      console.error("[path-picker] open() requires { onPick }");
      return;
    }
    const rootEl = build();
    ctx = {
      title: opts.title || "Select a folder or file",
      mode: opts.mode === "file" || opts.mode === "any" ? opts.mode : "folder",
      onPick: opts.onPick,
      onCancel: typeof opts.onCancel === "function" ? opts.onCancel : null,
      initialPath: opts.initialPath || "",
      showHidden: !!opts.showHidden,
      currentPath: "",
      selectedPath: null,
      prevFocus:
        document.activeElement instanceof Element ? document.activeElement : null,
    };

    // Title.
    const titleEl = rootEl.querySelector("#path-picker-title");
    if (titleEl) titleEl.textContent = ctx.title;

    // Select-button label follows the mode ("Create" for folder, "Select"
    // for file/any). Falls back to "Select" for unknown modes.
    const selectBtn = rootEl.querySelector('[data-path-picker-select]');
    if (selectBtn) {
      selectBtn.textContent =
        ctx.mode === "folder" ? "Select" : ctx.mode === "file" ? "Select file" : "Select";
    }

    // Hidden-files toggle.
    const hiddenCb = rootEl.querySelector('[data-path-picker-hidden-toggle]');
    if (hiddenCb) hiddenCb.checked = ctx.showHidden;

    // Clear stale state, then show the dialog.
    const tree = rootEl.querySelector('[data-path-picker-tree]');
    if (tree) {
      tree.innerHTML = "";
      tree.append(
        el("div", "path-picker-placeholder", { text: "Loading…" }),
      );
    }
    const pathInput = rootEl.querySelector('[data-path-picker-input]');
    if (pathInput) pathInput.value = "";
    const status = rootEl.querySelector('[data-path-picker-status]');
    if (status) status.textContent = "";

    rootEl.hidden = false;
    document.body.classList.add("path-picker-open");

    // Decide where to start.
    const seed = (ctx.initialPath || "").trim();
    const target = seed ? seed : null;
    try {
      if (target) {
        await navigateTo(target);
      } else {
        await navigateHome();
      }
    } catch (err) {
      console.error("[path-picker] initial navigate failed:", err);
      setStatus(`Could not load initial directory: ${err?.message || err}`);
    }
    // Focus the path input for keyboard navigation.
    setTimeout(() => {
      try { pathInput?.focus({ preventScroll: true }); } catch {}
    }, 0);
  }

  function close(reason) {
    if (!root || root.hidden || !ctx) return;
    root.hidden = true;
    document.body.classList.remove("path-picker-open");
    const cancelled = reason !== "pick";
    if (cancelled && typeof ctx.onCancel === "function") {
      try { ctx.onCancel(); } catch (e) {
        console.error("[path-picker] onCancel threw:", e);
      }
    }
    if (ctx.prevFocus && document.contains(ctx.prevFocus)) {
      try { ctx.prevFocus.focus({ preventScroll: true }); } catch {}
    }
    ctx = null;
  }

  // ─── Navigation ────────────────────────────────────────────────────────
  async function navigateTo(path) {
    if (!ctx) return;
    if (!path || typeof path !== "string") return;
    const abs = normalisePath(path);
    if (!abs) {
      setStatus(`Invalid path: ${path}`);
      return;
    }
    ctx.currentPath = abs;
    ctx.selectedPath = null;
    updateSelectedDisplay();
    setStatus(`Loading ${abs}…`);
    let entry;
    try {
      entry = await fetchFsEntry(abs);
    } catch (err) {
      setStatus(`Failed to load ${abs}: ${err?.message || err}`);
      renderTreeError(abs, err);
      await renderCrumbs(abs);
      return;
    }
    if (!entry || entry.isFile) {
      // If the entry doesn't exist or is a file, we still want breadcrumbs
      // visible — the form input + path display already handles selection.
      setStatus(entry?.isFile ? `${abs} is a file.` : `${abs} is not accessible.`);
      renderTreeEmpty(entry?.isFile ? "Selected path is a file" : "Empty or inaccessible");
      await renderCrumbs(abs);
      return;
    }
    await renderCrumbs(abs);
    setStatus("");
    renderTree(abs, entry.children || []);
  }

  async function navigateHome() {
    let home = null;
    try {
      const res = await api("GET", "/api/home");
      home = res?.home || null;
    } catch (err) {
      // Endpoint may not exist in this deployment. Fall back to a sensible
      // default so the picker is still usable (Linux/macOS only — Windows
      // doesn't have a /home tree, but neither does the rest of the app).
      home = "/home";
      console.debug(
        "[path-picker] /api/home unavailable, falling back to /home:",
        err?.message || err,
      );
    }
    await navigateTo(home);
  }

  async function navigateUp() {
    if (!ctx || !ctx.currentPath) return;
    const parent = parentOf(ctx.currentPath);
    if (parent && parent !== ctx.currentPath) {
      await navigateTo(parent);
    }
  }

  // ─── Data fetching ─────────────────────────────────────────────────────
  async function fetchFsEntry(absPath) {
    const q = `?path=${encodeURIComponent(absPath)}&depth=1`;
    try {
      return await api("GET", `/api/fs${q}`);
    } catch (err) {
      // Re-throw with the path included for better diagnostics.
      throw new Error(`/api/fs failed for ${absPath}: ${err?.message || err}`);
    }
  }

  async function fetchParents(absPath, maxDepth = 8) {
    const q = `?path=${encodeURIComponent(absPath)}&maxDepth=${maxDepth}`;
    try {
      const res = await api("GET", `/api/parents${q}`);
      return Array.isArray(res) ? res : Array.isArray(res?.parents) ? res.parents : [];
    } catch {
      // Synthesize a breadcrumb from the path string itself — this is a
      // graceful degradation when the endpoint isn't deployed yet.
      return synthesiseParents(absPath);
    }
  }

  function synthesiseParents(absPath) {
    if (!absPath || absPath === "/") {
      return [{ name: "/", path: "/", isDir: true }];
    }
    const parts = absPath.split("/").filter(Boolean);
    const out = [{ name: "/", path: "/", isDir: true }];
    let acc = "";
    for (const p of parts) {
      acc += "/" + p;
      out.push({ name: p, path: acc, isDir: true });
    }
    return out;
  }

  // ─── Rendering ────────────────────────────────────────────────────────
  async function renderCrumbs(absPath) {
    const rootEl = build();
    const wrap = rootEl.querySelector('[data-path-picker-crumbs]');
    if (!wrap) return;
    wrap.innerHTML = "";
    const parents = await fetchParents(absPath);
    if (!parents || parents.length === 0) {
      wrap.append(el("span", "path-picker-crumb-leaf", { text: absPath }));
      return;
    }
    parents.forEach((p, idx) => {
      const isLast = idx === parents.length - 1;
      if (idx > 0) {
        wrap.append(
          el("span", "path-picker-crumb-sep", {
            "aria-hidden": "true",
            text: "/",
          }),
        );
      }
      if (isLast) {
        wrap.append(
          el("span", "path-picker-crumb-leaf", {
            text: p.name,
            title: p.path,
          }),
        );
      } else {
        const btn = el("button", "path-picker-crumb", {
          type: "button",
          text: p.name,
          title: p.path,
        });
        btn.addEventListener("click", () => navigateTo(p.path));
        wrap.append(btn);
      }
    });
  }

  function renderTree(absPath, children) {
    const rootEl = build();
    const tree = rootEl.querySelector('[data-path-picker-tree]');
    if (!tree) return;
    tree.innerHTML = "";
    const filtered = children.filter((c) => ctx?.showHidden || !c.name.startsWith("."));
    if (filtered.length === 0) {
      tree.append(
        el("div", "path-picker-placeholder", { text: "Empty folder" }),
      );
      return;
    }
    // Dirs first, then files; alphabetical within each group.
    const dirs = filtered.filter((c) => c.isDir).sort(byName);
    const files = filtered.filter((c) => !c.isDir).sort(byName);
    for (const child of [...dirs, ...files]) {
      tree.append(renderRow(absPath, child));
    }
  }

  function renderTreeError(absPath, err) {
    const rootEl = build();
    const tree = rootEl.querySelector('[data-path-picker-tree]');
    if (!tree) return;
    tree.innerHTML = "";
    tree.append(
      el("div", "path-picker-placeholder path-picker-error", {
        text: `Could not list ${absPath}: ${err?.message || err}`,
      }),
    );
  }

  function renderTreeEmpty(text) {
    const rootEl = build();
    const tree = rootEl.querySelector('[data-path-picker-tree]');
    if (!tree) return;
    tree.innerHTML = "";
    tree.append(el("div", "path-picker-placeholder", { text }));
  }

  function renderRow(parentPath, child) {
    const isDir = !!child.isDir;
    const row = el("div", "path-picker-row", {
      role: "option",
      "aria-selected": "false",
      "data-path": child.path,
      tabindex: "0",
    });
    if (child.name.startsWith(".")) row.classList.add("path-picker-row-hidden");
    const icon = el("span", "path-picker-icon", {
      "aria-hidden": "true",
      text: isDir ? "📁" : "📄",
    });
    const name = el("span", "path-picker-name", { text: child.name });
    row.append(icon, name);
    if (child.isSymlink) {
      row.append(el("span", "path-picker-symlink", {
        "aria-hidden": "true",
        text: "↪",
        title: "symlink",
      }));
    }

    const select = () => {
      // Folder: select the folder (mode permits). File: pick immediately if
      // the mode allows files.
      if (!ctx) return;
      if (isDir) {
        ctx.selectedPath = child.path;
        ctx.currentPath = child.path;
        // For folder mode, selecting a folder also navigates into it so the
        // user can drill down. For other modes, selection is sticky until
        // confirmed with the footer button.
        if (ctx.mode === "folder") {
          navigateTo(child.path);
        } else {
          markSelected(row);
          updateSelectedDisplay();
        }
      } else if (ctx.mode !== "folder") {
        // File in file/any mode → pick immediately.
        pick(child.path);
      } else {
        // File in folder-only mode → treat as a no-op (or show a hint).
        setStatus("Folder mode: files cannot be selected.");
      }
    };

    row.addEventListener("click", select);
    row.addEventListener("dblclick", () => {
      if (isDir) {
        // Double-click jumps into the folder regardless of mode.
        navigateTo(child.path);
      } else {
        pick(child.path);
      }
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });
    return row;
  }

  function markSelected(row) {
    if (!row) return;
    const tree = build().querySelector('[data-path-picker-tree]');
    if (!tree) return;
    for (const r of tree.querySelectorAll(".path-picker-row.selected")) {
      r.classList.remove("selected");
      r.setAttribute("aria-selected", "false");
    }
    row.classList.add("selected");
    row.setAttribute("aria-selected", "true");
    try { row.scrollIntoView({ block: "nearest" }); } catch {}
  }

  function updateSelectedDisplay() {
    const rootEl = build();
    const val = rootEl.querySelector(".path-picker-selected-value");
    if (!val) return;
    if (ctx && ctx.selectedPath) {
      val.textContent = ctx.selectedPath;
    } else if (ctx && ctx.currentPath) {
      val.textContent = `${ctx.currentPath}/`;
    } else {
      val.textContent = "(none — pick a folder)";
    }
  }

  function setStatus(msg) {
    const rootEl = build();
    const status = rootEl.querySelector('[data-path-picker-status]');
    if (status) status.textContent = msg || "";
  }

  // ─── Pick ─────────────────────────────────────────────────────────────
  function pick(path) {
    if (!ctx) return;
    const handler = ctx.onPick;
    const value = path;
    close("pick");
    try { handler(value); } catch (e) {
      console.error("[path-picker] onPick threw:", e);
    }
  }

  function pickCurrent() {
    if (!ctx) return;
    let path = ctx.selectedPath || ctx.currentPath;
    if (!path) {
      setStatus("No path selected yet — navigate or type a path.");
      return;
    }
    // For folder mode, default to the current directory if nothing was
    // explicitly selected (the user is "in" the folder).
    if (!ctx.selectedPath && ctx.currentPath && ctx.mode === "folder") {
      path = ctx.currentPath;
    }
    pick(path);
  }

  // ─── Path utilities ───────────────────────────────────────────────────
  function normalisePath(p) {
    if (!p) return null;
    let s = String(p).trim();
    if (!s) return null;
    // Collapse trailing slashes (but keep "/" itself).
    if (s.length > 1) s = s.replace(/\/+$/, "");
    return s;
  }

  function parentOf(p) {
    if (!p || p === "/") return "/";
    const idx = p.lastIndexOf("/");
    if (idx <= 0) return "/";
    return p.slice(0, idx) || "/";
  }

  function byName(a, b) {
    return String(a.name).localeCompare(String(b.name));
  }

  // ─── Event delegation ─────────────────────────────────────────────────
  function onRootClick(e) {
    const target = /** @type {HTMLElement|null} */ (e.target);
    if (!target) return;
    if (e.target === root) {
      close("cancel");
      return;
    }
    const closer = target.closest("[data-close-path-picker]");
    if (closer) {
      close("cancel");
      return;
    }
    const upBtn = target.closest("[data-path-picker-up]");
    if (upBtn) {
      navigateUp();
      return;
    }
    const homeBtn = target.closest("[data-path-picker-home]");
    if (homeBtn) {
      navigateHome();
      return;
    }
    const refreshBtn = target.closest("[data-path-picker-refresh]");
    if (refreshBtn) {
      if (ctx?.currentPath) navigateTo(ctx.currentPath);
      return;
    }
    const goBtn = target.closest("[data-path-picker-go]");
    if (goBtn) {
      submitPathInput();
      return;
    }
    const selectBtn = target.closest("[data-path-picker-select]");
    if (selectBtn) {
      pickCurrent();
      return;
    }
    const hiddenCb = target.closest("[data-path-picker-hidden-toggle]");
    if (hiddenCb && hiddenCb instanceof HTMLInputElement) {
      if (ctx) {
        ctx.showHidden = hiddenCb.checked;
        if (ctx.currentPath) navigateTo(ctx.currentPath);
      }
      return;
    }
  }

  function onKeydown(e) {
    if (!ctx || !root || root.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close("cancel");
      return;
    }
    if (e.key === "Enter") {
      // If the focus is in the path input, submit it. Otherwise Enter picks.
      const ae = document.activeElement;
      if (ae && ae instanceof HTMLInputElement && ae.matches('[data-path-picker-input]')) {
        e.preventDefault();
        submitPathInput();
        return;
      }
      // Don't capture Enter while a row is focused — the row's own handler
      // takes care of selection. Just pick whatever is selected.
      e.preventDefault();
      pickCurrent();
    }
  }

  function submitPathInput() {
    const rootEl = build();
    const input = rootEl.querySelector('[data-path-picker-input]');
    if (!input || !(input instanceof HTMLInputElement)) return;
    const raw = input.value.trim();
    if (!raw) {
      setStatus("Type a path first.");
      return;
    }
    // Treat a bare "~" or "~/..." as the user's home (very common in shells).
    let target = raw;
    if (raw === "~" || raw.startsWith("~/")) {
      target = "/" + raw.slice(2);
    }
    navigateTo(target);
  }

  // ─── Command-palette wiring ───────────────────────────────────────────
  function registerPaletteAction() {
    const palette = window.OpenKanCommandPalette;
    if (!palette || typeof palette.registerAction !== "function") return;
    palette.registerAction({
      id: "project.pick-path",
      label: "Open Path Picker",
      hint: "Pick a folder from the filesystem",
      keys: "Cmd/Ctrl+Shift+O",
      run: () => {
        open({
          title: "Choose a folder",
          mode: "folder",
          onPick: (path) => {
            const show =
              window.OpenKanSettings?.showToast ||
              ((m) => console.log("[path-picker]", m));
            try { show(`Picked: ${path}`); } catch {}
          },
        });
      },
    });
  }

  function bootShortcut() {
    document.addEventListener("keydown", (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.shiftKey && (e.key === "o" || e.key === "O")) {
        // Don't fight the OS open shortcut when the user is typing in a
        // non-picker input.
        const ae = document.activeElement;
        if (ae && ae instanceof HTMLInputElement) {
          // Always allow the picker to open even from inputs — it's a
          // global launcher. But skip if the focus is inside the picker
          // itself to avoid recursion.
          if (ae.matches('[data-path-picker-input]')) return;
        }
        e.preventDefault();
        e.stopPropagation();
        open({
          title: "Choose a folder",
          mode: "folder",
          onPick: (path) => {
            const show =
              window.OpenKanSettings?.showToast ||
              ((m) => console.log("[path-picker]", m));
            try { show(`Picked: ${path}`); } catch {}
          },
        });
      }
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────
  window.OpenKanPathPicker = { open, close };

  function boot() {
    registerPaletteAction();
    bootShortcut();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();