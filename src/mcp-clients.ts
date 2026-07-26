import fs from "fs";
import path from "path";
import { isPidAlive } from "./pid.js";
import { readPidLock, sleepSync, tryClaimPidLock } from "./file-lock.js";
import { log } from "./logger.js";
import { mcpClientsPath, resolveClanceyDir } from "./paths.js";

export interface McpClientRecord {
  pid: number;
  startedAt: string;
  lastBeat: string;
}

export interface McpClientsFile {
  clients: Record<string, McpClientRecord>;
}

/** Heartbeats older than this (ms) are stale even if the PID still looks alive. */
export const DEFAULT_HEARTBEAT_TTL_MS = 20_000;

export interface RegistryOptions {
  dir?: string;
  /** Override clock for tests. */
  nowMs?: () => number;
  ttlMs?: number;
}

function nowIso(nowMs: () => number): string {
  return new Date(nowMs()).toISOString();
}

function emptyFile(): McpClientsFile {
  return { clients: {} };
}

function readFile(file: string): McpClientsFile {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as McpClientsFile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.clients !== "object" || !parsed.clients) {
      return emptyFile();
    }
    return parsed;
  } catch {
    return emptyFile();
  }
}

function writeFileAtomic(file: string, data: McpClientsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Total time a caller will wait for the registry lock before giving up on it. */
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Delete `${file}.<pid>.tmp` files whose owning PID is gone.
 *
 * `writeFileAtomic` writes a PID-named temp and renames it into place; a process killed between
 * those two steps leaves the temp behind forever. Every MCP client heartbeats, so the leak is
 * unbounded over time. The sweep is a directory scan, so it runs only on registration and when a
 * caller actually has to wait for the lock — never on the uncontended heartbeat path.
 */
function sweepOrphanedTemps(file: string): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
    const pid = Number(entry.slice(prefix.length, -".tmp".length));
    if (!Number.isInteger(pid) || pid <= 0 || isPidAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
    } catch {
      // ignore — another sweeper won the race
    }
  }
}

/**
 * Run `fn` while holding the registry lock, waiting in real sleeps for a live holder to finish.
 *
 * Two things made the old implementation actively harmful (CLA-3). The lock file was zero-byte
 * with no owner recorded and no stale recovery, so a process killed while holding it left a lock
 * nobody could ever clear; and waiters burned a core in `while (Date.now() < end) {}`. Together
 * that meant every caller — `listLiveMcpClients` runs every 500ms in watch, plus one heartbeat
 * per MCP client — spun a full CPU for five seconds and then ran unlocked anyway. The lock now
 * carries the owner PID so `tryClaimPidLock` can reclaim it from a dead holder, and waiting is a
 * futex sleep.
 */
function withRegistryFileLock(file: string, fn: () => void): void {
  const lockPath = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let swept = false;
  let backoffMs = 5;
  for (;;) {
    const lock = tryClaimPidLock(lockPath);
    if (lock.owned) {
      try {
        fn();
      } finally {
        lock.release();
      }
      return;
    }
    if (Date.now() >= deadline) break;
    if (!swept) {
      // We are contended, which is also the only cheap moment to notice leaked temps.
      swept = true;
      sweepOrphanedTemps(file);
    }
    sleepSync(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 25);
  }

  // Last resort without the lock. A live owner held it for the entire timeout (or the FS refuses
  // to give us one), and dropping the write entirely would silently lose a registration; log it,
  // because before this the registry degraded to no locking without a trace.
  log(
    `mcp-clients: registry lock at ${lockPath} unavailable after ${LOCK_TIMEOUT_MS}ms ` +
      `(holder pid ${readPidLock(lockPath) ?? "unknown"}); proceeding unlocked`,
  );
  fn();
}

function mutate(file: string, fn: (data: McpClientsFile) => void): McpClientsFile {
  let data = emptyFile();
  withRegistryFileLock(file, () => {
    data = readFile(file);
    fn(data);
    writeFileAtomic(file, data);
  });
  return data;
}

/** Register this process as a live MCP client. Returns the client id. */
export function registerMcpClient(opts: RegistryOptions = {}): string {
  const dir = opts.dir ?? resolveClanceyDir();
  const file = mcpClientsPath(dir);
  const nowMs = opts.nowMs ?? Date.now;
  const id = `${process.pid}-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ts = nowIso(nowMs);
  // Once per process, not once per heartbeat: clears temps leaked by clients that were killed
  // mid-write in a previous run.
  sweepOrphanedTemps(file);
  mutate(file, (data) => {
    data.clients[id] = { pid: process.pid, startedAt: ts, lastBeat: ts };
  });
  return id;
}

/** Touch lastBeat for a registered client. */
export function heartbeatMcpClient(id: string, opts: RegistryOptions = {}): boolean {
  const dir = opts.dir ?? resolveClanceyDir();
  const file = mcpClientsPath(dir);
  const nowMs = opts.nowMs ?? Date.now;
  let ok = false;
  mutate(file, (data) => {
    const row = data.clients[id];
    if (!row) return;
    row.lastBeat = nowIso(nowMs);
    ok = true;
  });
  return ok;
}

/** Remove a client registration (best-effort on shutdown). */
export function unregisterMcpClient(id: string, opts: RegistryOptions = {}): void {
  const dir = opts.dir ?? resolveClanceyDir();
  const file = mcpClientsPath(dir);
  mutate(file, (data) => {
    delete data.clients[id];
  });
}

/**
 * Drop dead PIDs and expired heartbeats; return the remaining live client ids.
 */
export function reapMcpClients(opts: RegistryOptions = {}): string[] {
  const dir = opts.dir ?? resolveClanceyDir();
  const file = mcpClientsPath(dir);
  const nowMs = opts.nowMs ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  const now = nowMs();
  const live: string[] = [];
  mutate(file, (data) => {
    for (const [id, row] of Object.entries(data.clients)) {
      const beat = Date.parse(row.lastBeat);
      const staleBeat = !Number.isFinite(beat) || now - beat > ttlMs;
      if (!isPidAlive(row.pid) || staleBeat) {
        delete data.clients[id];
        continue;
      }
      live.push(id);
    }
  });
  return live;
}

/** Live clients after a reap (ids only). */
export function listLiveMcpClients(opts: RegistryOptions = {}): string[] {
  return reapMcpClients(opts);
}

/** Test helper: read raw registry without reaping. */
export function readMcpClientsRaw(opts: RegistryOptions = {}): McpClientsFile {
  const dir = opts.dir ?? resolveClanceyDir();
  return readFile(mcpClientsPath(dir));
}
