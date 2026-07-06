// OpenKan — settings dialog (M10 + M13 sidebar restructure).
// window.OpenKanSettings = { open(), close(), refresh(), showToast(), applyTheme(), currentTheme(), cycleTheme() }
//
// Layout:
//   ┌───────────────────────────────────────────────────┐
//   │ Settings                              [×]          │
//   ├─────────────┬─────────────────────────────────────┤
//   │  Project    │  Project settings                   │
//   │  Server     │                                     │
//   │  UI         │  [Default agent]    [_________]    │
//   │  Sandbox    │  [Default model]    [_________]    │
//   │  Import     │  [Default column ▼]                │
//   │  Contribs   │                                     │
//   │  Advanced   │                                     │
//   └─────────────┴─────────────────────────────────────┘
//
// Uses /api/config-sections (Thor is shipping it). Falls back to /api/settings
// with the legacy single-blob layout when the sections endpoint isn't
// implemented yet — keeps the dialog usable during the rollout.

(() => {
  "use strict";

  const { api } = window.OpenKanAPI;

  // ─── Theme persistence (separate from /api/settings so it works without
  // a backend round-trip) ───────────────────────────────────────────────
  const THEME_KEY = "openkan:theme";
  const VALID_THEMES = new Set(["dark", "light", "system"]);

  function applyTheme(theme) {
    const t = VALID_THEMES.has(theme) ? theme : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch {}
  }

  function currentTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (VALID_THEMES.has(t)) return t;
    } catch {}
    return "dark";
  }

  function cycleTheme() {
    const order = ["dark", "light", "system"];
    const cur = currentTheme().toLowerCase();
    const next = order[(order.indexOf(cur) + 1) % order.length] || "dark";
    applyTheme(next);
    try { window.OpenKanCrossTab?.publish?.("theme.changed", { theme: next }); } catch {}
    return next;
  }

  // Apply on boot — this must happen before the first paint to avoid a
  // flash, but the script is `defer`red, so the page may already be light.
  // We accept that brief flash; the alternative (an inline script) would
  // break the no-inline-script Content-Security-Policy in production.
  applyTheme(currentTheme());

  // ─── DOM helpers ───────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const backdrop = $("settings-backdrop");
  const body = $("settings-body");
  const saveBtn = $("settings-save");
  const navEl = $("settings-nav");
  const titleEl = $("settings-title");

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

  function showToast(message, kind = "success") {
    const container = $("toast-container");
    if (!container) {
      try { alert(message); } catch {}
      return;
    }
    const toast = el("div", `toast toast-${kind}`, { text: message });
    container.append(toast);
    // 4s auto-dismiss (UX spec). Mark as leaving so CSS animates opacity +
    // 8px slide-down together, matching the entry animation's direction.
    setTimeout(() => {
      toast.classList.add("toast-leaving");
      setTimeout(() => toast.remove(), 220);
    }, 4000);
  }

  // ─── Section model ──────────────────────────────────────────────────────
  // A "section" is what the sidebar shows and what the right pane renders.
  // We support two shapes:
  //   1. /api/config-sections returns [{ id, title, fields: [...] }, ...]
  //   2. /api/config-sections returns { sections: [...] } — unwrap.
  // Each field: { name, label, type, value, options?, placeholder?, hint?,
  //                min?, max?, step?, disabled?, readOnly? }
  // Types: text | number | select | radio | checkbox | readonly

  /** @type {Array<{id:string,title:string,hint?:string,fields:any[]}>|null} */
  let sections = null;
  /** @type {string|null} */
  let activeSectionId = null;
  /** @type {Object<string,any>} */
  let workingValues = {}; // collected from inputs as the user types

  // Legacy fallback sections — used when /api/config-sections 404s.
  function legacySectionsFromSettings(s) {
    const project = s?.project || {};
    return [
      {
        id: "project",
        title: "Project",
        hint: "Defaults used when creating a new task in this project.",
        fields: [
          { name: "defaultAgent", label: "Default agent", type: "text", value: project.defaultAgent || "", placeholder: "build" },
          { name: "defaultModel", label: "Default model", type: "text", value: project.defaultModel || "", placeholder: "provider/model" },
          { name: "defaultColumn", label: "Default column", type: "select",
            value: project.defaultColumn || "todo",
            options: [
              { v: "backlog", t: "Backlog" },
              { v: "todo", t: "To Do" },
              { v: "doing", t: "In Progress" },
              { v: "review", t: "Review" },
              { v: "done", t: "Done" },
            ],
          },
          { name: "autoArchiveDays", label: "Auto-archive done tasks after (days)", type: "number", value: project.autoArchiveDays ?? 0, min: 0, step: 1, hint: "0 = never" },
        ],
      },
      {
        id: "server",
        title: "Server",
        hint: "Server connection details (read-only at runtime).",
        fields: [
          { name: "host", label: "Host", type: "readonly", value: project.host || "" },
          { name: "port", label: "Port", type: "readonly", value: project.port ?? "" },
        ],
      },
      {
        id: "ui",
        title: "UI",
        fields: [
          { name: "theme", label: "Theme", type: "radio", value: currentTheme(),
            options: [
              { v: "dark", t: "Dark" },
              { v: "light", t: "Light" },
              { v: "system", t: "System" },
            ],
          },
        ],
      },
    ];
  }

  async function loadSections() {
    // Try the new endpoint first. Fall back to legacy /api/settings shape
    // when the endpoint isn't implemented yet.
    try {
      const data = await api("GET", "/api/config-sections");
      const list = Array.isArray(data) ? data : Array.isArray(data?.sections) ? data.sections : null;
      if (list && list.length > 0) return list;
      // Endpoint returned but empty — fall back to legacy too.
      const s = await api("GET", "/api/settings").catch(() => null);
      return legacySectionsFromSettings(s || {});
    } catch (err) {
      // /api/config-sections not implemented yet — fall back.
      try {
        const s = await api("GET", "/api/settings");
        return legacySectionsFromSettings(s || {});
      } catch {
        // No backend at all — show defaults.
        return legacySectionsFromSettings({});
      }
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────
  function renderNav() {
    if (!navEl || !sections) return;
    navEl.innerHTML = "";
    for (const sec of sections) {
      const item = el("button", "settings-nav-item" + (sec.id === activeSectionId ? " active" : ""), {
        type: "button",
        role: "tab",
        "aria-selected": sec.id === activeSectionId ? "true" : "false",
        "data-section": sec.id,
      });
      item.append(el("span", "settings-nav-label", { text: sec.title }));
      item.addEventListener("click", () => {
        activeSectionId = sec.id;
        renderNav();
        renderSection();
      });
      navEl.append(item);
    }
  }

  function renderSection() {
    if (!body || !sections) return;
    const sec = sections.find((s) => s.id === activeSectionId) || sections[0];
    if (!sec) return;
    if (titleEl) titleEl.textContent = sec.title;

    body.innerHTML = "";

    if (sec.hint) {
      body.append(el("p", "settings-section-hint", { text: sec.hint }));
    }

    for (const field of sec.fields) {
      body.append(renderField(sec, field));
    }

    // If this is the "ui" section (legacy), expose a "Saved locally" note
    // since theme is not persisted server-side yet.
    if (sec.id === "ui") {
      body.append(el("p", "settings-section-hint", {
        text: "Theme is stored locally and applied immediately.",
      }));
    }
  }

  function renderField(sec, field) {
    const wrap = el("div", "settings-field");
    wrap.append(el("label", "settings-field-label", {
      for: `settings-field-${sec.id}-${field.name}`,
      text: field.label || field.name,
    }));

    const inputId = `settings-field-${sec.id}-${field.name}`;
    let control;
    switch (field.type) {
      case "select": {
        control = el("select", "settings-input", { id: inputId, name: field.name });
        for (const opt of field.options || []) {
          const o = el("option", null, { value: opt.v ?? opt.value, text: opt.t ?? opt.label });
          if (String(field.value ?? "") === String(opt.v ?? opt.value)) o.selected = true;
          control.append(o);
        }
        break;
      }
      case "radio": {
        control = el("div", "settings-radio-row");
        for (const opt of field.options || []) {
          const id = `${inputId}-${opt.v ?? opt.value}`;
          const lbl = el("label", null, { for: id });
          const radio = el("input", null, {
            type: "radio",
            name: field.name,
            id,
            value: opt.v ?? opt.value,
          });
          if (String(field.value ?? "") === String(opt.v ?? opt.value)) radio.checked = true;
          radio.addEventListener("change", () => {
            if (field.name === "theme") applyTheme(String(opt.v ?? opt.value));
          });
          lbl.append(radio, ` ${opt.t ?? opt.label}`);
          control.append(lbl);
        }
        break;
      }
      case "number": {
        control = el("input", "settings-input", {
          type: "number",
          id: inputId,
          name: field.name,
          value: String(field.value ?? ""),
        });
        if (field.min !== undefined) control.setAttribute("min", String(field.min));
        if (field.max !== undefined) control.setAttribute("max", String(field.max));
        if (field.step !== undefined) control.setAttribute("step", String(field.step));
        if (field.placeholder) control.setAttribute("placeholder", field.placeholder);
        break;
      }
      case "readonly":
      case "text":
      default: {
        control = el("input", field.type === "readonly" ? "settings-input settings-readonly" : "settings-input", {
          type: field.type === "readonly" ? "text" : "text",
          id: inputId,
          name: field.name,
          value: String(field.value ?? ""),
          disabled: field.type === "readonly" ? "true" : null,
        });
        if (field.placeholder) control.setAttribute("placeholder", field.placeholder);
        if (field.readOnly) control.setAttribute("readonly", "readonly");
      }
    }

    if (control) wrap.append(control);
    if (field.hint) wrap.append(el("div", "settings-field-hint", { text: field.hint }));

    return wrap;
  }

  function collectValues() {
    const out = {};
    if (!body) return out;
    for (const sec of sections || []) {
      for (const field of sec.fields) {
        const id = `settings-field-${sec.id}-${field.name}`;
        const el_ = body.querySelector(`#${CSS.escape(id)}`);
        if (!el_) continue;
        const tag = (el_.tagName || "").toLowerCase();
        if (tag === "input" && el_.type === "radio") {
          // Skip — handled via the selected radio inside .settings-radio-row.
          continue;
        }
        if (tag === "input" && el_.type === "number") {
          out[field.name] = Number(el_.value || 0);
        } else {
          out[field.name] = String(el_.value || "");
        }
      }
      // Collect radios separately (multiple radios per field name).
      const radios = body.querySelectorAll(`input[type="radio"][name]:checked`);
      const seen = new Set();
      for (const r of radios) {
        if (seen.has(r.name)) continue;
        seen.add(r.name);
        out[r.name] = r.value;
      }
    }
    return out;
  }

  // ─── Open / close ──────────────────────────────────────────────────────
  function close() {
    if (!backdrop) return;
    backdrop.hidden = true;
  }

  async function open() {
    if (!backdrop) return;
    if (body) body.innerHTML = '<div class="settings-readonly">Loading…</div>';
    backdrop.hidden = false;

    sections = await loadSections();
    activeSectionId = sections[0]?.id || null;

    renderNav();
    renderSection();
  }

  // ─── Wire close + save ────────────────────────────────────────────────
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelectorAll("[data-close-settings]").forEach((b) =>
      b.addEventListener("click", close),
    );
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && backdrop && !backdrop.hidden) close();
  });

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const payload = collectValues();

        // First try the new endpoint. Then fall back to /api/settings.
        // The legacy endpoint is opt-in during the M10/M13 rollout — most
        // installations only have one. We treat any non-2xx as an error.
        let saved = null;
        let lastError = null;
        try {
          saved = await api("PATCH", "/api/config-sections", payload);
        } catch (err) {
          lastError = err;
          try {
            saved = await api("PATCH", "/api/settings", payload);
            lastError = null;
          } catch (err2) {
            lastError = err2;
          }
        }

        if (saved == null) {
          // Both endpoints failed. Persist locally as a last resort, but
          // surface the original error and keep the dialog open so the user
          // can retry once the server is back. Closing silently here would
          // look like success — the toast would be the only signal.
          try { localStorage.setItem("openkan:settings", JSON.stringify(payload)); } catch {}
          showToast(
            `Save failed (kept locally): ${lastError?.message || "unknown error"}`,
            "error",
          );
          return;
        }

        // The theme is local-only — apply already happened on radio change.
        // If we got here, the theme was part of `payload`; re-apply to keep
        // state in sync.
        if (payload.theme) applyTheme(String(payload.theme));
        showToast("Settings saved", "success");
        close();
        window.dispatchEvent(new CustomEvent("openkan:settings-saved", { detail: saved || payload }));
      } catch (err) {
        // collectValues() or the CustomEvent dispatch failed — keep the
        // dialog open so the user can retry.
        showToast(`Save failed: ${err.message}`, "error");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // ─── External wiring (gear icon in topbar) ─────────────────────────────
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#settings-btn");
    if (!btn) return;
    e.preventDefault();
    open();
  });

  window.OpenKanSettings = {
    open, close, refresh: open,
    applyTheme, currentTheme, cycleTheme, showToast,
  };
})();