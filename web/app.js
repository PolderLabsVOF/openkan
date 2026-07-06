// OpenKan — single-file vanilla JS kanban client.
// 5 columns, SSE live updates with polling fallback, HTML5 drag-and-drop,
// "New Task" modal, per-task action menu.

(() => {
  "use strict";

  const COLUMNS = [
    { id: "backlog", title: "Backlog" },
    { id: "todo", title: "To Do" },
    { id: "doing", title: "In Progress" },
    { id: "review", title: "Review" },
    { id: "done", title: "Done" },
  ];
  const POLL_MS = 5000;

  /** @type {Map<string, any>} */
  const tasks = new Map();
  let es = null;
  let pollTimer = null;

  const $ = (id) => document.getElementById(id);
  const board = $("board");
  const statusPill = $("status-pill");
  const statusText = $("status-text");
  const modal = $("modal-backdrop");
  const form = $("new-task-form");
  const menu = $("action-menu");

  // ---------- API ----------
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${method} ${path} -> ${res.status} ${t}`);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  // ---------- Connection state ----------
  function setConnected(v) {
    statusPill.classList.toggle("pill-connected", v);
    statusPill.classList.toggle("pill-disconnected", !v);
    statusText.textContent = v ? "Connected" : "Disconnected";
  }

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

  function renderCard(t) {
    const card = el("article", "card", { draggable: "true", "data-id": t.id });
    card.append(
      el("div", "card-title", { text: t.title || "(untitled)" }),
      el("div", "card-desc", { text: t.description || "" }),
    );
    const meta = el("div", "card-meta");
    const left = el("div");
    left.style.cssText = "display:flex;align-items:center;gap:6px;";
    left.append(
      el("span", `status-dot ${t.status || "idle"}`, { title: t.status || "idle" }),
    );
    if (t.agent)
      left.append(el("span", "card-agent", { text: t.agent, title: `agent: ${t.agent}` }));
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

    card.addEventListener("dragstart", (e) => {
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", t.id);
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      document.querySelectorAll(".column.drag-over").forEach((c) => c.classList.remove("drag-over"));
    });
    return card;
  }

  function renderBoard() {
    board.innerHTML = "";
    for (const col of COLUMNS) {
      const colTasks = [...tasks.values()]
        .filter((t) => t.column === col.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const body = el("div", "column-body", { "data-column": col.id });
      if (colTasks.length === 0) body.append(el("div", "column-empty", { text: "No tasks" }));
      else for (const t of colTasks) body.append(renderCard(t));

      const column = el("section", "column", { "data-column": col.id });
      const header = el("div", "column-header");
      header.append(
        el("span", null, { text: col.title }),
        el("span", "column-count", { text: String(colTasks.length) }),
      );
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
    menu.style.left = `${Math.max(8, r.right - 180)}px`;
    menu.hidden = false;

    const run = (label, fn, danger = false) => {
      const b = el("button", danger ? "danger" : null, { text: label });
      b.addEventListener("click", () => {
        menu.hidden = true;
        fn();
      });
      menu.append(b);
    };
    const call = (m, p, b) => api(m, p, b).catch((e) => alert(`${m} failed: ${e.message}`));

    if (task.status !== "running") {
      run("Start", () => call("POST", `/api/tasks/${task.id}/start`));
    } else {
      run("Abort", () => {
        if (confirm(`Abort running task "${task.title}"?`))
          call("POST", `/api/tasks/${task.id}/abort`);
      });
    }
    if (task.artifact) {
      const a = el("a", null, { href: `/artifacts/tasks/${task.id}`, text: "View Artifact ↗", target: "_blank", rel: "noopener" });
      menu.append(a);
    }
    run(
      "Delete",
      () => {
        if (confirm(`Delete task "${task.title}"? This cannot be undone.`))
          call("DELETE", `/api/tasks/${task.id}`);
      },
      true,
    );

    const off = (e) => {
      if (!menu.contains(e.target)) {
        menu.hidden = true;
        document.removeEventListener("click", off);
      }
    };
    setTimeout(() => document.addEventListener("click", off), 0);
  }

  // ---------- Drag and drop ----------
  function attachDnD(column) {
    const body = column.querySelector(".column-body");
    column.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      column.classList.add("drag-over");
    });
    column.addEventListener("dragleave", (e) => {
      if (!column.contains(e.relatedTarget)) column.classList.remove("drag-over");
    });
    column.addEventListener("drop", async (e) => {
      e.preventDefault();
      column.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      if (!id) return;
      const order = dropIndex(body, e.clientY, id);
      await moveTask(id, body.dataset.column, order);
    });
  }

  function dropIndex(body, y, draggingId) {
    const cards = [...body.querySelectorAll(".card:not(.dragging)")];
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
      alert(`Move failed: ${e.message}`);
    }
  }

  // ---------- SSE ----------
  function connect() {
    if (es) es.close();
    es = new EventSource("/api/events");
    es.onopen = () => {
      setConnected(true);
      stopPoll();
    };
    es.onerror = () => {
      setConnected(false);
      es.close();
      es = null;
      startPoll();
    };
    const onTask = (e) => {
      try {
        const t = JSON.parse(e.data).task;
        if (t) {
          tasks.set(t.id, t);
          renderBoard();
        }
      } catch {}
    };
    es.addEventListener("board.snapshot", (e) => {
      try {
        applySnapshot(JSON.parse(e.data));
      } catch {}
    });
    es.addEventListener("task.created", onTask);
    es.addEventListener("task.updated", onTask);
    es.addEventListener("task.deleted", (e) => {
      try {
        const id = JSON.parse(e.data).id;
        if (id && tasks.delete(id)) renderBoard();
      } catch {}
    });
  }

  function applySnapshot(snap) {
    tasks.clear();
    const list = Array.isArray(snap) ? snap : snap.tasks || [];
    for (const t of list) tasks.set(t.id, t);
    renderBoard();
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(refresh, POLL_MS);
    refresh();
  }
  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  async function refresh() {
    try {
      applySnapshot(await api("GET", "/api/board"));
    } catch {
      setConnected(false);
    }
  }

  // ---------- Modal ----------
  function openModal() {
    modal.hidden = false;
    form.reset();
    form.elements.title.focus();
  }
  function closeModal() {
    modal.hidden = true;
  }
  $("new-task-btn").addEventListener("click", openModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.querySelectorAll("[data-close-modal]").forEach((b) =>
    b.addEventListener("click", closeModal),
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
      menu.hidden = true;
    }
  });
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
    try {
      const res = await api("POST", "/api/tasks", body);
      if (res && res.task) {
        tasks.set(res.task.id, res.task);
        renderBoard();
      }
      closeModal();
    } catch (err) {
      alert(`Create failed: ${err.message}`);
    }
  });

  // ---------- Boot ----------
  (async () => {
    try {
      applySnapshot(await api("GET", "/api/board"));
    } catch {}
    connect();
  })();
})();
