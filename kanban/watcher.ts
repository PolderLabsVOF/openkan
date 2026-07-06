// OpenKan — filesystem watcher using Node's built-in fs.watch.

import { watch as fsWatch } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WatchEventKind = "change" | "rename" | "create" | "delete";

export interface WatchEvent {
  kind: WatchEventKind;
  path: string;      // relative to root
  absPath: string;   // absolute
  ts: string;        // ISO
}

export interface WatchOptions {
  root: string;                                // directory to watch (e.g. .openkan)
  debounceMs?: number;                         // default 100
  ignore?: (absPath: string) => boolean;      // additional ignores beyond defaults
}

// ─── Default ignore list ─────────────────────────────────────────────────────

const DEFAULT_IGNORED = [
  /server\.lock$/,
  /server\.pid$/,
  /server\.log$/,
  /changelog\.jsonl$/,
  /[/\\]node_modules[/\\]/,   // matches node_modules/ or node_modules\ anywhere in path
];

function defaultIgnore(absPath: string): boolean {
  const normalized = absPath.replace(/\\/g, "/"); // Windows path normalisation
  return DEFAULT_IGNORED.some(re => re.test(normalized)) || normalized.endsWith(".tmp");
}

// ─── AsyncIterable watcher ───────────────────────────────────────────────────

interface QueuedEvent {
  kind: WatchEventKind;
  absPath: string;
}

interface WatcherStats {
  started: number;
  delivered: number;
  filtered: number;
}

/**
 * An AsyncIterable that yields filesystem change events from one or more fs.watch
 * handles. Debouncing coalesces rapid write+rename bursts into single deliveries.
 */
class WatchEventIterable implements AsyncIterable<WatchEvent> {
  private readonly queue: QueuedEvent[] = [];
  private readonly root: string;
  private readonly debounceMs: number;
  private readonly ignoreFn: (absPath: string) => boolean;
  private readonly stats: WatcherStats;
  private readonly closed: () => boolean;
  private readonly closeWatchers: () => void;
  private resolveNext: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when close() is explicitly called — no more events accepted. */
  private done = false;
  /** Set when a consumer exits (return() called) — blocks new events but allows reuse. */
  private closing = false;

  constructor(
    root: string,
    debounceMs: number,
    ignoreFn: (absPath: string) => boolean,
    stats: WatcherStats,
    closed: () => boolean,
    closeWatchers: () => void,
  ) {
    this.root = root;
    this.debounceMs = debounceMs;
    this.ignoreFn = ignoreFn;
    this.stats = stats;
    this.closed = closed;
    this.closeWatchers = closeWatchers;
  }

  /** Called by fs.watch callbacks to enqueue an event. */
  pushEvent(kind: WatchEventKind, absPath: string): void {
    if (this.closed()) return;
    if (this.closing) return; // close() was called; no more events accepted
    this.stats.started += 1;
    if (this.ignoreFn(absPath)) { this.stats.filtered += 1; return; }
    this.queue.push({ kind, absPath });
    if (this.resolveNext) { this.resolveNext(); this.resolveNext = null; }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.queue.length === 0) return;
      if (this.resolveNext) { this.resolveNext(); this.resolveNext = null; }
    }, this.debounceMs);
  }

  async next(): Promise<IteratorResult<WatchEvent>> {
    // Always drain any pending events first.
    if (this.queue.length > 0) {
      const ev = this.queue.shift()!;
      this.stats.delivered += 1;
      return {
        done: false,
        value: {
          kind: ev.kind,
          path: relative(this.root, ev.absPath).replace(/\\/g, "/"),
          absPath: ev.absPath,
          ts: new Date().toISOString(),
        },
      };
    }
    if (this.done) return { done: true, value: undefined as unknown as WatchEvent };
    // Wait for next event.
    let resolveWait: (() => void) | null = null;
    const waitForEvent = new Promise<void>(r => { resolveWait = r; });
    this.resolveNext = () => { if (resolveWait) { resolveWait(); resolveWait = null; } };
    // Poll for done=true every 5ms so we don't wait forever on a closed watcher.
    const pollDone = setInterval(() => {
      if (this.done && resolveWait) { resolveWait(); resolveWait = null; }
    }, 5);
    await waitForEvent;
    clearInterval(pollDone);
    this.resolveNext = null;
    // Drain queue even if done=true (e.g., events arrived just before done was set).
    if (this.queue.length > 0) {
      const ev = this.queue.shift()!;
      this.stats.delivered += 1;
      return {
        done: false,
        value: {
          kind: ev.kind,
          path: relative(this.root, ev.absPath).replace(/\\/g, "/"),
          absPath: ev.absPath,
          ts: new Date().toISOString(),
        },
      };
    }
    // If closing (consumer exited), return done=true so for-await exits permanently.
    // If done=true (close() was called), also return done=true.
    return { done: this.closing || this.done, value: undefined as unknown as WatchEvent };
  }

  [Symbol.asyncIterator](): AsyncIterator<WatchEvent> {
    return this;
  }

  /** Called by for-await when the consumer exits (timeout or normal end). */
  async return?(): Promise<IteratorResult<WatchEvent>> {
    // Only permanently close if the queue is empty. If events are pending (e.g., a
    // debounced event arrived just before this return() call), keep the watcher
    // alive so the next consumer can drain them. Only close watchers if done=true.
    if (this.queue.length === 0) {
      this.closing = true; // block new events; watchers stay open until close()
    }
    if (this.resolveNext) { this.resolveNext(); this.resolveNext = null; }
    if (this.debounceTimer !== null) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    return { done: true, value: undefined as unknown as WatchEvent };
  }

  /** Mark iteration as permanently done and clean up watchers. */
  destroy(): void {
    this.done = true;
    this.closing = true;
    this.closeWatchers();
    if (this.resolveNext) { this.resolveNext(); this.resolveNext = null; }
    if (this.debounceTimer !== null) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }
}

// ─── Public watch() ───────────────────────────────────────────────────────────

export interface WatcherHandle {
  events: AsyncIterable<WatchEvent>;
  close(): void;
  stats: WatcherStats;
}

/**
 * Watch a directory for filesystem changes.
 *
 * Uses `fs.watch` with `recursive: true` on Linux/macOS. On Windows (where
 * recursive is not supported), falls back to a manual readdirRecursive walk
 * and watches each sub-directory individually.
 *
 * Events are debounced (default 100 ms) to coalesce rapid write+rename bursts.
 * A default filter ignores server.lock, server.pid, server.log, changelog.jsonl,
 * node_modules, and any .tmp file. Additional ignores can be passed via options.
 */
export function watch(options: WatchOptions): WatcherHandle {
  const root = isAbsolute(options.root) ? options.root : join(process.cwd(), options.root);
  const debounceMs = options.debounceMs ?? 100;
  const extraIgnore = options.ignore ?? (() => false);
  const ignoreFn = (absPath: string) => defaultIgnore(absPath) || extraIgnore(absPath);

  const stats: WatcherStats = { started: 0, delivered: 0, filtered: 0 };
  let closedFlag = false;

  function isClosed() { return closedFlag; }

  // ── Try recursive watch (Linux / macOS) ─────────────────────────────────────
  let recursiveWatchers: ReturnType<typeof fsWatch>[] = [];

  try {
    const w = fsWatch(root, { recursive: true, persistent: true }, () => {});
    recursiveWatchers = [w];
  } catch {
    recursiveWatchers = []; // not supported; use fallback
  }

  if (recursiveWatchers.length > 0) {
    // Recursive watch works.
    const watcher = recursiveWatchers[0];
    const iterable = new WatchEventIterable(
      root,
      debounceMs,
      ignoreFn,
      stats,
      isClosed,
      () => { for (const w of recursiveWatchers) w.close(); },
    );

    watcher.on("change", (eventName: string, filename: string | null) => {
      if (!filename || closedFlag) return;
      const kind: WatchEventKind = eventName === "rename" ? "rename" : "change";
      iterable.pushEvent(kind, join(root, filename));
    });

    watcher.on("error", () => { /* swallow */ });

    return {
      events: iterable,
      close() {
        closedFlag = true;
        iterable.destroy();
      },
      stats,
    };
  }

  // ── Fallback: manual recursive walk + per-directory watches (Windows) ───────
  const dirsToWatch: string[] = [root];

  function walkDirs(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === "node_modules") continue;
      const abs = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        dirsToWatch.push(abs);
        walkDirs(abs);
      }
    }
  }
  walkDirs(root);

  const perDirWatchers: ReturnType<typeof fsWatch>[] = [];
  const iterable = new WatchEventIterable(
    root,
    debounceMs,
    ignoreFn,
    stats,
    isClosed,
    () => { for (const w of perDirWatchers) w.close(); },
  );

  for (const dir of dirsToWatch) {
    try {
      const w = fsWatch(dir, (eventName: string, filename: string | null) => {
        if (!filename || closedFlag) return;
        const kind: WatchEventKind = eventName === "rename" ? "rename" : "change";
        iterable.pushEvent(kind, join(dir, filename));
      });
      w.on("error", () => { /* swallow */ });
      perDirWatchers.push(w);
    } catch { /* directory deleted between stat and watch */ }
  }

  return {
    events: iterable,
    close() {
      closedFlag = true;
      iterable.destroy();
    },
    stats,
  };
}
