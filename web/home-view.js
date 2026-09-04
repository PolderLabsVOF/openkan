// OpenKan Home — registered project overview plus live active-agent snapshot.
(() => {
  "use strict";
  const { api } = window.OpenKanAPI;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  function worktree(root) { return /\/(?:\.claude|\.git)\/worktrees\//.test(String(root || "").replace(/\\/g, "/")); }
  async function mount(root) {
    root.innerHTML = `<section class="home-view home-loading">Loading workspace overview…</section>`;
    const [projectResult, agentResult] = await Promise.allSettled([api("GET", "/api/projects"), api("GET", "/api/claude/agents")]);
    const projects = projectResult.status === "fulfilled" ? (projectResult.value.projects || []).filter((p) => !worktree(p.root)) : [];
    const agents = agentResult.status === "fulfilled" ? (agentResult.value.agents || agentResult.value || []) : [];
    const running = agents.filter((a) => /running|active|working/i.test(String(a.status || a.state || "")));
    root.innerHTML = `<section class="home-view"><header class="home-hero"><div><span class="workspace-eyebrow">OpenKan home</span><h2>Everything in motion.</h2><p>Choose a project, check active agents, and move directly into focused work.</p></div><div class="home-stats"><span><b>${projects.length}</b> projects</span><span><b>${running.length}</b> active agents</span></div></header><div class="home-grid"><section class="home-panel"><header><h3>Projects</h3><button data-home="add">Add project</button></header><div class="home-project-list">${projects.map((p) => `<button class="home-project${p.active ? " active" : ""}" data-project="${esc(p.id)}"><span class="home-project-dot"></span><span><strong>${esc(p.name)}</strong><small>${esc(p.root)}</small></span>${p.active ? "<em>Current</em>" : ""}</button>`).join("") || "<p class=home-empty>No registered projects yet.</p>"}</div></section><section class="home-panel"><header><h3>Active agents</h3><button data-home="agents">Open Agents</button></header><div class="home-agent-list">${agents.length ? agents.map((a) => `<div class="home-agent"><span class="home-agent-dot ${/running|active|working/i.test(String(a.status || a.state || "")) ? "active" : ""}"></span><span><strong>${esc(a.name || a.id || "Agent")}</strong><small>${esc(a.status || a.state || "Idle")}${a.task ? ` · ${esc(a.task)}` : ""}</small></span></div>`).join("") : "<p class=home-empty>No active Claude Code agents reported for the selected project.</p>"}</div></section></div></section>`;
    root.querySelectorAll("[data-project]").forEach((button) => button.addEventListener("click", async () => { await api("PATCH", `/api/projects/${encodeURIComponent(button.dataset.project)}/active`); location.reload(); }));
    root.querySelector("[data-home=add]")?.addEventListener("click", () => document.getElementById("new-task-btn")?.dispatchEvent(new Event("noop")) || document.getElementById("brand-project-chip")?.click());
    root.querySelector("[data-home=agents]")?.addEventListener("click", () => document.querySelector('[data-tab="agents"]')?.click());
  }
  window.OpenKanHome = { mount, unmount() {} };
})();
