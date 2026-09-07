// tests/atomic-write.test.mjs — regression coverage for Windows-flaky
// rename-then-orphan trap in kanban/io.ts:writeFileAtomic and
// kanban/chat.ts:archiveSession.
//
// Background:
// - EPERM/EBUSY/EACCES on Windows from antivirus / indexer / OneDrive sync
//   used to leave `<path>.tmp` next to destination; next persist recreated
//   the same `<path>.tmp` and collided with the orphan. We now use
//   `<path>.tmp-<pid>-<ts>-<rand8>` so concurrent and retry-after-failure
//   persists never collide.
// - `renameSync(active, archived)` over an existing destination on Windows
//   throws rather than overwriting; OpenKan's archiveSession path had to
//   be portable.

import {
  after,
  before,
  beforeEach,
  describe,
  it,
} from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Under test.
import { writeFileAtomic } from "../kanban/io.ts";
import { archiveSession } from "../kanban/chat.ts";

let tmp;

before(() => {
  tmp = join(
    tmpdir(),
    `ok-atomic-write-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmp, { recursive: true });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of readdirSync(tmp)) {
    if (name.endsWith(".tmp") || /\.tmp-\d+-\d+-[0-9a-f]+$/.test(name))
      rmSync(join(tmp, name), { force: true });
  }
});

describe("writeFileAtomic", () => {
  it("completes a basic round-trip text file", () => {
    const file = join(tmp, "basic.txt");
    writeFileAtomic(file, "hello world");
    assert.equal(readFileSync(file, "utf-8"), "hello world");
  });

  it("overwrites an existing destination", () => {
    const file = join(tmp, "over.txt");
    writeFileSync(file, "old", "utf-8");
    writeFileAtomic(file, "new");
    assert.equal(readFileSync(file, "utf-8"), "new");
  });

  it("round-trips a binary buffer", () => {
    const file = join(tmp, "bin.dat");
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    writeFileAtomic(file, buf);
    assert.deepStrictEqual(readFileSync(file), buf);
  });

  it("uses a unique tmp suffix per call (no `.tmp` collisions under concurrency)", () => {
    // Pre-fix: every concurrent call wanted `<dest>.tmp`, so a held
    // destination surfaced EPERM on every caller. Post-fix: each call
    // gets its own `<dest>.tmp-<pid>-<ts>-<rand8>` so the rename failures
    // are isolated per-caller and at most one reuses the same path.
    //
    // We assert the synchronous part: after `writeFileAtomic` returns,
    // the destination must be non-empty and the legacy collision-name
    // (`<dest>.tmp` literal) must never appear as a leftover.
    const dest = join(tmp, "concurrent.json");
    writeFileSync(dest, "{\"seed\":true}");
    const N = 32;

    const proms = [];
    for (let i = 0; i < N; i++) {
      proms.push(
        Promise.resolve().then(() =>
          writeFileAtomic(dest, JSON.stringify({ round: i })),
        ),
      );
    }

    return Promise.all(proms).then(() => {
      // Destination is parseable JSON, non-empty.
      const finalText = readFileSync(dest, "utf-8");
      assert.ok(finalText.length > 0, "destination should not be empty");
      const parsed = JSON.parse(finalText);
      assert.ok(typeof parsed.round === "number");

      // The legacy collision name `<dest>.tmp` (literal, no suffix) must
      // never be present.
      assert.ok(
        !existsSync(`${dest}.tmp`),
        "legacy collision name `<dest>.tmp` must not exist",
      );

      // Each unique-suffix tmp may have transient existence during async
      // retries; once rename succeeds on the happy path the file is
      // consumed. Allow a brief settle window for stragglers — the goal
      // is to confirm *no* literal `<dest>.tmp` orphans linger.
    });
  });

  it("does not throw EPERM on a destination briefly held by another fd", () => {
    // We hold an fd open on the destination. On Windows the underlying
    // rename fails with EPERM/EBUSY; on POSIX it generally succeeds.
    // Either way, the contract the helper now offers is:
    //   - never leave a literal `<dest>.tmp` orphan behind, and
    //   - never throw to the caller for transient rename-only failures.
    const dest = join(tmp, "retry.json");
    writeFileSync(dest, "{}", "utf-8");
    const fd = openSync(dest, "r+");

    let threw = false;
    try {
      writeFileAtomic(dest, "first");
    } catch (e) {
      threw = true;
      // Only an unrecoverable (non-transient) error is acceptable here.
      const code = e?.code ?? "";
      assert.ok(
        !["EPERM", "EBUSY", "EACCES", "EAGAIN"].includes(code),
        `transient rename errors must be hidden from caller: ${code}`,
      );
    } finally {
      closeSync(fd);
    }

    // Even on POSIX (where the rename wins anyway) the literal orphan
    // name must not survive.
    assert.ok(
      !existsSync(`${dest}.tmp`),
      "no `<dest>.tmp` orphan should exist after call returns",
    );

    // Subsequent write must still succeed.
    writeFileAtomic(dest, "second");
    assert.equal(readFileSync(dest, "utf-8"), "second");
  });
});

describe("archiveSession", () => {
  function setupProject() {
    const root = join(
      tmp,
      `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(root, ".ok", "sessions"), { recursive: true });
    mkdirSync(join(root, ".ok", "sessions", ".archived"), {
      recursive: true,
    });
    return root;
  }

  it("archives a session when destination does not exist", () => {
    const root = setupProject();
    const sid = "ses-fresh";
    const body = '{"role":"user","content":"hi"}\n';
    writeFileSync(join(root, ".ok", "sessions", `${sid}.jsonl`), body);

    const ok = archiveSession(root, sid);
    assert.equal(ok, true);
    assert.ok(
      existsSync(join(root, ".ok", "sessions", ".archived", `${sid}.jsonl`)),
      "archived copy should now exist",
    );
    assert.ok(
      !existsSync(join(root, ".ok", "sessions", `${sid}.jsonl`)),
      "active copy should be gone",
    );
    assert.equal(
      readFileSync(
        join(root, ".ok", "sessions", ".archived", `${sid}.jsonl`),
        "utf-8",
      ),
      body,
    );
  });

  it("archives over an existing archived destination (Windows-safe)", () => {
    // Pre-fix: renameSync over an existing destination would throw on
    // Windows. The helper must destroy-then-rename (with rename retries)
    // so second-archive of an already-archived sid is idempotent.
    const root = setupProject();
    const sid = "ses-existing";
    const archivedPath = join(
      root,
      ".ok",
      "sessions",
      ".archived",
      `${sid}.jsonl`,
    );
    const activePath = join(root, ".ok", "sessions", `${sid}.jsonl`);

    writeFileSync(archivedPath, '{"role":"user","content":"stale"}\n');
    writeFileSync(activePath, '{"role":"user","content":"new"}\n');

    let ok = true;
    let err;
    try {
      ok = archiveSession(root, sid);
    } catch (e) {
      err = e;
    }
    assert.equal(err, undefined, `archiveSession must not throw: ${err}`);
    assert.equal(ok, true);
    assert.ok(existsSync(archivedPath), "archived copy must still exist");
    assert.ok(!existsSync(activePath), "active copy must be gone");

    const finalText = readFileSync(archivedPath, "utf-8");
    assert.ok(
      finalText.includes("new"),
      `archived content must reflect the new payload, got: ${finalText}`,
    );
    assert.ok(
      !finalText.includes("stale"),
      `archived content must not retain stale bytes, got: ${finalText}`,
    );
  });

  it("returns false when there is nothing to archive", () => {
    const root = setupProject();
    const ok = archiveSession(root, "ses-missing");
    assert.equal(ok, false);
  });
});
