import { execFileSync } from "child_process";
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
