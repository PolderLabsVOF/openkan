// ok/lock.ts — per-task claim/heartbeat/release lock protocol.
//
// Locks are advisory JSON files under `.ok/locks/`. They prevent the
// most common multi-agent failure (two writers updating the same task
// at once) without requiring native fcntl or OS-level coordination.
//
// Protocol:
//   claim(id, owner, leaseMs) -> writes .ok/locks/<id>.lock with
//     {owner, leasedUntil}. If a lock already exists held by a *different*
//     non-expired owner, claim throws. If the existing owner is "us"
//     (same string), heartbeat semantics apply.
//   heartbeat(id, owner, leaseMs) -> same write, refreshes leasedUntil.
//     Throws if the lock is not held by `owner`.
//   release(id, owner) -> removes the lock if held by `owner`.
//   inspect(id) -> returns the current Lock | undefined.
//
// Expiration is checked against `now`. A lock whose `leasedUntil` is
// in the past is treated as if it didn't exist — another writer can
// claim it.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type OkPaths } from "./storage.ts";
import { nowIso } from "./ids.ts";

const DEFAULT_LEASE_MS = 60 * 60 * 1000;

export interface Lock {
  owner: string;
  leasedUntil: string;
  acquiredAt?: string;
}

export class LockHeldError extends Error {
  readonly currentOwner: string;
  readonly leasedUntil: string;
  constructor(currentOwner: string, leasedUntil: string) {
    super(`locked by ${currentOwner} until ${leasedUntil}`);
    this.name = "LockHeldError";
    this.currentOwner = currentOwner;
    this.leasedUntil = leasedUntil;
  }
}

export class LockNotHeldError extends Error {
  constructor(id: string, owner: string) {
    super(`lock for ${id} is not held by ${owner}`);
    this.name = "LockNotHeldError";
  }
}

function lockPath(p: OkPaths, id: string): string {
  if (!/^tsk-[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid task id for lock: ${id}`);
  return path.join(p.locksDir, `${id}.lock`);
}

export async function inspect(p: OkPaths, id: string): Promise<Lock | undefined> {
  try {
    const raw = await fs.readFile(lockPath(p, id), "utf-8");
    const obj = JSON.parse(raw) as Partial<Lock>;
    if (typeof obj.owner !== "string" || typeof obj.leasedUntil !== "string") return undefined;
    return {
      owner: obj.owner,
      leasedUntil: obj.leasedUntil,
      acquiredAt: typeof obj.acquiredAt === "string" ? obj.acquiredAt : undefined,
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
}

export function isExpired(lock: Lock, now: number = Date.now()): boolean {
  const t = Date.parse(lock.leasedUntil);
  if (Number.isNaN(t)) return true;
  return t <= now;
}

async function writeLockFile(filePath: string, body: Lock): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const data = JSON.stringify(body, null, 2);
  let fh: import("node:fs").promises.FileHandle | undefined;
  try {
    fh = await fs.open(tmp, "w");
    await fh.writeFile(data, "utf-8");
    await fh.sync();
  } finally {
    if (fh) await fh.close();
  }
  await fs.rename(tmp, filePath);
}

export interface ClaimOptions {
  leaseMs?: number;
  acquiredAt?: string;
}

/**
 * Acquire (or refresh) a lock for `id`. If the lock is absent, expired,
 * or already owned by `owner`, succeeds. If owned by a *different*
 * non-expired holder, throws `LockHeldError`.
 */
export async function claim(p: OkPaths, id: string, owner: string, opts: ClaimOptions = {}): Promise<Lock> {
  if (!owner) throw new Error("claim requires an owner");
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const filePath = lockPath(p, id);
  await fs.mkdir(p.locksDir, { recursive: true });

  const existing = await inspect(p, id);
  const now = Date.now();
  const target: Lock = {
    owner,
    leasedUntil: new Date(now + leaseMs).toISOString(),
    acquiredAt: existing?.owner === owner ? existing.acquiredAt ?? nowIso() : nowIso(),
  };

  if (existing && existing.owner !== owner && !isExpired(existing, now)) {
    throw new LockHeldError(existing.owner, existing.leasedUntil);
  }

  await writeLockFile(filePath, target);
  return target;
}

/**
 * Refresh an existing lock's lease. Throws if the lock is absent or
 * owned by a different owner.
 */
export async function heartbeat(p: OkPaths, id: string, owner: string, opts: ClaimOptions = {}): Promise<Lock> {
  const existing = await inspect(p, id);
  if (!existing || existing.owner !== owner) {
    throw new LockNotHeldError(id, owner);
  }
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const target: Lock = {
    owner,
    leasedUntil: new Date(Date.now() + leaseMs).toISOString(),
    acquiredAt: existing.acquiredAt ?? nowIso(),
  };
  await writeLockFile(lockPath(p, id), target);
  return target;
}

/**
 * Remove a lock owned by `owner`. No-op if not held by `owner`.
 * Returns true if the lock was removed.
 */
export async function release(p: OkPaths, id: string, owner: string): Promise<boolean> {
  const existing = await inspect(p, id);
  if (!existing) return false;
  if (existing.owner !== owner) return false;
  try {
    await fs.unlink(lockPath(p, id));
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  return true;
}

/**
 * Assert that the lock is either absent, expired, or owned by `owner`.
 * Used by task transitions that may have been pre-claimed.
 */
export async function assertUsable(p: OkPaths, id: string, owner: string): Promise<void> {
  const existing = await inspect(p, id);
  if (!existing || isExpired(existing)) return;
  if (existing.owner !== owner) {
    throw new LockHeldError(existing.owner, existing.leasedUntil);
  }
}
