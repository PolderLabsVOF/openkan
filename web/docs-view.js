// OpenKan Docs — preview-first MDX workspace with an in-place source editor.
// The rendered preview is the default surface; an "Edit" button swaps it for a
// toolbar + textarea so the user can shape MDX without leaving the page, then
// calls back into the existing /api/docs/* API to persist.
(() => {
  "use strict";
  const { api } = window.OpenKanAPI;
  let state = null;
  let renderTimer = 0;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  const DOC_FILE_PATTERN = /\.(md|mdx|txt)$/i;
  const flatten = (entries, out = []) => { for (const entry of entries || []) entry.isDir ? flatten(entry.children, out) : out.push(entry); return out; };
  const safePath = (value = "") => String(value).trim().replace(/^\/+/, "").replace(/\.\.+/g, "");
  const askPath = (value = "") => safePath(prompt("Document path relative to docs/", value) || "");
  const fileName = (path) => path ? path.split("/").pop() : "Untitled document";
  const relativeTime = (iso) => iso ? new Intl.DateTimeFormat(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }).format(new Date(iso)) : "";

  function sourceToolbar() {
    return `<div class="docs-source-tools" aria-label="Markdown formatting"><button data-doc-format="h2" title="Heading">H2</button><button data-doc-format="bold" title="Bold"><b>B</b></button><button data-doc-format="italic" title="Italic"><i>I</i></button><button data-doc-format="ul" title="Bulleted list">• List</button><button data-doc-format="ol" title="Numbered list">1. List</button><button data-doc-format="link" title="Link">↗</button><button data-doc-format="code" title="Code">&lt;/&gt;</button></div>`;
  }
  function visibleTree(entries, query = "") {
    return (entries || []).flatMap((entry) => {
      if (entry.isDir) {
        const children = visibleTree(entry.children, query);
        return children.length ? [{ ...entry, children }] : [];
      }
      return DOC_FILE_PATTERN.test(entry.path) && (!query || entry.path.toLowerCase().includes(query)) ? [entry] : [];
    });
  }
  function directoryCount(entries) {
    return (entries || []).reduce((count, entry) => count + (entry.isDir ? directoryCount(entry.children) : 1), 0);
  }
  function openParentDirectories(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) { current = current ? `${current}/${part}` : part; state.expandedDirs.add(current); }
  }
  function docTree(entries, depth = 0) {
    return entries.map((entry) => {
      if (!entry.isDir) {
        const extension = entry.name.includes(".") ? entry.name.split(".").pop().toUpperCase() : "TEXT";
        return `<button class="docs-tree-file${entry.path === state.path ? " active" : ""}" data-doc-path="${esc(entry.path)}" title="${esc(entry.path)}"><strong>${esc(entry.name)}</strong><span>${extension}</span></button>`;
      }
      const open = state.docFilter || state.expandedDirs.has(entry.path) || state.path.startsWith(`${entry.path}/`);
      const children = docTree(entry.children || [], depth + 1);
      return `<details class="docs-tree-directory" data-doc-directory="${esc(entry.path)}" ${open ? "open" : ""}><summary class="docs-tree-directory-summary"><span class="docs-tree-directory-name">${esc(entry.name)}</span><small>${directoryCount(entry.children)}</small></summary><div class="docs-tree-children" style="--docs-tree-depth:${depth + 1}">${children}</div></details>`;
    }).join("");
  }
  function renderTree() {
    const list = state?.root?.querySelector("[data-doc-list]");
    if (!list) return;
    const query = String(state.docFilter || "").trim().toLowerCase();
    const tree = visibleTree(state.entries, query);
    list.innerHTML = docTree(tree) || `<div class="docs-empty-tree">${query ? "No documents match this filter." : "No documents yet.<br>Create your first workspace note."}</div>`;
    list.querySelectorAll("[data-doc-path]").forEach((button) => button.addEventListener("click", () => load(button.dataset.docPath)));
    list.querySelectorAll("[data-doc-directory]").forEach((directory) => directory.addEventListener("toggle", () => {
      if (directory.open) state.expandedDirs.add(directory.dataset.docDirectory);
      else state.expandedDirs.delete(directory.dataset.docDirectory);
    }));
  }
  function renderPreviewBody() {
    if (state.html) return state.html;
    if (state.editing) return `<section class="docs-preview-empty"><h3>Start a durable note.</h3><p>Markdown previews here as you write. **bold**, *italic*, ` + "`code`" + `, and [links](https://example.com) all render.</p></section>`;
    return `<section class="docs-preview-empty"><h3>Pick a document, or start a new one.</h3><p>The rendered MDX lives here. Click <strong>Edit</strong> above to open the source panel — the preview keeps pace as you type.</p><button data-doc-action="new">New document</button></section>`;
  }
  function editorView() {
    return `<section class="docs-editor-shell" aria-label="Source editor">${sourceToolbar()}<textarea id="docs-editor-input" spellcheck="true" placeholder="# Start writing…">${esc(state.content)}</textarea><footer class="docs-editor-foot"><span>${state.content.length.toLocaleString()} characters</span><span class="docs-editor-hint">MDX / Markdown · preview updates as you type</span></footer></section>`;
  }
  function render() {
    if (!state?.root) return;
    const files = flatten(state.entries).filter((entry) => DOC_FILE_PATTERN.test(entry.path));
    const status = state.dirty ? "Unsaved draft" : state.path ? `Saved ${relativeTime(state.mtime)}` : "New draft";
    const editLabel = state.editing ? "Done editing" : "Edit document";
    const stageBody = state.editing
      ? editorView()
      : `<article class="docs-rendered docs-mdx-preview" tabindex="0" data-doc-preview>${renderPreviewBody()}</article>`;
    state.root.innerHTML = `<section class="docs-shell">
      <div class="docs-workspace docs-workspace--${state.editing ? "editing" : "reading"}">
        <aside class="docs-sidebar"><div class="docs-sidebar-head"><div><span>docs/</span><small>${files.length} documents · folders preserved</small></div><button data-doc-action="new" aria-label="New document">+</button></div><div class="docs-sidebar-search"><input type="search" value="${esc(state.docFilter || "")}" placeholder="Filter documents" aria-label="Filter documents" data-doc-filter></div><div class="docs-file-list docs-folder-tree" data-doc-list></div><div class="docs-sidebar-foot"><button data-doc-action="generate">Generate with agent</button></div></aside>
        <main class="docs-stage">
          <header class="docs-filebar"><div class="docs-file-ident"><span class="docs-file-icon">⌁</span><span><strong>${esc(fileName(state.path))}</strong><small>${esc(state.path || "Choose a path before saving")} · ${status}</small></span></div>
            <div class="docs-file-actions">
              ${state.editing
                ? `<button class="docs-btn-secondary" data-doc-action="cancel-edit">Discard</button><button class="docs-btn-primary" data-doc-action="save" ${state.path ? "" : "disabled"}>Save changes</button>`
                : `<button class="docs-btn-secondary" data-doc-action="help" title="MDX syntax help">MDX help</button><button class="docs-btn-primary" data-doc-action="source" aria-pressed="${state.editing}">${editLabel}</button>`}
              <button data-doc-action="more" aria-label="More document actions" class="docs-btn-icon">•••</button>
            </div>
          </header>
          ${stageBody}
        </main>
      </div><div id="docs-context-menu" class="docs-context-menu" hidden></div></section>`;
    wire();
  }
  function wire() {
    const root = state.root;
    renderTree();
    root.querySelectorAll("[data-doc-action]").forEach((button) => button.addEventListener("click", () => action(button.dataset.docAction)));
    root.querySelectorAll("[data-doc-format]").forEach((button) => button.addEventListener("click", () => applyFormat(button.dataset.docFormat)));
    root.querySelector("#docs-editor-input")?.addEventListener("input", (event) => {
      state.content = event.target.value; state.dirty = true;
      const status = root.querySelector(".docs-file-ident small");
      if (status) status.textContent = `${state.path || "Choose a path before saving"} · Unsaved draft`;
      schedulePreview();
    });
    root.querySelector("[data-doc-filter]")?.addEventListener("input", (event) => {
      state.docFilter = event.target.value;
      renderTree();
    });
    root.addEventListener("contextmenu", contextMenu);
    document.addEventListener("click", dismissMenu, { once: true });
  }
  async function load(path) {
    if (!path || !state) return;
    const doc = await api("GET", `/api/docs/${encodeURI(path)}?raw=0`);
    openParentDirectories(path);
    Object.assign(state, { path, content: doc.raw || "", html: doc.html || doc.rendered || "", mtime: doc.mtime || "", dirty: false, editing: false });
    render();
  }
  async function refresh({ loadInitial = false } = {}) {
    const docs = await api("GET", "/api/docs");
    state.entries = docs.entries || [];
    const files = flatten(state.entries).filter((entry) => DOC_FILE_PATTERN.test(entry.path));
    if (loadInitial && files.length) return load(state.initialDoc && files.some((file) => file.path === state.initialDoc) ? state.initialDoc : files[0].path);
    render();
  }
  async function renderPreview() {
    if (!state) return;
    const rendered = await api("POST", "/api/docs/render", { content: state.content });
    state.html = rendered.html || rendered.rendered || "";
  }
  function schedulePreview() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(async () => {
      try { await renderPreview(); } catch { return; }
      if (!state?.root) return;
      const preview = state.root.querySelector("[data-doc-preview]");
      if (preview) preview.innerHTML = state.html;
    }, 480);
  }
  async function save() {
    if (!state.path) return;
    await renderPreview();
    const doc = await api("PUT", `/api/docs/${encodeURI(state.path)}`, { content: state.content });
    Object.assign(state, { html: doc.html || doc.rendered || state.html, mtime: doc.mtime || new Date().toISOString(), dirty: false });
    state.editing = false;
    await refresh();
  }
  function insertAtSelection(before, after = "", placeholder = "text") {
    const textarea = state.root.querySelector("#docs-editor-input");
    if (!textarea) { state.editing = true; render(); requestAnimationFrame(() => insertAtSelection(before, after, placeholder)); return; }
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const chosen = textarea.value.slice(start, end) || placeholder;
    const output = `${textarea.value.slice(0, start)}${before}${chosen}${after}${textarea.value.slice(end)}`;
    textarea.value = output; textarea.focus(); textarea.setSelectionRange(start + before.length, start + before.length + chosen.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function applyFormat(kind) {
    if (kind === "h2") return insertAtSelection("## ", "", "Heading");
    if (kind === "bold") return insertAtSelection("**", "**", "bold text");
    if (kind === "italic") return insertAtSelection("*", "*", "emphasis");
    if (kind === "ul") return insertAtSelection("- ", "", "List item");
    if (kind === "ol") return insertAtSelection("1. ", "", "List item");
    if (kind === "code") return insertAtSelection("`", "`", "code");
    if (kind === "link") { const url = prompt("Link URL", "https://"); if (url) insertAtSelection("[", `](${url})`, "link text"); }
  }
  async function action(name) {
    if (name === "new") { const path = askPath("notes/new-document.mdx"); if (!path) return; Object.assign(state, { path, content: "# New document\n\n", html: "<h1>New document</h1>", mtime: "", dirty: true, editing: true }); return render(); }
    if (name === "source") { state.editing = !state.editing; return render(); }
    if (name === "cancel-edit") {
      // Reload the canonical content from the server so we drop unsaved edits.
      if (state.path) {
        const doc = await api("GET", `/api/docs/${encodeURI(state.path)}?raw=0`);
        Object.assign(state, { content: doc.raw || "", html: doc.html || doc.rendered || "", mtime: doc.mtime || "", dirty: false, editing: false });
      } else {
        state.editing = false;
      }
      return render();
    }
    if (name === "save") return save();
    if (name === "more") return openMoreMenu();
    if (name === "help") return showHelp();
    if (name === "generate") return generate();
  }
  function showHelp() { alert("OpenKan MDX\n\n# Heading\n**bold** · *italic* · `code`\n- bullet\n1. numbered\n[link](https://example.com)\n\nClick **Edit document** to switch into the source editor. The preview re-renders as you type and Save writes back to the same path."); }
  async function generate() {
    const path = askPath(state.path || "guides/new-guide.mdx"); if (!path) return;
    const promptText = prompt("What should the configured agent write?", "Create a practical, complete guide."); if (!promptText) return;
    state.root.classList.add("is-generating");
    try { const doc = await api("POST", "/api/docs/generate", { path, prompt: promptText, model: "default", effort: "high", permissionMode: "bypassPermissions" }); Object.assign(state, { path, content: doc.raw || "", html: doc.html || doc.rendered || "", mtime: doc.mtime || "", dirty: false, editing: false }); await refresh(); } finally { state?.root?.classList.remove("is-generating"); }
  }
  function menuAt(html, x, y) { const menu = state.root.querySelector("#docs-context-menu"); menu.innerHTML = html; menu.hidden = false; menu.style.left = `${x}px`; menu.style.top = `${y}px`; return menu; }
  function dismissMenu(event) { if (!event?.target?.closest?.("#docs-context-menu")) { const menu = state?.root?.querySelector("#docs-context-menu"); if (menu) menu.hidden = true; } }
  function openMoreMenu() { const trigger = state.root.querySelector('[data-doc-action="more"]'); const box = trigger.getBoundingClientRect(); const menu = menuAt(`<button data-doc-menu="rename">Rename document</button><button data-doc-menu="delete" class="danger">Delete document</button>`, box.left, box.bottom + 6); menu.onclick = async (event) => { const actionName = event.target.dataset.docMenu; menu.hidden = true; if (actionName === "delete" && state.path && confirm(`Delete ${state.path}?`)) { await api("DELETE", `/api/docs/${encodeURI(state.path)}`); Object.assign(state, { path:"", content:"", html:"", dirty:false, editing:false }); await refresh({ loadInitial:true }); } if (actionName === "rename" && state.path) { const next = askPath(state.path); if (!next || next === state.path) return; await api("PUT", `/api/docs/${encodeURI(next)}`, { content: state.content }); await api("DELETE", `/api/docs/${encodeURI(state.path)}`); state.path = next; await refresh(); } }; }
  function contextMenu(event) { const file = event.target.closest("[data-doc-path]"); const editor = event.target.closest("#docs-editor-input"); if (!file && !editor) return; event.preventDefault(); const menu = file ? menuAt(`<button data-doc-menu="open">Open</button><button data-doc-menu="rename">Rename</button><button data-doc-menu="delete" class="danger">Delete</button>`, event.clientX, event.clientY) : menuAt(`<button data-doc-format="h2">Heading</button><button data-doc-format="bold">Bold</button><button data-doc-format="italic">Italic</button><button data-doc-format="ul">Bulleted list</button><button data-doc-format="link">Link</button>`, event.clientX, event.clientY); menu.onclick = async (actionEvent) => { menu.hidden = true; const format = actionEvent.target.dataset.docFormat; if (format) return applyFormat(format); const menuAction = actionEvent.target.dataset.docMenu, path = file?.dataset.docPath; if (menuAction === "open") return load(path); if (menuAction === "delete" && confirm(`Delete ${path}?`)) { await api("DELETE", `/api/docs/${encodeURI(path)}`); return refresh({ loadInitial: path === state.path }); } if (menuAction === "rename") { const next = askPath(path); if (!next || next === path) return; const doc = await api("GET", `/api/docs/${encodeURI(path)}?raw=0`); await api("PUT", `/api/docs/${encodeURI(next)}`, { content: doc.raw || "" }); await api("DELETE", `/api/docs/${encodeURI(path)}`); if (path === state.path) state.path = next; return refresh(); } }; }
  window.OpenKanDocs = { async mount(root, options = {}) { if (state?.root === root) return; state = { root, entries: [], path:"", content:"", html:"", mtime:"", dirty:false, editing:false, docFilter:"", expandedDirs:new Set(), initialDoc:options.initialDoc || "" }; await refresh({ loadInitial:true }); }, unmount() { clearTimeout(renderTimer); state = null; } };
})();
