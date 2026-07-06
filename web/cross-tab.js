// OpenKan — cross-tab sync (M13).
// window.OpenKanCrossTab = { publish(event, data), subscribe(event, handler) }
//
// Thin wrapper around BroadcastChannel('openkan'). When SSE is unavailable or
// behind a load balancer that strips long-lived connections, this keeps two
// tabs of the same project in sync. The channel is fire-and-forget on the
// publisher side; subscribers receive the parsed payload from message events
// on other tabs of the same browser, same origin.
//
// The event names here mirror what SSE would emit, so app.js can subscribe to
// cross-tab and SSE with the same handler shape.
//
// Graceful degradation: if BroadcastChannel isn't available (older browsers,
// sandboxed contexts), the wrapper becomes a no-op — publish() does nothing
// and subscribe() returns an unsubscribe that does nothing. Cross-tab sync is
// a "nice to have"; SSE remains the source of truth.

(() => {
  "use strict";

  const CHANNEL_NAME = "openkan";

  /** @type {BroadcastChannel|null} */
  let channel = null;
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();

  // Skip origin-mismatch channels silently — the wrapper assumes same-origin.
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener("message", (ev) => {
        const data = ev.data;
        if (!data || typeof data !== "object") return;
        const { event, payload } = data;
        if (typeof event !== "string") return;
        const set = handlers.get(event);
        if (!set) return;
        for (const fn of set) {
          try { fn(payload); } catch (e) {
            console.error(`[cross-tab] handler for ${event} threw:`, e);
          }
        }
      });
      // Close on page unload so we don't keep a stale handle around.
      window.addEventListener("pagehide", () => {
        try { channel?.close(); } catch {}
        channel = null;
      });
    } catch (err) {
      // SecurityError / disabled — fall through to no-op below.
      channel = null;
    }
  }

  /**
   * Publish an event to other tabs. Returns true if a channel is available,
   * false if the call was a no-op.
   * @param {string} event
   * @param {any} data
   * @returns {boolean}
   */
  function publish(event, data) {
    if (!channel) return false;
    if (typeof event !== "string" || !event) return false;
    try {
      channel.postMessage({ event, payload: data });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Subscribe to events from other tabs. Returns an unsubscribe function.
   * @param {string} event
   * @param {(data:any) => void} handler
   * @returns {() => void}
   */
  function subscribe(event, handler) {
    if (typeof event !== "string" || !event || typeof handler !== "function") {
      return () => {};
    }
    let set = handlers.get(event);
    if (!set) { set = new Set(); handlers.set(event, set); }
    set.add(handler);
    return () => {
      const s = handlers.get(event);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) handlers.delete(event);
    };
  }

  /**
   * Test-only: expose hasChannel() so callers can detect whether the wrapper
   * is actually live. Not part of the public API used by app.js.
   */
  function hasChannel() { return channel !== null; }

  window.OpenKanCrossTab = { publish, subscribe, hasChannel };
})();
