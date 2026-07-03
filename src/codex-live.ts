import fs from "fs";
import path from "path";
import { listCodexFiles, parseCodexJsonlLine, type CodexParseState, type ToolEvent } from "./parser.js";
import { repoKey } from "./git.js";
import { insertToolEvent, type Store } from "./store.js";
import { logError } from "./logger.js";

interface FileState {
  offset: number;
  partial: string;
  codex: CodexParseState;
}

export interface CodexLiveOptions {
  pollMs?: number;
  listFiles?: () => Promise<string[]>;
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

export class CodexLiveCapture {
  private readonly states = new Map<string, FileState>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Store,
    private readonly opts: CodexLiveOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.primeExistingFiles();
    const pollMs = this.opts.pollMs ?? 2000;
    this.timer = setInterval(() => {
      void this.pollNow().catch((err) => logError("codex live poll failed", err));
    }, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  private async primeExistingFiles(): Promise<void> {
    const files = await this.files();
    for (const file of files) {
      try {
        const stat = await fs.promises.stat(file);
        const state: FileState = { offset: stat.size, partial: "", codex: { cwd: null, branch: null } };
        const text = await fs.promises.readFile(file, "utf-8");
        for (const line of text.split(/\r?\n/)) parseCodexJsonlLine(line, state.codex);
        this.states.set(file, state);
      } catch {
        // The transcript can move while Codex is writing/rotating; retry on the next poll.
      }
    }
  }

  private files(): Promise<string[]> {
    return this.opts.listFiles ? this.opts.listFiles() : listCodexFiles();
  }

  private async ingestFile(file: string, fromStart: boolean): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      this.states.delete(file);
      return;
    }

    const state = this.states.get(file) ?? { offset: 0, partial: "", codex: { cwd: null, branch: null } };
    if (fromStart) {
      state.offset = 0;
      state.partial = "";
      state.codex = { cwd: null, branch: null };
    } else if (stat.size < state.offset) {
      state.offset = 0;
      state.partial = "";
      state.codex = { cwd: null, branch: null };
    }

    const text = await readSlice(file, state.offset, stat.size);
    state.offset = stat.size;
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

export function startCodexLiveCapture(db: Store, opts?: CodexLiveOptions): CodexLiveCapture {
  const watcher = new CodexLiveCapture(db, opts);
  void watcher.start().catch((err) => logError("codex live capture failed to start", err));
  return watcher;
}
