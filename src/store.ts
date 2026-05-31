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

/** The two kinds of note an agent records by hand: a decision, or an incidental learning. */
export type NoteKind = "decision" | "learning";

export interface NoteInput {
  kind: NoteKind;
  session: string | null;
  repo: string | null;
  branch: string | null;
  body: string; // decision text, or the learning
  detail: string | null; // the "why" of a decision, or the context of a learning
  files: string[] | null;
  ts: string;
}

export interface EmbeddingInput {
  session: string;
  repo: string | null;
  branch: string | null;
  kind: NoteKind | "framing";
  text: string;
  vector: number[];
  ts: string;
  eventId?: number | null;
}

export interface StoredNote {
  id: number;
  kind: NoteKind;
  body: string;
  detail: string | null;
  repo: string | null;
  branch: string | null;
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
  decisions: { id: number; decision: string; why: string | null; ts: string }[];
  learnings: { id: number; learning: string; context: string | null; ts: string }[];
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
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       TEXT NOT NULL,
      session  TEXT,
      repo     TEXT,
      branch   TEXT,
      kind     TEXT NOT NULL,              -- 'decision' | 'framing'
      text     TEXT NOT NULL,
      vector   BLOB NOT NULL,
      event_id INTEGER                     -- decision rows: the events.id they embed
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

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  addColumnIfMissing(db, "embeddings", "event_id", "INTEGER");
}

/** Additive schema upgrade for dbs created before a column existed. */
function addColumnIfMissing(db: Store, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export function getMeta(db: Store, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Store, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function insertToolEvent(db: Store, e: ToolEventInput): void {
  db.prepare(
    `INSERT INTO events (ts, type, session, repo, branch, cwd, tool, file, command)
     VALUES (@ts, 'tool', @session, @repo, @branch, @cwd, @tool, @file, @command)`,
  ).run(e);
}

/** Insert a note (decision or learning) and return its id, so its embedding can link back to it. */
export function insertNote(db: Store, n: NoteInput): number {
  const info = db
    .prepare(
      `INSERT INTO events (ts, type, session, repo, branch, decision, why, files_json)
       VALUES (@ts, @kind, @session, @repo, @branch, @body, @detail, @files_json)`,
    )
    .run({
      ts: n.ts,
      kind: n.kind,
      session: n.session,
      repo: n.repo,
      branch: n.branch,
      body: n.body,
      detail: n.detail,
      files_json: n.files ? JSON.stringify(n.files) : null,
    });
  return Number(info.lastInsertRowid);
}

export function insertEmbedding(db: Store, e: EmbeddingInput): void {
  db.prepare(
    `INSERT INTO embeddings (ts, session, repo, branch, kind, text, vector, event_id)
     VALUES (@ts, @session, @repo, @branch, @kind, @text, @vector, @event_id)`,
  ).run({ ...e, vector: vectorToBlob(e.vector), event_id: e.eventId ?? null });
}

/** The text stored on a note's embedding row (the search-visible summary). */
export function noteText(body: string, detail: string | null): string {
  return detail ? `${body} — ${detail}` : body;
}

/** The text fed to the embedder for a note (what `search` ranks against). */
export function noteEmbedInput(body: string, detail: string | null): string {
  return detail ? `${body}\n\n${detail}` : body;
}

export function getNote(db: Store, id: number): StoredNote | undefined {
  const row = db
    .prepare(`SELECT id, type, decision, why, repo, branch FROM events WHERE id = ? AND type IN ('decision', 'learning')`)
    .get(id) as
    | { id: number; type: NoteKind; decision: string; why: string | null; repo: string | null; branch: string | null }
    | undefined;
  return row ? { id: row.id, kind: row.type, body: row.decision, detail: row.why, repo: row.repo, branch: row.branch } : undefined;
}

/**
 * Delete a note's embedding. New notes link by event_id; notes recorded before
 * that column existed are matched by their stored text (and kind/repo/branch) instead.
 */
function removeNoteEmbedding(db: Store, n: StoredNote): void {
  const byId = db.prepare(`DELETE FROM embeddings WHERE event_id = ?`).run(n.id);
  if (byId.changes > 0) return;
  db.prepare(
    `DELETE FROM embeddings WHERE kind = @kind AND event_id IS NULL AND text = @text
     AND ${eqOrNull("repo", n.repo, "repo")} AND ${eqOrNull("branch", n.branch, "branch")}`,
  ).run({ kind: n.kind, text: noteText(n.body, n.detail), repo: n.repo, branch: n.branch });
}

/** Rewrite a note and replace its embedding (caller supplies the new vector). */
export function updateNote(
  db: Store,
  id: number,
  next: { body: string; detail: string | null },
  vector: number[],
): boolean {
  const existing = getNote(db, id);
  if (!existing) return false;
  removeNoteEmbedding(db, existing);
  db.prepare(`UPDATE events SET decision = @body, why = @detail WHERE id = @id`).run({
    id,
    body: next.body,
    detail: next.detail,
  });
  insertEmbedding(db, {
    session: "",
    repo: existing.repo,
    branch: existing.branch,
    kind: existing.kind,
    text: noteText(next.body, next.detail),
    vector,
    ts: new Date().toISOString(),
    eventId: id,
  });
  return true;
}

/** Delete a note and its embedding. Returns false if no such note exists. */
export function deleteNote(db: Store, id: number): boolean {
  const existing = getNote(db, id);
  if (!existing) return false;
  removeNoteEmbedding(db, existing);
  db.prepare(`DELETE FROM events WHERE id = ? AND type IN ('decision', 'learning')`).run(id);
  return true;
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
  id: number;
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
    const learnings: WorkItem["learnings"] = [];
    let toolEventCount = 0;
    for (const r of rows) {
      if (r.session) sessions.add(r.session);
      if (r.type === "tool") {
        toolEventCount++;
        if (r.file) files.add(r.file);
      } else if (r.type === "decision" && r.decision) {
        decisions.push({ id: r.id, decision: r.decision, why: r.why, ts: r.ts });
      } else if (r.type === "learning" && r.decision) {
        learnings.push({ id: r.id, learning: r.decision, context: r.why, ts: r.ts });
      }
    }
    return {
      repo,
      branch,
      sessions: [...sessions],
      files: [...files],
      decisions,
      learnings,
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
