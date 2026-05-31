import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import { vectorToBlob, blobToVector, cosineSimilarity } from "./embeddings.js";

export const CLANCEY_DIR = path.join(os.homedir(), ".clancey");
export const DB_PATH = path.join(CLANCEY_DIR, "clancey.db");

export type Store = Database.Database;

export interface ToolEventInput {
  session: string;
  repo: string | null;
  branch: string | null;
  cwd: string | null;
  tool: string;
  file: string | null;
  command: string | null;
  ts: string;
}

export interface DecisionInput {
  session: string | null;
  repo: string | null;
  branch: string | null;
  decision: string;
  why: string | null;
  files: string[] | null;
  ts: string;
}

export interface EmbeddingInput {
  session: string;
  repo: string | null;
  branch: string | null;
  kind: "decision" | "framing";
  text: string;
  vector: number[];
  ts: string;
}

export interface TurnInput {
  session: string;
  ts: string;
  branch: string | null;
  text: string;
}

export interface StoredTurn {
  ts: string;
  branch: string | null;
  text: string;
}

export interface WorkItem {
  repo: string | null;
  branch: string | null;
  sessions: string[];
  files: string[];
  decisions: { decision: string; why: string | null; ts: string }[];
  firstTs: string;
  lastTs: string;
  toolEventCount: number;
}

export interface SearchHit {
  session: string;
  repo: string | null;
  branch: string | null;
  kind: string;
  text: string;
  score: number;
}

export function openStore(dbPath: string = DB_PATH): Store {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Store): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL,
      type       TEXT NOT NULL,            -- 'tool' | 'decision'
      session    TEXT,
      repo       TEXT,
      branch     TEXT,
      cwd        TEXT,
      tool       TEXT,
      file       TEXT,
      command    TEXT,
      decision   TEXT,
      why        TEXT,
      files_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_repo_branch ON events(repo, branch);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session);
    CREATE INDEX IF NOT EXISTS idx_events_file ON events(file);

    CREATE TABLE IF NOT EXISTS embeddings (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT NOT NULL,
      session TEXT,
      repo    TEXT,
      branch  TEXT,
      kind    TEXT NOT NULL,               -- 'decision' | 'framing'
      text    TEXT NOT NULL,
      vector  BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_session ON embeddings(session);

    CREATE TABLE IF NOT EXISTS turns (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT NOT NULL,
      ts      TEXT NOT NULL,
      branch  TEXT,
      text    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session);

    CREATE TABLE IF NOT EXISTS state (
      session       TEXT PRIMARY KEY,
      last_branch   TEXT,
      last_nudge_ts TEXT
    );

    CREATE TABLE IF NOT EXISTS ingested (
      path     TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL
    );
  `);
}

export function insertToolEvent(db: Store, e: ToolEventInput): void {
  db.prepare(
    `INSERT INTO events (ts, type, session, repo, branch, cwd, tool, file, command)
     VALUES (@ts, 'tool', @session, @repo, @branch, @cwd, @tool, @file, @command)`,
  ).run(e);
}

export function insertDecision(db: Store, d: DecisionInput): void {
  db.prepare(
    `INSERT INTO events (ts, type, session, repo, branch, decision, why, files_json)
     VALUES (@ts, 'decision', @session, @repo, @branch, @decision, @why, @files_json)`,
  ).run({ ...d, files_json: d.files ? JSON.stringify(d.files) : null });
}

export function insertEmbedding(db: Store, e: EmbeddingInput): void {
  db.prepare(
    `INSERT INTO embeddings (ts, session, repo, branch, kind, text, vector)
     VALUES (@ts, @session, @repo, @branch, @kind, @text, @vector)`,
  ).run({ ...e, vector: vectorToBlob(e.vector) });
}

/** Snapshot a human turn so read_turns survives transcript pruning. */
export function insertTurn(db: Store, t: TurnInput): void {
  db.prepare(`INSERT INTO turns (session, ts, branch, text) VALUES (@session, @ts, @branch, @text)`).run(t);
}

export function getTurns(db: Store, session: string, branch?: string): StoredTurn[] {
  const clause = branch === undefined ? "" : " AND branch = @branch";
  return db
    .prepare(`SELECT ts, branch, text FROM turns WHERE session = @session${clause} ORDER BY ts, id`)
    .all({ session, branch }) as StoredTurn[];
}

interface EventRow {
  ts: string;
  type: string;
  session: string | null;
  repo: string | null;
  branch: string | null;
  file: string | null;
  decision: string | null;
  why: string | null;
}

/** `col = @p` for a value, `col IS NULL` for null — sqlite `=` never matches NULL. */
function eqOrNull(col: string, value: string | null, param: string): string {
  return value === null ? `${col} IS NULL` : `${col} = @${param}`;
}

export function recall(
  db: Store,
  opts: { repo?: string; branch?: string; file?: string; since?: string; limit?: number } = {},
): WorkItem[] {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (opts.repo) {
    where.push("repo = @repo");
    params.repo = opts.repo;
  }
  if (opts.branch) {
    where.push("branch = @branch");
    params.branch = opts.branch;
  }
  if (opts.file) {
    where.push("file LIKE @file");
    params.file = `%${opts.file}%`;
  }
  if (opts.since) {
    where.push("ts >= @since");
    params.since = opts.since;
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Candidate (repo, branch) groups matching the filters, most recent first.
  const groups = db
    .prepare(
      `SELECT repo, branch, MAX(ts) AS lastTs FROM events ${clause}
       GROUP BY repo, branch ORDER BY lastTs DESC ${opts.limit ? "LIMIT @limit" : ""}`,
    )
    .all({ ...params, limit: opts.limit ?? 0 }) as { repo: string | null; branch: string | null }[];

  return groups.map(({ repo, branch }) => {
    const rows = db
      .prepare(
        `SELECT * FROM events
         WHERE ${eqOrNull("repo", repo, "repo")} AND ${eqOrNull("branch", branch, "branch")}
         ORDER BY ts`,
      )
      .all({ repo, branch }) as EventRow[];

    const sessions = new Set<string>();
    const files = new Set<string>();
    const decisions: WorkItem["decisions"] = [];
    let toolEventCount = 0;
    for (const r of rows) {
      if (r.session) sessions.add(r.session);
      if (r.type === "tool") {
        toolEventCount++;
        if (r.file) files.add(r.file);
      } else if (r.type === "decision" && r.decision) {
        decisions.push({ decision: r.decision, why: r.why, ts: r.ts });
      }
    }
    return {
      repo,
      branch,
      sessions: [...sessions],
      files: [...files],
      decisions,
      firstTs: rows[0]?.ts ?? "",
      lastTs: rows[rows.length - 1]?.ts ?? "",
      toolEventCount,
    };
  });
}

export function search(db: Store, queryVector: number[], limit = 8): SearchHit[] {
  const rows = db
    .prepare(`SELECT session, repo, branch, kind, text, vector FROM embeddings`)
    .all() as {
    session: string;
    repo: string | null;
    branch: string | null;
    kind: string;
    text: string;
    vector: Buffer;
  }[];

  return rows
    .map((r) => ({
      session: r.session,
      repo: r.repo,
      branch: r.branch,
      kind: r.kind,
      text: r.text,
      score: cosineSimilarity(queryVector, blobToVector(r.vector)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface NudgeState {
  last_branch: string | null;
  last_nudge_ts: string | null;
}

export function getNudgeState(db: Store, session: string): NudgeState | undefined {
  return db
    .prepare(`SELECT last_branch, last_nudge_ts FROM state WHERE session = ?`)
    .get(session) as NudgeState | undefined;
}

export function setNudgeState(db: Store, session: string, branch: string | null, ts: string): void {
  db.prepare(
    `INSERT INTO state (session, last_branch, last_nudge_ts) VALUES (@session, @branch, @ts)
     ON CONFLICT(session) DO UPDATE SET last_branch = @branch, last_nudge_ts = @ts`,
  ).run({ session, branch, ts });
}

/** Cumulative counts across everything ingested (not just the last backfill). */
export function storeTotals(db: Store): { sessions: number; events: number; embeddings: number } {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    sessions: one(
      `SELECT count(*) c FROM (
         SELECT session FROM events WHERE session <> ''
         UNION SELECT session FROM embeddings WHERE session <> ''
       )`,
    ),
    events: one(`SELECT count(*) c FROM events WHERE type = 'tool'`),
    embeddings: one(`SELECT count(*) c FROM embeddings`),
  };
}

export function getIngestedMtime(db: Store, filePath: string): number | undefined {
  const row = db.prepare(`SELECT mtime_ms FROM ingested WHERE path = ?`).get(filePath) as
    | { mtime_ms: number }
    | undefined;
  return row?.mtime_ms;
}

export function setIngested(db: Store, filePath: string, mtimeMs: number): void {
  db.prepare(
    `INSERT INTO ingested (path, mtime_ms) VALUES (?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms`,
  ).run(filePath, mtimeMs);
}

/** Remove all rows sourced from a transcript (idempotent re-ingest). */
export function deleteSession(db: Store, session: string): void {
  db.prepare(`DELETE FROM events WHERE session = ? AND type = 'tool'`).run(session);
  db.prepare(`DELETE FROM embeddings WHERE session = ? AND kind = 'framing'`).run(session);
  db.prepare(`DELETE FROM turns WHERE session = ?`).run(session);
}
