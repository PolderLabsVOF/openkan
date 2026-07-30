// OpenKan — Bizar agents, tasks, sessions, and durable message control plane.
(() => {
  "use strict";

  const { api } = window.OpenKanAPI;
  let root = null;
  let socket = null;
  let snapshot = null;
  let requestSeq = 0;
  const pending = new Map();

  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  function stateClass(value) {
    return `bizar-state bizar-state-${String(value || "unknown").replace(/[^a-z0-9-]/gi, "-")}`;
  }

  function setStatus(text, kind = "") {
    const node = root?.querySelector("#bizar-status");
    if (!node) return;
    node.textContent = text;
    node.className = `bizar-status ${kind}`.trim();
  }

  function connect() {
    if (!root || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/api/bizar/ws`);
    socket.addEventListener("open", () => setStatus("Live", "connected"));
    socket.addEventListener("close", () => {
      setStatus("Reconnecting…", "disconnected");
      if (root) setTimeout(connect, 1500);
    });
    socket.addEventListener("error", () => setStatus("Unavailable", "error"));
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "snapshot") {
        snapshot = message.data;
        render();
        return;
      }
      if (message.requestId && pending.has(message.requestId)) {
        const request = pending.get(message.requestId);
        pending.delete(message.requestId);
        if (message.type === "error") request.reject(new Error(message.error || "Bizar command failed"));
        else request.resolve(message.data);
        return;
      }
      if (message.type === "error") showError(message.error || "Bizar bridge unavailable");
    });
  }

  function command(name, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Bizar WebSocket is not connected"));
    }
    const requestId = `bizar-${Date.now()}-${++requestSeq}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ type: "command", requestId, command: name, payload }));
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error("Bizar command timed out"));
      }, 30_000);
    });
  }

  function showError(message) {
    setStatus(message, "error");
    const error = root?.querySelector("#bizar-error");
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  }

  function clearError() {
    const error = root?.querySelector("#bizar-error");
    if (error) error.hidden = true;
  }

  function agentsHtml(agents) {
    if (!agents.length) return '<p class="bizar-empty">No Bizar agents found.</p>';
    return agents.map((agent) => `
      <article class="bizar-agent">
        <div>
          <strong>@${esc(agent.id)}</strong>
          <p>${esc(agent.description || "Bizar agent")}</p>
        </div>
        <button class="btn btn-sm" data-bizar-start-agent="${esc(agent.id)}">Start</button>
      </article>
    `).join("");
  }

  function tasksHtml(tasks) {
    if (!tasks.length) return '<p class="bizar-empty">No durable Bizar tasks.</p>';
    return `
      <div class="bizar-table-wrap">
        <table class="bizar-table">
          <thead><tr><th>Task</th><th>State</th><th>Owner</th><th>Dependencies</th><th>Actions</th></tr></thead>
          <tbody>${tasks.map((task) => `
            <tr>
              <td><strong>${esc(task.id)}</strong><span>${esc(task.title)}</span></td>
              <td><span class="${stateClass(task.state)}">${esc(task.state)}</span></td>
              <td>${esc(task.owner || "—")}</td>
              <td>${esc((task.dependencies || []).join(", ") || "—")}</td>
              <td class="bizar-actions">
                ${task.state === "pending" ? `<button class="btn btn-sm" data-bizar-task-action="claim" data-task-id="${esc(task.id)}">Claim</button>` : ""}
                ${task.state === "active" ? `<button class="btn btn-sm" data-bizar-task-action="heartbeat" data-task-id="${esc(task.id)}">Heartbeat</button><button class="btn btn-sm" data-bizar-task-action="complete" data-task-id="${esc(task.id)}">Complete</button>` : ""}
                ${!["integrated", "cancelled"].includes(task.state) ? `<button class="btn btn-sm btn-danger" data-bizar-task-action="cancel" data-task-id="${esc(task.id)}">Cancel</button>` : ""}
              </td>
            </tr>
          `).join("")}</tbody>
        </table>
      </div>`;
  }

  function sessionsHtml(sessions) {
    if (!sessions.length) return '<p class="bizar-empty">No Claude Code background sessions.</p>';
    return sessions.map((session) => `
      <article class="bizar-session">
        <div>
          <strong>${esc(session.name || session.id || session.sessionId)}</strong>
          <code>${esc(session.sessionId)}</code>
          <span class="${stateClass(session.state || session.status)}">${esc(session.state || session.status || "unknown")}</span>
        </div>
        <div class="bizar-actions">
          <button class="btn btn-sm" data-bizar-message-session="${esc(session.sessionId)}">Message</button>
          ${session.pid && !["done", "failed", "cancelled"].includes(session.state)
            ? `<button class="btn btn-sm btn-danger" data-bizar-stop-session="${esc(session.sessionId)}">Stop</button>`
            : ""}
        </div>
      </article>
    `).join("");
  }

  function messagesHtml(messages) {
    if (!messages.length) return '<p class="bizar-empty">No control messages.</p>';
    return messages.slice(0, 30).map((message) => `
      <article class="bizar-message">
        <header>
          <strong>${esc(message.from)}</strong>
          <span>→ ${esc(message.toAgent ? `@${message.toAgent}` : message.toSession)}</span>
          <span class="${stateClass(message.status)}">${esc(message.status)}</span>
        </header>
        <p>${esc(message.text)}</p>
        <time>${esc(message.createdAt || "")}</time>
      </article>
    `).join("");
  }

  function featuresHtml(features) {
    if (!features.length) return '<p class="bizar-empty">No Bizar feature ledger found.</p>';
    return features.slice().reverse().slice(0, 50).map((feature) => `
      <article class="bizar-feature">
        <strong>${esc(feature.id)}</strong>
        <span>${esc(feature.behavior)}</span>
        <span class="${stateClass(feature.state)}">${esc(feature.state)}</span>
      </article>
    `).join("");
  }

  function render() {
    if (!root || !snapshot) return;
    clearError();
    root.innerHTML = `
      <header class="bizar-hero">
        <div>
          <span class="bizar-eyebrow">Bizar control plane</span>
          <h2>Agents, sessions, tasks, and messages</h2>
          <p>${esc(snapshot.projectRoot)}</p>
          <div class="bizar-metrics">
            <span><strong>${snapshot.vcr?.passing ?? 0}</strong> passing features</span>
            <span><strong>${snapshot.integrations?.length ?? 0}</strong> integration items</span>
            <span><strong>${snapshot.sessions?.filter((item) => !["done", "failed"].includes(item.state)).length ?? 0}</strong> live sessions</span>
          </div>
        </div>
        <div class="bizar-hero-actions">
          <span id="bizar-status" class="bizar-status connected">Live</span>
          <button id="bizar-refresh" class="btn btn-sm">Refresh</button>
        </div>
      </header>
      <div id="bizar-error" class="bizar-error" hidden></div>

      <section class="bizar-panel bizar-panel-features">
        <header>
          <div><span class="bizar-count">${snapshot.features?.length || 0}</span><h3>Feature ledger</h3></div>
          <span class="bizar-progress-title">${esc(snapshot.progress?.current || "")}</span>
        </header>
        <div class="bizar-list">${featuresHtml(snapshot.features || [])}</div>
      </section>

      <section class="bizar-panel bizar-panel-agents">
        <header><div><span class="bizar-count">${snapshot.agents?.length || 0}</span><h3>Agents</h3></div></header>
        <form id="bizar-start-form" class="bizar-form">
          <select name="agent" aria-label="Bizar agent">${(snapshot.agents || []).map((agent) => `<option value="${esc(agent.id)}">${esc(agent.id)}</option>`).join("")}</select>
          <input name="name" placeholder="Session name (optional)" />
          <textarea name="prompt" required placeholder="What should this agent do?"></textarea>
          <button class="btn btn-primary" type="submit">Start session</button>
        </form>
        <div class="bizar-list">${agentsHtml(snapshot.agents || [])}</div>
      </section>

      <section class="bizar-panel bizar-panel-tasks">
        <header><div><span class="bizar-count">${snapshot.tasks?.length || 0}</span><h3>Durable tasks</h3></div></header>
        <form id="bizar-task-form" class="bizar-form bizar-form-inline">
          <input name="id" required placeholder="task-id" />
          <input name="title" required placeholder="Task title" />
          <input name="scopes" placeholder="Scopes, comma separated" />
          <button class="btn btn-primary" type="submit">Create task</button>
        </form>
        ${tasksHtml(snapshot.tasks || [])}
      </section>

      <section class="bizar-panel bizar-panel-sessions">
        <header><div><span class="bizar-count">${snapshot.sessions?.length || 0}</span><h3>Sessions</h3></div></header>
        <div class="bizar-list">${sessionsHtml(snapshot.sessions || [])}</div>
      </section>

      <section class="bizar-panel bizar-panel-messages">
        <header><div><span class="bizar-count">${snapshot.messages?.length || 0}</span><h3>Messages</h3></div></header>
        <form id="bizar-message-form" class="bizar-form">
          <select name="agent" aria-label="Recipient agent"><option value="">Choose agent…</option>${(snapshot.agents || []).map((agent) => `<option value="${esc(agent.id)}">@${esc(agent.id)}</option>`).join("")}</select>
          <textarea name="text" required placeholder="Message delivered at the next supported hook boundary"></textarea>
          <button class="btn btn-primary" type="submit">Queue message</button>
        </form>
        <div class="bizar-list">${messagesHtml(snapshot.messages || [])}</div>
      </section>
    `;
    bind();
  }

  async function run(name, payload) {
    clearError();
    try {
      await command(name, payload);
    } catch (error) {
      showError(error.message);
    }
  }

  function bind() {
    root.querySelector("#bizar-refresh")?.addEventListener("click", () => {
      socket?.send(JSON.stringify({ type: "refresh" }));
    });
    root.querySelector("#bizar-start-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      run("start-session", {
        agent: data.get("agent"),
        name: data.get("name"),
        prompt: data.get("prompt"),
      });
    });
    root.querySelector("#bizar-task-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      run("create-task", {
        id: data.get("id"),
        title: data.get("title"),
        scopes: String(data.get("scopes") || "").split(",").map((item) => item.trim()).filter(Boolean),
      });
    });
    root.querySelector("#bizar-message-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      run("send-message", {
        agent: data.get("agent"),
        from: "openkan",
        text: data.get("text"),
      });
    });
    root.querySelectorAll("[data-bizar-start-agent]").forEach((button) => {
      button.addEventListener("click", () => {
        const promptText = prompt(`Task for @${button.dataset.bizarStartAgent}`);
        if (promptText) run("start-session", { agent: button.dataset.bizarStartAgent, prompt: promptText });
      });
    });
    root.querySelectorAll("[data-bizar-task-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.bizarTaskAction;
        const task = snapshot.tasks.find((item) => item.id === button.dataset.taskId);
        const owner = task?.owner || prompt("Agent/owner");
        if (["claim", "heartbeat", "complete"].includes(action) && !owner) return;
        const payload = { id: button.dataset.taskId, owner };
        if (action === "complete") payload.evidence = prompt("Completion evidence") || "";
        if (action === "cancel") payload.reason = prompt("Cancellation reason") || "";
        run(`${action}-task`, payload);
      });
    });
    root.querySelectorAll("[data-bizar-message-session]").forEach((button) => {
      button.addEventListener("click", () => {
        const text = prompt("Message to this Claude Code session");
        if (text) run("send-session", { sessionId: button.dataset.bizarMessageSession, from: "openkan", text });
      });
    });
    root.querySelectorAll("[data-bizar-stop-session]").forEach((button) => {
      button.addEventListener("click", () => {
        if (confirm("Stop this locally managed Claude Code session?")) {
          run("stop-session", { sessionId: button.dataset.bizarStopSession });
        }
      });
    });
  }

  async function mount(node) {
    if (root === node) return;
    root = node;
    root.innerHTML = '<div class="bizar-loading">Connecting to Bizar…</div>';
    try {
      snapshot = await api("GET", "/api/bizar/snapshot");
      render();
    } catch (error) {
      root.innerHTML = `<div class="bizar-error">${esc(error.message)}</div>`;
    }
    connect();
  }

  function unmount() {
    if (socket) socket.close();
    socket = null;
    root = null;
    for (const request of pending.values()) request.reject(new Error("Bizar view closed"));
    pending.clear();
  }

  window.OpenKanBizar = { mount, unmount };
})();
