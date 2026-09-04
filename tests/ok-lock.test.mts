// tests/ok-lock.test.mts — claim / heartbeat / release semantics.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initIfMissing, paths } from "../ok/storage.ts";
import { claim, heartbeat, release, inspect, LockHeldError, LockNotHeldError, isExpired } from "../ok/lock.ts";

describe("ok/lock", () => {
  let root: string;
  let p: ReturnType<typeof paths>;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "ok-lock-"));
    p = await initIfMissing(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("claim writes a lock file with owner and leasedUntil", async () => {
    const lock = await claim(p, "tsk-lock01", "alice");
    assert.strictEqual(lock.owner, "alice");
    assert.ok(lock.acquiredAt);
    assert.ok(lock.leasedUntil);
    const got = await inspect(p, "tsk-lock01");
    assert.ok(got);
    assert.strictEqual(got!.owner, "alice");
  });

  it("same-owner claim refreshes lease (idempotent)", async () => {
    const before = await inspect(p, "tsk-lock01");
    await claim(p, "tsk-lock01", "alice", { leaseMs: 60_000 });
    const after = await inspect(p, "tsk-lock01");
    assert.ok(before && after);
    assert.notStrictEqual(before!.leasedUntil, after!.leasedUntil, "lease advanced");
  });

  it("different-owner claim is rejected", async () => {
    await assert.rejects(
      () => claim(p, "tsk-lock01", "bob"),
      (e: any) => e instanceof LockHeldError && e.currentOwner === "alice",
    );
  });

  it("expired lock can be claimed by a new owner", async () => {
    await claim(p, "tsk-lock02", "alice", { leaseMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const lock = await claim(p, "tsk-lock02", "bob");
    assert.strictEqual(lock.owner, "bob");
  });

  it("heartbeat refreshes an existing owner's lease", async () => {
    await claim(p, "tsk-lock03", "alice");
    const before = (await inspect(p, "tsk-lock03"))!;
    await new Promise((r) => setTimeout(r, 5));
    await heartbeat(p, "tsk-lock03", "alice", { leaseMs: 60_000 });
    const after = (await inspect(p, "tsk-lock03"))!;
    assert.strictEqual(after.owner, "alice");
    assert.notStrictEqual(before.leasedUntil, after.leasedUntil);
  });

  it("heartbeat by a non-owner throws", async () => {
    await assert.rejects(
      () => heartbeat(p, "tsk-lock03", "intruder"),
      (e: any) => e instanceof LockNotHeldError,
    );
  });

  it("release removes the lock when owner matches", async () => {
    await claim(p, "tsk-lock04", "alice");
    const removed = await release(p, "tsk-lock04", "alice");
    assert.strictEqual(removed, true);
    assert.strictEqual(await inspect(p, "tsk-lock04"), undefined);
  });

  it("release is no-op when owner does not match", async () => {
    await claim(p, "tsk-lock05", "alice");
    const removed = await release(p, "tsk-lock05", "bob");
    assert.strictEqual(removed, false);
    assert.strictEqual((await inspect(p, "tsk-lock05"))!.owner, "alice");
  });

  it("isExpired returns true for past timestamps", () => {
    assert.strictEqual(isExpired({ owner: "x", leasedUntil: "2000-01-01T00:00:00Z" }), true);
    assert.strictEqual(isExpired({ owner: "x", leasedUntil: "2999-01-01T00:00:00Z" }), false);
  });

  it("concurrent claim race — second claim rejected", async () => {
    await claim(p, "tsk-race", "alice");
    const result = await Promise.allSettled([
      claim(p, "tsk-race", "bob"),
      claim(p, "tsk-race", "carol"),
    ]);
    const rejected = result.filter((r) => r.status === "rejected");
    assert.strictEqual(rejected.length, 2);
  });
});
