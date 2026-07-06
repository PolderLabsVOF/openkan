// OpenKan — global keyboard shortcuts + help overlay (M13).
// window.OpenKanKeyboard = { on, off, execute, showHelp, hideHelp,
//                            isHelpOpen, getFocusedId, setFocusedId,
//                            focusCardById, scrollFocusedIntoView }
//
// The keyboard module is a thin event hub: it owns the global keydown
// listener, the focused-card state, and the help overlay. Consumers
// (app.js, task-view.js) register action handlers via on("focus.next", …)
// and the module invokes them when the matching key is pressed.
//
// The focused-card class is rendered by app.js's renderCard() — it calls
// getFocusedId() and adds .focused to the matching <article>. The keyboard
// module also exposes scrollFocusedIntoView() so callers can force a scroll
// after a navigation event without waiting for the next render pass.
//
// Shortcut table:
//   j / ↓         focus.next            — select next card in column
//   k / ↑         focus.previous        — select previous card
//   h / ←         focus.column-prev     — select first card in prev column
//   l / →         focus.column-next     — select first card in next column
//   Enter         focus.open            — open the focused card's task view
//   Space         focus.toggle-select   — toggle selection of the focused card
//   1..5          action.move-column    — column index 0..4 (backlog → done)
//   a             action.archive
//   e             action.edit           — open / focus the task view's edit mode
//   d             action.delete
//   /             search.focus
//   ? or Shift+/ help.show
//   Cmd/Ctrl+K    palette.open
//   Esc           (priority: palette > help > others — see handler)
//
// Keys that could disrupt typing (e, d, a, ?, /) are ignored while focus is
// inside an <input>, <textarea>, or [contenteditable]. Cmd/Ctrl+K and Esc
// always work.

(() => {
  "use strict";

  /** @type {string|null} */
  let focusedId = null;
  /** @type {HTMLElement|null} The help overlay root, built lazily. */
  let helpRoot = null;
  /** Element that had focus before the help overlay opened; restored on close. */
  let helpPrevFocus = null;

  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();

  function on(event, handler) {
    if (!event || typeof handler !== "function") return () => {};
    let set = handlers.get(event);
    if (!set) { set = new Set(); handlers.set(event, set); }
    set.add(handler);
    return () => off(event, handler);
  }
  function off(event, handler) {
    const set = handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) handlers.delete(event);
  }
  function emit(event, ...args) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(...args); } catch (e) {
        console.error(`[keyboard] handler for ${event} threw:`, e);
      }
    }
  }
  /** Manual invocation of a named action — useful for tests / external triggers. */
  function execute(event, ...args) {
    emit(event, ...args);
  }

  function getFocusedId() { return focusedId; }
  function setFocusedId(id) {
    if (focusedId === id) return;
    focusedId = id;
    emit("focus.changed", id);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function isTypingTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    if (target.matches && target.matches("input, textarea")) return true;
    if (target.isContentEditable) return true;
    // Select / contenteditable ancestors.
    let n = target.parentElement;
    while (n) {
      if (n.isContentEditable) return true;
      n = n.parentElement;
    }
    return false;
  }

  function taskViewOpen() {
    const v = document.getElementById("task-view");
    return !!v && !v.hidden;
  }

  function lightboxOpen() {
    const lb = document.getElementById("image-lightbox");
    return !!lb && !lb.hidden;
  }

  function modalOpen() {
    for (const id of ["modal-backdrop", "settings-backdrop", "template-backdrop"]) {
      const el = document.getElementById(id);
      if (el && !el.hidden) return true;
    }
    return false;
  }

  // ─── Help overlay (lazy-created) ──────────────────────────────────────────
  function buildHelpOverlay() {
    const root = document.createElement("div");
    root.id = "help-overlay";
    root.className = "help-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "help-title");
    root.hidden = true;

    const dialog = document.createElement("div");
    dialog.className = "help-dialog";
    dialog.tabIndex = -1;
    dialog.innerHTML = `
      <header class="help-header">
        <h2 id="help-title">Keyboard shortcuts</h2>
        <button type="button" class="btn-icon help-close" aria-label="Close">×</button>
      </header>
      <div class="help-body">
        <section class="help-col">
          <h3>Navigation</h3>
          <dl>
            <dt><kbd>j</kbd> / <kbd>↓</kbd></dt><dd>next card</dd>
            <dt><kbd>k</kbd> / <kbd>↑</kbd></dt><dd>previous card</dd>
            <dt><kbd>h</kbd> / <kbd>←</kbd></dt><dd>previous column</dd>
            <dt><kbd>l</kbd> / <kbd>→</kbd></dt><dd>next column</dd>
            <dt><kbd>Enter</kbd></dt><dd>open focused task</dd>
          </dl>
        </section>
        <section class="help-col">
          <h3>Selection</h3>
          <dl>
            <dt><kbd>Space</kbd></dt><dd>toggle selection of focused card</dd>
            <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>move selected cards to column (backlog → done)</dd>
            <dt><kbd>a</kbd></dt><dd>archive selected</dd>
            <dt><kbd>d</kbd></dt><dd>delete selected (confirm)</dd>
          </dl>
        </section>
        <section class="help-col">
          <h3>Other</h3>
          <dl>
            <dt><kbd>/</kbd></dt><dd>focus search</dd>
            <dt><kbd>?</kbd></dt><dd>this help</dd>
            <dt><kbd>⌘K</kbd> / <kbd>Ctrl K</kbd></dt><dd>command palette</dd>
            <dt><kbd>Esc</kbd></dt><dd>close overlay / clear selection</dd>
          </dl>
        </section>
      </div>
    `;
    root.append(dialog);

    // Click on backdrop (not dialog body) closes.
    root.addEventListener("click", (e) => {
      if (e.target === root) hideHelp();
    });
    dialog.querySelector(".help-close").addEventListener("click", hideHelp);

    document.body.appendChild(root);
    return root;
  }

  function ensureHelp() {
    if (!helpRoot) helpRoot = buildHelpOverlay();
    return helpRoot;
  }

  function showHelp() {
    const root = ensureHelp();
    root.hidden = false;
    // Move focus into the dialog so Esc / Tab work naturally.
    setTimeout(() => {
      const dlg = root.querySelector(".help-dialog");
      try { dlg?.focus({ preventScroll: true }); } catch {}
      // Focus the close button by default.
      const btn = root.querySelector(".help-close");
      try { btn?.focus({ preventScroll: true }); } catch {}
    }, 0);
    document.body.classList.add("help-open");
  }

  function hideHelp() {
    if (!helpRoot || helpRoot.hidden) return false;
    helpRoot.hidden = true;
    document.body.classList.remove("help-open");
    // Return focus to whatever had it before opening, if still attached.
    if (helpPrevFocus && document.contains(helpPrevFocus)) {
      try { helpPrevFocus.focus({ preventScroll: true }); } catch {}
    }
    helpPrevFocus = null;
    return true;
  }

  function isHelpOpen() {
    return !!(helpRoot && !helpRoot.hidden);
  }

  // ─── Command palette interlock ───────────────────────────────────────────
  // The palette module lives in command-palette.js and registers handlers for
  // "palette.open" / "palette.close" / "palette.isOpen". Esc closes it from
  // there so we don't create a circular dependency — keyboard.js only knows
  // it can ask via emit("palette.isOpen") → emit("palette.close").
  function paletteIsOpen() {
    let open = false;
    emit("palette.isOpen", () => { open = true; });
    return open;
  }
  function paletteClose() {
    emit("palette.close");
  }

  // ─── Scroll focused card into view ───────────────────────────────────────
  function scrollFocusedIntoView() {
    if (!focusedId) return;
    const board = document.getElementById("board");
    if (!board) return;
    const card = board.querySelector(`.card[data-id="${cssEscape(focusedId)}"]`);
    if (!card) return;
    try {
      card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    } catch {
      try { card.scrollIntoView(); } catch {}
    }
    // Mark the card as the active element so Enter / Space don't reach the body.
    try { card.focus({ preventScroll: true }); } catch {}
  }

  function focusCardById(id) {
    if (!id) return;
    const board = document.getElementById("board");
    if (!board) return;
    const card = board.querySelector(`.card[data-id="${cssEscape(id)}"]`);
    if (!card) return;
    setFocusedId(id);
    scrollFocusedIntoView();
  }

  // CSS.escape isn't always available — roll our own for the bare chars that
  // appear in task ids (UUIDs, [A-Z0-9-]). Falls back to a no-op escape.
  function cssEscape(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }

  // ─── Global keydown handler ──────────────────────────────────────────────
  // Capture phase: we see keys before the focused element does. Cmd/Ctrl+K
  // always works; Esc always works. Other shortcuts yield when the user is
  // typing in an input/textarea or [contenteditable].

  function handler(e) {
    // Allow our own input (palette, help) to work even when focused.
    const key = e.key;

    // Esc — applies the priority order described in the spec:
    //   palette > help > lightbox > task view > bulk select > modal
    // The first two are owned by this module. Lightbox is owned by images.js
    // and modal by app.js — we just fall through to them. The task view has
    // no Esc handler of its own, so we close it from here. Bulk select is
    // handled by app.js's bubble-phase listener; ditto fall through.
    if (key === "Escape") {
      if (paletteIsOpen()) {
        e.preventDefault();
        e.stopPropagation();
        paletteClose();
        return;
      }
      if (isHelpOpen()) {
        e.preventDefault();
        e.stopPropagation();
        hideHelp();
        return;
      }
      if (taskViewOpen()) {
        e.preventDefault();
        e.stopPropagation();
        window.OpenKanTaskView?.close?.();
        return;
      }
      // Other handlers (lightbox / modal / bulk select) own their own Esc.
      return;
    }

    // From here on, ignore typing inside editable fields unless the key is
    // Cmd/Ctrl+K (handled below; nothing else has a global override).
    if (isTypingTarget(e.target)) return;

    // If the palette or help overlay is open, hand off every shortcut to its
    // own keydown handlers — we don't want j/k to move the board focus, or
    // Space to bubble out and toggle board selection while the user is
    // navigating the overlay. Esc still has priority (handled above).
    if (paletteIsOpen() || isHelpOpen()) return;

    const isMod = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl+K → palette
    if (isMod && (key === "k" || key === "K")) {
      e.preventDefault();
      e.stopPropagation();
      emit("palette.open");
      return;
    }

    // ? or Shift+/
    if ((key === "?" || (e.shiftKey && key === "/")) && !e.altKey) {
      // Don't intercept when a modal is open — let the modal receive the key.
      if (modalOpen()) return;
      e.preventDefault();
      showHelp();
      return;
    }

    // /
    if (key === "/" && !e.shiftKey && !isMod) {
      if (modalOpen()) return;
      e.preventDefault();
      emit("search.focus");
      return;
    }

    // If the task view is the active surface, narrow navigation to app.js
    // handlers so app.js can decide whether to act (it currently doesn't
    // expose edit-mode navigation, so most keys are no-ops here).
    if (taskViewOpen()) {
      // Space is still consumed by us — prevent the page from scrolling
      // while the task view is open and the user presses Space.
      if (key === " ") {
        e.preventDefault();
        emit("focus.toggle-select");
        return;
      }
      // j/k/e forward even when the task view is up; consumers can ignore.
    }

    // j / ↓ — next card
    if (key === "j" || key === "ArrowDown") {
      if (modalOpen() && !taskViewOpen()) return;
      e.preventDefault();
      emit("focus.next");
      return;
    }
    // k / ↑ — previous card
    if (key === "k" || key === "ArrowUp") {
      if (modalOpen() && !taskViewOpen()) return;
      e.preventDefault();
      emit("focus.previous");
      return;
    }
    // h / ← — previous column
    if (key === "h" || key === "ArrowLeft") {
      if (modalOpen() && !taskViewOpen()) return;
      e.preventDefault();
      emit("focus.column-prev");
      return;
    }
    // l / → — next column
    if (key === "l" || key === "ArrowRight") {
      if (modalOpen() && !taskViewOpen()) return;
      e.preventDefault();
      emit("focus.column-next");
      return;
    }

    // Enter — open focused card.
    if (key === "Enter" && !isMod) {
      // Let Enter submit forms inside the task view's <input>/<textarea>; we
      // shouldn't intercept when an editable child is the actual target.
      if (e.target && e.target.matches && e.target.matches("input, textarea, button, a")) return;
      e.preventDefault();
      emit("focus.open");
      return;
    }

    // Space — toggle selection of focused card.
    if (key === " ") {
      // Don't swallow Space in inputs.
      if (e.target && e.target.matches && e.target.matches("input, textarea, button")) return;
      e.preventDefault();
      emit("focus.toggle-select");
      return;
    }

    // 1-5 — move to column (0-indexed; backlog → done).
    if (/^[1-5]$/.test(key) && !isMod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      emit("action.move-column", parseInt(key, 10) - 1);
      return;
    }

    // a — archive
    if (key === "a" && !isMod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      emit("action.archive");
      return;
    }

    // d — delete
    if (key === "d" && !isMod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      emit("action.delete");
      return;
    }

    // e — edit (task view edit mode)
    if (key === "e" && !isMod && !e.shiftKey && !e.altKey) {
      // Spec: proxy — opens the focused task if not already; otherwise a no-op.
      e.preventDefault();
      emit("action.edit");
      return;
    }
  }

  // ─── Boot ────────────────────────────────────────────────────────────────
  function init() {
    if (window.__openkanKeyboardInit) return;
    window.__openkanKeyboardInit = true;
    window.addEventListener("keydown", handler, { capture: true });
    document.body.classList.add("keyboard-enabled");
  }

  // Public API.
  window.OpenKanKeyboard = {
    on, off, execute,
    showHelp, hideHelp, isHelpOpen,
    getFocusedId, setFocusedId,
    focusCardById, scrollFocusedIntoView,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
