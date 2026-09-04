// OpenKan — task detail view (M7/M8/M9 + M10/M11 + M13 keyboard nav).
// window.OpenKanTaskView = { open(taskId), close(), getCurrentTaskId() }
//
// Owns:
//   - #task-view shell + header + "needs you" banner
//   - assignees row, agent progress timeline, last-activity timestamp
//   - right-side comments panel + inputs history
//   - delegates rendered HTML → window.OpenKanMdxViewer.mount(...)
//   - archive / restore / move-to-next-column actions
//   - SSE subscriptions scoped to this task (filters by taskId)

(() => {
  "use strict";

  const { api, on } = window.OpenKanAPI;

  // Categories that the server may report; must match what the cards + filter
  // bar use (see web/app.js).
  const CATEGORIES = new Set([
    "frontend", "backend", "infra", "docs",
    "test", "design", "data", "security", "task",
  ]);
  const PRIORITY_META = {
    urgent: { code: "P0", label: "Urgent" },
    high:   { code: "P1", label: "High" },
    normal: { code: "P2", label: "Normal" },
    low:    { code: "P3", label: "Low" },
  };
  // Same column progression as the board.
  const COLUMN_ORDER = ["backlog", "todo", "doing", "review", "done"];
  const COLUMN_LABEL = {
    backlog: "Backlog", todo: "To Do", doing: "In Progress", review: "Review", done: "Done",
  };

  let currentTaskId = null;
  /** @type {Array<() => void>} */
  let unsubs = [];

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

  // Build a clickable tag chip. When the user clicks one in the task view,
  // we close the view, set the tag as a board filter, and re-render.
  function makeTagChip(tag) {
    const lower = String(tag).toLowerCase();
    const isCategory = CATEGORIES.has(lower);
    const cls = `tag-chip t-${lower}` + (isCategory ? " category" : "");
    const chip = el("button", cls, { type: "button", text: lower, title: `Filter board by ${lower}` });
    if (isCategory) chip.classList.add(`c-${lower}`);
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const board = window.OpenKanBoard;
      if (board) board.setTagFilter(lower);
      window.OpenKanTaskView.close();
    });
    return chip;
  }

  function shortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      year: sameYear ? undefined : "numeric",
    });
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

  // ─── Inline editing ─────────────────────────────────────────────────────────
  // Wire a contenteditable element (title or description) to auto-save on
  // blur (debounced 800ms) or Enter (Shift+Enter inserts a newline). Shows
  // a "✓ Saved" toast on success. Returns a cleanup function.
  function wireInlineEdit(el_, task, field) {
    if (!el_) return () => {};
    let timer = null;
    let lastSaved = String(el_.dataset?.original ?? el_.textContent ?? "");

    const flush = async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const newVal = String(el_.textContent || "").trim();
      if (newVal === lastSaved) return;
      if (field === "title" && !newVal) {
        // Title is required — revert on empty.
        el_.textContent = lastSaved;
        return;
      }
      try {
        await api("PATCH", `/api/tasks/${task.id}`, { [field]: newVal });
        lastSaved = newVal;
        el_.classList.remove("dirty");
        if (window.OpenKanSettings?.showToast) {
          window.OpenKanSettings.showToast(`✓ Saved`, "success");
        }
      } catch (err) {
        el_.classList.add("dirty");
        if (window.OpenKanSettings?.showToast) {
          window.OpenKanSettings.showToast(`Save failed: ${err.message}`, "error");
        } else {
          alert(`Save failed: ${err.message}`);
        }
      }
    };

    const debouncedFlush = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 800);
    };

    const onInput = () => {
      el_.classList.toggle("dirty", String(el_.textContent || "").trim() !== lastSaved);
      el_.classList.remove("placeholder");
      debouncedFlush();
    };
    const onKeydown = (e) => {
      if (field === "title" && e.key === "Enter") {
        e.preventDefault();
        flush();
        el_.blur();
      } else if (field === "description" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        flush();
        el_.blur();
      }
    };
    const onBlur = () => {
      flush();
    };
    const onFocus = () => {
      el_.classList.add("editing");
    };
    const onFocusout = () => {
      el_.classList.remove("editing");
    };

    el_.addEventListener("input", onInput);
    el_.addEventListener("keydown", onKeydown);
    el_.addEventListener("blur", onBlur);
    el_.addEventListener("focus", onFocus);
    el_.addEventListener("focusout", onFocusout);

    return () => {
      if (timer) clearTimeout(timer);
      el_.removeEventListener("input", onInput);
      el_.removeEventListener("keydown", onKeydown);
      el_.removeEventListener("blur", onBlur);
      el_.removeEventListener("focus", onFocus);
      el_.removeEventListener("focusout", onFocusout);
    };
  }

  // ─── Right-click context menu on the MDX slot ──────────────────────────────
  // The MDX viewer is shared with the per-task card right-click menu, so we
  // expose the menu renderer at window.OpenKanMenu (set by app.js). If it
  // isn't available (e.g. tests), this is a no-op.
  function onMdxContextMenu(ev) {
    const menu = window.OpenKanMenu;
    if (!menu) return;
    // Don't hijack the menu on input/textarea/buttons.
    const tag = (ev.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "button" || tag === "a") return;
    if (ev.target.isContentEditable) return;

    ev.preventDefault();
    ev.stopPropagation();

    // Pick the closest block (or use the MDX root if user right-clicked the
    // empty area).
    const block = ev.target.closest(".mdx-block[data-block-id]");
    const blockId = block?.getAttribute("data-block-id") || null;
    const line = block?.getAttribute("data-line") || null;

    const items = [
      { label: "Copy", action: () => {
        const sel = window.getSelection()?.toString() || block?.textContent || "";
        if (!sel) return;
        navigator.clipboard.writeText(sel).catch(() => {});
      }},
      { label: "Copy as Markdown", action: () => {
        // Render the HTML to plain markdown-ish text via textContent of
        // each block, preserving newlines. Lightweight — the task view
        // surfaces this for "paste into chat" workflows.
        const target = block || ev.target.closest(".mdx-slot");
        if (!target) return;
        const text = target.innerText || target.textContent || "";
        navigator.clipboard.writeText(text).catch(() => {});
      }},
      { label: "Open in new tab", action: () => {
        const url = `${location.origin}${location.pathname}#tab=tasks&taskId=${currentTaskId}`;
        window.open(url, "_blank", "noopener");
      }},
    ];
    if (blockId) {
      items.push({ kind: "divider" });
      items.push({
        label: "Add comment here",
        action: () => {
          // Synthesize a click on the block so the mdx-viewer opens its composer.
          try { block.click(); } catch {}
          setTimeout(() => {
            const ta = document.querySelector(".mdx-block-comment-composer .composer-textarea");
            if (ta) try { ta.focus(); } catch {}
          }, 80);
        },
      });
      items.push({
        label: `Copy block hash (${String(blockId).slice(0, 8)}…)`,
        action: () => {
          navigator.clipboard.writeText(String(blockId)).catch(() => {});
        },
      });
      if (line) {
        items.push({
          label: `Copy line number (${line})`,
          action: () => {
            navigator.clipboard.writeText(String(line)).catch(() => {});
          },
        });
      }
    }
    menu.showAt(items, ev);
  }

  // ─── Render header ──────────────────────────────────────────────────────────
  // Layout (top to bottom):
  //   • Quick-actions toolbar (right-aligned icon buttons)
  //   • Back button row + <h1 contenteditable="true"> title + status pills
  //   • <div contenteditable="true"> description
  function renderHeader(root, task) {
    root.innerHTML = "";
    const header = el("header", "task-header");

    // Quick-actions toolbar uses compact text labels so every action remains
    // clear without relying on emoji or a separate icon dependency.
    const actions = el("div", "task-actions");
    const mkIconBtn = (glyph, label, onClick, danger) => {
      const b = el("button", "task-action-btn" + (danger ? " danger" : ""), {
        type: "button",
        text: glyph,
        title: label,
        "aria-label": label,
      });
      b.addEventListener("click", onClick);
      return b;
    };
    // Copy task ID.
    actions.append(mkIconBtn("ID", "Copy ID", async () => {
      try {
        await navigator.clipboard.writeText(String(task.id || ""));
        window.OpenKanSettings?.showToast?.("Task ID copied", "success");
      } catch (_) {
        alert(`Task ID: ${task.id}`);
      }
    }));
    // Copy markdown link.
    actions.append(mkIconBtn("Link", "Copy markdown link", async () => {
      const md = `[${task.title || task.id}](.ok/tasks/${task.id}/task.mdx)`;
      try {
        await navigator.clipboard.writeText(md);
        window.OpenKanSettings?.showToast?.("Markdown link copied", "success");
      } catch (_) {
        alert(md);
      }
    }));
    // Open in new tab — same URL but in a fresh tab so the user can keep
    // their context (e.g. side-by-side comparison).
    actions.append(mkIconBtn("Open", "Open in new tab", () => {
      const url = `${location.origin}${location.pathname}#tab=tasks&taskId=${task.id}`;
      window.open(url, "_blank", "noopener");
    }));
    // Edit — focuses the inline-editable title (the footer also has an Edit
    // button; this one is just closer to the cursor for keyboard users).
    actions.append(mkIconBtn("Edit", "Edit title & description", () => {
      const titleEl = document.querySelector(".task-title");
      if (titleEl && titleEl.isContentEditable) {
        try { titleEl.focus(); } catch {}
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        return;
      }
      if (window.OpenKanEditTask?.open) window.OpenKanEditTask.open(task.id);
    }));
    // Archive / Restore.
    if (task.archived) {
      actions.append(mkIconBtn("Restore", "Restore from archive", async () => {
        try { await api("POST", `/api/tasks/${task.id}/restore`); }
        catch (err) { alert(`Restore failed: ${err.message}`); }
      }));
    } else {
      actions.append(mkIconBtn("Archive", "Archive", () => {
        if (!confirm(`Archive "${task.title}"?`)) return;
        api("POST", `/api/tasks/${task.id}/archive`).catch((err) =>
          alert(`Archive failed: ${err.message}`),
        );
      }));
    }
    // Delete (always last in the toolbar, danger styling).
    actions.append(mkIconBtn("Delete", "Delete task", () => {
      if (!confirm(`Delete task "${task.title}"? This cannot be undone.`)) return;
      api("DELETE", `/api/tasks/${task.id}`)
        .then(() => window.OpenKanTaskView.close())
        .catch((err) => alert(`Delete failed: ${err.message}`));
    }, true));
    header.append(actions);

    const back = el("button", "btn", { text: "← Back", type: "button" });
    back.addEventListener("click", () => window.OpenKanTaskView.close());
    header.append(back);

    const titleWrap = el("div", "task-title-wrap");
    const title = el("h1", "task-title", {
      contenteditable: "true",
      spellcheck: "false",
      "data-original": task.title || "",
      title: "Click to edit title",
      "aria-label": "Task title (click to edit)",
    });
    title.textContent = task.title || "(untitled)";
    titleWrap.append(title);

    header.append(titleWrap);

    // Right-aligned status / priority pills (visually anchored to the title row).
    const statusCol = el("div", "task-status-col");
    const state = effectiveState(task);
    const statePill = el("span", `pill state-pill state-${state}`, { text: state });
    statusCol.append(statePill);
    const pri = PRIORITY_META[task.priority];
    if (pri && task.priority) {
      const pCls = `priority-${task.priority}`;
      statusCol.append(el("span", `pill ${pCls}`, {
        text: `${pri.code} ${pri.label}`,
        title: `priority: ${pri.label}`,
      }));
    }
    if (task.archived) statusCol.append(el("span", "pill archived-pill", { text: "archived" }));
    header.append(statusCol);

    // Description — also inline-editable. Lives directly under the header so
    // title+description form the natural top of the task.
    const desc = el("div", "task-description", {
      contenteditable: "true",
      spellcheck: "true",
      "data-original": task.description || "",
      title: "Click to edit description",
      "aria-label": "Task description (click to edit)",
    });
    desc.textContent = task.description || "";
    if (!task.description) desc.classList.add("placeholder");
    header.append(desc);

    root.append(header);

    // Wire inline-edit save on title + description.
    wireInlineEdit(title, task, "title");
    wireInlineEdit(desc, task, "description");
  }

  // ─── Render "Needs you" banner ─────────────────────────────────────────────
  function renderBanner(root, task, pendingInput) {
    root.innerHTML = "";
    if (effectiveState(task) !== "waiting-for-input" || !pendingInput) return;

    const banner = el("section", "needs-you-banner");
    const cat = String(task.category || "").toLowerCase();
    if (cat && CATEGORIES.has(cat)) banner.classList.add(`cat-${cat}`);
    banner.append(el("div", "banner-title", { text: "Needs your input" }));
    banner.append(el("div", "banner-question", { text: pendingInput.question || "" }));

    const form = el("form", "banner-form");
    let inputEl;
    switch (pendingInput.type) {
      case "choice": {
        inputEl = el("div", "banner-options");
        const opts = pendingInput.options ?? [];
        for (const opt of opts) {
          const id = `${pendingInput.id}-${opt.id}`;
          const radio = el("input", null, { type: "radio", name: "value", value: opt.id, id });
          const lbl = el("label", null, { for: id });
          lbl.append(radio, ` ${opt.label}`);
          if (opt.description) {
            const desc = el("div", "option-desc", { text: opt.description });
            lbl.append(desc);
          }
          inputEl.append(lbl);
        }
        form.append(inputEl);
        break;
      }
      case "confirm": {
        const row = el("div", "banner-confirm-row");
        const yesId = `${pendingInput.id}-yes`;
        const noId = `${pendingInput.id}-no`;
        const yes = el("label", null, { for: yesId });
        yes.append(el("input", null, { type: "radio", name: "value", value: "yes", id: yesId }), " Yes");
        const no = el("label", null, { for: noId });
        no.append(el("input", null, { type: "radio", name: "value", value: "no", id: noId }), " No");
        row.append(yes, no);
        form.append(row);
        break;
      }
      case "input":
      case "ask":
      default: {
        const ta = el("textarea", "banner-textarea", {
          rows: "3",
          placeholder: pendingInput.placeholder || "Type your response…",
          name: "value",
        });
        form.append(ta);
        break;
      }
    }
    const actions = el("div", "banner-actions");
    const cancel = el("button", "btn", { text: "Cancel", type: "button" });
    cancel.addEventListener("click", () => {
      if (confirm("Discard this question? The agent will continue without your answer.")) {
        banner.hidden = true;
      }
    });
    const submit = el("submit", "btn btn-primary", { text: "Send", type: "submit" });
    actions.append(cancel, submit);
    form.append(actions);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      let body;
      if (pendingInput.type === "choice") {
        body = { inputId: pendingInput.id, optionId: String(fd.get("value") || "") };
        if (!body.optionId) return alert("Please choose an option.");
      } else if (pendingInput.type === "confirm") {
        body = { inputId: pendingInput.id, value: String(fd.get("value") || "") };
        if (!body.value) return alert("Please choose Yes or No.");
      } else {
        body = { inputId: pendingInput.id, value: String(fd.get("value") || "").trim() };
        if (!body.value) return alert("Please type a response.");
      }
      submit.disabled = true;
      try {
        await api("POST", `/api/tasks/${task.id}/respond`, body);
      } catch (err) {
        alert(`Failed to send response: ${err.message}`);
        submit.disabled = false;
      }
    });

    banner.append(form);
    root.append(banner);
  }

  // ─── Render comments panel ──────────────────────────────────────────────────
  // Best-effort resolve of the current user; used to decide whether the
  // delete affordance is shown (only your own comments can be deleted).
  let cachedMe = null;
  async function fetchMe() {
    if (cachedMe) return cachedMe;
    try {
      cachedMe = await api("GET", "/api/me");
    } catch {
      cachedMe = { name: "user" };
    }
    try { window.OpenKanCurrentUser = cachedMe; } catch {}
    return cachedMe;
  }
  function meName() {
    return cachedMe?.name || window.OpenKanCurrentUser?.name || "user";
  }

  function renderCommentCard(task, c) {
    const author = String(c.author || "user");
    const seed = author;
    const card = el("article", `comment${c.resolved ? " resolved" : ""}`, { "data-cid": c.id });

    // Header row — avatar, author name, timestamp on the right.
    const head = el("div", "comment-head");
    const av = el("span", "avatar-circle avatar-md");
    av.style.setProperty("--avatar-bg", avatarColorFor(seed));
    av.textContent = initialsFor(author);
    head.append(av);

    const authorWrap = el("div", "comment-author");
    authorWrap.append(el("span", "comment-author-name", {
      text: author,
      title: author,
    }));
    authorWrap.append(el("span", "comment-timestamp", {
      text: relativeTime(c.createdAt),
      title: c.createdAt,
    }));
    head.append(authorWrap);
    card.append(head);

    // Line indicator (small dim chip) — surfaces which block the comment was
    // attached to so readers can correlate without scrolling.
    if (c.line || c.blockId) {
      const lineChip = el("span", "comment-line-chip", {
        text: c.blockId ? `block ${String(c.blockId).slice(0, 8)} · line ${c.line || "?"}` : `line ${c.line || "?"}`,
        title: `blockId: ${c.blockId || ""}`,
      });
      card.append(lineChip);
    }

    card.append(el("div", "comment-text", { text: c.text }));

    // Resolved footer (if resolved). The server populates `resolvedBy` and
    // `resolvedAt`; fall back gracefully when older tasks don't carry them.
    if (c.resolved) {
      const by = c.resolvedBy || "user";
      const at = c.resolvedAt || c.createdAt;
      card.append(el("div", "comment-resolved-foot", {
        text: `✓ resolved by ${by} · ${relativeTime(at)}`,
        title: at,
      }));
    }

    // Actions row — Reply (always shown; focuses the composer for the same
    // block when one is open, else scrolls the block into view) + Resolve +
    // Delete (delete only for the author).
    const actions = el("div", "comment-actions");
    const reply = el("button", "comment-action-link", {
      text: "Reply",
      type: "button",
      title: "Open the comment composer for this block",
    });
    reply.addEventListener("click", () => {
      const root = document.querySelector(".task-view");
      if (!root) return;
      const block = root.querySelector(`.mdx-block[data-block-id="${CSS.escape(c.blockId || "")}"]`);
      if (block) {
        block.scrollIntoView({ behavior: "smooth", block: "center" });
        // Programmatically dispatch a click on the block so the existing
        // mdx-viewer handler opens the composer.
        try { block.click(); } catch {}
        // Focus the textarea after a tick so the click handler has time to
        // insert the composer.
        setTimeout(() => {
          const ta = document.querySelector(".mdx-block-comment-composer .composer-textarea");
          if (ta) try { ta.focus(); } catch {}
        }, 80);
      }
    });
    actions.append(reply);

    const toggle = el("button", "btn btn-icon-sm", {
      text: c.resolved ? "Unresolve" : "Resolve",
      type: "button",
    });
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await api("PATCH", `/api/tasks/${task.id}/comments/${c.id}`, {
          resolved: !c.resolved,
          author: meName(),
        });
      } catch (err) {
        alert(`Failed: ${err.message}`);
        toggle.disabled = false;
      }
    });
    actions.append(toggle);

    if (author === meName()) {
      const del = el("button", "btn btn-icon-sm danger comment-delete", {
        text: "×",
        type: "button",
        title: "Delete this comment",
        "aria-label": "Delete this comment",
      });
      del.addEventListener("click", async () => {
        if (!confirm("Delete this comment?")) return;
        del.disabled = true;
        try {
          await api("DELETE", `/api/tasks/${task.id}/comments/${c.id}`);
        } catch (err) {
          alert(`Failed: ${err.message}`);
          del.disabled = false;
        }
      });
      actions.append(del);
    }
    card.append(actions);
    return card;
  }

  function renderComments(root, task, comments) {
    root.innerHTML = "";
    const panel = el("section", "comments-panel");
    panel.append(el("h2", "panel-title", { text: `Comments (${comments.length})` }));

    if (comments.length === 0) {
      panel.append(el("div", "panel-empty", { text: "Click any block in the MDX to leave a comment." }));
    } else {
      const list = el("div", "comments-list");
      for (const c of comments) list.append(renderCommentCard(task, c));
      panel.append(list);
    }
    root.append(panel);
  }

  // ─── Render inputs history ─────────────────────────────────────────────────
  function renderInputs(root, task, inputs) {
    root.innerHTML = "";
    const panel = el("section", "inputs-panel");
    panel.append(el("h2", "panel-title", { text: `Inputs (${inputs.length})` }));

    if (inputs.length === 0) {
      panel.append(el("div", "panel-empty", { text: "No inputs yet." }));
    } else {
      const list = el("div", "inputs-list");
      for (const inp of inputs) {
        const item = el("article", `input-history-item status-${inp.status}`, { "data-iid": inp.id });
        item.append(el("div", "input-meta", {
          text: `${inp.type} · ${inp.status} · ${inp.createdAt}`,
        }));
        item.append(el("div", "input-question", { text: inp.question || "" }));
        if (inp.status === "responded") {
          const ans = inp.responseOptionId
            ? `(option) ${inp.options?.find((o) => o.id === inp.responseOptionId)?.label ?? inp.responseOptionId}`
            : inp.response ?? "";
          item.append(el("div", "input-response", { text: `↳ ${ans}` }));
        }
        list.append(item);
      }
      panel.append(list);
    }
    root.append(panel);
  }

  // ─── Render assignees strip + agent progress timeline + last activity ─────
  // Returns a normalized list of {label, seed} for the assignees on a task.
  // Supports both shapes: `assignees: string[]` (new index payload) and
  // `contributors: Array<{name, email}>` (task detail payload).
  function getAssignees(task) {
    if (Array.isArray(task?.assignees) && task.assignees.length > 0) {
      return task.assignees
        .map((a) => {
          if (a && typeof a === "object") {
            const seed = String(a.email || a.name || "");
            return { label: a.name || a.email || "?", seed };
          }
          const s = String(a || "").trim();
          return s ? { label: s, seed: s } : null;
        })
        .filter(Boolean);
    }
    if (Array.isArray(task?.contributors)) {
      return task.contributors
        .map((c) => {
          const seed = String(c?.email || c?.name || "");
          if (!seed) return null;
          return { label: c.name || c.email || "?", seed };
        })
        .filter(Boolean);
    }
    return [];
  }

  // (assignees are rendered inline inside renderMetadata's dl/dt/dd grid.)

  // ─── Footer actions ────────────────────────────────────────────────────────
  function renderFooter(root, task) {
    root.innerHTML = "";
    const footer = el("footer", "task-footer");
    const state = effectiveState(task);

    // "Move to next column" — hidden when archived or on the last column.
    if (!task.archived) {
      const idx = COLUMN_ORDER.indexOf(task.column);
      if (idx >= 0 && idx < COLUMN_ORDER.length - 1) {
        const next = COLUMN_ORDER[idx + 1];
        const move = el("button", "btn btn-primary", { text: `→ ${COLUMN_LABEL[next]}`, type: "button" });
        move.title = `Move to ${COLUMN_LABEL[next]}`;
        move.addEventListener("click", async () => {
          move.disabled = true;
          try {
            await api("PATCH", `/api/tasks/${task.id}`, { column: next });
          } catch (err) {
            alert(`Failed: ${err.message}`);
            move.disabled = false;
          }
        });
        footer.append(move);
      }
    }

    if (state === "running") {
      const abort = el("button", "btn btn-danger", { text: "Abort", type: "button" });
      abort.addEventListener("click", async () => {
        if (!confirm("Abort this task?")) return;
        try { await api("POST", `/api/tasks/${task.id}/abort`); }
        catch (err) { alert(`Failed: ${err.message}`); }
      });
      footer.append(abort);
    } else if (state === "idle" || state === "done" || state === "failed" || state === "cancelled") {
      const start = el("button", "btn", { text: "Run", type: "button" });
      start.addEventListener("click", async () => {
        start.disabled = true;
        try { await api("POST", `/api/tasks/${task.id}/start`); }
        catch (err) { alert(`Failed: ${err.message}`); start.disabled = false; }
      });
      footer.append(start);
    }

    // Edit — focuses the inline-editable title (or falls back to the modal if
    // the inline editor isn't mounted). The inline-edit path is the new
    // primary; the modal stays as a fallback for accessibility.
    const edit = el("button", "btn", { text: "✎ Edit", type: "button" });
    edit.title = "Edit title and description inline";
    edit.addEventListener("click", () => {
      const titleEl = document.querySelector(".task-title");
      if (titleEl && titleEl.isContentEditable) {
        try { titleEl.focus(); } catch {}
        // Select all text so the user can immediately type a replacement.
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        return;
      }
      if (window.OpenKanEditTask?.open) window.OpenKanEditTask.open(task.id);
      else alert("Edit modal not available — refresh the page.");
    });
    footer.append(edit);

    // Template help — opens a modal showing the canonical task MDX template.
    // Surfaces the same content the server uses when seeding new tasks, so
    // authors can copy the structure directly into their task description.
    const tmpl = el("button", "btn", { text: "Template", type: "button" });
    tmpl.title = "Show the canonical task template";
    tmpl.addEventListener("click", () => openTemplateModal(task));
    footer.append(tmpl);

    // Archive / Restore (placed before the artifact link so it's the natural
    // left-to-right read order).
    if (task.archived) {
      const restore = el("button", "btn", { text: "↩ Restore", type: "button" });
      restore.title = "Restore from archive";
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        try { await api("POST", `/api/tasks/${task.id}/restore`); }
        catch (err) { alert(`Failed: ${err.message}`); restore.disabled = false; }
      });
      footer.append(restore);
    } else {
      const archive = el("button", "btn", { text: "Archive", type: "button" });
      archive.title = "Hide this task from the active board";
      archive.addEventListener("click", async () => {
        if (!confirm(`Archive "${task.title}"? You can restore it later.`)) return;
        archive.disabled = true;
        try { await api("POST", `/api/tasks/${task.id}/archive`); }
        catch (err) { alert(`Failed: ${err.message}`); archive.disabled = false; }
      });
      footer.append(archive);
    }

    if (task.artifact) {
      const a = el("a", "btn", {
        href: `/artifacts/tasks/${task.id}`,
        text: "View Artifact ↗",
        target: "_blank",
        rel: "noopener",
      });
      footer.append(a);
    }

    const del = el("button", "btn btn-danger", { text: "Delete", type: "button" });
    del.addEventListener("click", async () => {
      if (!confirm(`Delete task "${task.title}"? This cannot be undone.`)) return;
      try {
        await api("DELETE", `/api/tasks/${task.id}`);
        window.OpenKanTaskView.close();
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    });
    footer.append(del);

    root.append(footer);
  }

  // ─── Template modal ─────────────────────────────────────────────────────────
  // Fetches /api/template (the canonical MDX seed for new tasks) and shows
  // it in a copyable modal. Falls back to a sensible default template if the
  // endpoint is not yet implemented.
  let templateBodyCache = null;
  let templateBackdrop = null;

  function getTemplateModal() {
    if (templateBackdrop) return templateBackdrop;
    templateBackdrop = document.getElementById("template-backdrop");
    if (!templateBackdrop) return null;
    templateBackdrop.addEventListener("click", (e) => {
      if (e.target === templateBackdrop) closeTemplateModal();
    });
    templateBackdrop.querySelectorAll("[data-close-template]").forEach((b) =>
      b.addEventListener("click", closeTemplateModal),
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !templateBackdrop.hidden) {
        e.stopPropagation();
        closeTemplateModal();
      }
    }, true);
    return templateBackdrop;
  }

  async function openTemplateModal(task) {
    const backdrop = getTemplateModal();
    if (!backdrop) return;
    const body = document.getElementById("template-body");
    const copyBtn = document.getElementById("template-copy-btn");
    if (body) body.innerHTML = '<div class="panel-empty">Loading template…</div>';
    backdrop.hidden = false;
    if (copyBtn) copyBtn.disabled = true;

    let templateText = templateBodyCache;
    if (!templateText) {
      try {
        const payload = await api("GET", "/api/template");
        templateText = typeof payload === "string"
          ? payload
          : (payload?.template || payload?.mdx || payload?.body || payload?.content || "");
      } catch (err) {
        templateText = null;
      }
    }
    if (!templateText) {
      templateText = defaultTemplateText(task);
    } else {
      templateBodyCache = templateText;
    }

    if (body) {
      body.innerHTML = "";
      const intro = el("p", "template-intro", {
        text: "Use this template as the starting point for the task's MDX body. Each H2 is a section the UI understands (Description, Acceptance criteria, Agent progress, …).",
      });
      body.append(intro);
      const pre = el("pre", "template-preview");
      const code = el("code", "language-markdown", { text: templateText });
      pre.append(code);
      body.append(pre);
      body.append(el("p", "template-hint", {
        text: "Tip: paste this into the task's description field, then edit it as you go.",
      }));
    }
    if (copyBtn) {
      copyBtn.disabled = false;
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(templateText);
          copyBtn.textContent = "Copied ✓";
          setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 1500);
        } catch (err) {
          alert(`Copy failed: ${err.message || err}`);
        }
      };
    }
  }

  function closeTemplateModal() {
    const backdrop = getTemplateModal();
    if (backdrop) backdrop.hidden = true;
  }

  // Local fallback so the modal still works during the rollout of
  // /api/template. Mirrors the structure of kanban/template.mdx.
  function defaultTemplateText(task) {
    const title = (task && task.title) || "Untitled task";
    return [
      `# ${title}`,
      "",
      "## Description",
      "",
      "What this task is, why it matters, and what success looks like.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] …",
      "- [ ] …",
      "",
      "## Implementation notes",
      "",
      "Free-form notes for whoever picks this up.",
      "",
      "## Agent progress",
      "",
      "> [HH:MM:SS] tool: edit_file on path/to/file — short summary",
      "> [HH:MM:SS] tool: run_command — short summary",
      "",
    ].join("\n");
  }

  // ─── Render task header metadata strip ──────────────────────────────────────
  // Clean, scannable dl/dt/dd grid with tag chips and assignees below.
  function renderMetadata(root, task, lastActivity) {
    root.innerHTML = "";
    const meta = el("div", "task-header-meta");

    // ── Definition list — label/value pairs in a clean grid ──────────────
    const dl = el("dl", "meta-dl");

    // Column → human label
    if (task.column) {
      const lbl = el("dt", null, { text: "Column" });
      const val = el("dd", null, { text: COLUMN_LABEL[task.column] || task.column });
      dl.append(lbl, val);
    }

    // Category
    const cat = String(task.category || "").toLowerCase();
    if (cat) {
      const lbl = el("dt", null, { text: "Category" });
      const catCls = CATEGORIES.has(cat) ? `tag-chip category c-${cat}` : "tag-chip category";
      const val = el("dd", null, {});
      val.append(el("span", catCls, { text: cat, title: `category: ${cat}` }));
      dl.append(lbl, val);
    }

    // Priority
    const p = PRIORITY_META[task.priority];
    if (p && task.priority) {
      const lbl = el("dt", null, { text: "Priority" });
      const val = el("dd", null, {});
      val.append(el("span", `tag-chip priority priority-${task.priority}`, {
        text: `${p.code} ${p.label}`,
        title: `priority: ${p.label}`,
      }));
      dl.append(lbl, val);
    }

    // Effort
    if (task.effort) {
      const effortText = String(task.effort).toUpperCase();
      const lbl = el("dt", null, { text: "Effort" });
      const val = el("dd", null, {});
      val.append(el("span", "tag-chip effort", { text: effortText, title: `effort: ${effortText}` }));
      dl.append(lbl, val);
    }

    // Agent / model
    if (task.agent || task.model) {
      const lbl = el("dt", null, { text: "Runner" });
      const val = el("dd", "runner-value", {});
      if (task.agent) val.append(el("span", "runner-agent", { text: task.agent }));
      if (task.agent && task.model) val.append(el("span", "runner-sep", { text: " · " }));
      if (task.model) val.append(el("span", "runner-model", { text: task.model }));
      dl.append(lbl, val);
    }

    // Source path (where it was imported from). Render as a clickable link
    // so the user can jump straight to the file. The path is repo-relative
    // (e.g. "docs/roadmap.mdx"), so we prefix with "/" for an absolute path
    // that the dev server will serve.
    if (task.source?.path) {
      const lbl = el("dt", null, { text: "Source" });
      const val = el("dd", "source-dd", {});
      const path = String(task.source.path);
      const line = task.source.line ?? "?";
      const link = el("a", "source-link", {
        href: `/${path}`,
        target: "_blank",
        rel: "noopener",
        title: `Open ${path}:${line} in a new tab`,
      });
      link.append(
        el("span", "source-link-icon", { text: "📄", "aria-hidden": "true" }),
        el("span", "source-link-text", { text: `${path}:${line}` }),
      );
      val.append(link);
      dl.append(lbl, val);
    }

    // Stale — surfaces when the server detected the source file has changed
    // since import. The user can re-derive tags via the organize endpoint
    // (kind: "rederive"). Falls back to /api/tasks/:id/organize if Thor's
    // per-task endpoint ships first.
    if (task.stale === true) {
      const lbl = el("dt", null, { text: "Stale" });
      const val = el("dd", "meta-stale", {});
      val.append(el("span", "stale-warning", {
        text: "⚠️ Source has changed since this task was imported.",
      }));
      const rederive = el("button", "btn btn-sm stale-rederive", {
        type: "button",
        text: "Re-derive tags",
        title: "Re-run the tag/category/priority extractor for this task",
      });
      rederive.addEventListener("click", async () => {
        rederive.disabled = true;
        const restore = rederive.textContent;
        rederive.textContent = "Re-deriving…";
        try {
          // Prefer /api/organize (the canonical endpoint). Fall back to a
          // per-task /api/tasks/:id/organize if Thor ships that one first.
          try {
            await api("POST", "/api/organize", {
              operations: [{ kind: "rederive", taskId: task.id }],
            });
          } catch (_) {
            await api("POST", `/api/tasks/${task.id}/organize`, { kind: "rederive" });
          }
          window.OpenKanSettings?.showToast?.("Tags re-derived", "success");
          // Re-fetch the task so the cleared `stale` flag + fresh tags show up.
          try {
            const fresh = await api("GET", `/api/tasks/${task.id}`);
            const t = fresh?.task || fresh;
            if (t && t.id && window.OpenKanBoard?.getFilter) {
              // No-op: the next SSE `task.updated` event will trigger a
              // re-render. We don't force-refresh here so we don't race
              // with the broadcast.
            }
          } catch (_) { /* soft-fail; the broadcast will sync */ }
        } catch (err) {
          alert(`Re-derive failed: ${err.message}`);
          rederive.disabled = false;
          rederive.textContent = restore;
        }
      });
      val.append(rederive);
      dl.append(lbl, val);
    }

    // Assignees
    const assigneesList = getAssignees(task);
    if (assigneesList.length > 0) {
      const lbl = el("dt", null, { text: "Assignees" });
      const val = el("dd", "assignees-dd", {});
      for (const a of assigneesList) {
        const pair = el("span", "assignee-pair", { title: a.seed });
        const av = el("span", "assignee-avatar md");
        av.style.background = avatarColorFor(a.seed);
        av.textContent = initialsFor(a.label);
        pair.append(av, el("span", "assignee-name", { text: a.label }));
        val.append(pair);
      }
      dl.append(lbl, val);
    }

    // Created / updated timestamps
    if (task.createdAt) {
      const lbl = el("dt", null, { text: "Created" });
      const val = el("dd", null, { text: shortDate(task.createdAt), title: task.createdAt });
      dl.append(lbl, val);
    }
    if (task.updatedAt && task.updatedAt !== task.createdAt) {
      const lbl = el("dt", null, { text: "Updated" });
      const val = el("dd", null, { text: relativeTime(task.updatedAt), title: task.updatedAt });
      dl.append(lbl, val);
    }
    if (lastActivity) {
      const lbl = el("dt", null, { text: "Last activity" });
      const val = el("dd", null, { text: relativeTime(lastActivity), title: lastActivity });
      dl.append(lbl, val);
    }

    if (dl.children.length > 0) meta.append(dl);

    // ── Tag chips row — below the dl ────────────────────────────────────
    const tags = Array.isArray(task.tags) ? task.tags : [];
    if (tags.length > 0) {
      const tagRow = el("div", "meta-tag-row");
      const tagLabel = el("span", "meta-tag-label", { text: "Tags" });
      tagRow.append(tagLabel);
      for (const t of tags) tagRow.append(makeTagChip(t));
      meta.append(tagRow);
    }

    root.append(meta);
  }

  // ─── Render agent progress timeline (if the MDX contains one) ──────────────
  // The MDX viewer is responsible for restyling the `## Agent progress`
  // section; here we just check whether any `.agent-progress-timeline` was
  // injected into the rendered MDX slot.
  function maybeRenderAgentProgress(metaSlot, task) {
    // The mdx-viewer adds the timeline inside its own root. Nothing to do here
    // — this hook is left for future enhancements (e.g. a list-of-actions
    // banner above the MDX). The visual timeline is rendered by the
    // mdx-viewer based on `## Agent progress` heading + blockquote lines.
    return null;
  }

  // ─── Images panel (gallery + drop zone + paste) ────────────────────────────
  // Lives in the left column of the task main grid, just under the MDX slot.
  // Refreshes the gallery after each successful upload.
  const imagesState = {
    panel: null,
    taskId: null,
    fileInput: null,
    dropDetacher: null,
    pasteDetacher: null,
  };

  async function uploadFiles(taskId, files) {
    if (!imagesState.panel) return;
    const status = imagesState.panel.querySelector(".image-status");
    const gallery = imagesState.panel.querySelector(".image-gallery");
    const ok = [];
    const failed = [];
    for (const file of files) {
      if (status) status.textContent = `Uploading ${file.name || "image"}…`;
      try {
        await window.OpenKanImages.upload(taskId, file);
        ok.push(file.name || "image");
      } catch (err) {
        failed.push({ name: file.name || "image", error: err.message || String(err) });
      }
    }
    if (status) {
      if (failed.length === 0) {
        status.classList.remove("error");
        status.textContent = `Uploaded ${ok.length} image${ok.length === 1 ? "" : "s"}.`;
      } else {
        status.classList.add("error");
        const sample = failed.slice(0, 2).map((f) => `${f.name}: ${f.error}`).join("; ");
        status.textContent = `Uploaded ${ok.length}, failed ${failed.length}. ${sample}`;
      }
      setTimeout(() => {
        if (status.textContent.startsWith("Uploaded ")) {
          status.classList.remove("error");
          status.textContent = "";
        }
      }, 4000);
    }
    if (ok.length > 0) await refreshImages(taskId);
    void gallery;
  }

  async function refreshImages(taskId) {
    if (!imagesState.panel) return;
    const gallery = imagesState.panel.querySelector(".image-gallery");
    const counter = imagesState.panel.querySelector(".images-count");
    if (!gallery) return;
    let list = [];
    try {
      list = await window.OpenKanImages.list(taskId);
    } catch (err) {
      gallery.innerHTML = "";
      gallery.append(el("li", "panel-empty", {
        text: `Failed to load images: ${err.message || err}`,
      }));
      if (counter) counter.textContent = "";
      return;
    }
    gallery.innerHTML = "";
    if (counter) counter.textContent = `${list.length} image${list.length === 1 ? "" : "s"}`;
    if (list.length === 0) return;
    for (const img of list) {
      gallery.append(renderImageThumb(taskId, img));
    }
  }

  function renderImageThumb(taskId, img) {
    const li = el("li", "image-thumb");
    const url = window.OpenKanImages.srcFor(taskId, img.name);
    const image = el("img", null, {
      src: url,
      alt: img.name,
      loading: "lazy",
      title: img.name,
    });
    image.addEventListener("click", () => {
      window.OpenKanImages.openLightbox(url, img.name);
    });
    li.append(image);

    const meta = el("div", "image-meta");
    meta.append(el("span", null, { text: img.name }));
    const sizeKb = Math.max(1, Math.round((img.size || 0) / 1024));
    meta.append(el("span", null, { text: `${sizeKb} KB` }));
    li.append(meta);

    const actions = el("div", "image-actions");
    const copyBtn = el("button", "image-action-btn", {
      type: "button",
      title: "Copy markdown link",
      "aria-label": "Copy markdown link",
      text: "⧉",
    });
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await window.OpenKanImages.copyMarkdown(taskId, img.name);
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "⧉"; }, 1200);
      } catch (err) {
        alert(`Copy failed: ${err.message || err}`);
      }
    });
    actions.append(copyBtn);

    const delBtn = el("button", "image-action-btn danger", {
      type: "button",
      title: "Delete image",
      "aria-label": "Delete image",
      text: "×",
    });
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete image "${img.name}"?`)) return;
      delBtn.disabled = true;
      try {
        await window.OpenKanImages.remove(taskId, img.name);
        await refreshImages(taskId);
      } catch (err) {
        alert(`Delete failed: ${err.message || err}`);
        delBtn.disabled = false;
      }
    });
    actions.append(delBtn);
    li.append(actions);
    return li;
  }

  function buildImagesPanel(taskId) {
    // Tear down any prior wiring before rebuilding.
    if (imagesState.dropDetacher) { imagesState.dropDetacher(); imagesState.dropDetacher = null; }

    const panel = el("section", "images-panel");
    const head = el("div", "images-panel-head");
    head.append(
      el("h2", "panel-title", { text: "Images" }),
      el("span", "images-count", { text: "" }),
    );
    panel.append(head);

    const dropZone = el("div", "image-drop-zone", {
      role: "button",
      tabindex: "0",
      "aria-label": "Upload images. Click, drag, or paste.",
    });
    dropZone.append(el("div", "image-drop-title", { text: "Drag images here" }));
    dropZone.append(el("div", "image-drop-sub", {
      text: "…or click to browse, or paste from clipboard (⌘V / Ctrl-V)",
    }));
    const fileInput = el("input", null, {
      type: "file",
      accept: "image/*",
      multiple: "multiple",
      "aria-hidden": "true",
    });
    dropZone.append(fileInput);

    const trigger = (e) => {
      if (e.target === fileInput) return;
      e.preventDefault();
      fileInput.click();
    };
    dropZone.addEventListener("click", trigger);
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener("change", async () => {
      const files = [...fileInput.files];
      if (files.length > 0) await uploadFiles(taskId, files);
      fileInput.value = "";
    });

    imagesState.dropDetacher = window.OpenKanImages.attachDropZone(dropZone, async (files) => {
      await uploadFiles(taskId, files);
    });

    const gallery = el("ul", "image-gallery", { "aria-label": "Task images" });
    const status = el("div", "image-status");
    panel.append(dropZone, gallery, status);

    imagesState.panel = panel;
    imagesState.taskId = taskId;
    imagesState.fileInput = fileInput;
    return panel;
  }

  // ─── Subtasks section ──────────────────────────────────────────────────────
  // Compact list of children. The parent id is passed in; we hit
  // /api/tasks/:id/subtasks (which Thor is shipping alongside the cascade).
  // Until that endpoint lands, we fall back to `task.subtasks` (the inline
  // array some payloads include).
  async function loadSubtasks(taskId) {
    try {
      const data = await api("GET", `/api/tasks/${taskId}/subtasks`);
      return Array.isArray(data?.subtasks) ? data.subtasks : Array.isArray(data) ? data : [];
    } catch (_) {
      // Endpoint may not exist yet — caller falls back to inline data.
      throw _;
    }
  }

  function renderSubtasksPanel(parentTask, children, parentIdForNew) {
    const panel = el("section", "subtasks-panel");
    const head = el("div", "subtasks-head");
    head.append(el("h2", "panel-title", { text: `Subtasks (${children.length})` }));
    const addBtn = el("button", "btn btn-icon-sm", {
      type: "button",
      text: "+ Add subtask",
      title: "Create a new task as a subtask",
    });
    addBtn.addEventListener("click", () => {
      const btn = document.getElementById("new-task-btn");
      if (btn) btn.click();
      // After modal opens, set the hidden parentId and force the column to
      // the parent's column so subtasks usually land in the same place.
      const colSel = document.querySelector('select[name="column"]');
      if (colSel) {
        colSel.value = parentTask.column || colSel.value;
        colSel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const parentField = document.querySelector('input[name="parentId"]');
      if (parentField) {
        parentField.value = parentIdForNew || "";
        parentField.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const titleInput = document.querySelector('input[name="title"]');
      if (titleInput) setTimeout(() => titleInput.focus(), 0);
    });
    head.append(addBtn);
    panel.append(head);

    if (children.length === 0) {
      const empty = el("div", "subtasks-empty");
      empty.append(
        el("div", "panel-empty", { text: "No subtasks yet. Click + Add subtask to create one." }),
      );
      panel.append(empty);
    } else {
      // Group pending vs done. Pending first (visual priority), then
      // completed collapsed under a small section header. The "done" set
      // includes any non-idle terminal state (done, failed, cancelled) so
      // the user sees the full picture without burying the work that still
      // needs attention.
      const done = children.filter((c) => {
        const s = effectiveState(c);
        return s === "done" || s === "failed" || s === "cancelled";
      });
      const pending = children.filter((c) => !done.includes(c));

      const buildCard = (c) => {
        const child = el("button", "subtask-card", {
          type: "button",
          "data-id": c.id,
          title: c.id,
        });
        const state = effectiveState(c);
        child.append(el("span", `status-dot ${state}`, { title: state || "?" }));
        const body = el("div", "subtask-card-body");
        body.append(el("span", "subtask-card-title", { text: c.title || "(untitled)" }));
        if (c.description) {
          // Truncate description for the compact card view.
          const desc = String(c.description).replace(/\s+/g, " ").trim();
          const max = 140;
          body.append(el("span", "subtask-card-desc", {
            text: desc.length > max ? `${desc.slice(0, max)}…` : desc,
          }));
        }
        child.append(body);
        // Assignees — show the first one (or +N overflow) as a small avatar.
        const subAssignees = getAssignees(c);
        if (subAssignees.length > 0) {
          const wrap = el("span", "subtask-card-assignee");
          const first = subAssignees[0];
          const av = el("span", "assignee-avatar sm");
          av.style.background = avatarColorFor(first.seed);
          av.textContent = initialsFor(first.label);
          wrap.append(av);
          if (subAssignees.length > 1) {
            wrap.append(el("span", "assignee-overflow", { text: `+${subAssignees.length - 1}` }));
          }
          child.append(wrap);
        }
        child.addEventListener("click", () => {
          if (window.OpenKanTaskView?.open) window.OpenKanTaskView.open(c.id);
        });
        return child;
      };

      const list = el("div", "subtasks-list");
      for (const c of pending) list.append(buildCard(c));
      if (done.length > 0) {
        const headerRow = el("div", "subtasks-done-header");
        headerRow.append(el("span", "subtasks-done-label", {
          text: `Completed (${done.length})`,
        }));
        list.append(headerRow);
        for (const c of done) list.append(buildCard(c));
      }
      panel.append(list);
    }
    return panel;
  }

  // ─── Main render (one full pass) ───────────────────────────────────────────
  async function render(taskId) {
    const view = document.getElementById("task-view");
    if (!view) return;
    let payload;
    try {
      payload = await api("GET", `/api/tasks/${taskId}`);
    } catch (err) {
      view.innerHTML = "";
      view.append(el("div", "task-error", { text: `Failed to load task: ${err.message}` }));
      return;
    }

    // Resolve the current user so the comments panel can decide which cards
    // show a delete affordance. Runs in parallel with the rest of the render
    // — the comments panel re-renders on its own when this resolves, via
    // the cachedMe-on-window trick used in renderCommentCard.
    fetchMe().then(() => {
      const slot = view.querySelector(".comments-slot");
      if (!slot) return;
      // Only re-render the comments — everything else stays put.
      slot.innerHTML = "";
      renderComments(slot, payload.task, payload.comments || []);
    }).catch(() => { /* /api/me unavailable — show no delete affordance */ });

    const {
      task,
      comments = [],
      inputs = [],
      renderedHtml,
      renderedBlocks,
    } = payload;
    const pendingInput = (inputs || []).find((i) => i.status === "pending") || null;

    // Last activity — fetch from /api/changelog in the background (best-effort).
    let lastActivity = null;
    api("GET", `/api/changelog?taskId=${encodeURIComponent(taskId)}&limit=1`)
      .then((data) => {
        const ev = Array.isArray(data?.events) ? data.events[0] : Array.isArray(data) ? data[0] : null;
        if (ev?.ts) {
          lastActivity = ev.ts;
          // Re-render just the metadata strip with the new last-activity.
          const slot = view.querySelector(".task-meta-slot");
          if (slot) renderMetadata(slot, task, lastActivity);
        }
      })
      .catch(() => { /* soft fail */ });

    const headerEl = view.querySelector(".task-header-slot") || el("div", "task-header-slot");
    if (!headerEl.isConnected) view.append(headerEl);
    renderHeader(headerEl, task);

    const metaEl = view.querySelector(".task-meta-slot") || el("div", "task-meta-slot");
    if (!metaEl.isConnected) view.append(metaEl);
    renderMetadata(metaEl, task, lastActivity);

    const bannerEl = view.querySelector(".task-banner-slot") || el("div", "task-banner-slot");
    if (!bannerEl.isConnected) view.append(bannerEl);
    renderBanner(bannerEl, task, pendingInput);

    // Main grid: left column (mdx + images) and right sidebar (comments+inputs).
    const main = view.querySelector(".task-main") || el("div", "task-main");
    if (!main.isConnected) view.append(main);
    main.innerHTML = "";

    const leftCol = el("div", "task-left-col");
    const mdxSlot = el("div", "mdx-slot");
    // Right-click context menu on the MDX area. Wired here (not inside the
    // mdx-viewer) so the menu item definitions live with the task view.
    // Capture phase so we beat any potential stopPropagation from inner MDX
    // elements.
    mdxSlot.addEventListener("contextmenu", onMdxContextMenu, true);
    leftCol.append(mdxSlot);
    main.append(leftCol);

    const sideSlot = el("div", "task-side");
    main.append(sideSlot);

    const commentsEl = el("div", "comments-slot");
    const inputsEl = el("div", "inputs-slot");
    sideSlot.append(commentsEl, inputsEl);

    window.OpenKanMdxViewer.mount(mdxSlot, {
      taskId,
      html: typeof renderedHtml === "string" ? renderedHtml : null,
      blocks: Array.isArray(renderedBlocks) ? renderedBlocks : null,
      comments: Array.isArray(comments) ? comments : null,
      onCommentAdded: async () => {
        try {
          const fresh = await api("GET", `/api/tasks/${taskId}/comments`);
          renderComments(commentsEl, task, fresh);
        } catch {}
      },
      onInputResponded: async (inputId, payload) => {
        try {
          await api("POST", `/api/tasks/${taskId}/respond`, payload);
        } catch (err) {
          alert(`Failed to respond: ${err.message}`);
        }
      },
    });

    renderComments(commentsEl, task, comments || []);
    renderInputs(inputsEl, task, inputs || []);

    // Images panel sits in the left column under the MDX viewer. Built last
    // because it kicks off its own GET to /api/tasks/:id/images.
    if (window.OpenKanImages) {
      const imagesPanel = buildImagesPanel(taskId);
      leftCol.append(imagesPanel);
      refreshImages(taskId).catch(() => { /* status line shows the error */ });
    }

    // Subtasks panel — under the MDX + images, still in the left column.
    // Best-effort fetch; if the endpoint is missing we fall back to whatever
    // the task payload already includes.
    let inlineSubtasks = Array.isArray(task?.subtasks) ? task.subtasks : [];
    let fetched = false;
    try {
      const remote = await loadSubtasks(taskId);
      if (Array.isArray(remote)) { inlineSubtasks = remote; fetched = true; }
    } catch (_) {
      // Endpoint not implemented yet — keep using the payload's inline field.
    }
    if (!fetched && inlineSubtasks.length === 0) {
      // Render an empty panel so the user always sees the + Add subtask affordance.
    }
    const subtasksPanel = renderSubtasksPanel(task, inlineSubtasks, taskId);
    leftCol.append(subtasksPanel);

    const footerEl = view.querySelector(".task-footer-slot") || el("div", "task-footer-slot");
    if (!footerEl.isConnected) view.append(footerEl);
    renderFooter(footerEl, task);
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  async function open(taskId) {
    if (!taskId) return;
    currentTaskId = taskId;
    const view = document.getElementById("task-view");
    if (!view) return;
    // Hide the dashboard and all tab panes so the task view takes the full
    // body height. Without this, both #task-view and main.dashboard have
    // flex:1 and split the body 50/50, leaving an empty region above the
    // task view.
    const dash = document.querySelector("main.dashboard");
    if (dash) dash.style.display = "none";
    for (const pane of document.querySelectorAll(".tab-pane")) pane.hidden = true;
    view.hidden = false;
    // Re-render on relevant SSE events for THIS task.
    unsubs.push(on("task.updated", (p) => {
      const t = p?.task ?? p;
      if (t?.id === taskId) render(taskId);
    }));
    unsubs.push(on("task.input.asked", (p) => {
      if (p?.taskId === taskId) render(taskId);
    }));
    unsubs.push(on("task.input.responded", (p) => {
      if (p?.taskId === taskId) render(taskId);
    }));
    unsubs.push(on("task.comment.added", (p) => {
      if (p?.taskId === taskId) render(taskId);
    }));
    unsubs.push(on("task.comment.resolved", (p) => {
      if (p?.taskId === taskId) render(taskId);
    }));
    unsubs.push(on("task.comment.deleted", (p) => {
      if (p?.taskId === taskId) render(taskId);
    }));

    // Paste-to-upload: active only while the task view is open. Use capture
    // phase so we beat any focused editor (the paste handler is registered
    // as a capture-phase listener in images.js, but we keep a safety net
    // for paste events that reach the document bubble phase).
    if (window.OpenKanImages) {
      imagesState.pasteDetacher = window.OpenKanImages.attachPasteHandler(async (files) => {
        await uploadFiles(taskId, files);
      });
    }

    await render(taskId);
  }

  function close() {
    currentTaskId = null;
    for (const u of unsubs) { try { u(); } catch {} }
    unsubs = [];
    if (imagesState.pasteDetacher) { imagesState.pasteDetacher(); imagesState.pasteDetacher = null; }
    if (imagesState.dropDetacher) { imagesState.dropDetacher(); imagesState.dropDetacher = null; }
    imagesState.panel = null;
    imagesState.fileInput = null;
    imagesState.taskId = null;
    const view = document.getElementById("task-view");
    if (view) {
      view.hidden = true;
      view.innerHTML = "";
    }
    // Restore dashboard visibility (hidden when task view opened).
    const dash = document.querySelector("main.dashboard");
    if (dash) dash.style.display = "";
    // Restore the active tab via the canonical router — this updates both
    // pane visibility and tab-button active state, and rewrites the hash.
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const tab = params.get("tab") || "tasks";
    if (window.OpenKanTabs) {
      window.OpenKanTabs.activate(tab);
    } else {
      const valid = ["tasks", "changelog", "contributors", "docs"];
      const name = valid.includes(tab) ? tab : "tasks";
      for (const pane of document.querySelectorAll(".tab-pane")) {
        pane.hidden = pane.dataset.tab !== name;
      }
      for (const btn of document.querySelectorAll(".tab")) {
        btn.classList.toggle("active", btn.dataset.tab === name);
      }
    }
  }

  window.OpenKanTaskView = {
    open,
    close,
    /** The id of the currently displayed task, or null if the view is closed. */
    getCurrentTaskId() { return currentTaskId; },
  };

  // Kick off the current-user fetch on load so the comments panel can
  // immediately decide whether to show the delete affordance the first time
  // the task view opens. Safe to call multiple times — fetchMe caches.
  fetchMe().catch(() => { /* /api/me unavailable — comments render without delete */ });
})();