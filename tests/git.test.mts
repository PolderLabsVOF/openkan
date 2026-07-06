// tests/git.test.mts — unit tests for kanban/git.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "child_process";
import { isGitRepo, currentUser, listContributors, listCommits, attributeCommitsToTasks } from "../kanban/git.ts";

// Use a private HOME so git tests don't pick up the user's global ~/.gitconfig
const TEST_HOME = join(tmpdir(), `git-test-home-${Date.now()}`);

// Run a git command with TEST_HOME isolation; args are split so strings with spaces work correctly
function git(args: string[], cwd: string): string {
  const env = { ...process.env, HOME: TEST_HOME };
  return execSync(args.join(" "), { cwd, env, shell: "/bin/bash" }).toString();
}

describe("git", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    git(["git init"], tmp);
    git(["git config user.name Alice"], tmp);
    git(["git config user.email alice@example.com"], tmp);
    git(["git commit --allow-empty -m 'Initial commit'"], tmp);
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  describe("isGitRepo", () => {
    it("returns true for a git repo", () => {
      assert.strictEqual(isGitRepo(tmp), true);
    });
    it("returns false for a non-git directory", () => {
      const nonGit = join(tmpdir(), `non-git-${Date.now()}`);
      mkdirSync(nonGit, { recursive: true });
      try {
        assert.strictEqual(isGitRepo(nonGit), false);
      } finally {
        rmSync(nonGit, { force: true, recursive: true });
      }
    });
  });

  describe("currentUser", () => {
    it("reads git config user.name and user.email from local config", () => {
      const user = currentUser(tmp);
      assert.ok(user);
      assert.strictEqual(user.name, "Alice");
      assert.strictEqual(user.email, "alice@example.com");
    });

    it("returns null if no git config", () => {
      const bare = join(tmpdir(), `bare-${Date.now()}`);
      mkdirSync(bare, { recursive: true });
      git(["git init"], bare);
      // Explicitly do NOT set user.name/email
      const user = currentUser(bare);
      assert.strictEqual(user, null);
      rmSync(bare, { force: true, recursive: true });
    });
  });

  describe("listCommits + listContributors", () => {
    it("returns empty array when no commits", () => {
      const emptyTmp = join(tmpdir(), `empty-git-${Date.now()}`);
      mkdirSync(emptyTmp, { recursive: true });
      git(["git init"], emptyTmp);
      try {
        assert.deepStrictEqual(listCommits(emptyTmp), []);
        assert.deepStrictEqual(listContributors(emptyTmp), []);
      } finally {
        rmSync(emptyTmp, { force: true, recursive: true });
      }
    });

    it("lists commits with files", () => {
      writeFileSync(join(tmp, "foo.txt"), "hello");
      git(["git add foo.txt"], tmp);
      git(["git commit -m 'Add foo.txt'"], tmp);

      const commits = listCommits(tmp);
      // Filter to only the "Add foo.txt" commit (skip initial empty commit)
      const fooCommits = commits.filter(c => c.subject === "Add foo.txt");
      assert.ok(fooCommits.length >= 1);
      const commit = fooCommits[0];
      assert.deepStrictEqual(commit.files, ["foo.txt"]);
      assert.ok(commit.sha);
      assert.ok(commit.ts);
    });

    it("lists contributors", () => {
      writeFileSync(join(tmp, "foo.txt"), "hello");
      git(["git add foo.txt"], tmp);
      git(["git commit -m 'Add foo.txt'"], tmp);

      const contributors = listContributors(tmp);
      assert.strictEqual(contributors.length, 1);
      assert.strictEqual(contributors[0].name, "Alice");
      assert.strictEqual(contributors[0].email, "alice@example.com");
      assert.ok(contributors[0].commits >= 1);
    });
  });

  describe("attributeCommitsToTasks", () => {
    it("matches by exact file path", () => {
      mkdirSync(join(tmp, "src"), { recursive: true });
      writeFileSync(join(tmp, "src", "auth.ts"), "auth");
      git(["git add src/auth.ts"], tmp);
      git(["git commit -m 'Implement auth'"], tmp);

      const tasks = [{ id: "tsk-1", source: { path: "src/auth.ts", line: 1 } }];
      const result = attributeCommitsToTasks(tmp, tasks);
      const attributed = result.get("tsk-1");
      assert.ok(attributed);
      assert.strictEqual(attributed!.length, 1);
      assert.strictEqual(attributed![0].subject, "Implement auth");
    });

    it("matches by directory (file under same dir)", () => {
      mkdirSync(join(tmp, "src"), { recursive: true });
      writeFileSync(join(tmp, "src", "auth.ts"), "auth");
      writeFileSync(join(tmp, "src", "router.ts"), "router");
      git(["git add src/"], tmp);
      git(["git commit -m 'Add src files'"], tmp);

      const tasks = [{ id: "tsk-1", source: { path: "src/utils.ts", line: 1 } }];
      const result = attributeCommitsToTasks(tmp, tasks);
      const attributed = result.get("tsk-1");
      assert.ok(attributed!.length >= 1);
    });

    it("matches by task id in subject", () => {
      writeFileSync(join(tmp, "foo.txt"), "hello");
      git(["git add foo.txt"], tmp);
      git(["git commit -m 'Fix tsk-abc12345: auth regression'"], tmp);

      const tasks = [{ id: "tsk-abc12345" }];
      const result = attributeCommitsToTasks(tmp, tasks);
      const attributed = result.get("tsk-abc12345");
      assert.strictEqual(attributed!.length, 1);
    });

    it("matches by title keyword (min 8 chars)", () => {
      writeFileSync(join(tmp, "foo.txt"), "hello");
      git(["git add foo.txt"], tmp);
      git(["git commit -m 'Implement authentication module'"], tmp);

      // Title is >= 8 chars so it qualifies as a keyword; full title must appear in commit subject
      const tasks = [{ id: "tsk-1", title: "authentication module" }];
      const result = attributeCommitsToTasks(tmp, tasks);
      const attributed = result.get("tsk-1");
      assert.strictEqual(attributed!.length, 1);
    });

    it("returns empty arrays when git is unavailable", () => {
      const noGit = join(tmpdir(), `nogit-${Date.now()}`);
      mkdirSync(noGit, { recursive: true });
      try {
        const result = attributeCommitsToTasks(noGit, [{ id: "tsk-1" }]);
        assert.ok(result.get("tsk-1"));
        assert.deepStrictEqual(result.get("tsk-1"), []);
      } finally {
        rmSync(noGit, { force: true, recursive: true });
      }
    });
  });
});
