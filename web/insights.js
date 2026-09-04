// web/insights.js — Insights tab (M-Insights).
//
// window.OpenKanInsights = { mount(root), unmount() }
//
// Fetches /api/insights/velocity on first mount (or on hash change
// to re-fetch). Renders a three-card summary row (tasks done in
// window, busiest day, average lead time) above one stacked-bar
// chart via window.OpenKanCharts. Empty state shows the
// `web/brand/empty-tasks.svg` illustration + a real cause-and-action
// sentence.

(() => {
  "use strict";

  const { api } = window.OpenKanAPI;
  const { renderStackedBar, isAllZero } = window.OpenKanCharts;

  let mountedRoot = null;
  let mountedData = null;

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

  function buildSummary(data) {
    const days = data.days || [];
    const cols = data.columns || {};
    const done = cols.done || [];
    const totalDone = done.reduce((a, b) => a + (b > 0 ? b : 0), 0);

    // Busiest day: argmax of day total across all columns.
    let bestIdx = -1;
    let bestVal = 0;
    for (let i = 0; i < days.length; i++) {
      let dayTotal = 0;
      for (const id of ["backlog", "todo", "doing", "review", "done"]) {
        const arr = cols[id] || [];
        const v = arr[i] || 0;
        if (v > 0) dayTotal += v;
      }
      if (dayTotal > bestVal) { bestVal = dayTotal; bestIdx = i; }
    }
    let busiestDay = "—";
    if (bestIdx >= 0) {
      const parts = (days[bestIdx] || "").split("-").map(Number);
      if (parts.length === 3 && parts.every(n => !isNaN(n))) {
        const dt = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
        try {
          busiestDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" }).format(dt);
        } catch {
          busiestDay = days[bestIdx];
        }
      }
    }

    // Average lead time. We don't have per-task move-into-doing /
    // move-into-done timestamps in the current response, so this card
    // reports the count of move-into-done events in the window. The
    // design spec notes the per-task lead-time derivation as a v2.
    // For v1 we display a derived "moves per day" number as a stand-in
    // and a clear copy line.
    const window = Math.max(1, days.length);
    const movesPerDay = (totalDone / window).toFixed(1);

    return { totalDone, busiestDay, movesPerDay, bestVal, window };
  }

  function renderSummaryRow(parent, summary) {
    const row = el("div", "insights-summary");
    row.appendChild(buildCard(String(summary.totalDone), "Tasks done in window",
      "Sum of move-into-done events over the period."));
    row.appendChild(buildCard(summary.busiestDay, "Busiest day",
      `Day with the most moves (${summary.bestVal || 0} total).`));
    row.appendChild(buildCard(summary.movesPerDay, "Avg moves / day (done)",
      "Tasks reaching Done per day, averaged over the window."));
    parent.appendChild(row);
  }

  function buildCard(value, label, hint) {
    const card = el("div", "insights-card");
    const v = el("div", "insights-card-value", { text: value });
    const l = el("div", "insights-card-label", { text: label });
    const h = el("div", "insights-card-hint", { text: hint });
    card.appendChild(v);
    card.appendChild(l);
    card.appendChild(h);
    return card;
  }

  function renderEmptyState(parent) {
    const wrap = el("div", "insights-empty");
    const img = el("img", "insights-empty-img", {
      src: "./brand/empty-tasks.svg",
      alt: "",
      width: 320,
      height: 200,
    });
    const caption = el("p", "insights-empty-caption");
    caption.appendChild(document.createTextNode(
      "No changelog activity yet. Start moving cards to populate this chart."
    ));
    wrap.appendChild(img);
    wrap.appendChild(caption);
    parent.appendChild(wrap);
  }

  function buildDataTable(parent, data) {
    const details = el("details", "insights-data");
    const summary = el("summary", "insights-data-summary", { text: "Show data table" });
    details.appendChild(summary);
    const table = el("table", "insights-data-table");
    const thead = el("thead");
    const tr = el("tr");
    tr.appendChild(el("th", "", { text: "Date" }));
    for (const id of ["backlog", "todo", "doing", "review", "done"]) {
      tr.appendChild(el("th", "", { text: id }));
    }
    tr.appendChild(el("th", "", { text: "total" }));
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = el("tbody");
    const days = data.days || [];
    for (let i = 0; i < days.length; i++) {
      const tr2 = el("tr");
      tr2.appendChild(el("td", "", { text: days[i] }));
      let dayTotal = 0;
      for (const id of ["backlog", "todo", "doing", "review", "done"]) {
        const v = (data.columns?.[id] || [])[i] || 0;
        tr2.appendChild(el("td", "", { text: String(v) }));
        if (v > 0) dayTotal += v;
      }
      tr2.appendChild(el("td", "", { text: String(dayTotal) }));
      tbody.appendChild(tr2);
    }
    table.appendChild(tbody);
    details.appendChild(table);
    parent.appendChild(details);
  }

  function buildLegend(parent) {
    const ul = el("ul", "insights-legend");
    for (const id of ["backlog", "todo", "doing", "review", "done"]) {
      const li = el("li", "insights-legend-item");
      const sw = el("span", `insights-legend-swatch swatch-${id}`);
      sw.setAttribute("aria-hidden", "true");
      li.appendChild(sw);
      li.appendChild(document.createTextNode(id));
      ul.appendChild(li);
    }
    parent.appendChild(ul);
  }

  function render(mount, data) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    const card = el("section", "insights-card-wrap");
    mount.appendChild(card);

    const summary = buildSummary(data);
    renderSummaryRow(card, summary);

    const chartWrap = el("div", "insights-chart");
    if (isAllZero(data)) {
      renderEmptyState(chartWrap);
    } else {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("insights-chart-svg");
      renderStackedBar(svg, data);
      chartWrap.appendChild(svg);
      buildLegend(chartWrap);
    }
    card.appendChild(chartWrap);
    buildDataTable(card, data);
  }

  async function mount(root) {
    if (!root) return;
    mountedRoot = root;
    while (root.firstChild) root.removeChild(root.firstChild);
    const loading = el("p", "insights-loading", { text: "Loading insights…" });
    root.appendChild(loading);
    try {
      const data = await api("GET", "/api/insights/velocity?days=30");
      mountedData = data;
      if (mountedRoot === root) render(root, data);
    } catch (err) {
      while (root.firstChild) root.removeChild(root.firstChild);
      const errP = el("p", "insights-error");
      errP.appendChild(document.createTextNode(
        "Failed to load insights. Retry by switching tabs."
      ));
      const errHint = el("span", "insights-error-hint");
      errHint.appendChild(document.createTextNode(
        (err && err.message) ? ` (${err.message})` : ""
      ));
      errP.appendChild(errHint);
      root.appendChild(errP);
    }
  }

  function unmount() {
    if (mountedRoot) {
      while (mountedRoot.firstChild) mountedRoot.removeChild(mountedRoot.firstChild);
    }
    mountedRoot = null;
    mountedData = null;
  }

  window.OpenKanInsights = { mount, unmount };
})();
