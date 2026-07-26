import { isPidLockHeld, readPidLock, tryClaimPidLock } from "./file-lock.js";
import { resolveClanceyDir, watchLockPath } from "./paths.js";

export interface WatchLock {
  owned: boolean;
  release: () => void;
}

/**
 * Claim exclusive ownership of the watch indexer.
 *
 * `ensureWatchRunning` runs on every MCP client start, and clients start in bursts (one per
 * editor window), so the recovery path here is genuinely concurrent rather than theoretical.
 * The read-check-unlink-create sequence this used to do let two racers both conclude the owner
 * was dead and both end up "owning" the watcher — the second unlink deleting the first's fresh
 * lock file (CLA-4). `tryClaimPidLock` does the steal with an atomic rename instead.
 */
export function tryClaimWatchLock(lockFile?: string): WatchLock {
  return tryClaimPidLock(lockFile ?? watchLockPath(resolveClanceyDir()));
}

/** True when watch.lock names a live PID. */
export function isWatchLockHeld(lockFile?: string): boolean {
  return isPidLockHeld(lockFile ?? watchLockPath(resolveClanceyDir()));
}

/** PID written in the lock file, or null. */
export function readWatchLockPid(lockFile?: string): number | null {
  return readPidLock(lockFile ?? watchLockPath(resolveClanceyDir()));
}
