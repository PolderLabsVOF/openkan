// OpenKan Goals — durable PRD goals from the canonical .ok/ workspace.
(() => {
  "use strict";
  const { api } = window.OpenKanAPI;
  let root = null;
  let mounted = false;
  const STATUS_LABELS = { open: "Open", in_progress: "In progress", met: "Met", dropped: "Dropped" };
  const STATUS_ORDER = ["open", "in_progress", "met", "dropped"];

  function escapeHtml(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }
  function goalRow(prd, goal) {
    const actions = STATUS_ORDER.map((status) => `<button type="button" class="goal-status ${goal.status === status ? "is-active" : ""}" data-prd="${prd.id}" data-goal="${goal.id}" data-status="${status}" aria-pressed="${goal.status === status}">${STATUS_LABELS[status]}</button>`).join("");
    return `<li class="goal-row"><div><span class="goal-copy">${escapeHtml(goal.text)}</span><span class="goal-current goal-${goal.status}">${STATUS_LABELS[goal.status]}</span></div><div class="goal-actions" aria-label="Set goal status">${actions}</div></li>`;
  }
  function render(prds) {
    if (!root) return;
    const activeGoals = prds.flatMap((prd) => prd.goals || []).filter((goal) => goal.status !== "met" && goal.status !== "dropped").length;
    const metGoals = prds.flatMap((prd) => prd.goals || []).filter((goal) => goal.status === "met").length;
    root.innerHTML = `<div class="goals-view">
      <header class="goals-header"><div><span class="workspace-eyebrow">Planning workspace</span><h2>Goals</h2><p>Long-horizon outcomes stored directly in <code>.ok/prds</code>.</p></div><div class="goals-summary"><span><strong>${activeGoals}</strong> active</span><span><strong>${metGoals}</strong> met</span></div></header>
      ${prds.length ? `<div class="goals-list">${prds.map((prd) => `<article class="goal-prd-card"><header><div><span class="goal-prd-id">${escapeHtml(prd.id)}</span><h3>${escapeHtml(prd.title)}</h3></div><span class="goal-prd-status">${escapeHtml(prd.status)}</span></header><p>${escapeHtml(prd.vision)}</p><ul>${(prd.goals || []).map((goal) => goalRow(prd, goal)).join("") || "<li class=\"goal-row-empty\">No goals defined yet.</li>"}</ul></article>`).join("")}</div>` : `<div class="goals-empty"><strong>No goals yet</strong><p>Create a PRD with <code>ok prd add</code>; it will appear here automatically.</p></div>`}
    </div>`;
  }
  async function refresh() {
    if (!root) return;
    root.innerHTML = '<div class="goals-loading">Loading durable goals…</div>';
    try { render((await api("GET", "/api/goals")).prds || []); }
    catch (error) { root.innerHTML = `<div class="goals-empty"><strong>Goals could not load</strong><p>${escapeHtml(error.message)}</p></div>`; }
  }
  async function onClick(event) {
    const button = event.target.closest("[data-goal][data-status]");
    if (!button || button.classList.contains("is-active")) return;
    button.disabled = true;
    try { await api("PATCH", `/api/goals/${button.dataset.prd}/${button.dataset.goal}`, { status: button.dataset.status }); await refresh(); }
    catch (error) { button.disabled = false; window.alert(`Could not update goal: ${error.message}`); }
  }
  window.OpenKanGoals = {
    mount(target) { if (mounted && root === target) return; root = target; mounted = true; root.addEventListener("click", onClick); refresh(); },
    unmount() { if (root) root.removeEventListener("click", onClick); root = null; mounted = false; },
  };
})();
