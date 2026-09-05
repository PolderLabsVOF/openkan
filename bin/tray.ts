// bin/tray.ts — System tray icon for OpenKan.
//
// Wraps `systray` (the zaaack/node-systray Go-binary bridge) so the rest of
// the CLI can call a small, well-typed surface and trust that:
//   * the tray handle exposes `close()` and `setState()`
//   * all init failures are surfaced as `TrayUnavailableError` so the caller
//     can fall back to background mode on Linux without libappindicator, etc.
//
// The tray library ships precompiled Go binaries for darwin, linux, and
// win32 (x86_64). Apple Silicon will run the x86_64 binary via Rosetta.

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Lazy-loaded to keep tests and headless Linux paths free of the side-effect
// of spawning a Go subprocess on import. The import itself is cheap; the
// cost is the child_process spawn when the caller actually instantiates
// `new SysTray(...)` below.
type SysTrayCtor = new (opts: unknown) => SysTrayInstance;
interface SysTrayInstance {
  onClick(cb: (action: SysTrayAction) => void): void;
  onExit(cb: (code: number | null) => void): void;
  onError(cb: (err: Error) => void): void;
  sendAction(action: unknown): void;
  kill(): void;
  readonly killed: boolean;
}
interface SysTrayAction {
  seq_id: number;
  item: { title?: string; tooltip?: string };
}

export class TrayUnavailableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TrayUnavailableError";
    this.cause = cause;
  }
}

export type TrayState = "idle" | "running" | "working" | "error";

export interface TrayMenuItem {
  title: string;
  tooltip?: string;
  enabled?: boolean;
  checked?: boolean;
}

export interface TrayOptions {
  url: string;
  iconDir: string;          // directory containing icon-default.png, icon-working.png, icon-idle.png
  initialState?: TrayState;
  onOpen: () => void | Promise<void>;
  onStatus: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
}

export interface TrayHandle {
  close(): void;
  setState(state: TrayState): void;
  readonly state: TrayState;
}

// Resolve the bundled tray assets whether the entrypoint is bin/openkan.ts
// (development) or bin/openkan.mjs (published package). Both live in bin/.
function loadIconPngBase64(iconDir: string, filename: string): string {
  const path = join(iconDir, filename);
  if (!existsSync(path)) {
    throw new TrayUnavailableError(`Tray icon not found: ${path}`);
  }
  return readFileSync(path).toString("base64");
}

const ITEM_OPEN = 0;
const ITEM_STATUS = 1;
const ITEM_SEPARATOR = 2;
const ITEM_STOP = 3;

function buildMenu(icons: Record<TrayState, string>, url: string, state: TrayState): unknown {
  return {
    icon: icons[state] ?? icons.idle,
    title: "OpenKan",
    tooltip: `OpenKan — ${url}`,
    items: [
      { title: "Open dashboard", tooltip: `Open ${url}`, enabled: true },
      { title: "Status", tooltip: "Show server status", enabled: true },
      { title: "-", enabled: false },
      { title: "Stop server", tooltip: "Stop the OpenKan server and quit", enabled: true },
    ],
  };
}

export async function createTray(opts: TrayOptions): Promise<TrayHandle> {
  const icons = {
    idle: loadIconPngBase64(opts.iconDir, "icon-idle.png"),
    running: loadIconPngBase64(opts.iconDir, "icon-default.png"),
    working: loadIconPngBase64(opts.iconDir, "icon-working.png"),
    error: loadIconPngBase64(opts.iconDir, "icon-idle.png"),
  };

  // systray treats "running" and "default" the same visually; map both to the
  // default icon. The state label is still surfaced in the tooltip via
  // setState() below.
  icons.running = icons.running ?? icons.idle;

  let SysTray: SysTrayCtor;
  try {
    // Dynamic import — keeps `systray` out of unit tests and headless paths.
    SysTray = (await import("systray")).default as unknown as SysTrayCtor;
  } catch (e) {
    throw new TrayUnavailableError("node-systray package not available", e);
  }

  let currentState: TrayState = opts.initialState ?? "running";
  let tray: SysTrayInstance | null = null;

  function makeMenu() {
    return buildMenu(icons, opts.url, currentState);
  }

  try {
    tray = new SysTray({ menu: makeMenu(), debug: false, copyDir: false });
  } catch (e) {
    throw new TrayUnavailableError(
      "Failed to initialize tray icon (libappindicator missing on Linux? See https://github.com/zaaack/node-systray#linux)",
      e,
    );
  }

  // Linux without libappindicator-3 silently kills the tray subprocess a
  // few hundred milliseconds after spawn — well before the user does
  // anything. Reject the createTray promise when we see an early 'exit'
  // or 'error' so the caller can fall back to background mode instead of
  // leaving a half-dead tray icon and a server running with no UI.
  let settled = false;
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    const finish = (err?: TrayUnavailableError) => {
      if (resolved) return;
      resolved = true;
      settled = true;
      if (err) reject(err); else resolve();
    };

    const READINESS_MS = 500;
    const timer = setTimeout(() => finish(), READINESS_MS);
    // 'exit' is emitted when the tray subprocess closes its stdout (the
    // library uses readline.on('close') to translate that to 'exit').
    (tray as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
      .on("exit", () => {
        clearTimeout(timer);
        finish(new TrayUnavailableError(
          "tray subprocess exited before it was ready (libappindicator missing on Linux?)",
        ));
      });
    tray!.onError((err) => {
      clearTimeout(timer);
      finish(new TrayUnavailableError(
        `tray subprocess errored before it was ready: ${err.message}`,
        err,
      ));
    });

    // If the tray already exited synchronously (rare but possible), close
    // out the promise in the next microtask so callers always see a
    // settled result.
    queueMicrotask(() => {
      if (tray && tray.killed) {
        clearTimeout(timer);
        finish(new TrayUnavailableError("tray subprocess exited immediately"));
      }
    });
  });

  if (!settled || !tray) {
    // Defensive: should never reach here — the await above always settles.
    throw new TrayUnavailableError("tray readiness check did not settle");
  }

  tray.onError((err) => {
    // Post-init errors: log and keep going. We do not want a tray
    // subprocess crash to kill the CLI; the user can still run
    // `openkan stop` from a terminal.
    process.stderr.write(`openkan tray: ${err.message}\n`);
  });

  tray.onClick(async (action) => {
    try {
      if (action.seq_id === ITEM_OPEN) {
        await opts.onOpen();
      } else if (action.seq_id === ITEM_STATUS) {
        await opts.onStatus();
      } else if (action.seq_id === ITEM_STOP) {
        await opts.onStop();
        // onStop is expected to terminate the process. As a safety net, kill
        // the tray after a short delay so we never linger if the caller
        // forgot to exit.
        setTimeout(() => tray?.kill(), 250);
      }
    } catch (e) {
      process.stderr.write(`openkan tray: menu handler failed: ${(e as Error).message}\n`);
    }
  });

  tray.onExit(() => {
    // Tray subprocess exited unexpectedly (e.g. user clicked the close box
    // on macOS). We still want the server to stop cleanly so it does not
    // outlive the user-visible tray icon. The caller passes onStop which
    // resolves to `cmdStop(ctx)` and then exits the process.
    void Promise.resolve(opts.onStop()).catch(() => {
      // best effort; process is going down regardless
    });
  });

  function setState(state: TrayState) {
    currentState = state;
    if (!tray || tray.killed) return;
    try {
      tray.sendAction({ type: "update-menu", menu: makeMenu() });
    } catch {
      // Update-menu failures are non-fatal; the tray may already be dead.
    }
  }

  function close() {
    if (!tray || tray.killed) return;
    try {
      tray.kill();
    } catch {
      // best effort
    }
  }

  return {
    close,
    setState,
    get state() { return currentState; },
  };
}

// Resolve the canonical icon directory relative to this source file so the
// tray works whether invoked from bin/openkan.ts (dev) or bin/openkan.mjs
// (published).
export function defaultIconDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "assets", "tray");
}
