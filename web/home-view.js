// OpenKan Home — a live operational overview built from the active workspace.
(() => {
  "use strict";
  const { api } = window.OpenKanAPI;
  let frame = 0;
  let activeRoot = null;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  const isWorktree = (root) => /\/(?:\.claude|\.git)\/worktrees\//.test(String(root || "").replace(/\\/g, "/"));
  const flatten = (entries, out = []) => { for (const entry of entries || []) entry.isDir ? flatten(entry.children, out) : out.push(entry); return out; };
  const countColumns = (tasks) => tasks.reduce((acc, task) => { acc[task.column || "backlog"] = (acc[task.column || "backlog"] || 0) + 1; return acc; }, {});
  const short = (value) => String(value || "").replace(/^.*\//, "");

  function flowSvg(days) {
    const points = (days || []).map((day, index) => ({ x: 8 + index * (248 / Math.max(1, days.length - 1)), y: 56 - Math.min(48, (day.total || 0) * 8) }));
    const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    const area = `${line} L256 64 L8 64 Z`;
    return `<svg class="home-flow-chart" viewBox="0 0 264 70" role="img" aria-label="Task activity over the last 30 days"><path class="home-flow-area" d="${area}"/><path class="home-flow-line" d="${line}"/>${points.filter((_, i) => i % Math.max(1, Math.ceil(points.length / 7)) === 0).map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2"/>`).join("")}</svg>`;
  }

  function drawNetwork(canvas, projects, agents, counts) {
    cancelAnimationFrame(frame);
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      return box;
    };
    let box = resize();
    const seed = [...projects, ...agents].map((item, index) => ({
      label: item.name || item.id || `Node ${index + 1}`,
      kind: item.root ? "project" : "agent",
      angle: (Math.PI * 2 * index) / Math.max(1, projects.length + agents.length),
      orbit: 0.21 + ((index * 37) % 38) / 100,
      offset: index * 0.67,
    }));
    const taskNode = { label: `${(counts.backlog || 0) + (counts.todo || 0) + (counts.doing || 0) + (counts.review || 0)} active tasks`, kind: "task" };
    const paint = (time) => {
      if (!activeRoot?.contains(canvas)) return;
      box = resize();
      const width = box.width, height = box.height, cx = width * 0.5, cy = height * 0.5;
      context.clearRect(0, 0, width, height);
      const gradient = context.createRadialGradient(cx, cy, 4, cx, cy, Math.max(width, height) * .62);
      gradient.addColorStop(0, "rgba(111, 104, 255, .15)"); gradient.addColorStop(1, "rgba(111, 104, 255, 0)");
      context.fillStyle = gradient; context.fillRect(0, 0, width, height);
      const nodes = seed.map((item, index) => {
        const r = Math.min(width, height) * item.orbit;
        const phase = time / 5000 + item.offset;
        return { ...item, x: cx + Math.cos(item.angle + phase * .2) * r, y: cy + Math.sin(item.angle + phase * .24) * r, radius: item.kind === "project" ? 6 : 4 };
      });
      context.lineWidth = 1;
      nodes.forEach((node, index) => {
        const next = nodes[(index + 1) % Math.max(1, nodes.length)];
        if (!next) return;
        context.strokeStyle = "rgba(126, 149, 195, .22)";
        context.beginPath(); context.moveTo(cx, cy); context.lineTo(node.x, node.y); context.lineTo(next.x, next.y); context.stroke();
      });
      nodes.forEach((node) => {
        const color = node.kind === "project" ? "#7c73ff" : "#55d6a3";
        context.fillStyle = color; context.shadowBlur = node.kind === "project" ? 15 : 10; context.shadowColor = color;
        context.beginPath(); context.arc(node.x, node.y, node.radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
      });
      context.fillStyle = "#111b2c"; context.strokeStyle = "rgba(135, 151, 180, .8)"; context.lineWidth = 1.2;
      context.beginPath(); context.arc(cx, cy, 18, 0, Math.PI * 2); context.fill(); context.stroke();
      context.fillStyle = "#e7edff"; context.font = "600 10px ui-monospace, monospace"; context.textAlign = "center"; context.fillText("WORK", cx, cy + 3);
      frame = requestAnimationFrame(paint);
    };
    const observer = new ResizeObserver(() => { box = resize(); }); observer.observe(canvas);
    canvas._openKanObserver = observer;
    frame = requestAnimationFrame(paint);
  }

  function render(root, data) {
    const projects = data.projects.filter((project) => !isWorktree(project.root));
    const tasks = data.board.tasks || data.board || [];
    const counts = countColumns(Array.isArray(tasks) ? tasks : []);
    const activeAgents = data.agents.filter((agent) => /running|active|working|busy/i.test(String(agent.status || agent.state || "")));
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const goals = data.goals.prds || data.goals || [];
    const metGoals = (Array.isArray(goals) ? goals : []).flatMap((prd) => prd.goals || []).filter((goal) => goal.status === "met").length;
    const docs = flatten(data.docs.entries || []).filter((entry) => /\.mdx?$/i.test(entry.path)).length;
    root.innerHTML = `<section class="home-view home-command-center">
      <header class="home-command-header"><div><span class="workspace-eyebrow">Workspace command center</span></div><div class="home-command-actions"><button data-home-action="tasks">Open board</button><button data-home-action="agents">Inspect agents</button></div></header>
      <section class="home-network-card"><div class="home-network-copy"><span class="home-section-label">LIVE WORKSPACE MAP</span><h3>${esc(projects.find((project) => project.active)?.name || "OpenKan")}</h3><p>${activeAgents.length ? `${activeAgents.length} agent${activeAgents.length === 1 ? " is" : "s are"} active across the workspace.` : "No agents are currently active. Start from a task or an agent session when you are ready."}</p><div class="home-network-legend"><span><i class="is-project"></i>Project</span><span><i class="is-agent"></i>Agent</span><span><i class="is-work"></i>Work</span></div></div><canvas class="home-network" aria-label="Animated workspace relationship map"></canvas></section>
      <section class="home-stat-grid"><article><span>Active tasks</span><strong>${total - (counts.done || 0)}</strong><small>${counts.doing || 0} in progress · ${counts.review || 0} in review</small></article><article><span>Projects</span><strong>${projects.length}</strong><small>${projects.filter((project) => project.active).length ? "1 currently selected" : "Select a project to begin"}</small></article><article><span>Knowledge base</span><strong>${docs}</strong><small>Markdown and MDX documents</small></article><article><span>Goals met</span><strong>${metGoals}</strong><small>Durable .ok planning goals</small></article></section>
      <section class="home-dashboard-grid"><article class="home-activity-card"><header><div><span class="home-section-label">FLOW</span><h3>Activity cadence</h3></div><span>${(data.velocity.days || []).length || 30} days</span></header>${flowSvg(data.velocity.days || [])}<footer><span>Quiet</span><span>Today</span></footer></article><article class="home-queue-card"><header><div><span class="home-section-label">QUEUE</span><h3>Where work sits</h3></div><button data-home-action="tasks">View board</button></header><div class="home-queue-list">${[["Backlog","backlog"],["Ready","todo"],["In progress","doing"],["Review","review"],["Done","done"]].map(([label, key]) => `<div><span>${label}</span><b>${counts[key] || 0}</b><i style="--queue:${Math.min(100, ((counts[key] || 0) / Math.max(1, total)) * 100)}%"></i></div>`).join("")}</div></article><article class="home-operators-card"><header><div><span class="home-section-label">OPERATORS</span><h3>Agents and projects</h3></div><button data-home-action="agents">All agents</button></header><div class="home-operator-list">${[...activeAgents, ...projects.slice(0, Math.max(0, 4 - activeAgents.length))].slice(0,4).map((item) => `<div><i class="${item.root ? "project" : "agent"}"></i><span><strong>${esc(item.name || item.id || short(item.root))}</strong><small>${esc(item.root ? short(item.root) : item.status || item.state || "Idle")}</small></span></div>`).join("") || "<p class=home-empty>No workspace signals yet.</p>"}</div></article></section>
    </section>`;
    root.querySelectorAll("[data-home-action]").forEach((button) => button.addEventListener("click", () => window.OpenKanTabs?.activate?.(button.dataset.homeAction)));
    drawNetwork(root.querySelector(".home-network"), projects, activeAgents, counts);
  }

  async function mount(root) {
    activeRoot = root;
    root.innerHTML = `<section class="home-view home-loading">Preparing workspace overview…</section>`;
    const [projects, board, agents, goals, velocity, docs] = await Promise.allSettled([
      api("GET", "/api/projects"), api("GET", "/api/board"), api("GET", "/api/claude/agents"), api("GET", "/api/goals"), api("GET", "/api/insights/velocity?days=30"), api("GET", "/api/docs"),
    ]);
    if (activeRoot !== root) return;
    render(root, {
      projects: projects.status === "fulfilled" ? projects.value.projects || [] : [],
      board: board.status === "fulfilled" ? board.value : { tasks: [] },
      agents: agents.status === "fulfilled" ? agents.value.agents || agents.value || [] : [],
      goals: goals.status === "fulfilled" ? goals.value : [],
      velocity: velocity.status === "fulfilled" ? velocity.value : { days: [] },
      docs: docs.status === "fulfilled" ? docs.value : { entries: [] },
    });
  }
  function unmount() { cancelAnimationFrame(frame); activeRoot?.querySelectorAll("canvas").forEach((canvas) => canvas._openKanObserver?.disconnect()); activeRoot = null; }
  window.OpenKanHome = { mount, unmount };
})();
