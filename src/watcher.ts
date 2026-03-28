import chokidar, { type FSWatcher } from "chokidar";
import { getConversationWatchDirs } from "./parser.js";
import { ConversationDB } from "./db.js";
import { log, logError } from "./logger.js";
import path from "path";
import fs from "fs";

// Don't re-index the same file more than once per 5 minutes
const REINDEX_COOLDOWN_MS = 5 * 60 * 1000;

export class ConversationWatcher {
  private db: ConversationDB;
  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastIndexedAt: Map<string, number> = new Map(); // filePath -> Date.now() of last index

  constructor(db: ConversationDB) {
    this.db = db;
  }

  start(): void {
    const watchDirs = getConversationWatchDirs();
    if (watchDirs.length === 0) {
      log("No conversation directories found to watch.");
      return;
    }

    log(`Watching ${watchDirs.join(", ")} for changes...`);

    this.watcher = chokidar.watch(watchDirs, {
      // Ignore hidden files by basename only. Using full-path dot matching would
      // exclude everything under hidden roots like ~/.claude.
      ignored: (watchedPath, stats) =>
        !stats?.isDirectory() && path.basename(watchedPath).startsWith("."),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000, // Wait 2s after last write
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (filePath) => this.handleChange(filePath));
    this.watcher.on("change", (filePath) => this.handleChange(filePath));
  }

  private handleChange(filePath: string): void {
    // Only care about .jsonl files
    if (!filePath.endsWith(".jsonl")) return;

    // Skip if already being indexed
    if (this.db.isIndexing(filePath)) return;

    // Debounce: wait for writes to settle
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);

      // Re-check after debounce - may have been picked up by indexAll
      if (this.db.isIndexing(filePath)) return;

      // Check mtime — skip if file hasn't changed since last index
      try {
        const stat = await fs.promises.stat(filePath);
        const lastIndexed = this.db.getLastIndexedMtime(filePath);
        if (lastIndexed !== undefined && lastIndexed >= stat.mtimeMs) return;
      } catch {
        return; // File may have been deleted
      }

      // Cooldown — don't re-index the same file more than once per 5 minutes
      const lastRun = this.lastIndexedAt.get(filePath);
      if (lastRun !== undefined && Date.now() - lastRun < REINDEX_COOLDOWN_MS) return;

      log(`Re-indexing ${path.basename(filePath)}...`);

      try {
        const stats = await this.db.indexFile(filePath);
        this.lastIndexedAt.set(filePath, Date.now());
        if (stats.added > 0) {
          log(`Added ${stats.added} chunks from ${path.basename(filePath)}`);
        }
      } catch (error) {
        logError(`Error indexing ${filePath}`, error);
      }
    }, 3000); // Wait 3s after last change

    this.debounceTimers.set(filePath, timer);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
