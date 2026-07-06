// OpenKan — shared fetch wrapper + SSE pub/sub (M13 updates).
// Loaded by index.html before app.js, task-view.js, mdx-viewer.js.
// Exposes window.OpenKanAPI = { api, connectSSE, on, off, status }.
//
// M13 changes:
//   - Reconnect on error uses exponential backoff (1s, 2s, 4s, 8s … capped
//     at 30s) instead of relying on the EventSource's own backoff and falling
//     back to polling.
//   - Each named event is also re-broadcast on the OpenKanCrossTab channel
//     so tabs that lost their SSE connection catch up via siblings.
//   - On reconnect, /api/board is re-fetched and the resulting snapshot is
//     emitted locally and broadcast to siblings — guarantees any tab that
//     comes back online gets full state.
//   - Added "task.changed" to the known-event list (M14 disk watcher).

(() => {
  "use strict";

  const POLL_MS = 5000;
  const SSE_PATH = "/api/events";
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_CAP_MS = 30000;
  const RECONNECT_GIVE_UP_MS = 60000; // after this long with no usable events, fall back to polling

  // ─── fetch wrapper ─────────────────────────────────────────────────────────
  // Match the original app.js signature so existing callers don't change.
  // Returns parsed JSON when content-type is JSON, otherwise the raw text.
  async function api(method, path, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${method} ${path} -> ${res.status} ${t}`);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  // ─── SSE pub/sub ────────────────────────────────────────────────────────────
  // One singleton EventSource per page. Multiple consumers subscribe via on()/off().
  // Auto-reconnects on error with exponential backoff capped at 30s. Each
  // named event is also pushed onto window.OpenKanCrossTab so siblings stay
  // in sync even when SSE is unreliable for one of them.

  /** @type {EventSource|null} */
  let es = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let reconnectTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let pollTimer = null;
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  let connected = false;
  /** Delay before the next reconnect attempt. Reset on a successful onopen. */
  let reconnectDelay = RECONNECT_BASE_MS;
  /** Wall-clock timestamp of the last successful SSE event (ms). */
  let lastEventAt = 0;
  const statusListeners = new Set();

  // Best-effort cross-tab publish. The wrapper is loaded after api.js in some
  // bundle orders, so defer the lookup to call time, not module init.
  function xtPublish(event, payload) {
    try {
      const xt = window.OpenKanCrossTab;
      if (xt?.publish) xt.publish(event, payload);
    } catch { /* no-op */ }
  }

  function emit(event, data) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(data); } catch (e) { console.error(`SSE handler for ${event} threw:`, e); }
    }
  }

  // Mirror a server SSE event into the cross-tab channel. Local subscribers
  // already get the event via emit() so they run once. Other tabs receive
  // the same payload via OpenKanCrossTab and call emit() locally too —
  // handlers are idempotent (Map upsert + renderBoard), so a brief double-
  // delivery at sync time is harmless and worth the simplicity.
  function emitAndMirror(event, data) {
    emit(event, data);
    xtPublish(event, data);
  }

  function setConnected(v) {
    if (connected === v) return;
    connected = v;
    for (const fn of statusListeners) {
      try { fn(v); } catch {}
    }
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(refresh, POLL_MS);
    refresh();
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  async function refresh() {
    try {
      const snap = await api("GET", "/api/board");
      emitAndMirror("board.snapshot", snap);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSSE();
    }, reconnectDelay);
    // Exponential backoff: 1s, 2s, 4s, 8s, … capped at 30s.
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP_MS);
  }

  async function refreshBoardAfterReconnect() {
    try {
      const snap = await api("GET", "/api/board");
      emitAndMirror("board.snapshot", snap);
      return true;
    } catch {
      return false;
    }
  }

  function connectSSE() {
    if (es) {
      try { es.close(); } catch {}
      es = null;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    try {
      es = new EventSource(SSE_PATH);
    } catch (err) {
      // EventSource constructor can throw on bad URL etc. — fall back to poll.
      startPoll();
      return null;
    }

    es.onopen = () => {
      setConnected(true);
      reconnectDelay = RECONNECT_BASE_MS;
      lastEventAt = Date.now();
      stopPoll();
      // SSE re-opened — pull a fresh board snapshot so the UI reflects
      // anything that happened while we were disconnected, and let sibling
      // tabs catch up too.
      refreshBoardAfterReconnect();
    };

    es.onerror = () => {
      setConnected(false);
      // The EventSource will try to reopen internally; we don't trust its
      // timing so we tear down and schedule our own reconnect with
      // exponential backoff. After RECONNECT_GIVE_UP_MS of no progress, fall
      // back to polling instead of hammering the server.
      try { es?.close(); } catch {}
      es = null;
      scheduleReconnect();
      // If we haven't seen a single event in the give-up window, polling
      // is more reliable than a tight SSE reconnect loop.
      setTimeout(() => {
        if (!connected && !reconnectTimer && Date.now() - lastEventAt > RECONNECT_GIVE_UP_MS) {
          startPoll();
        }
      }, RECONNECT_GIVE_UP_MS + 100);
    };

    // Generic event fan-out: any `onmessage` or named event fires `emit(event, data)`.
    // The known list also gets mirrored to OpenKanCrossTab. Catch-all "message"
    // events (no name) are emitted locally only — they're server-internal pings.
    const KNOWN = [
      "board.snapshot",
      "task.created", "task.updated", "task.deleted",
      "task.archived", "task.restored",
      "task.comment.added", "task.comment.resolved", "task.comment.deleted",
      "task.input.asked", "task.input.responded",
      "task.changed",
      "bulk.updated",
      "theme.changed",
      "filter.changed",
      "session.ended",
      "server.connected",
    ];
    for (const name of KNOWN) {
      es.addEventListener(name, (e) => {
        let parsed = null;
        try { parsed = JSON.parse(e.data); } catch { parsed = e.data; }
        lastEventAt = Date.now();
        emitAndMirror(name, parsed);
      });
    }
    // Unnamed `message` events.
    es.addEventListener("message", (e) => {
      lastEventAt = Date.now();
      let parsed = null;
      try { parsed = JSON.parse(e.data); } catch { parsed = e.data; }
      emit("message", parsed);
    });
    return es;
  }

  function on(event, handler) {
    let set = handlers.get(event);
    if (!set) { set = new Set(); handlers.set(event, set); }
    set.add(handler);
    // Ensure SSE is running once a consumer attaches.
    if (event !== "*") connectSSE();
    return () => off(event, handler);
  }
  function off(event, handler) {
    const set = handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) handlers.delete(event);
  }
  function onStatus(fn) {
    statusListeners.add(fn);
    fn(connected);
    return () => statusListeners.delete(fn);
  }

  // Auto-start on load.
  connectSSE();

  // Cross-tab subscriber → local emit. Same idempotency reasoning as above:
  // a local tab may see its own SSE event mirrored back; both paths call the
  // same handlers and Map/renderBoard are idempotent.
  if (window.OpenKanCrossTab && window.OpenKanCrossTab.subscribe) {
    const FORWARDED = [
      "task.created", "task.updated", "task.deleted",
      "task.archived", "task.restored",
      "task.comment.added", "task.comment.resolved", "task.comment.deleted",
      "task.input.asked", "task.input.responded",
      "task.changed",
      "bulk.updated",
      "theme.changed",
      "filter.changed",
      "session.ended",
      "board.snapshot",
    ];
    for (const evt of FORWARDED) {
      window.OpenKanCrossTab.subscribe(evt, (payload) => emit(evt, payload));
    }
  }

  window.OpenKanAPI = { api, connectSSE, on, off, onStatus, refresh, get connected() { return connected; } };
})();
