// web/status.js — shared task status derivation for the web UI.
//
// Mirrors `kanban/board.ts:mapColumnToStatus()` so the board cards and
// opened-task panel render the same canonical state. The server stores
// `state` only when an explicit lifecycle state exists (running / done /
// failed / cancelled / waiting-for-input); for the rest it defaults to
// `idle` regardless of column, which made every card look idle. This
// helper falls back to column + archived when `state` is the default
// idle marker.
//
// Output values: "pending" | "in_progress" | "review" | "done" |
// "cancelled" | "running" | "waiting-for-input" | "failed".
// (The trailing four mirror the explicit lifecycle states so the helper
// stays lossless when the server has already recorded one.)

(function () {
  "use strict";

  function displayState(task) {
    if (!task) return "pending";
    if (task.archived) return "cancelled";
    const explicit = task.state ?? task.status;
    // Explicit lifecycle states pass through unchanged so callers can
    // still observe "running", "failed", "waiting-for-input", etc.
    if (explicit && explicit !== "idle") return explicit;
    // Otherwise derive from the column. The server defaults `state` to
    // "idle" for everything that hasn't been claimed by an agent, so we
    // trust the column here.
    switch (task.column) {
      case "doing":   return "in_progress";
      case "review":  return "review";
      case "done":    return "done";
      case "todo":
      case "backlog":
      default:        return "pending";
    }
  }

  window.OpenKanStatus = { displayState };
})();
