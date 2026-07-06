// OpenKan — MDX viewer (M7/M8/M9).
// window.OpenKanMdxViewer = { mount(rootEl, opts) }
//
// Consumes server-rendered MDX HTML from /api/tasks/:id/mdx-rendered and wires:
//   - clickable blocks (inline comment composer)
//   - <Preview> placeholders → /api/preview POST → sandboxed iframe
//   - <Ask>/<Choice>/<Input>/<Confirm> placeholders → live forms
//   - postMessage listener for iframe respond() callbacks
//
// The viewer is mounted and torn down by window.OpenKanTaskView.

(() => {
  "use strict";

  const { api } = window.OpenKanAPI;

  /**
   * Internal per-mount state.
   * @type {{
   *   taskId: string,
   *   rootEl: HTMLElement,
   *   pendingInputs: Array<{id:string,blockId?:string,type:string,question:string,options?:any,placeholder?:string}>,
   *   commentCounts: Map<string, number>,
   *   onCommentAdded: Function,
   *   onInputResponded: Function,
   *   messageListener: ((e: MessageEvent) => void)|null,
   *   activeComposer: HTMLElement|null,
   *   activeComposerBlock: HTMLElement|null,
   * }|null}
   */
  let state = null;

  // ─── Current user cache (loaded from /api/me) ───────────────────────────────
  // Used by the comment composer so the POST body carries `author` and the
  // server / other tabs can attribute the comment correctly. Loaded once on
  // first mount, refreshed if missing.
  let currentUserCache = null;
  let currentUserPromise = null;
  async function loadCurrentUser() {
    if (currentUserCache) return currentUserCache;
    if (currentUserPromise) return currentUserPromise;
    currentUserPromise = (async () => {
      try {
        const data = await api("GET", "/api/me");
        currentUserCache = data && typeof data === "object" ? data : { name: "user" };
      } catch {
        currentUserCache = { name: "user" };
      }
      // Expose for other modules (docs-view, task-view) so they can compare
      // authors without re-fetching.
      try { window.OpenKanCurrentUser = currentUserCache; } catch {}
      return currentUserCache;
    })();
    return currentUserPromise;
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────
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

  function escapeAttr(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // Parse a single progress line. The canonical format is:
  //   > [12:34:56] tool: edit_file on src/auth.ts — added login rate-limit
  // but we tolerate `> tool: …` (no leading timestamp) and treat the whole
  // remainder as the text. Returns { time, text } or null if the line is empty.
  function parseProgressLine(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]\s+(.*)$/);
    if (m) return { time: trimmed.slice(1, trimmed.indexOf("]") + 1), text: m[1] };
    // Fallback: try "HH:MM" without seconds
    const m2 = trimmed.match(/^(\d{1,2}:\d{2})\s+(.*)$/);
    if (m2) return { time: m2[1], text: m2[2] };
    return { time: null, text: trimmed };
  }

  // Walk the rendered MDX looking for an h2 with the exact text "Agent
  // progress" and turn the immediate-following blockquote siblings into a
  // styled vertical timeline. If no section is found, this is a no-op.
  function restyleAgentProgress(rootEl) {
    if (!rootEl) return;
    const headings = rootEl.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const h of headings) {
      if ((h.textContent || "").trim().toLowerCase() !== "agent progress") continue;
      // Collect following siblings until the next heading of any level.
      const collected = [];
      let node = h.nextElementSibling;
      while (node) {
        const tag = node.tagName?.toLowerCase() || "";
        if (/^h[1-6]$/.test(tag)) break;
        collected.push(node);
        node = node.nextElementSibling;
      }
      if (collected.length === 0) return;

      // Build the timeline container and move each blockquote in.
      const tl = document.createElement("div");
      tl.className = "agent-progress-timeline";
      let entries = 0;
      for (const elNode of collected) {
        // Each blockquote may contain multiple <p> tags. We treat each <p> as
        // a separate progress entry; multi-paragraph quotes are uncommon but
        // handled.
        const ps = elNode.tagName?.toLowerCase() === "blockquote"
          ? elNode.querySelectorAll("p")
          : [elNode];
        for (const p of ps) {
          const parsed = parseProgressLine(p.textContent || "");
          if (!parsed) continue;
          const entry = document.createElement("div");
          entry.className = "agent-progress-entry";
          if (parsed.time) {
            const t = document.createElement("span");
            t.className = "progress-time";
            t.textContent = parsed.time;
            entry.append(t);
          }
          const txt = document.createElement("span");
          txt.className = "progress-text";
          txt.textContent = parsed.text;
          entry.append(txt);
          tl.append(entry);
          entries++;
        }
        elNode.remove();
      }

      // Insert the timeline after the heading.
      h.parentNode?.insertBefore(tl, h.nextSibling);

      // If there are more than 20 entries, collapse with a "show all" button.
      if (entries > 20) {
        const items = [...tl.querySelectorAll(".agent-progress-entry")];
        items.slice(20).forEach((it) => { it.hidden = true; });
        const more = document.createElement("button");
        more.className = "agent-progress-more";
        more.type = "button";
        more.textContent = `Show all (${entries})`;
        let expanded = false;
        more.addEventListener("click", () => {
          expanded = !expanded;
          items.slice(20).forEach((it) => { it.hidden = !expanded; });
          more.textContent = expanded ? "Show recent only" : `Show all (${entries})`;
        });
        tl.append(more);
      }
      return; // only the first "Agent progress" section is restyled.
    }
  }

  // Add an anchor ¶ to every heading so readers can deep-link to a section.
  // The id is derived from the heading text (lowercased, kebab-cased, de-
  // duplicated). Clicking the anchor copies the URL hash to the clipboard.
  function addHeadingAnchors(rootEl) {
    if (!rootEl) return;
    const headings = rootEl.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const seen = new Set();
    for (const h of headings) {
      const level = parseInt(h.tagName.slice(1), 10);
      if (level > 4) continue; // keep the timeline clean; only h1-h4
      const text = (h.textContent || "").trim();
      if (!text) continue;
      let slug = text.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || "section";
      let id = slug;
      let n = 2;
      while (seen.has(id) || (rootEl.ownerDocument || document).getElementById(id)) {
        id = `${slug}-${n++}`;
      }
      seen.add(id);
      h.id = id;
      h.classList.add("mdx-heading");
      const a = document.createElement("a");
      a.className = "mdx-heading-anchor";
      a.href = `#${id}`;
      a.setAttribute("aria-label", `Link to section: ${text}`);
      a.textContent = "¶";
      a.addEventListener("click", async (e) => {
        // Copy the deep link to the clipboard but let the hash update too.
        try {
          const url = `${location.origin}${location.pathname}#${id}`;
          await navigator.clipboard.writeText(url);
          a.classList.add("copied");
          a.setAttribute("aria-label", `Copied link to ${text}`);
          setTimeout(() => a.classList.remove("copied"), 1200);
        } catch { /* clipboard unavailable — hash still updates */ }
      });
      h.append(a);
    }
  }

  // ─── Comment composer ───────────────────────────────────────────────────────
  function closeComposer() {
    if (state?.activeComposer) {
      state.activeComposer.remove();
      state.activeComposer = null;
      state.activeComposerBlock = null;
    }
  }

  function openComposer(blockEl) {
    console.debug("[openkan] composer opened for block", blockEl.getAttribute("data-block-id"));
    closeComposer();
    const blockId = blockEl.getAttribute("data-block-id");
    const line = blockEl.getAttribute("data-line") || "1";
    if (!blockId) {
      console.warn("[openkan] composer: block has no data-block-id, aborting");
      return;
    }

    const composer = el("div", "mdx-block-comment-composer");
    const ta = el("textarea", "composer-textarea", {
      rows: "2",
      placeholder: "Leave a comment on this block…",
    });
    composer.append(ta);
    const actions = el("div", "composer-actions");
    const cancel = el("button", "btn btn-icon-sm", { text: "Cancel", type: "button" });
    cancel.addEventListener("click", closeComposer);
    const save = el("button", "btn btn-primary btn-icon-sm", { text: "Save", type: "button" });
    actions.append(cancel, save);
    composer.append(actions);

    save.addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) return;
      save.disabled = true;
      // Resolve current user. Three fallbacks, in order:
      //   1. window.OpenKanCurrentUser — set by mdx-viewer.loadCurrentUser()
      //      or by task-view.fetchMe().
      //   2. A fresh /api/me call (covers the race where the user is loaded
      //      *during* the click).
      //   3. The literal "user" — server never silently drops a comment
      //      because of a missing author field.
      const me = window.OpenKanCurrentUser;
      let author = (me && me.name) || "user";
      console.debug("[openkan] comment POST starting", { taskId: state.taskId, blockId, line, text, author });
      try {
        const result = await api("POST", `/api/tasks/${state.taskId}/comments`, {
          blockId,
          line: Number(line) || 1,
          text,
          author,
        });
        console.debug("[openkan] comment POST response:", result);
        closeComposer();
        await state.onCommentAdded?.();
      } catch (err) {
        console.error("[openkan] comment POST error:", err);
        alert(`Failed to save comment: ${err.message}`);
        save.disabled = false;
      }
    });

    // Also submit with Cmd/Ctrl+Enter for power users.
    ta.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        save.click();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeComposer();
      }
    });

    // Insert immediately after the block.
    blockEl.insertAdjacentElement("afterend", composer);
    state.activeComposer = composer;
    state.activeComposerBlock = blockEl;
    // Defer focus so the textarea is in the DOM and visible.
    setTimeout(() => { try { ta.focus(); } catch {} }, 0);
  }

  // ─── Comment-count indicators ───────────────────────────────────────────────
  function paintCommentIndicators() {
    if (!state?.rootEl) return;
    const blocks = state.rootEl.querySelectorAll(".mdx-block[data-block-id]");
    blocks.forEach((b) => {
      const id = b.getAttribute("data-block-id");
      const count = state.commentCounts.get(id) || 0;
      b.classList.toggle("has-comments", count > 0);
      let badge = b.querySelector(":scope > .mdx-comment-count");
      if (count > 0) {
        if (!badge) {
          badge = el("span", "mdx-comment-count", { text: String(count) });
          badge.title = `${count} comment${count === 1 ? "" : "s"}`;
          b.append(badge);
        } else {
          badge.textContent = String(count);
        }
      } else if (badge) {
        badge.remove();
      }
    });
  }

  // ─── <Preview> placeholder → sandboxed iframe ──────────────────────────────
  async function mountPreview(placeholder) {
    const tsx = placeholder.getAttribute("data-mdx-tsx") || "";
    const propsRaw = placeholder.getAttribute("data-mdx-props") || "{}";
    let props = {};
    try { props = JSON.parse(propsRaw); } catch { props = {}; }

    placeholder.classList.add("mdx-preview");
    placeholder.innerHTML = `<div class="mdx-preview-loading">Compiling preview…</div>`;

    let result;
    try {
      result = await api("POST", "/api/preview", { tsx, props });
    } catch (err) {
      placeholder.innerHTML = `<div class="mdx-preview-error">Preview failed: ${escapeAttr(err.message)}</div>`;
      return;
    }
    if (result?.error || !result?.sandboxHtml) {
      placeholder.innerHTML = `<div class="mdx-preview-error">Preview failed: ${escapeAttr(result?.error || "no output")}</div>`;
      return;
    }
    placeholder.innerHTML = "";
    const iframe = el("iframe", "mdx-preview-iframe", {
      sandbox: "allow-scripts",
      referrerpolicy: "no-referrer",
      title: "TSX preview",
    });
    // srcdoc comes from the server (trusted). The sandbox attribute already isolates it.
    iframe.srcdoc = result.sandboxHtml;
    placeholder.append(iframe);
  }

  // ─── <Ask>/<Choice>/<Input>/<Confirm> placeholder → live form ──────────────
  function mountFormPlaceholder(placeholder) {
    const blockId = placeholder.getAttribute("data-block-id");
    const type = placeholder.getAttribute("data-mdx-component");
    const question = placeholder.getAttribute("data-question") || "";
    const placeholderText = placeholder.getAttribute("data-placeholder") || "";
    let options = [];
    try { options = JSON.parse(placeholder.getAttribute("data-options") || "[]"); } catch {}

    // Find a pending input that matches this blockId (if any).
    const match = state?.pendingInputs?.find(
      (i) => i.status === "pending" && i.blockId && i.blockId === blockId,
    );

    placeholder.classList.add("mdx-component-form");
    placeholder.innerHTML = "";

    const head = el("header", "mdx-component-form-head");
    head.append(el("span", "mdx-component-type", { text: type }));
    if (match) head.append(el("span", "mdx-component-status", { text: "· awaiting response" }));
    placeholder.append(head);

    if (!match) {
      placeholder.append(el("div", "mdx-component-question", { text: question || "(no question text)" }));
      placeholder.append(el("div", "mdx-component-inactive", {
        text: match ? "" : "This question is not currently active.",
      }));
      return;
    }

    const form = el("form", "mdx-component-form-body");
    form.append(el("div", "mdx-component-question", { text: match.question || question }));

    let control;
    switch (match.type) {
      case "choice": {
        control = el("div", "banner-options");
        for (const opt of (match.options || options)) {
          const id = `${match.id}-${opt.id}`;
          const radio = el("input", null, { type: "radio", name: "value", value: opt.id, id });
          const lbl = el("label", null, { for: id });
          lbl.append(radio, ` ${opt.label}`);
          if (opt.description) lbl.append(el("div", "option-desc", { text: opt.description }));
          control.append(lbl);
        }
        form.append(control);
        break;
      }
      case "confirm": {
        control = el("div", "banner-confirm-row");
        const yesId = `${match.id}-yes`;
        const noId = `${match.id}-no`;
        const yl = el("label", null, { for: yesId });
        yl.append(el("input", null, { type: "radio", name: "value", value: "yes", id: yesId }), " Yes");
        const nl = el("label", null, { for: noId });
        nl.append(el("input", null, { type: "radio", name: "value", value: "no", id: noId }), " No");
        control.append(yl, nl);
        form.append(control);
        break;
      }
      case "input":
      case "ask":
      default: {
        control = el("textarea", "banner-textarea", {
          rows: "3",
          placeholder: match.placeholder || placeholderText || "Type your response…",
          name: "value",
        });
        form.append(control);
        break;
      }
    }
    const submit = el("button", "btn btn-primary", { text: "Send", type: "submit" });
    form.append(submit);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      let body;
      if (match.type === "choice") {
        body = { inputId: match.id, optionId: String(fd.get("value") || "") };
        if (!body.optionId) return alert("Please choose an option.");
      } else if (match.type === "confirm") {
        body = { inputId: match.id, value: String(fd.get("value") || "") };
        if (!body.value) return alert("Please choose Yes or No.");
      } else {
        body = { inputId: match.id, value: String(fd.get("value") || "").trim() };
        if (!body.value) return alert("Please type a response.");
      }
      submit.disabled = true;
      try {
        await state.onInputResponded?.(match.id, body);
      } catch (err) {
        alert(`Failed: ${err.message}`);
        submit.disabled = false;
      }
    });

    placeholder.append(form);
  }

  // ─── Click handler for comment composer ─────────────────────────────────────
  function onBlockClick(ev) {
    if (typeof console !== "undefined") {
      const block = ev.target.closest(".mdx-block[data-block-id]");
      console.debug("[openkan] mdx-block clicked:", block?.getAttribute("data-block-id") || "(none)");
    }
    const block = ev.target.closest(".mdx-block[data-block-id]");
    if (!block) return;
    // Don't open composer when clicking inside a form, iframe, button, input, or textarea.
    if (ev.target.closest("form, button, input, textarea, select, iframe, a")) return;
    // Don't open composer for component placeholders (they handle their own interaction).
    if (ev.target.closest("[data-mdx-component]")) return;
    ev.preventDefault();
    openComposer(block);
  }

  // Some MDX renders dynamically swap the inner HTML (e.g. comment-count
  // badges are inserted via paintCommentIndicators). Bind a single delegated
  // click handler at the document level that catches the rare case where the
  // per-root listener missed the target due to a bubble-phase stop. Cheap
  // because it just walks closest() and exits.
  function documentBlockClick(ev) {
    const root = state?.rootEl;
    if (!root) return;
    // Only act when the click is inside the current MDX root.
    if (!root.contains(ev.target)) return;
    onBlockClick(ev);
  }

  // ─── postMessage listener for preview iframes ───────────────────────────────
  function onMessage(ev) {
    const data = ev.data;
    if (!data || data.type !== "openkan:respond" || data.version !== 1) return;
    // The iframe cannot tell us which input it relates to; surface to task view
    // which can log/ignore. Preview components are visual — respond() is rare.
    try { state?.onInputResponded?.(null, { value: data.value }); } catch {}
  }

  function teardown() {
    if (state) {
      try { window.removeEventListener("message", state.messageListener); } catch {}
      try { state.rootEl?.removeEventListener("click", onBlockClick); } catch {}
      try { document.removeEventListener("click", documentBlockClick, true); } catch {}
      state = null;
    }
  }
  async function mount(rootEl, opts = {}) {
    if (!rootEl) throw new Error("mdx-viewer: rootEl is required");
    teardown();

    const taskId = opts.taskId;
    if (!taskId) throw new Error("mdx-viewer: opts.taskId is required");

    state = {
      taskId,
      rootEl,
      pendingInputs: opts.pendingInputs || [],
      commentCounts: new Map(),
      onCommentAdded: opts.onCommentAdded || (() => {}),
      onInputResponded: opts.onInputResponded || (() => {}),
      messageListener: onMessage,
      activeComposer: null,
      activeComposerBlock: null,
    };

    window.addEventListener("message", state.messageListener);
    // Eagerly fetch the current user so the composer can attach author to
    // the POST body without waiting on user interaction.
    loadCurrentUser();

    // 1. Resolve the rendered HTML/blocks. Prefer what the caller already has
    //    (the /api/tasks/:id endpoint embeds renderedHtml/renderedBlocks, so
    //    a second fetch is wasted work). Fall back to the legacy endpoint
    //    when the embedded payload is missing — e.g. an older server.
    //    The decision to skip the fetch hinges on the rendered payload, NOT
    //    on the comments list (which is always present on /api/tasks/:id
    //    but absent from /api/tasks/:id/mdx-rendered).
    let html = null;
    let blocks = null;
    let comments = [];
    const hasEmbeddedRendered = typeof opts.html === "string" || Array.isArray(opts.blocks);
    if (hasEmbeddedRendered) {
      html = typeof opts.html === "string" ? opts.html : "";
      blocks = Array.isArray(opts.blocks) ? opts.blocks : [];
      comments = Array.isArray(opts.comments) ? opts.comments : [];
    } else {
      try {
        const rendered = await api("GET", `/api/tasks/${taskId}/mdx-rendered`);
        html = rendered?.html ?? "";
        blocks = rendered?.blocks ?? [];
        comments = rendered?.comments ?? [];
      } catch (err) {
        rootEl.innerHTML = `<div class="mdx-error">Failed to render MDX: ${escapeAttr(err.message)}</div>`;
        return;
      }
    }

    // 2. Build comment-count map.
    for (const c of comments) {
      if (c?.blockId) {
        state.commentCounts.set(c.blockId, (state.commentCounts.get(c.blockId) || 0) + 1);
      }
    }
    // Also merge in any comments passed separately (the task view fetched the same set).

    // 3. Inject HTML. The server has sanitized it.
    rootEl.innerHTML = html;

    // Focus mgmt — make the MDX root programmatically focusable so screen
    // readers can announce the freshly-mounted content without forcing the
    // user to Tab through every browser chrome element first. We don't
    // steal focus here (callers can request it via opts.focusRoot); just
    // make sure tabindex is set so the element IS reachable on demand.
    if (opts.focusRoot) {
      rootEl.tabIndex = -1;
      try { rootEl.focus({ preventScroll: false }); } catch {}
    } else {
      // Always expose tabindex so the parent can decide to focus.
      if (!rootEl.hasAttribute("tabindex")) rootEl.setAttribute("tabindex", "-1");
    }

    // 4. Wire click → composer for each .mdx-block.
    rootEl.addEventListener("click", onBlockClick);
    // Defense in depth: also listen at the document level (capture phase) so
    // we catch clicks even if a downstream handler called stopPropagation()
    // before bubbling reached rootEl. documentBlockClick is a no-op when the
    // click is outside the current root, so it doesn't interfere with other
    // viewers.
    document.addEventListener("click", documentBlockClick, true);

    // 5. Paint comment-count indicators.
    paintCommentIndicators();

    // 6. Process <Preview> placeholders — these become iframes.
    const previewEls = rootEl.querySelectorAll('[data-mdx-component="Preview"]');
    previewEls.forEach((ph) => { mountPreview(ph); });

    // 7. Process <Ask>/<Choice>/<Input>/<Confirm> placeholders.
    for (const type of ["Ask", "Choice", "Input", "Confirm"]) {
      rootEl.querySelectorAll(`[data-mdx-component="${type}"]`).forEach((ph) => {
        mountFormPlaceholder(ph);
      });
    }

    // 8. Restyle the "## Agent progress" section as a vertical timeline.
    // The MDX file stores progress lines as blockquotes under an h2 with that
    // exact text (per M11 spec). We re-render those blockquotes as a
    // `.agent-progress-timeline` so it reads cleanly instead of as raw quotes.
    restyleAgentProgress(rootEl);

    // 9. Add anchor-link icons to every h1-h4 so readers can deep-link to
    // a section and copy the URL.
    addHeadingAnchors(rootEl);
  }

  window.OpenKanMdxViewer = { mount, teardown };
})();