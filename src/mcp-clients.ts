import fs from "fs";
import path from "path";
import { isPidAlive } from "./pid.js";
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

function withRegistryFileLock(file: string, fn: () => void): void {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lock);
        } catch {
          // ignore
        }
      }
      return;
    } catch {
      // spin
      const wait = Atomics ? undefined : undefined;
      void wait;
      // busy-yield
      const end = Date.now() + 5;
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
  // Last resort without lock (tests / broken FS).
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
