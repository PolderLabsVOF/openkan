// web/charts.js — pure-SVG stacked-bar renderer for the Insights tab.
//
// No dependencies. Uses document.createElementNS so the host must provide
// a DOM. Color and tokens come from the page (CSS variables on the SVG).
//
// data shape (matches /api/insights/velocity):
//   {
//     days: string[],          // YYYY-MM-DD local, oldest first
//     columns: { backlog, todo, doing, review, done: number[] },
//     windowDays: number,
//     generatedAt: string,
//   }

(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const COLUMNS = [
    { id: "backlog", token: "var(--ink-50)" },
    { id: "todo",    token: "var(--warn)" },
    { id: "doing",   token: "var(--accent)" },
    { id: "review",  token: "var(--coral)" },
    { id: "done",    token: "var(--success)" },
  ];

  const BAR_WIDTH = 18;
  const BAR_GAP = 6;
  const PLOT_PAD_LEFT = 32;   // space for y-axis labels
  const PLOT_PAD_RIGHT = 8;
  const PLOT_PAD_TOP = 16;
  const PLOT_PAD_BOTTOM = 28; // space for x-axis labels
  const PLOT_HEIGHT = 180;

  function svg(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        el.setAttribute(k, String(v));
      }
    }
    return el;
  }

  function clearChildren(parent) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
  }

  function isAllZero(data) {
    if (!data || !data.columns) return true;
    for (const col of COLUMNS) {
      const arr = data.columns[col.id];
      if (!Array.isArray(arr)) continue;
      for (const n of arr) if (n > 0) return false;
    }
    return true;
  }

  function dayTotal(data, dayIdx) {
    let sum = 0;
    for (const col of COLUMNS) {
      const arr = data.columns[col.id] || [];
      const v = arr[dayIdx] || 0;
      if (v > 0) sum += v;
    }
    return sum;
  }

  function formatDayLabel(yyyyMmDd) {
    // YYYY-MM-DD → Mon DD (e.g. "Aug 04")
    const parts = yyyyMmDd.split("-").map(Number);
    const y = parts[0], m = parts[1] - 1, d = parts[2];
    const date = new Date(y, m, d, 12, 0, 0, 0);
    if (isNaN(date.getTime())) return yyyyMmDd;
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: "short", day: "2-digit",
      }).format(date);
    } catch {
      return yyyyMmDd;
    }
  }

  function formatDayLabelLong(yyyyMmDd) {
    const parts = yyyyMmDd.split("-").map(Number);
    const y = parts[0], m = parts[1] - 1, d = parts[2];
    const date = new Date(y, m, d, 12, 0, 0, 0);
    if (isNaN(date.getTime())) return yyyyMmDd;
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: "short", day: "2-digit", year: "numeric",
      }).format(date);
    } catch {
      return yyyyMmDd;
    }
  }

  function renderStackedBar(svgEl, data) {
    if (!svgEl || !data || !data.columns) return;
    clearChildren(svgEl);

    const days = data.days || [];
    const dayCount = days.length;
    const innerWidth = dayCount * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
    const totalWidth = innerWidth + PLOT_PAD_LEFT + PLOT_PAD_RIGHT;
    const totalHeight = PLOT_HEIGHT + PLOT_PAD_TOP + PLOT_PAD_BOTTOM;

    svgEl.setAttribute("viewBox", `0 0 ${totalWidth} ${totalHeight}`);
    svgEl.setAttribute("width", String(totalWidth));
    svgEl.setAttribute("height", String(totalHeight));
    svgEl.setAttribute("preserveAspectRatio", "xMinYMid meet");
    svgEl.setAttribute("role", "img");

    const summary = `Stacked bar chart of tasks moved per column over the last ${dayCount} days, generated ${data.generatedAt || "n/a"}.`;
    const desc = svg("desc", {});
    desc.textContent = summary;
    svgEl.appendChild(desc);
    svgEl.setAttribute("aria-label", summary);

    // Compute the max per-day total to drive the y-axis.
    let max = 0;
    for (let i = 0; i < dayCount; i++) {
      const t = dayTotal(data, i);
      if (t > max) max = t;
    }
    const yMax = Math.max(1, max);

    // Background plot rect (subtle, flat surface)
    svgEl.appendChild(svg("rect", {
      x: PLOT_PAD_LEFT,
      y: PLOT_PAD_TOP,
      width: innerWidth,
      height: PLOT_HEIGHT,
      fill: "transparent",
    }));

    // Y-axis ticks at 0, ceil(max/2), max.
    const yTicks = [0, Math.ceil(yMax / 2), yMax];
    for (const tick of yTicks) {
      const ratio = yMax === 0 ? 0 : tick / yMax;
      const y = PLOT_PAD_TOP + PLOT_HEIGHT - ratio * PLOT_HEIGHT;
      svgEl.appendChild(svg("line", {
        x1: PLOT_PAD_LEFT,
        y1: y,
        x2: PLOT_PAD_LEFT + innerWidth,
        y2: y,
        stroke: "var(--ink-30)",
        "stroke-width": 1,
      }));
      const label = svg("text", {
        x: PLOT_PAD_LEFT - 6,
        y: y + 3,
        "text-anchor": "end",
        "font-size": 11,
        "font-family": "inherit",
        fill: "var(--ink-50)",
      });
      label.textContent = String(tick);
      svgEl.appendChild(label);
    }

    // Bars
    for (let i = 0; i < dayCount; i++) {
      const x = PLOT_PAD_LEFT + i * (BAR_WIDTH + BAR_GAP);
      // Determine which segments are non-zero (in fixed column order).
      const segments = [];
      for (const col of COLUMNS) {
        const arr = data.columns[col.id] || [];
        const v = arr[i] || 0;
        if (v > 0) segments.push({ col: col.id, token: col.token, count: v });
      }
      if (segments.length === 0) {
        // Empty day: render a faint baseline so the bar slot is visible.
        const ghost = svg("rect", {
          x, y: PLOT_PAD_TOP + PLOT_HEIGHT - 2,
          width: BAR_WIDTH, height: 2,
          fill: "var(--ink-30)", rx: 1,
        });
        svgEl.appendChild(ghost);
        continue;
      }
      // Stack segments from bottom (PLOT_PAD_TOP + PLOT_HEIGHT) up.
      const totalUnits = segments.reduce((a, s) => a + s.count, 0);
      const usableHeight = PLOT_HEIGHT - 2; // 1-unit top/bottom inset
      let cursor = PLOT_PAD_TOP + PLOT_HEIGHT - 1; // bottom edge
      const segCount = segments.length;
      segments.forEach((seg, sIdx) => {
        const segH = Math.max(1, Math.round((seg.count / totalUnits) * usableHeight));
        const isFirst = sIdx === 0;
        const isLast = sIdx === segCount - 1;
        const segY = cursor - segH;
        const rect = svg("rect", {
          x, y: segY,
          width: BAR_WIDTH, height: segH,
          fill: seg.token,
        });
        // Rounding on outermost segments.
        if (isFirst) {
          rect.setAttribute("rx", "4");
          rect.setAttribute("ry", "4");
        }
        if (isLast) {
          // top corners rounded for the top segment
          rect.setAttribute("rx", "4");
          rect.setAttribute("ry", "4");
        }
        // 2px surface gap between stacked segments.
        if (!isFirst) {
          rect.setAttribute("y", String(segY + 1));
          rect.setAttribute("height", String(segH - 1));
        }
        // Title for hover (per the spec).
        const titleText = `${seg.col} on ${formatDayLabelLong(days[i])}: ${seg.count} move${seg.count === 1 ? "" : "s"}`;
        const titleEl = svg("title", {});
        titleEl.textContent = titleText;
        rect.appendChild(titleEl);
        svgEl.appendChild(rect);
        cursor = segY;
      });
      // Invisible full-height hit target for hover over zero-count gaps
      // inside a day (per dataviz interaction guidance).
      const hit = svg("rect", {
        x, y: PLOT_PAD_TOP,
        width: BAR_WIDTH, height: PLOT_HEIGHT,
        fill: "transparent",
        "pointer-events": "all",
      });
      const hitTitle = svg("title", {});
      hitTitle.textContent = `${formatDayLabelLong(days[i])}: ${totalUnits} move${totalUnits === 1 ? "" : "s"}`;
      hit.appendChild(hitTitle);
      svgEl.appendChild(hit);
    }

    // X-axis labels every 5 days + day 29 (per spec).
    for (let i = 0; i < dayCount; i++) {
      const isMajor = i % 5 === 0;
      const isLast = i === dayCount - 1;
      if (!isMajor && !isLast) continue;
      const x = PLOT_PAD_LEFT + i * (BAR_WIDTH + BAR_GAP) + BAR_WIDTH / 2;
      const label = svg("text", {
        x, y: PLOT_PAD_TOP + PLOT_HEIGHT + 16,
        "text-anchor": "middle",
        "font-size": 11,
        "font-family": "inherit",
        fill: "var(--ink-50)",
      });
      label.textContent = formatDayLabel(days[i]);
      svgEl.appendChild(label);
    }

    // Axis baseline + left axis.
    svgEl.appendChild(svg("line", {
      x1: PLOT_PAD_LEFT,
      y1: PLOT_PAD_TOP + PLOT_HEIGHT,
      x2: PLOT_PAD_LEFT + innerWidth,
      y2: PLOT_PAD_TOP + PLOT_HEIGHT,
      stroke: "var(--ink-30)", "stroke-width": 1,
    }));
    svgEl.appendChild(svg("line", {
      x1: PLOT_PAD_LEFT,
      y1: PLOT_PAD_TOP,
      x2: PLOT_PAD_LEFT,
      y2: PLOT_PAD_TOP + PLOT_HEIGHT,
      stroke: "var(--ink-30)", "stroke-width": 1,
    }));
  }

  window.OpenKanCharts = { renderStackedBar, isAllZero };
})();
