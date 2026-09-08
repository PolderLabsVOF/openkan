// tests/tray-error-reporting.test.mts — regression tests for the tray
// subsystem's error reporting.
//
// Before this fix, the three failure modes in bin/tray.ts (missing-package,
// constructor, early-exit) collapsed into a single misdirected message that
// pointed users at `libappindicator` on every platform, even when the real
// cause was something else (missing systray binary, EACCES on the icon
// asset, etc.).
//
// These tests pin:
//   * the platform-aware hint returned by trayInitHint() for each kind+OS
//     combination the user-facing docs reference
//   * the full message built by buildTrayUnavailableMessage() includes both
//     the underlying cause AND the install hint
//   * raiseTrayUnavailable() emits a WARN line to stderr AND returns an
//     instance of TrayUnavailableError so the existing `instanceof` check
//     in ok/commands/serve.ts still triggers the background fallback
//   * createTray() with a stub loader propagates the underlying cause
//     message verbatim into the thrown TrayUnavailableError
//
// Tests run under `node --test --experimental-strip-types` like the rest of
// the suite.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Re-import under a relative path so the test runs from any cwd; the
// repository's `npm test` script invokes `node --test` from the repo root.
const TRAY_MODULE_PATH = new URL("../bin/tray.ts", import.meta.url).pathname;

interface TrayModule {
  TrayUnavailableError: typeof import("../bin/tray.ts").TrayUnavailableError;
  trayInitHint: typeof import("../bin/tray.ts").trayInitHint;
  buildTrayUnavailableMessage: typeof import("../bin/tray.ts").buildTrayUnavailableMessage;
  raiseTrayUnavailable: typeof import("../bin/tray.ts").raiseTrayUnavailable;
  createTray: typeof import("../bin/tray.ts").createTray;
}

async function loadTrayModule(): Promise<TrayModule> {
  return (await import(TRAY_MODULE_PATH)) as unknown as TrayModule;
}

interface CapturedStderr {
  text: string;
  restore(): void;
}

// Tap stderr for the duration of `fn` so tests can assert that
// raiseTrayUnavailable() emits the WARN line we expect. Returns a single
// text blob so test bodies can use one assertion call.
async function captureStderr<T>(fn: () => Promise<T> | T): Promise<{ value: T; stderr: CapturedStderr }> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = "";
  const captured: CapturedStderr = {
    get text() { return buffer; },
    restore() { process.stderr.write = original; },
  };
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    buffer += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return original(chunk as string | Uint8Array, ...(rest as []));
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, stderr: captured };
  } finally {
    captured.restore();
  }
}

describe("trayInitHint() — platform-aware install guidance", () => {
  it("missing-package hint is OS-independent and points at npm", async () => {
    const { trayInitHint } = await loadTrayModule();
    for (const platform of ["linux", "darwin", "win32", "freebsd", "aix"] as NodeJS.Platform[]) {
      const hint = trayInitHint("missing-package", platform);
      assert.match(hint, /npm install systray/, `platform=${platform}: ${hint}`);
      assert.doesNotMatch(hint, /libappindicator/i, `platform=${platform} should not mention libappindicator for a missing-package hint`);
    }
  });

  it("icon-missing hint recommends reinstalling OpenKan", async () => {
    const { trayInitHint } = await loadTrayModule();
    const hint = trayInitHint("icon-missing", "linux");
    assert.match(hint, /Reinstall OpenKan|bin\/assets\/tray/, hint);
  });

  it("constructor / early-exit hint on Linux names libappindicator", async () => {
    const { trayInitHint } = await loadTrayModule();
    for (const kind of ["constructor", "early-exit", "exited-immediately", "readiness-timeout"] as const) {
      const hint = trayInitHint(kind, "linux");
      assert.match(hint, /libappindicator/, `kind=${kind}: ${hint}`);
      assert.match(hint, /apt install libappindicator3-1/, `kind=${kind}: ${hint}`);
      assert.match(hint, /dnf install libappindicator-gtk3/, `kind=${kind}: ${hint}`);
    }
  });

  it("constructor / early-exit hint on macOS does NOT mention libappindicator", async () => {
    const { trayInitHint } = await loadTrayModule();
    const hint = trayInitHint("constructor", "darwin");
    assert.doesNotMatch(hint, /libappindicator/i, hint);
    assert.match(hint, /macOS/i, hint);
    assert.match(hint, /prebuilt binary/, hint);
  });

  it("constructor / early-exit hint on Windows does NOT mention libappindicator", async () => {
    const { trayInitHint } = await loadTrayModule();
    const hint = trayInitHint("early-exit", "win32");
    assert.doesNotMatch(hint, /libappindicator/i, hint);
    assert.match(hint, /Windows/i, hint);
  });
});

describe("buildTrayUnavailableMessage() — embeds cause and hint", () => {
  it("includes the underlying error message verbatim", async () => {
    const { buildTrayUnavailableMessage } = await loadTrayModule();
    const cause = new Error("Cannot find module 'systray'");
    const message = buildTrayUnavailableMessage({
      kind: "missing-package",
      platform: "linux",
      cause,
    });
    assert.match(message, /Cannot find module 'systray'/, message);
    // missing-package hint is npm install, not libappindicator
    assert.match(message, /npm install systray/, message);
  });

  it("falls back to kind label when no cause is supplied", async () => {
    const { buildTrayUnavailableMessage } = await loadTrayModule();
    const message = buildTrayUnavailableMessage({
      kind: "readiness-timeout",
      platform: "linux",
    });
    assert.match(message, /tray readiness check did not settle/, message);
    assert.match(message, /libappindicator/, message);
  });

  it("appends the extra annotation when supplied (icon-missing path)", async () => {
    const { buildTrayUnavailableMessage } = await loadTrayModule();
    const message = buildTrayUnavailableMessage({
      kind: "icon-missing",
      platform: "linux",
      extra: "/opt/openkan/bin/assets/tray/icon-default.png",
    });
    assert.match(message, /\/opt\/openkan\/bin\/assets\/tray\/icon-default\.png/, message);
    assert.match(message, /tray icon asset is missing/, message);
  });

  it("serialises non-Error cause values (e.g. strings) without throwing", async () => {
    const { buildTrayUnavailableMessage } = await loadTrayModule();
    const message = buildTrayUnavailableMessage({
      kind: "constructor",
      platform: "linux",
      cause: "spawn ENOENT",
    });
    assert.match(message, /spawn ENOENT/, message);
    assert.match(message, /libappindicator/, message);
  });
});

describe("raiseTrayUnavailable() — warn + throw semantics", () => {
  it("emits a WARN line to stderr AND returns a TrayUnavailableError", async () => {
    const { raiseTrayUnavailable, TrayUnavailableError } = await loadTrayModule();
    const cause = new Error("ENOENT on icon-default.png");
    const { value: err, stderr } = await captureStderr(() => {
      return raiseTrayUnavailable({ kind: "constructor", platform: "linux", cause });
    });
    assert.ok(err instanceof TrayUnavailableError, "must return TrayUnavailableError so serve.ts instanceof check still works");
    assert.match(err.message, /ENOENT on icon-default\.png/, err.message);
    assert.match(err.message, /libappindicator/, err.message);
    assert.match(stderr.text, /ok tray: WARN/, stderr.text);
    assert.match(stderr.text, /ENOENT on icon-default\.png/, stderr.text);
  });

  it("works without a cause", async () => {
    const { raiseTrayUnavailable, TrayUnavailableError } = await loadTrayModule();
    const { value: err, stderr } = await captureStderr(() => {
      return raiseTrayUnavailable({ kind: "early-exit", platform: "darwin" });
    });
    assert.ok(err instanceof TrayUnavailableError);
    assert.match(err.message, /tray subprocess exited before it was ready/, err.message);
    assert.match(err.message, /macOS/, err.message);
    assert.doesNotMatch(err.message, /libappindicator/i, err.message);
    assert.match(stderr.text, /ok tray: WARN/, stderr.text);
  });
});

describe("createTray() — propagates the underlying cause", () => {
  function writeIcons(dir: string): void {
    // Tiny 1x1 PNG. Enough to satisfy existsSync(); the test bypasses the
    // real constructor so the PNG bytes are never sent to the tray binary.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000100201b9ad40000000049454e44ae426082",
      "hex",
    );
    for (const name of ["icon-default.png", "icon-working.png", "icon-idle.png"]) {
      writeFileSync(join(dir, name), png);
    }
  }

  it("missing-package: throws TrayUnavailableError whose message embeds the underlying error", async () => {
    const { createTray, TrayUnavailableError } = await loadTrayModule();
    const dir = mkdtempSync(join(tmpdir(), "tray-err-test-"));
    try {
      writeIcons(dir);
      const { stderr } = await captureStderr(async () => {
        await assert.rejects(
          createTray({
            url: "http://127.0.0.1:9999",
            iconDir: dir,
            onOpen: () => {},
            onStatus: () => {},
            onStop: () => {},
            runtime: {
              platform: "linux",
              loadSysTray: async () => {
                throw new Error("Cannot find module 'systray'");
              },
            },
          }),
          (err: unknown) => {
            assert.ok(err instanceof TrayUnavailableError, "expected TrayUnavailableError");
            assert.match((err as Error).message, /Cannot find module 'systray'/, (err as Error).message);
            // missing-package hint is npm install, not libappindicator
            assert.match((err as Error).message, /npm install systray/, (err as Error).message);
            return true;
          },
        );
      });
      assert.match(stderr.text, /ok tray: WARN/, stderr.text);
      assert.match(stderr.text, /Cannot find module 'systray'/, stderr.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing-package on macOS does not surface libappindicator", async () => {
    const { createTray, TrayUnavailableError } = await loadTrayModule();
    const dir = mkdtempSync(join(tmpdir(), "tray-err-test-"));
    try {
      writeIcons(dir);
      await assert.rejects(
        createTray({
          url: "http://127.0.0.1:9999",
          iconDir: dir,
          onOpen: () => {},
          onStatus: () => {},
          onStop: () => {},
          runtime: {
            platform: "darwin",
            loadSysTray: async () => {
              throw new Error("ENOENT tray_darwin_release");
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof TrayUnavailableError);
          const msg = (err as Error).message;
          assert.match(msg, /ENOENT tray_darwin_release/, msg);
          assert.doesNotMatch(msg, /libappindicator/i, msg);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("icon-missing: throws TrayUnavailableError pointing at the missing path", async () => {
    const { createTray, TrayUnavailableError } = await loadTrayModule();
    const dir = mkdtempSync(join(tmpdir(), "tray-err-test-"));
    // NOTE: deliberately do NOT write icons so loadIconPngBase64 throws.
    try {
      await assert.rejects(
        createTray({
          url: "http://127.0.0.1:9999",
          iconDir: dir,
          onOpen: () => {},
          onStatus: () => {},
          onStop: () => {},
          runtime: {
            platform: "linux",
            loadSysTray: async () => (() => ({}) as unknown as new (opts: unknown) => never),
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof TrayUnavailableError);
          const msg = (err as Error).message;
          assert.match(msg, /tray icon asset is missing/, msg);
          assert.match(msg, /icon-idle\.png/, msg);
          assert.match(msg, /Reinstall OpenKan/, msg);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("constructor: throws TrayUnavailableError whose message embeds the underlying error", async () => {
    const { createTray, TrayUnavailableError } = await loadTrayModule();
    const dir = mkdtempSync(join(tmpdir(), "tray-err-test-"));
    try {
      writeIcons(dir);
      const { stderr } = await captureStderr(async () => {
        await assert.rejects(
          createTray({
            url: "http://127.0.0.1:9999",
            iconDir: dir,
            onOpen: () => {},
            onStatus: () => {},
            onStop: () => {},
            runtime: {
              platform: "linux",
              // Successful loader returns a ctor that throws synchronously,
              // which exercises the catch around `new SysTray(...)`.
              loadSysTray: async () => {
                return class {
                  constructor() {
                    throw new Error("Failed to load libappindicator: /usr/lib/libappindicator3.so.1: cannot open shared object file");
                  }
                } as unknown as new (opts: unknown) => never;
              },
            },
          }),
          (err: unknown) => {
            assert.ok(err instanceof TrayUnavailableError);
            const msg = (err as Error).message;
            assert.match(msg, /libappindicator3\.so\.1/, msg);
            assert.match(msg, /libappindicator/, msg);
            return true;
          },
        );
      });
      assert.match(stderr.text, /ok tray: WARN/, stderr.text);
      assert.match(stderr.text, /libappindicator3\.so\.1/, stderr.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("early-exit: emits the underlying exit error message verbatim", async () => {
    const { createTray, TrayUnavailableError } = await loadTrayModule();
    const dir = mkdtempSync(join(tmpdir(), "tray-err-test-"));
    try {
      writeIcons(dir);

      // Build a fake SysTray constructor that emits 'exit' asynchronously.
      // CRITICAL: The exit event MUST fire after the 'exit' listener is
      // registered, which happens in createTray() after new SysTray() returns.
      // Using setTimeout(0) ensures the listener is in place before the event.
      // The readiness window (50ms) is longer than the setTimeout(0) ~1ms,
      // so the exit always wins and triggers the early-exit error.
      function FakeSysTray(_opts: unknown) {
        // Store callbacks for event handlers
        let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
        let errorCb: ((err: Error) => void) | null = null;

        (this as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void }).on = (
          event: string,
          cb: (...args: unknown[]) => void,
        ) => {
          if (event === "exit") {
            exitCb = cb as typeof exitCb;
          }
        };
        (this as unknown as { onError: (cb: (err: Error) => void) => void }).onError = (
          cb: (err: Error) => void,
        ) => {
          errorCb = cb;
        };
        // onClick, onReady, onExit, sendAction, kill, killed: required by createTray
        (this as unknown as { onClick: (cb: (action: { seq_id: number; item: { title?: string; tooltip?: string } }) => void) => void }).onClick = () => {};
        (this as unknown as { onReady: (cb: () => void) => void }).onReady = () => {};
        (this as unknown as { onExit: (cb: (code: number | null, signal: string | null) => void) => void }).onExit = () => {};
        (this as unknown as { sendAction: (action: { type: string; menu?: unknown; item?: unknown }) => void }).sendAction = () => {};
        (this as unknown as { kill: () => void }).kill = () => {};
        Object.defineProperty(this, "killed", { value: false, writable: true });

        // Fire exit asynchronously so the listener registered by createTray
        // is in place before the event fires. This resolves the timing race
        // where the readiness timer could fire first if the exit were sync.
        setTimeout(() => {
          if (exitCb) exitCb(1, null);
        }, 0);
      }
      (FakeSysTray as unknown as { prototype: { killed: boolean } }).prototype.killed = false;

      let caughtError: unknown;
      const { stderr: stderrText } = await captureStderr(async () => {
        try {
          await createTray({
            url: "http://127.0.0.1:9999",
            iconDir: dir,
            onOpen: () => {},
            onStatus: () => {},
            onStop: () => {},
            runtime: {
              platform: "linux",
              readinessMs: 50, // longer than setTimeout(0), so exit wins
              loadSysTray: async () => FakeSysTray as unknown as new (opts: unknown) => never,
            },
          });
          assert.fail("createTray should have thrown");
        } catch (e) {
          caughtError = e;
          // Don't re-throw - we just want to capture stderr and assert
        }
      });

      assert.ok(caughtError instanceof TrayUnavailableError, `Expected TrayUnavailableError but got ${caughtError?.constructor?.name}: ${(caughtError as Error)?.message}`);
      const msg = (caughtError as Error).message;
      assert.match(msg, /tray subprocess exited before it was ready/, msg);
      assert.match(msg, /libappindicator/, msg);
      assert.match(stderrText.text, /ok tray: WARN/, stderrText.text);
      assert.match(stderrText.text, /tray subprocess exited before it was ready/, stderrText.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
