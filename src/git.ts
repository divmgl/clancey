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

/**
 * Comparison form for a repo name: case- and separator-insensitive. Lets `fifthdoor/gaia`,
 * `fifthdoor-gaia` (Grok worktree dirs) and `Fifthdoor/Gaia` all land on one key.
 */
export function slugRepo(s: string): string {
  return s.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The name-ish forms of a stored repo key, for loose matching: full key, basename, slug. */
export function repoAliases(key: string): string[] {
  const base = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
  const short = key.startsWith("/") ? null : key;
  return [...new Set([key, base, short, slugRepo(key), slugRepo(base)].filter(Boolean) as string[])];
}

/**
 * Canonical key for the repository a session ran in: `owner/name` when a remote is known,
 * otherwise the repo root path. Everything about a repo — main checkout, linked worktree,
 * subdirectory, and both URL forms of its remote — must collapse to this one value, or scope
 * filters silently return nothing and agents fall back to grepping disk.
 *
 * Directories that no longer exist (throwaway worktrees are the common case) can't be asked;
 * we walk up to the nearest surviving ancestor, and failing that match path segments against
 * repos we already know by slug (`…/worktrees/fifthdoor-gaia/…` → `fifthdoor/gaia`).
 */
export function canonicalRepo(cwd: string | null, knownKeys: readonly string[] = []): string | null {
  if (!cwd) return null;
  const abs = cwd.startsWith("~") ? path.join(process.env.HOME || "", cwd.slice(1)) : cwd;

  // Only an absolute path names a checkout. A short key like "fifthdoor/gaia" must not be walked:
  // every segment fails to exist, the walk lands on ".", and the answer becomes whatever repo the
  // process happens to be running in — which silently relabels other repos' history.
  if (path.isAbsolute(abs)) {
    for (let dir = abs; ; dir = path.dirname(dir)) {
      if (fs.existsSync(dir)) {
        const root = repoKey(dir);
        if (root) return remoteShortKey(root) ?? root;
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }

  const bySlug = new Map<string, string>();
  for (const key of knownKeys) {
    for (const alias of repoAliases(key)) bySlug.set(slugRepo(alias), key);
  }
  const segments = abs.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const hit = bySlug.get(slugRepo(segments[i]));
    if (hit) return hit;
    if (i > 0) {
      const pair = bySlug.get(slugRepo(`${segments[i - 1]}/${segments[i]}`));
      if (pair) return pair;
    }
  }

  return abs;
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

  // Loose name match against what's actually stored. Agents ask for `gaia`, `fifthdoor/gaia`
  // and `/Users/me/dev/gaia` interchangeably; all three should reach the same rows, and a bare
  // name should never be the reason a lookup comes back empty.
  const wanted = new Set([slugRepo(raw), ...[...keys].map(slugRepo)]);
  wanted.delete("");
  for (const known of knownRepos) {
    if (!known || keys.has(known)) continue;
    if (repoAliases(known).some((alias) => wanted.has(slugRepo(alias)))) keys.add(known);
  }

  return [...keys];
}
