import fs from "fs";
import path from "path";
import os from "os";
import { log } from "./logger.js";

const LOCK_DIR = path.join(os.homedir(), ".clancey");
const LOCK_FILE = path.join(LOCK_DIR, "indexer.lock");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to become the indexer instance. Returns true if this process
 * acquired the lock (and should run indexing + watcher). Returns false
 * if another live Clancey instance already holds the lock.
 */
export function tryAcquireIndexerLock(): boolean {
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  } catch {
    // ignore
  }

  // Check existing lock
  try {
    const content = fs.readFileSync(LOCK_FILE, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (!isNaN(pid) && pid !== process.pid && isProcessAlive(pid)) {
      log(`Another Clancey indexer is running (PID ${pid}). This instance will be search-only.`);
      return false;
    }
    // Stale lock — previous process is dead
    log(`Removing stale lock from PID ${pid}`);
  } catch {
    // No lock file exists — we can take it
  }

  // Write our PID
  try {
    fs.writeFileSync(LOCK_FILE, `${process.pid}\n`);
    log(`Acquired indexer lock (PID ${process.pid})`);

    // Clean up lock on exit
    const cleanup = () => {
      try {
        const content = fs.readFileSync(LOCK_FILE, "utf-8").trim();
        if (parseInt(content, 10) === process.pid) {
          fs.unlinkSync(LOCK_FILE);
        }
      } catch {
        // ignore
      }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });

    return true;
  } catch (error) {
    log(`Failed to write lock file: ${error}`);
    return false;
  }
}
