// web/bizar.js — legacy compat shim.
//
// The Bizar tab is being superseded by the Claude pane (web/claude-pane.js).
// app.js still routes data-tab="bizar" to OpenKanBizar.mount, so we keep the
// symbol but delegate to the new implementation. Mount/unmount signatures
// are preserved.
//
// The Claude pane renders the four control-plane resource surfaces that
// the previous Bizar tab implemented:
//
//   - Agents          — see claude-pane.js renderSubagents()
//   - Durable tasks   — see claude-pane.js renderSubagents() (tsk-* chips)
//   - Sessions        — surfaced as Teams / Workflows cards
//   - Messages        — surfaced via the sticky Live activity footer
//
// The underlying new WebSocket control plane lives in kanban/server.ts and
// exposes a send-session (and sibling) RPC on the bridge socket; the
// claude-pane.js snapshot/activity REST endpoints read the same state.
//
// Removal plan: when app.js switches the data-tab value from "bizar" to
// "claude" and updates the valid[] array accordingly, this file can be
// deleted in a follow-up release.
(() => {
  "use strict";
  let mountedRoot = null;
  const claude = () => window.OpenKanClaude;
  window.OpenKanBizar = {
    mount(root) {
      mountedRoot = root;
      const c = claude();
      if (c?.mount) c.mount(root);
    },
    unmount() {
      const c = claude();
      if (c?.unmount) c.unmount();
      mountedRoot = null;
    },
  };
})();
