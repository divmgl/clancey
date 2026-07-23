import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { openStore } from "./store.js";
import { backfill } from "./setup.js";
import { configureLogger, log, logError, setConsoleSilent } from "./logger.js";
import { listLiveMcpClients } from "./mcp-clients.js";
import { isWatchLockHeld, tryClaimWatchLock } from "./watch-lock.js";
import { resolveClanceyDir, resolveDbPath, watchLockPath, watchLogPath } from "./paths.js";

export const DEFAULT_WATCH_POLL_MS = 3_000;
/** Stay up briefly after start so a racing first register can land. */
export const DEFAULT_WATCH_START_GRACE_MS = 8_000;
/** Check client liveness more often than full ingest. */
export const DEFAULT_WATCH_CLIENT_CHECK_MS = 500;

export interface WatchOptions {
  dir?: string;
  pollMs?: number;
  startGraceMs?: number;
  clientCheckMs?: number;
  /** Injected for tests — default runs real backfill. */
  ingest?: (dbPath: string) => Promise<{ sessions: number }>;
  /** Injected sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Stop after this many loop iterations (tests). */
  maxIterations?: number;
  /** Override "should exit" for tests. */
  shouldStop?: () => boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Shipped ingest path used by `clancey watch`: incremental backfill of host transcripts.
 * Exported so tests drive the real entry (not a re-implemented insert).
 * Lifecycle tests set CLANCEY_WATCH_DRY=1 to skip a multi-minute full-world scan.
 */
export async function defaultWatchIngest(dbPath: string): Promise<{ sessions: number }> {
  if (process.env.CLANCEY_WATCH_DRY === "1") return { sessions: 0 };
  const db = openStore(dbPath);
  try {
    const stats = await backfill(db, { force: false });
    return { sessions: stats.sessions };
  } finally {
    db.close();
  }
}

async function defaultIngest(dbPath: string): Promise<{ sessions: number }> {
  return defaultWatchIngest(dbPath);
}

/**
 * Run the watch supervisor loop. Claims the watch lock or exits immediately if another
 * watch owns it. Exits when no live MCP clients remain (after start grace).
 * Logs only to the watch log file — never MCP stdio.
 */
export async function runWatch(opts: WatchOptions = {}): Promise<"exited-empty" | "not-owner" | "max-iterations"> {
  const dir = opts.dir ?? resolveClanceyDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = watchLockPath(dir);
  const claim = tryClaimWatchLock(lockFile);
  if (!claim.owned) return "not-owner";

  const logFile = watchLogPath(dir);
  configureLogger({ file: logFile });
  setConsoleSilent(true);

  const pollMs = opts.pollMs ?? DEFAULT_WATCH_POLL_MS;
  const graceMs = opts.startGraceMs ?? DEFAULT_WATCH_START_GRACE_MS;
  const clientCheckMs = opts.clientCheckMs ?? DEFAULT_WATCH_CLIENT_CHECK_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const ingest = opts.ingest ?? defaultIngest;
  const dbPath = resolveDbPath(dir);
  const started = Date.now();

  log(`watch started pid=${process.pid} dir=${dir}`);

  let iterations = 0;
  let lastIngest = 0;
  let stopping = false;
  const requestStop = (): void => {
    stopping = true;
  };
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);

  try {
    while (!stopping) {
      if (opts.shouldStop?.()) break;
      iterations++;

      const live = listLiveMcpClients({ dir });
      const pastGrace = Date.now() - started >= graceMs;
      if (live.length === 0 && pastGrace) {
        log("watch exiting: no live MCP clients");
        return "exited-empty";
      }

      const dueIngest = Date.now() - lastIngest >= pollMs;
      if (dueIngest) {
        try {
          const stats = await ingest(dbPath);
          lastIngest = Date.now();
          if (stats.sessions > 0) log(`watch ingest: ${stats.sessions} session unit(s) updated`);
        } catch (err) {
          logError("watch ingest failed", err);
          lastIngest = Date.now();
        }
      }

      if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) {
        return "max-iterations";
      }

      await sleep(clientCheckMs);
    }
    return "exited-empty";
  } finally {
    claim.release();
    log(`watch stopped pid=${process.pid}`);
  }
}

export interface EnsureWatchOptions {
  dir?: string;
  node?: string;
  entrypoint?: string;
  /** Extra env for the child (tests). */
  env?: NodeJS.ProcessEnv;
}

function currentEntrypoint(): string {
  const bin = process.argv[1];
  try {
    return fs.realpathSync(bin || fileURLToPath(import.meta.url));
  } catch {
    return bin || fileURLToPath(import.meta.url);
  }
}

/**
 * If no live watch holds the lock, spawn a detached `clancey watch` process.
 * Safe to call from every MCP start; spawn races resolve via the watch lock.
 */
export function ensureWatchRunning(opts: EnsureWatchOptions = {}): { spawned: boolean; reason: string } {
  const dir = opts.dir ?? resolveClanceyDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = watchLockPath(dir);
  if (isWatchLockHeld(lockFile)) {
    return { spawned: false, reason: "watch-lock-held" };
  }

  const node = opts.node ?? process.execPath;
  const entry = opts.entrypoint ?? currentEntrypoint();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    CLANCEY_HOME: dir,
  };

  try {
    const child = spawn(node, [entry, "watch", "--dir", dir], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    return { spawned: true, reason: `spawned-pid-${child.pid ?? "?"}` };
  } catch (err) {
    logError("ensureWatchRunning spawn failed", err);
    return { spawned: false, reason: "spawn-failed" };
  }
}

/** CLI entry for `clancey watch`. */
export async function runWatchCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`clancey watch — incremental transcript indexer (single instance)

Started automatically when an MCP server connects. You can also run it by hand.

Options:
  --dir <path>   Clancey data dir (default: $CLANCEY_HOME or ~/.clancey)
  -h, --help     Show this help

Logs to <dir>/watch.log. Exits when no MCP clients are registered.
`);
    return;
  }

  let dir = resolveClanceyDir();
  const dirIdx = argv.indexOf("--dir");
  if (dirIdx !== -1 && argv[dirIdx + 1]) dir = path.resolve(argv[dirIdx + 1]);

  process.env.CLANCEY_HOME = dir;
  const result = await runWatch({ dir });
  if (result === "not-owner") {
    // Another watch is alive — quiet exit for spawn races.
    process.exitCode = 0;
    return;
  }
}
