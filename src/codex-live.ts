import fs from "fs";
import path from "path";
import { listCodexFiles, parseCodexJsonlLine, type CodexParseState, type ToolEvent } from "./parser.js";
import { repoKey } from "./git.js";
import { insertToolEvent, type Store } from "./store.js";
import { log, logError } from "./logger.js";
import { resolveClanceyDir } from "./paths.js";
import { isPidAlive } from "./pid.js";

interface FileState {
  offset: number;
  partial: string;
  codex: CodexParseState;
  mtimeMs: number;
}

/** Default: skip tail metadata recovery above this size (16–32MB range). */
export const DEFAULT_MAX_FILE_BYTES = 24 * 1024 * 1024;

/** Bounded tail window used to recover cwd/branch without a full-file read. */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

export const DEFAULT_LOCK_NAME = "codex-live.lock";

export interface CodexLiveOptions {
  pollMs?: number;
  listFiles?: () => Promise<string[]>;
  /** Skip tail metadata recovery when file size exceeds this (default 24MB). */
  maxFileBytes?: number;
  /** Max trailing bytes scanned for session_meta on prime (default 256KB). */
  tailBytes?: number;
  /** Cross-process lock path; only the owner starts the poller. */
  lockPath?: string;
  /**
   * When true (default for startCodexLiveCapture), claim the single-owner lock.
   * Unit tests that drive one capture set this false or pass a private lockPath.
   */
  requireLock?: boolean;
  /** Optional pre-claimed release hook (used by startCodexLiveCapture). */
  releaseLock?: () => void;
}

function sessionId(file: string): string {
  return path.basename(file, ".jsonl");
}

function resolveRepo(cwd: string | null): string | null {
  if (!cwd) return null;
  return fs.existsSync(cwd) ? repoKey(cwd) ?? cwd : cwd;
}

function insertEvent(db: Store, session: string, event: ToolEvent): void {
  insertToolEvent(db, {
    session,
    repo: resolveRepo(event.cwd),
    branch: event.branch,
    cwd: event.cwd,
    tool: event.tool,
    file: event.file,
    command: event.command,
    ts: event.timestamp || new Date().toISOString(),
    host: "codex",
  });
}

async function readSlice(file: string, start: number, endExclusive: number): Promise<string> {
  if (endExclusive <= start) return "";
  return await new Promise((resolve, reject) => {
    let out = "";
    const stream = fs.createReadStream(file, { encoding: "utf-8", start, end: endExclusive - 1 });
    stream.on("data", (chunk) => {
      out += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(out));
  });
}

function emptyCodex(): CodexParseState {
  return { cwd: null, branch: null };
}

export interface LiveCaptureLock {
  owned: boolean;
  release: () => void;
}

/**
 * Claim exclusive ownership of Codex live capture for this store directory.
 * Uses an exclusive lock file with stale-PID recovery so dead owners do not block forever.
 */
export function tryClaimCodexLiveLock(lockPath: string): LiveCaptureLock {
  const noop: LiveCaptureLock = { owned: false, release: () => {} };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const makeRelease = (): (() => void) => () => {
    try {
      const cur = fs.readFileSync(lockPath, "utf-8").trim();
      if (cur === String(process.pid)) fs.unlinkSync(lockPath);
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

  if (tryCreate()) return { owned: true, release: makeRelease() };

  // Stale lock from a dead process — reclaim once.
  try {
    const existing = Number(fs.readFileSync(lockPath, "utf-8").trim());
    if (!isPidAlive(existing)) {
      try {
        fs.unlinkSync(lockPath);
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

export function defaultCodexLiveLockPath(): string {
  return path.join(resolveClanceyDir(), DEFAULT_LOCK_NAME);
}

/**
 * Recover cwd/branch from a bounded tail of an existing transcript.
 * Never inserts tool events. Never reads more than `tailBytes`.
 * Skips recovery entirely when `fileSize > maxFileBytes`.
 */
export async function recoverCodexMetaFromTail(
  file: string,
  fileSize: number,
  opts: { maxFileBytes?: number; tailBytes?: number } = {},
): Promise<CodexParseState> {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const state = emptyCodex();
  if (fileSize <= 0) return state;
  if (fileSize > maxFileBytes) return state;

  const window = Math.min(tailBytes, fileSize);
  const tailStart = fileSize - window;
  const text = await readSlice(file, tailStart, fileSize);
  if (!text) return state;

  const lines = text.split(/\r?\n/);
  // Drop a leading partial line when the window did not start at byte 0.
  if (tailStart > 0 && lines.length > 0) lines.shift();

  for (const line of lines) {
    // parseCodexJsonlLine updates state.cwd/branch on session_meta; ignore tool events.
    parseCodexJsonlLine(line, state);
  }
  return state;
}

export class CodexLiveCapture {
  private readonly states = new Map<string, FileState>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private releaseLock: (() => void) | null;
  private active = false;

  constructor(
    private readonly db: Store,
    private readonly opts: CodexLiveOptions = {},
  ) {
    this.releaseLock = opts.releaseLock ?? null;
  }

  /** True after start() has primed and the poller is running. */
  get isActive(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    await this.primeExistingFiles();
    const pollMs = this.opts.pollMs ?? 2000;
    this.timer = setInterval(() => {
      void this.pollNow().catch((err) => logError("codex live poll failed", err));
    }, pollMs);
    this.timer.unref?.();
    this.active = true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.active = false;
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }
  }

  async pollNow(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const files = await this.files();
      for (const file of files) await this.ingestFile(file, !this.states.has(file));
    } finally {
      this.running = false;
    }
  }

  /** Exposed for tests: current byte offset tracked for a file. */
  trackedOffset(file: string): number | undefined {
    return this.states.get(file)?.offset;
  }

  /** Exposed for tests: recovered parse state for a file. */
  trackedMeta(file: string): CodexParseState | undefined {
    const s = this.states.get(file);
    return s ? { ...s.codex } : undefined;
  }

  private maxFileBytes(): number {
    return this.opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  private tailBytes(): number {
    return this.opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  }

  private async primeExistingFiles(): Promise<void> {
    const files = await this.files();
    for (const file of files) {
      try {
        await this.primeOne(file);
      } catch {
        // The transcript can move while Codex is writing/rotating; retry on the next poll.
      }
    }
  }

  /**
   * Record size/offset only; recover cwd/branch from a bounded tail when under the size cap.
   * Never inserts historical tool events. Never full-reads the file.
   */
  private async primeOne(file: string): Promise<void> {
    const stat = await fs.promises.stat(file);
    const codex = await recoverCodexMetaFromTail(file, stat.size, {
      maxFileBytes: this.maxFileBytes(),
      tailBytes: this.tailBytes(),
    });
    this.states.set(file, {
      offset: stat.size,
      partial: "",
      codex,
      mtimeMs: stat.mtimeMs,
    });
  }

  private files(): Promise<string[]> {
    return this.opts.listFiles ? this.opts.listFiles() : listCodexFiles();
  }

  private async ingestFile(file: string, firstSeen: boolean): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      this.states.delete(file);
      return;
    }

    // First time seeing a large file after start: prime (no historical replay).
    if (firstSeen && stat.size > this.maxFileBytes()) {
      await this.primeOne(file);
      return;
    }

    const state = this.states.get(file) ?? {
      offset: 0,
      partial: "",
      codex: emptyCodex(),
      mtimeMs: 0,
    };

    if (stat.size < state.offset) {
      // truncated/rotated
      state.offset = 0;
      state.partial = "";
      state.codex = emptyCodex();
    }

    // Pathological growth between polls: jump forward with a tail window, never full-read.
    if (stat.size - state.offset > this.maxFileBytes()) {
      state.offset = Math.max(0, stat.size - this.tailBytes());
      state.partial = "";
      state.codex = await recoverCodexMetaFromTail(file, stat.size, {
        maxFileBytes: Number.POSITIVE_INFINITY,
        tailBytes: this.tailBytes(),
      });
    }

    const text = await readSlice(file, state.offset, stat.size);
    state.offset = stat.size;
    state.mtimeMs = stat.mtimeMs;
    this.states.set(file, state);
    if (!text) return;

    const combined = state.partial + text;
    const lines = combined.split(/\r?\n/);
    state.partial = combined.endsWith("\n") || combined.endsWith("\r") ? "" : lines.pop() ?? "";

    const session = sessionId(file);
    for (const line of lines) {
      const parsed = parseCodexJsonlLine(line, state.codex);
      for (const event of parsed.toolEvents) insertEvent(this.db, session, event);
    }
  }
}

/**
 * Start Codex live capture if this process wins the single-owner lock.
 * Non-owners return null and do not poll or prime.
 */
export function startCodexLiveCapture(db: Store, opts: CodexLiveOptions = {}): CodexLiveCapture | null {
  const requireLock = opts.requireLock !== false;
  let releaseLock = opts.releaseLock;

  if (requireLock) {
    const lockPath = opts.lockPath ?? defaultCodexLiveLockPath();
    const claim = tryClaimCodexLiveLock(lockPath);
    if (!claim.owned) {
      log("Codex live capture: another instance owns the poller; this process is search-only");
      return null;
    }
    releaseLock = claim.release;
  }

  const watcher = new CodexLiveCapture(db, { ...opts, requireLock: false, releaseLock });
  void watcher.start().catch((err) => {
    logError("codex live capture failed to start", err);
    watcher.stop();
  });
  return watcher;
}
