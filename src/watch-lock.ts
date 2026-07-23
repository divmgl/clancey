import fs from "fs";
import path from "path";
import { isPidAlive } from "./pid.js";
import { resolveClanceyDir, watchLockPath } from "./paths.js";

export interface WatchLock {
  owned: boolean;
  release: () => void;
}

/**
 * Claim exclusive ownership of the watch indexer.
 * Stale-PID recovery matches Codex live lock behavior.
 */
export function tryClaimWatchLock(lockFile?: string): WatchLock {
  const lock = lockFile ?? watchLockPath(resolveClanceyDir());
  const noop: WatchLock = { owned: false, release: () => {} };
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  const makeRelease = (): (() => void) => () => {
    try {
      const cur = fs.readFileSync(lock, "utf-8").trim();
      if (cur === String(process.pid)) fs.unlinkSync(lock);
    } catch {
      // ignore
    }
  };

  const tryCreate = (): boolean => {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  if (tryCreate()) return { owned: true, release: makeRelease() };

  try {
    const existing = Number(fs.readFileSync(lock, "utf-8").trim());
    if (!isPidAlive(existing)) {
      try {
        fs.unlinkSync(lock);
      } catch {
        return noop;
      }
      if (tryCreate()) return { owned: true, release: makeRelease() };
    }
  } catch {
    return noop;
  }

  return noop;
}

/** True when watch.lock names a live PID. */
export function isWatchLockHeld(lockFile?: string): boolean {
  const lock = lockFile ?? watchLockPath(resolveClanceyDir());
  try {
    const existing = Number(fs.readFileSync(lock, "utf-8").trim());
    return isPidAlive(existing);
  } catch {
    return false;
  }
}

/** PID written in the lock file, or null. */
export function readWatchLockPid(lockFile?: string): number | null {
  const lock = lockFile ?? watchLockPath(resolveClanceyDir());
  try {
    const n = Number(fs.readFileSync(lock, "utf-8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
