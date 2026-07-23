import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Stable key for the repository containing `cwd`, identical across the main checkout and
 * all of its linked worktrees. `--git-common-dir` resolves to the main repo's `.git` for
 * every worktree, so its parent is the shared repo root. Returns null if not in a repo.
 */
export function repoKey(cwd: string): string | null {
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return commonDir ? path.dirname(commonDir) : null;
}

/** Current branch name (HEAD), or null if detached / not a repo. */
export function currentBranch(cwd: string): string | null {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch && branch !== "HEAD" ? branch : null;
}

/**
 * Parse `owner/name` from a git remote URL (ssh or https). Returns null if unrecognized.
 */
export function parseRemoteShortKey(remoteUrl: string): string | null {
  const u = remoteUrl.trim();
  // git@github.com:owner/name.git  or  ssh://git@host/owner/name.git
  const ssh = u.match(/(?:git@|ssh:\/\/(?:git@)?)([^:/]+)[:/](.+?)(?:\.git)?$/i);
  if (ssh) {
    const repoPath = ssh[2].replace(/\.git$/i, "").replace(/^\/+/, "");
    if (repoPath.includes("/")) return repoPath;
  }
  // https://github.com/owner/name.git
  const https = u.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/i);
  if (https) {
    const repoPath = https[1].replace(/\.git$/i, "").replace(/\/$/, "");
    if (repoPath.includes("/")) return repoPath;
  }
  return null;
}

/** Short `owner/name` from `origin` (or first remote) for a checkout path, or null. */
export function remoteShortKey(cwd: string): string | null {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const origin = git(cwd, ["remote", "get-url", "origin"]);
  if (origin) {
    const k = parseRemoteShortKey(origin);
    if (k) return k;
  }
  const remotes = git(cwd, ["remote"]);
  if (!remotes) return null;
  for (const name of remotes.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const url = git(cwd, ["remote", "get-url", name]);
    if (!url) continue;
    const k = parseRemoteShortKey(url);
    if (k) return k;
  }
  return null;
}

/** True when `s` looks like a short remote key (owner/name), not a filesystem path. */
export function looksLikeRemoteShortKey(s: string): boolean {
  if (!s || s.startsWith("/") || s.startsWith("~") || /^[A-Za-z]:[\\/]/.test(s)) return false;
  // exactly one slash separating two non-empty segments, no spaces
  return /^[^\s/]+\/[^\s/]+$/.test(s);
}

/**
 * Expand a user-supplied repo filter into all equivalent keys for SQL matching.
 * - Absolute (or existing) path → git root path + remote short key when available.
 * - Short `owner/name` → itself + any `knownRepos` paths whose origin maps to that key.
 */
export function expandRepoFilterKeys(
  repo: string,
  knownRepos: readonly string[] = [],
): string[] {
  const raw = repo.trim();
  if (!raw) return [];
  const keys = new Set<string>([raw]);

  // Path form: resolve git root + short key from remotes.
  const asPath = raw.startsWith("~")
    ? path.join(process.env.HOME || "", raw.slice(1))
    : raw;
  if (asPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(asPath) || fs.existsSync(asPath)) {
    const root = repoKey(asPath) ?? (fs.existsSync(asPath) ? path.resolve(asPath) : null);
    if (root) {
      keys.add(root);
      const short = remoteShortKey(root);
      if (short) keys.add(short);
    }
  }

  // Short key form: match known absolute roots that share this remote.
  if (looksLikeRemoteShortKey(raw)) {
    for (const known of knownRepos) {
      if (!known || known === raw) continue;
      if (known.startsWith("/") || fs.existsSync(known)) {
        const short = remoteShortKey(known);
        if (short === raw) {
          keys.add(known);
          const root = repoKey(known);
          if (root) keys.add(root);
        }
      }
      // Also accept exact short-key rows already stored as owner/name.
      if (known === raw) keys.add(known);
    }
  }

  return [...keys];
}
