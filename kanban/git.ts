// OpenKan — pure git utilities (read-only).

import { existsSync } from "node:fs";
import { spawnSync } from "child_process";

const GIT_TIMEOUT_MS = 5000;

function git(args: string[], root: string): string {
  try {
    const result = spawnSync("git", args, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf-8",
      shell: false,
    });
    if (result.error || result.status !== 0) return "";
    return (result.stdout ?? "") as string;
  } catch {
    return "";
  }
}

export interface GitContributor {
  name: string;
  email: string;
  commits: number;
  firstSeen: string;   // ISO
  lastSeen: string;    // ISO
  linesAdded: number;
  linesDeleted: number;
}

export interface GitCommit {
  sha: string;
  author: string;
  email: string;
  ts: string;          // ISO
  subject: string;
  body: string;
  files: string[];     // paths touched (relative to repo root)
}

export interface CurrentGitUser {
  name: string;
  email: string;
}

// ─── Basic checks ──────────────────────────────────────────────────────────

export function isGitRepo(root: string): boolean {
  try {
    const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf-8",
    });
    return (result.stdout ?? "").trim() === "true";
  } catch {
    return false;
  }
}

export function currentUser(root: string): CurrentGitUser | null {
  // Read ONLY local config to avoid inheriting from global ~/.gitconfig
  const name = git(["config", "--local", "user.name"], root).trim();
  const email = git(["config", "--local", "user.email"], root).trim();
  if (!name || !email) return null;
  return { name, email };
}

// ─── Contributors ──────────────────────────────────────────────────────────

export function listContributors(
  root: string,
  opts?: { since?: string; until?: string; maxCount?: number },
): GitContributor[] {
  // Use git log to enumerate commits with author info, then group by email
  const args = ["log", "--no-merges", "--format=%aI|%an|%ae", "--use-mailmap"];
  if (opts?.since) args.push(`--since=${opts.since}`);
  if (opts?.until) args.push(`--until=${opts.until}`);
  if (opts?.maxCount) args.push(`--max-count=${opts.maxCount}`);

  const output = git(args, root);
  if (!output) return [];

  // Group by email
  const byEmail = new Map<string, { name: string; emails: Set<string>; dates: string[] }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("|");
    if (idx === -1) continue;
    const ts = trimmed.slice(0, idx);
    const rest = trimmed.slice(idx + 1);
    const nidx = rest.indexOf("|");
    if (nidx === -1) continue;
    const name = rest.slice(0, nidx);
    const email = rest.slice(nidx + 1);
    if (!byEmail.has(email)) {
      byEmail.set(email, { name, emails: new Set([email]), dates: [] });
    }
    byEmail.get(email)!.dates.push(ts);
  }

  const contributors: GitContributor[] = [];
  for (const [email, info] of byEmail) {
    const dates = info.dates.sort();
    contributors.push({
      name: info.name,
      email,
      commits: info.dates.length,
      firstSeen: dates[0] ?? new Date(0).toISOString(),
      lastSeen: dates[dates.length - 1] ?? new Date().toISOString(),
      linesAdded: 0,
      linesDeleted: 0,
    });
  }

  return contributors;
}

// ─── Commits ────────────────────────────────────────────────────────────────

export function listCommits(
  root: string,
  opts?: { since?: string; until?: string; maxCount?: number; author?: string },
): GitCommit[] {
  // Format: each commit is preceded by --OPENKAN-SEP-- on its own line.
  // Per commit: sha\nauthor\nemail\niso\nsubject\nbody\nfilename1\nfilename2\n
  // Since --pretty=format with %b outputs nothing when body is empty, the
  // number of header lines varies. We use --OPENKAN-SEP-- as an anchor:
  // --OPENKAN-SEP--\nSHA\nAN\nAE\nTS\nSUBJECT\n%B\nFILES...\n\n
  // But %b with empty body still consumes a \n, so files appear 6 lines after SHA
  // regardless of whether body is empty. Use this invariant to extract files.
  const SEP = "--OPENKAN-SEP";
  const args = [
    "log",
    `--pretty=format:${SEP}%n%H%n%an%n%ae%n%aI%n%s%n%b`,
    "--name-only",
    "--no-merges",
  ];
  if (opts?.since) args.push(`--since=${opts.since}`);
  if (opts?.until) args.push(`--until=${opts.until}`);
  if (opts?.maxCount) args.push(`--max-count=${opts.maxCount}`);
  if (opts?.author) args.push(`--author=${opts.author}`);

  const output = git(args, root);
  if (!output) return [];

  // Split into commit records: "SEP\nSHA\nAN\nAE\nTS\nSUBJECT\n%B\nFILE1\nFILE2\n\n"
  const SEP_PATTERN = `${SEP}\n`;
  const rawRecords = output.split(SEP_PATTERN).filter(r => r.trim());
  const commits: GitCommit[] = [];

  for (const raw of rawRecords) {
    const lines = raw.split("\n");
    if (lines.length < 6) continue;

    // sha at lines[0], author at [1], email at [2], ts at [3], subject at [4]
    // %b output at [5] (empty string if no body), then files from [6] onward
    // until first empty line (blank separator between commits)
    const sha = lines[0];
    const author = lines[1];
    const email = lines[2];
    const ts = lines[3];
    const subject = lines[4];
    // body is lines[5] (may be empty string) — we use it as-is
    const body = lines[5] ?? "";

    // Files: lines[6] onward, until first empty string (blank line between records)
    const fileLines: string[] = [];
    for (let i = 6; i < lines.length; i++) {
      if (lines[i] === "") break;
      fileLines.push(lines[i]);
    }

    commits.push({ sha, author, email, ts, subject, body, files: fileLines });
  }

  return commits;
}

// ─── Commit-to-task attribution ────────────────────────────────────────────

export function attributeCommitsToTasks(
  root: string,
  tasks: Array<{ id: string; title?: string; source?: { path: string; line: number } }>,
  opts?: { since?: string; maxCount?: number },
): Map<string, Array<{ sha: string; author: string; email: string; ts: string; subject: string; files: string[] }>> {
  const result = new Map<string, Array<{ sha: string; author: string; email: string; ts: string; subject: string; files: string[] }>>();

  const commits = listCommits(root, { since: opts?.since, maxCount: opts?.maxCount });

  for (const task of tasks) {
    result.set(task.id, []);
  }

  for (const commit of commits) {
    for (const task of tasks) {
      let matched = false;

      // 1. Exact file match
      if (task.source?.path) {
        if (commit.files.includes(task.source.path)) {
          matched = true;
        } else {
          // 2. Commit touches a file under the same directory
          const taskDir = task.source.path.replace(/\/[^/]+$/, ""); // parent dir
          if (taskDir && commit.files.some(f => f.startsWith(taskDir + "/"))) {
            matched = true;
          }
        }
      }

      // 3. Subject or body contains task id (tsk-xxxxxxxx)
      if (!matched && task.id) {
        if (commit.subject.includes(task.id) || commit.body.includes(task.id)) {
          matched = true;
        }
      }

      // 4. Subject or body contains title (case-insensitive, min 8 chars)
      if (!matched && task.title && task.title.length >= 8) {
        const lc = task.title.toLowerCase();
        if (commit.subject.toLowerCase().includes(lc) || commit.body.toLowerCase().includes(lc)) {
          matched = true;
        }
      }

      if (matched) {
        result.get(task.id)!.push({
          sha: commit.sha,
          author: commit.author,
          email: commit.email,
          ts: commit.ts,
          subject: commit.subject,
          files: commit.files,
        });
      }
    }
  }

  return result;
}
