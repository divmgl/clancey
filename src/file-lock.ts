import fs from "fs";
import path from "path";
import { isPidAlive } from "./pid.js";

export interface FileLock {
  owned: boolean;
  release: () => void;
}

const NOOP_LOCK: FileLock = { owned: false, release: () => {} };

/**
 * Block this thread for `ms` without burning a core.
 *
 * The registry lock is on synchronous call paths (heartbeat, reap) that cannot `await`, and the
 * previous `while (Date.now() < end) {}` spin pegged a core per waiter. `Atomics.wait` is a real
 * futex sleep and is permitted on Node's main thread.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Environments without SharedArrayBuffer: fall back to a bounded spin rather than not waiting.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/**
 * Claim an exclusive lock file stamped with the owner PID, reclaiming it if the owner is dead.
 *
 * The steal is a `rename`, not a `read`-then-`unlink`. Two processes recovering the same stale
 * lock could both see it dead and both unlink — the second unlink removing the *winner's* fresh
 * lock, handing ownership to both (CLA-4). `rename` is atomic, so only one racer moves the file;
 * the loser gets ENOENT. The post-rename liveness re-check covers the remaining ordering, where a
 * slow racer's rename lands after the winner has already written a new lock: it sees a live PID in
 * what it stole and puts it back.
 */
export function tryClaimPidLock(lockPath: string): FileLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const release = (): void => {
    try {
      if (fs.readFileSync(lockPath, "utf-8").trim() === String(process.pid)) fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  };

  const tryCreate = (): boolean => {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  if (tryCreate()) return { owned: true, release };

  let existing: number;
  try {
    existing = Number(fs.readFileSync(lockPath, "utf-8").trim());
  } catch {
    return NOOP_LOCK;
  }
  if (isPidAlive(existing)) return NOOP_LOCK;

  const claimed = `${lockPath}.claim.${process.pid}`;
  try {
    fs.renameSync(lockPath, claimed);
  } catch {
    // Another racer stole it first, or the owner released it — either way we are not the winner.
    return NOOP_LOCK;
  }

  let stolen = 0;
  try {
    stolen = Number(fs.readFileSync(claimed, "utf-8").trim());
  } catch {
    // ignore — treat unreadable as dead
  }
  if (isPidAlive(stolen)) {
    // We moved a live owner's lock out from under it. Put it back.
    try {
      fs.renameSync(claimed, lockPath);
    } catch {
      try {
        fs.unlinkSync(claimed);
      } catch {
        // ignore
      }
    }
    return NOOP_LOCK;
  }

  try {
    fs.unlinkSync(claimed);
  } catch {
    // ignore
  }
  return tryCreate() ? { owned: true, release } : NOOP_LOCK;
}

/** True when the lock file names a live PID. */
export function isPidLockHeld(lockPath: string): boolean {
  return isPidAlive(readPidLock(lockPath) ?? 0);
}

/** PID written in the lock file, or null when absent/unreadable/malformed. */
export function readPidLock(lockPath: string): number | null {
  try {
    const n = Number(fs.readFileSync(lockPath, "utf-8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
