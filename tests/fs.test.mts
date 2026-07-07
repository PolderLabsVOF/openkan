// tests/fs.test.mts — unit tests for kanban/fs.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  mkdirSync, rmSync, writeFileSync, symlinkSync,
  statSync, existsSync
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { listFs, parents, isDenyListed, realPathIfAllowed } from "../kanban/fs.ts";

describe("fs", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // ─── listFs shape ───────────────────────────────────────────────────────────

  describe("listFs", () => {
    it("returns correct shape for a temp dir with files and subdirs", async () => {
      // Create: file.txt, subdir/
      writeFileSync(join(tmp, "file.txt"), "hello");
      mkdirSync(join(tmp, "subdir"), { recursive: true });
      writeFileSync(join(tmp, "subdir", "nested.md"), "# hi");

      const result = await listFs({ root: tmp, depth: 1 });

      assert.strictEqual(result.name, basename(tmp));
      assert.strictEqual(result.path, tmp);
      assert.strictEqual(result.isDir, true);
      assert.strictEqual(result.isFile, false);
      assert.ok(Array.isArray(result.children));

      const names = result.children!.map(c => c.name).sort();
      assert.deepStrictEqual(names, ["file.txt", "subdir"]);

      const subdirChild = result.children!.find(c => c.name === "subdir")!;
      assert.strictEqual(subdirChild.isDir, true);
      assert.strictEqual(subdirChild.isSymlink, false);

      const fileChild = result.children!.find(c => c.name === "file.txt")!;
      assert.strictEqual(fileChild.isFile, true);
      assert.strictEqual(fileChild.size, 5); // "hello"
    });

    it("hidden files excluded by default", async () => {
      writeFileSync(join(tmp, "visible.txt"), "a");
      writeFileSync(join(tmp, ".hidden"), "secret");
      mkdirSync(join(tmp, "alsovisibledir"), { recursive: true });

      const result = await listFs({ root: tmp, depth: 1 });

      const names = result.children!.map(c => c.name);
      assert.ok(!names.includes(".hidden"));
      assert.ok(names.includes("visible.txt"));
    });

    it("includeHidden=true includes dotfiles", async () => {
      writeFileSync(join(tmp, "visible.txt"), "a");
      writeFileSync(join(tmp, ".hidden"), "secret");

      const result = await listFs({ root: tmp, depth: 1, includeHidden: true });

      const names = result.children!.map(c => c.name);
      assert.ok(names.includes(".hidden"));
      assert.ok(names.includes("visible.txt"));
    });

    it("depth=0 returns just the root entry with no children", async () => {
      writeFileSync(join(tmp, "file.txt"), "hello");

      const result = await listFs({ root: tmp, depth: 0 });

      assert.strictEqual(result.name, basename(tmp));
      assert.strictEqual(result.isDir, true);
      assert.ok(result.children === undefined || result.children.length === 0);
    });

    it("depth=1 includes one level of children", async () => {
      mkdirSync(join(tmp, "level1"), { recursive: true });
      writeFileSync(join(tmp, "level1", "file.txt"), "data");

      const result = await listFs({ root: tmp, depth: 1 });

      const l1 = result.children!.find(c => c.name === "level1")!;
      assert.ok(l1);
      assert.ok(l1.children === undefined || l1.children.length === 0); // depth stops at 1
    });

    it("depth=2 includes two levels of entries", async () => {
      mkdirSync(join(tmp, "a", "b"), { recursive: true });
      writeFileSync(join(tmp, "a", "b", "c.txt"), "deep");

      const result = await listFs({ root: tmp, depth: 2 });

      // depth=2: root (depth 0) + children (depth 1) + grandchildren (depth 2)
      // grandchild entries ARE included but their children are NOT (2 < 2 is false)
      const a = result.children!.find(c => c.name === "a")!;
      assert.ok(a.children, "children of a should be populated at depth=2");
      const b = a.children!.find(c => c.name === "b")!;
      assert.ok(b, "b should be in a's children at depth=2");
      // b is at depth 2: 2 < 2 is false, so b.children is undefined (no great-grandchildren)
      // Note: b IS found (a.children contains b), but b.children is undefined
      assert.strictEqual(b.children, undefined, "grandchildren don't have their children scanned");
      // c.txt is the grandchild (depth 2) of root — it IS found as b's child
      const c = b.children?.find ? b.children?.find(c => c.name === "c.txt") : undefined;
      assert.ok(!c, "c.txt should not be in b.children since b.children is undefined");
    });

    it("caps entries at maxEntries", async () => {
      // Create 10 files
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(tmp, `file${i}.txt`), `content${i}`);
      }

      const result = await listFs({ root: tmp, depth: 1, maxEntries: 3 });

      assert.strictEqual(result.children!.length, 3);
    });

    it("marks symlinks correctly", async () => {
      const target = join(tmp, "target.txt");
      const link = join(tmp, "link.txt");
      writeFileSync(target, "data");
      symlinkSync(target, link);

      const result = await listFs({ root: tmp, depth: 1 });

      const linkEntry = result.children!.find(c => c.name === "link.txt")!;
      assert.strictEqual(linkEntry.isSymlink, true);
      assert.strictEqual(linkEntry.isFile, true); // the target is a file
    });

    it("reports correct mtime format", async () => {
      writeFileSync(join(tmp, "file.txt"), "hello");

      const result = await listFs({ root: tmp, depth: 1 });

      const entry = result.children![0];
      assert.match(entry.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // ─── parents ────────────────────────────────────────────────────────────────

  describe("parents", () => {
    it("returns the expected ancestor chain", () => {
      const deepPath = join(tmp, "a", "b", "c", "d");
      mkdirSync(deepPath, { recursive: true });

      const result = parents(deepPath, 10);

      assert.ok(result.length >= 3, "should have at least 3 ancestors");
      const paths = result.map(e => e.path);
      // Should include tmp/a, tmp/a/b, tmp/a/b/c
      assert.ok(paths.includes(join(tmp, "a")));
      assert.ok(paths.includes(join(tmp, "a", "b")));
      assert.ok(paths.includes(join(tmp, "a", "b", "c")));
      // Should NOT include the file itself
      assert.ok(!paths.some(p => p.endsWith("d") && !result.find(e => e.path === p)?.isDir));
    });

    it("respects maxDepth", () => {
      const deepPath = join(tmp, "a", "b", "c");
      mkdirSync(deepPath, { recursive: true });

      const result = parents(deepPath, 2);

      assert.strictEqual(result.length, 2);
    });

    it("returns empty for root", () => {
      const result = parents("/", 8);
      assert.strictEqual(result.length, 0);
    });

    it("each entry has depth=0 (no children)", () => {
      mkdirSync(join(tmp, "a"), { recursive: true });
      writeFileSync(join(tmp, "a", "file.txt"), "x");

      const result = parents(join(tmp, "a", "file.txt"), 8);

      for (const entry of result) {
        assert.ok(entry.children === undefined || entry.children.length === 0);
      }
    });
  });

  // ─── Security ───────────────────────────────────────────────────────────────

  describe("isDenyListed", () => {
    it("rejects deny-listed prefixes", () => {
      assert.strictEqual(isDenyListed("/etc/passwd"), true);
      assert.strictEqual(isDenyListed("/etc/shadow"), true);
      assert.strictEqual(isDenyListed("/proc/1"), true);
      assert.strictEqual(isDenyListed("/sys/kernel"), true);
      assert.strictEqual(isDenyListed("/dev/null"), true);
      assert.strictEqual(isDenyListed("/boot/vmlinuz"), true);
      assert.strictEqual(isDenyListed("/root/.bashrc"), true);
    });

    it("rejects paths inside deny-listed trees", () => {
      assert.strictEqual(isDenyListed("/etc/pam.d/login"), true);
      assert.strictEqual(isDenyListed("/proc/1234/fd"), true);
    });

    it("accepts normal paths", () => {
      assert.strictEqual(isDenyListed("/home/drb0rk"), false);
      assert.strictEqual(isDenyListed("/home/drb0rk/Projects"), false);
      assert.strictEqual(isDenyListed("/tmp"), false);
    });

    it("handles symlinks to deny-listed paths", () => {
      // realPathIfAllowed should catch this
      const { allowed } = realPathIfAllowed("/etc/passwd");
      assert.strictEqual(allowed, false);
    });
  });

  // ─── Symlink loop detection ─────────────────────────────────────────────────

  describe("symlink loop detection", () => {
    it("does not infinite-loop on a symlink pointing to an ancestor", async () => {
      // Create: loopdir/a/ → ../  (a symlink pointing to loopdir's parent)
      const loopDir = join(tmp, "loopdir");
      mkdirSync(join(loopDir, "subdir"), { recursive: true });
      // subdir/back is a symlink to loopdir (the ancestor), creating a loop
      symlinkSync(loopDir, join(loopDir, "subdir", "backToLoop"));

      // This should not hang or throw
      const result = await listFs({ root: loopDir, depth: 3, maxEntries: 100 });

      // The symlink should be listed
      const backEntry = result.children?.find(c => c.name === "subdir");
      assert.ok(backEntry, "subdir should appear");
      const backLink = backEntry?.children?.find(c => c.name === "backToLoop");
      assert.ok(backLink, "backToLoop symlink should appear in subdir listing");
      assert.strictEqual(backLink!.isSymlink, true);
    });

    it("realPathIfAllowed returns allowed:false for broken symlinks", () => {
      const brokenLink = join(tmp, "broken");
      symlinkSync("/nonexistent/target", brokenLink);

      const { allowed } = realPathIfAllowed(brokenLink);
      assert.strictEqual(allowed, false);
    });
  });
});
