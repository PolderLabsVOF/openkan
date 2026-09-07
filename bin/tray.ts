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
import process from "node:process";

// Lazy-loaded to keep tests and headless Linux paths free of the side-effect
// of spawning a Go subprocess on import. The import itself is cheap; the
// cost is the child_process spawn when the caller actually instantiates
// `new SysTray(...)` below.
type SysTrayCtor = new (opts: unknown) => SysTrayInstance;
interface SysTrayInstance {
  onClick(cb: (action: SysTrayAction) => void): void;
  onReady(cb: () => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  onError(cb: (err: Error) => void): void;
  sendAction(action: { type: string; menu?: unknown; item?: unknown }): void;
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

// Categorical failure kinds so each catch site can build a deterministic,
// platform-aware error message instead of repeating the
// "libappindicator-missing" hand-wave on every platform. Exported so tests
// can pin the exact text per OS.
export type TrayFailureKind =
  | "missing-package"    // dynamic import('systray') threw
  | "icon-missing"       // loadIconPngBase64() could not find the icon asset
  | "constructor"        // new SysTray(...) threw synchronously
  | "early-exit"         // tray subprocess emitted 'exit' before readiness
  | "exited-immediately" // tray subprocess was already dead on next microtask
  | "readiness-timeout"; // defensive: the readiness promise never settled

const TRAY_NPM_PACKAGE = "systray";

// Build a deterministic, platform-aware install / troubleshooting hint for a
// given tray failure kind. Exported so tests can pin the exact text per OS.
//
// IMPORTANT: keep this side-effect free. It is called from the catch site and
// must not touch the filesystem, network, or process state.
export function trayInitHint(
  kind: TrayFailureKind,
  platform: NodeJS.Platform = process.platform,
): string {
  switch (kind) {
    case "missing-package":
      return `Install the '${TRAY_NPM_PACKAGE}' dependency with \`npm install ${TRAY_NPM_PACKAGE}\` (or run \`npm install\` to restore the project's declared dependencies).`;
    case "icon-missing":
      return `Reinstall OpenKan (\`npm install -g @polderlabs/openkan\`) so the bundled tray icons in bin/assets/tray/ are restored.`;
    case "constructor":
    case "early-exit":
    case "exited-immediately":
    case "readiness-timeout":
      switch (platform) {
        case "linux":
          return `On Debian/Ubuntu run \`apt install libappindicator3-1\`; on Fedora run \`dnf install libappindicator-gtk3\`. Log out and back in (or reboot) so the indicator service picks up the install.`;
        case "darwin":
          return `macOS does not require a separate tray package. If the tray still fails, verify the '${TRAY_NPM_PACKAGE}' prebuilt binary downloaded correctly under node_modules/${TRAY_NPM_PACKAGE}/ and that you are running from a graphical session (not over SSH without a forwarded display).`;
        case "win32":
          return `Windows does not require a separate tray package. If the tray still fails, run from a terminal that supports system-tray icons and check the system Event Viewer for missing DLLs (e.g. vcruntime140.dll, dbghelp.dll).`;
        default:
          return `Install your platform's system-tray indicator package (on Linux: libappindicator3-1 / libappindicator-gtk3) and retry.`;
      }
  }
}

// Extract the human-readable message from an unknown thrown value, falling
// back to a stable string for non-Error throws (strings, numbers, objects).
function causeMessage(cause: unknown): string {
  if (cause === undefined || cause === null) return "";
  if (cause instanceof Error) return cause.message || cause.name || "Error";
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return Object.prototype.toString.call(cause);
  }
}

// Compose the user-facing message for a TrayUnavailableError. Embeds both the
// cause message and the platform hint so the caller can print one
// `e.message` and the user gets the full story (without needing to walk
// `cause` themselves).
export interface TrayErrorContext {
  kind: TrayFailureKind;
  platform?: NodeJS.Platform;
  cause?: unknown;
  extra?: string;
}

export function buildTrayUnavailableMessage(ctx: TrayErrorContext): string {
  const platform = ctx.platform ?? process.platform;
  const causeMsg = causeMessage(ctx.cause);
  const hint = trayInitHint(ctx.kind, platform);
  const kindLabel = (() => {
    switch (ctx.kind) {
      case "missing-package": return "node-systray package is not loadable";
      case "icon-missing": return "tray icon asset is missing";
      case "constructor": return "failed to initialize tray icon";
      case "early-exit": return "tray subprocess exited before it was ready";
      case "exited-immediately": return "tray subprocess exited immediately";
      case "readiness-timeout": return "tray readiness check did not settle";
    }
  })();
  const reason = causeMsg ? `${kindLabel}: ${causeMsg}` : kindLabel;
  const extra = ctx.extra ? ` (${ctx.extra})` : "";
  return `${reason}${extra}. ${hint}`;
}

// Optional runtime overrides for unit testing. Tests can inject a fake
// SysTray constructor and an alternate readiness window without monkey-
// patching `import()` or sleeping for 500ms.
export interface TrayRuntime {
  platform?: NodeJS.Platform;
  loadSysTray?: () => Promise<SysTrayCtor>;
  readinessMs?: number;
}

// Emit a single warn-level line to stderr describing the underlying cause.
// We do this before throwing so that callers who catch and discard
// TrayUnavailableError still leave a breadcrumb in the user's terminal.
// Passing `cause` as a second argument to console.warn preserves the
// original Error object — including its name, stack, and nested cause —
// rather than collapsing it into a string.
function warnTray(message: string, cause?: unknown): void {
  if (cause !== undefined) {
    console.warn(`ok tray: WARN ${message}`, cause);
  } else {
    console.warn(`ok tray: WARN ${message}`);
  }
}

// Build a fully-detailed TrayUnavailableError and log the underlying cause
// to stderr. Single chokepoint so each catch site stays a one-liner and
// tests can pin both the thrown message and the warn-line content.
export function raiseTrayUnavailable(
  ctx: TrayErrorContext,
): TrayUnavailableError {
  const platform = ctx.platform ?? process.platform;
  const message = buildTrayUnavailableMessage({ ...ctx, platform });
  warnTray(message, ctx.cause);
  return new TrayUnavailableError(message, ctx.cause);
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
  // Test seam: overrides for platform, systray loader, and the readiness
  // timeout window. Production callers leave this undefined.
  runtime?: TrayRuntime;
}

export interface TrayHandle {
  close(): void;
  setState(state: TrayState): void;
  readonly state: TrayState;
}

// Resolve the bundled tray assets whether the entrypoint is bin/ok.ts
// (development) or bin/ok.mjs (published package). Both live in bin/.
function loadIconPngBase64(iconDir: string, filename: string): string {
  const path = join(iconDir, filename);
  if (!existsSync(path)) {
    throw raiseTrayUnavailable({ kind: "icon-missing", extra: path });
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
  const runtime = opts.runtime ?? {};
  const platform = runtime.platform ?? process.platform;
  const readinessMs = runtime.readinessMs ?? 500;

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
    // The runtime hook lets tests inject a fake loader that throws the
    // exact error they want to surface.
    const loadSysTray = runtime.loadSysTray
      ?? (async () => (await import("systray")).default as unknown as SysTrayCtor);
    SysTray = await loadSysTray();
  } catch (e) {
    throw raiseTrayUnavailable({ kind: "missing-package", platform, cause: e });
  }

  let currentState: TrayState = opts.initialState ?? "running";
  let tray: SysTrayInstance | null = null;

  function makeMenu() {
    return buildMenu(icons, opts.url, currentState);
  }

  try {
    tray = new SysTray({ menu: makeMenu(), debug: false, copyDir: false });
  } catch (e) {
    throw raiseTrayUnavailable({ kind: "constructor", platform, cause: e });
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

    const timer = setTimeout(() => finish(), readinessMs);
    // 'exit' is emitted when the tray subprocess closes its stdout (the
    // library uses readline.on('close') to translate that to 'exit').
    (tray as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void })
      .on("exit", () => {
        clearTimeout(timer);
        finish(raiseTrayUnavailable({ kind: "early-exit", platform }));
      });
    tray!.onError((err) => {
      clearTimeout(timer);
      finish(raiseTrayUnavailable({
        kind: "early-exit",
        platform,
        cause: err,
      }));
    });

    // If the tray already exited synchronously (rare but possible), close
    // out the promise in the next microtask so callers always see a
    // settled result.
    queueMicrotask(() => {
      if (tray && tray.killed) {
        clearTimeout(timer);
        finish(raiseTrayUnavailable({ kind: "exited-immediately", platform }));
      }
    });
  });

  if (!settled || !tray) {
    // Defensive: should never reach here — the await above always settles.
    throw raiseTrayUnavailable({ kind: "readiness-timeout", platform });
  }

  tray.onError((err) => {
    // Post-init errors: log and keep going. We do not want a tray
    // subprocess crash to kill the CLI; the user can still run
    // `ok stop` from a terminal.
    process.stderr.write(`ok tray: ${err.message}\n`);
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
      process.stderr.write(`ok tray: menu handler failed: ${(e as Error).message}\n`);
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
// tray works whether invoked from bin/ok.ts (dev) or bin/ok.mjs
// (published).
export function defaultIconDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "assets", "tray");
}
