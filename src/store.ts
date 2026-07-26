import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { vectorToBlob, blobToVector, cosineSimilarity } from "./embeddings.js";
import { expandRepoFilterKeys } from "./git.js";
import { resolveClanceyDir, resolveDbPath } from "./paths.js";
import { logError } from "./logger.js";

/** @deprecated Prefer resolveClanceyDir() — value is resolved at module load. */
export const CLANCEY_DIR = resolveClanceyDir();
/** @deprecated Prefer resolveDbPath() — value is resolved at module load. */
export const DB_PATH = resolveDbPath();

export type Store = Database.Database;

/** Coding host that produced a session/event. Unknown for pre-tag rows. */
export type Host = "claude" | "codex" | "opencode" | "grok" | "hermes" | "unknown";

export const HOSTS: readonly Host[] = ["claude", "codex", "opencode", "grok", "hermes", "unknown"] as const;

export function normalizeHost(raw: string | null | undefined): Host | null {
  if (raw == null || raw === "") return null;
  const h = raw.toLowerCase();
  return (HOSTS as readonly string[]).includes(h) ? (h as Host) : null;
}

export interface ToolEventInput {
  session: string;
  repo: string | null;
  branch: string | null;
  cwd: string | null;
  tool: string;
  file: string | null;
  command: string | null;
  ts: string;
  /** Subagent type when this event came from a subagent transcript; null for the main session. */
  agent?: string | null;
  /** Coding host (claude/codex/opencode/grok/hermes). */
  host?: Host | null;
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
  host?: Host | null;
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
  host?: Host | null;
}

export interface StoredNote {
  id: number;
  kind: NoteKind;
  body: string;
  detail: string | null;
  repo: string | null;
  branch: string | null;
  session: string | null;
  host: Host | null;
}

export interface MessageInput {
  session: string;
  ts: string;
  branch: string | null;
  role: "user" | "assistant";
  agent: string | null;
  agentId: string | null;
  text: string;
  host?: Host | null;
  repo?: string | null;
}

export interface StoredMessage {
  ts: string;
  branch: string | null;
  role: "user" | "assistant";
  agent: string | null;
  text: string;
}

export interface WorkItem {
  repo: string | null;
  branch: string | null;
  sessions: string[];
  files: string[];
  decisions: { id: number; decision: string; why: string | null; ts: string; session: string | null }[];
  learnings: { id: number; learning: string; context: string | null; ts: string; session: string | null }[];
  firstTs: string;
  lastTs: string;
  toolEventCount: number;
  hosts: Host[];
}

export interface SearchHit {
  session: string;
  title: string | null;
  repo: string | null;
  branch: string | null;
  kind: string;
  text: string;
  score: number;
  host: Host | null;
  ts: string | null;
  /** Which retrievers found this: semantic, keyword, or both. */
  matched: ("semantic" | "keyword")[];
}

export interface TimeFilter {
  since?: string;
  until?: string;
}

export interface SearchOptions extends TimeFilter {
  limit?: number;
  repo?: string;
  /** Prefer this over raw `repo` when the caller already expanded path ↔ owner/name keys. */
  repos?: string[];
  branch?: string;
  host?: string;
  /** Session ids to omit (e.g. the current conversation). */
  excludeSessions?: string[];
}

export interface SessionSummary {
  session: string;
  title: string | null;
  host: Host | null;
  repo: string | null;
  branch: string | null;
  firstTs: string;
  lastTs: string;
  /** Stored turns and their total text size — how big a read_turns on this session would be. */
  turns: number;
  bytes: number;
}

export function openStore(dbPath: string = resolveDbPath()): Store {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // Long-lived MCP readers keep the auto-checkpointer from resetting the WAL, so it grows
  // unbounded (hundreds of MB observed). A tighter threshold plus the explicit truncating
  // checkpoint the watcher runs keeps it bounded.
  db.pragma("wal_autocheckpoint = 512");
  migrate(db);
  return db;
}

/**
 * Fold the WAL back into the main db and truncate it. Best-effort: TRUNCATE needs a moment
 * with no active readers, so a busy result is normal and simply retried next cycle.
 */
export function checkpointWal(db: Store): "ok" | "busy" {
  try {
    const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    return row && row.busy === 0 ? "ok" : "busy";
  } catch {
    return "busy";
  }
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
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

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
    CREATE INDEX IF NOT EXISTS idx_embeddings_ts ON embeddings(ts);

    -- Full conversation: user + assistant turns (with verbatim scripts/code inline), plus
    -- subagent turns folded under their parent session. This is what makes grep/read cover
    -- what the agent actually did, not just what the human asked.
    CREATE TABLE IF NOT EXISTS messages (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      session  TEXT NOT NULL,        -- parent session id (subagents fold in)
      ts       TEXT NOT NULL,
      branch   TEXT,
      role     TEXT NOT NULL,        -- 'user' | 'assistant'
      agent    TEXT,                 -- NULL = main session; else the subagent type
      agent_id TEXT,
      text     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

    -- Keyword index over conversation text. External-content FTS5: inverted index only;
    -- document bodies live solely in messages (no messages_fts_content shadow copy).
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS state (
      session       TEXT PRIMARY KEY,
      last_branch   TEXT,
      last_nudge_ts TEXT
    );

    CREATE TABLE IF NOT EXISTS ingested (
      path     TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL
    );

    -- One row per session: the human-readable identity of a conversation. Hit lists that show
    -- only an opaque uuid force a read_turns on every candidate just to find out what it was.
    CREATE TABLE IF NOT EXISTS sessions (
      session TEXT PRIMARY KEY,
      title   TEXT,
      host    TEXT,
      repo    TEXT,
      branch  TEXT,
      cwd     TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  addColumnIfMissing(db, "embeddings", "event_id", "INTEGER");
  addColumnIfMissing(db, "state", "last_event_ts", "TEXT");
  addColumnIfMissing(db, "events", "agent", "TEXT");
  addColumnIfMissing(db, "events", "host", "TEXT");
  addColumnIfMissing(db, "embeddings", "host", "TEXT");
  addColumnIfMissing(db, "messages", "host", "TEXT");
  addColumnIfMissing(db, "messages", "repo", "TEXT");
  // Per-stream ingest cursor: how much of this file we already stored, so an append-only
  // transcript re-ingests only its tail instead of being deleted and rewritten wholesale.
  addColumnIfMissing(db, "ingested", "msg_count", "INTEGER");
  addColumnIfMissing(db, "ingested", "ev_count", "INTEGER");
  addColumnIfMissing(db, "ingested", "last_ts", "TEXT");
  addColumnIfMissing(db, "ingested", "last_id", "INTEGER");
  ensureMessagesFts(db);
  // The legacy human-only `turns` snapshot is superseded by `messages` (which stores user turns
  // too). Drop it so we don't keep a second copy of every human turn; `backfill --force`
  // repopulates `messages` from the transcripts.
  db.exec(`DROP TABLE IF EXISTS turns_fts; DROP TABLE IF EXISTS turns;`);
}

/** DDL for the external-content messages FTS index (no plaintext shadow table). */
export const MESSAGES_FTS_DDL = `CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id'
)`;

/** True when messages_fts is external-content (or contentless) and not the old contentful shape. */
export function isMessagesFtsExternalContent(db: Store): boolean {
  const sql = messagesFtsSql(db);
  if (!sql) return false;
  // External content: content='messages'. Contentless: content=''.
  // Old contentful FTS has neither and materializes messages_fts_content.
  if (/content\s*=\s*'messages'/i.test(sql) || /content\s*=\s*''/i.test(sql)) return true;
  return false;
}

/** True when the legacy contentful shadow table is present. */
export function hasMessagesFtsContentTable(db: Store): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts_content'`,
    )
    .get() as { ok: number } | undefined;
  return row !== undefined;
}

function messagesFtsSql(db: Store): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'messages_fts' AND sql IS NOT NULL`)
    .get() as { sql: string } | undefined;
  return row?.sql ?? null;
}

/**
 * Ensure messages_fts is external-content FTS5. Rebuilds once from messages when the DB still
 * has the old contentful shape (or is missing FTS). Subsequent opens are a no-op aside from a
 * cheap empty-index backfill check.
 */
function ensureMessagesFts(db: Store): void {
  const sql = messagesFtsSql(db);
  const needsRebuild = !sql || !isMessagesFtsExternalContent(db) || hasMessagesFtsContentTable(db);

  if (needsRebuild) {
    db.exec(`DROP TABLE IF EXISTS messages_fts`);
    db.exec(MESSAGES_FTS_DDL);
    db.exec(`INSERT INTO messages_fts (rowid, text) SELECT id, text FROM messages`);
    return;
  }

  backfillMessagesFts(db);
}

/** Populate messages_fts from messages when the FTS index is empty but messages already has rows. */
function backfillMessagesFts(db: Store): void {
  // External-content FTS: `SELECT count(*) FROM messages_fts` reads the content table
  // (messages), not the index — so an unbuilt index still reports messages.length.
  // docsize tracks indexed documents and is 0 until we INSERT into the FTS index.
  const indexed = (db.prepare(`SELECT count(*) c FROM messages_fts_docsize`).get() as { c: number }).c;
  if (indexed > 0) return;
  const msgs = (db.prepare(`SELECT count(*) c FROM messages`).get() as { c: number }).c;
  if (msgs === 0) return;
  db.exec(`INSERT INTO messages_fts (rowid, text) SELECT id, text FROM messages`);
}

/** Additive schema upgrade for dbs created before a column existed. */
function addColumnIfMissing(db: Store, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/**
 * Record a session's identity. Nulls never overwrite something we already knew — a later
 * ingest pass that can't see the title (pruned transcript, partial host data) must not erase it.
 */
export function upsertSessionCard(
  db: Store,
  card: { session: string; title?: string | null; host?: string | null; repo?: string | null; branch?: string | null; cwd?: string | null },
): void {
  db.prepare(
    `INSERT INTO sessions (session, title, host, repo, branch, cwd)
     VALUES (@session, @title, @host, @repo, @branch, @cwd)
     ON CONFLICT(session) DO UPDATE SET
       title  = COALESCE(excluded.title, sessions.title),
       host   = COALESCE(excluded.host, sessions.host),
       repo   = COALESCE(excluded.repo, sessions.repo),
       branch = COALESCE(excluded.branch, sessions.branch),
       cwd    = COALESCE(excluded.cwd, sessions.cwd)`,
  ).run({
    session: card.session,
    title: card.title ?? null,
    host: card.host ?? null,
    repo: card.repo ?? null,
    branch: card.branch ?? null,
    cwd: card.cwd ?? null,
  });
}

/** Titles for a set of sessions, for annotating hit lists. */
export function getSessionTitles(db: Store, sessions: readonly string[]): Map<string, string> {
  const ids = [...new Set(sessions.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT session, title FROM sessions
       WHERE title IS NOT NULL AND title <> '' AND session IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as { session: string; title: string }[];
  return new Map(rows.map((r) => [r.session, r.title]));
}

/** Turn count and stored size per session, so callers can judge a read_turns before making it. */
export function getSessionSizes(
  db: Store,
  sessions: readonly string[],
): Map<string, { turns: number; bytes: number }> {
  const ids = [...new Set(sessions.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT session, count(*) AS turns, COALESCE(sum(length(text)), 0) AS bytes
       FROM messages WHERE session IN (${ids.map(() => "?").join(", ")}) GROUP BY session`,
    )
    .all(...ids) as { session: string; turns: number; bytes: number }[];
  return new Map(rows.map((r) => [r.session, { turns: r.turns, bytes: r.bytes }]));
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
    `INSERT INTO events (ts, type, session, repo, branch, cwd, tool, file, command, agent, host)
     VALUES (@ts, 'tool', @session, @repo, @branch, @cwd, @tool, @file, @command, @agent, @host)`,
  ).run({ ...e, agent: e.agent ?? null, host: e.host ?? null });
}

/** Insert a note (decision or learning) and return its id, so its embedding can link back to it. */
export function insertNote(db: Store, n: NoteInput): number {
  const info = db
    .prepare(
      `INSERT INTO events (ts, type, session, repo, branch, decision, why, files_json, host)
       VALUES (@ts, @kind, @session, @repo, @branch, @body, @detail, @files_json, @host)`,
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
      host: n.host ?? null,
    });
  return Number(info.lastInsertRowid);
}

export function insertEmbedding(db: Store, e: EmbeddingInput): void {
  db.prepare(
    `INSERT INTO embeddings (ts, session, repo, branch, kind, text, vector, event_id, host)
     VALUES (@ts, @session, @repo, @branch, @kind, @text, @vector, @event_id, @host)`,
  ).run({ ...e, vector: vectorToBlob(e.vector), event_id: e.eventId ?? null, host: e.host ?? null });
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
    .prepare(
      `SELECT id, type, decision, why, repo, branch, session, host FROM events WHERE id = ? AND type IN ('decision', 'learning')`,
    )
    .get(id) as
    | {
        id: number;
        type: NoteKind;
        decision: string;
        why: string | null;
        repo: string | null;
        branch: string | null;
        session: string | null;
        host: string | null;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        kind: row.type,
        body: row.decision,
        detail: row.why,
        repo: row.repo,
        branch: row.branch,
        session: row.session,
        host: normalizeHost(row.host),
      }
    : undefined;
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
    session: existing.session ?? "",
    repo: existing.repo,
    branch: existing.branch,
    kind: existing.kind,
    text: noteText(next.body, next.detail),
    vector,
    ts: new Date().toISOString(),
    eventId: id,
    host: existing.host,
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

/**
 * Snapshot a full conversation message (any role, including subagents) and index it for grep.
 * Returns the row id so an incremental ingest can revisit a turn that is still being streamed.
 */
export function insertMessage(db: Store, m: MessageInput): number {
  const info = db
    .prepare(
      `INSERT INTO messages (session, ts, branch, role, agent, agent_id, text, host, repo)
       VALUES (@session, @ts, @branch, @role, @agent, @agentId, @text, @host, @repo)`,
    )
    .run({ ...m, host: m.host ?? null, repo: m.repo ?? null });
  const id = Number(info.lastInsertRowid);
  db.prepare(`INSERT INTO messages_fts (rowid, text) VALUES (@rowid, @text)`).run({ rowid: id, text: m.text });
  return id;
}

export function getMessages(db: Store, session: string, branch?: string): StoredMessage[] {
  const clause = branch === undefined ? "" : " AND branch = @branch";
  return db
    .prepare(`SELECT ts, branch, role, agent, text FROM messages WHERE session = @session${clause} ORDER BY ts, id`)
    .all({ session, branch }) as StoredMessage[];
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
  host: string | null;
}

/** `col = @p` for a value, `col IS NULL` for null — sqlite `=` never matches NULL. */
function eqOrNull(col: string, value: string | null, param: string): string {
  return value === null ? `${col} IS NULL` : `${col} = @${param}`;
}

/**
 * Distinct non-null repo keys stored in the index (for reverse short-key → path expansion).
 */
export function listKnownRepos(db: Store): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT repo FROM (
         SELECT repo FROM events WHERE repo IS NOT NULL AND repo <> ''
         UNION
         SELECT repo FROM messages WHERE repo IS NOT NULL AND repo <> ''
         UNION
         SELECT repo FROM embeddings WHERE repo IS NOT NULL AND repo <> ''
       )`,
    )
    .all() as { repo: string }[];
  return rows.map((r) => r.repo);
}

/**
 * Bumped whenever ingest changes what gets *stored* (not how it's queried). A mismatch makes
 * the next backfill drop its cursors and re-read every transcript, so shape fixes reach existing
 * databases on their own — `--force` is a flag nobody remembers to run.
 */
export const INGEST_VERSION = 5;

export function ingestVersionChanged(db: Store): boolean {
  return getMeta(db, "ingest_version") !== String(INGEST_VERSION);
}

export function markIngestVersion(db: Store): void {
  setMeta(db, "ingest_version", String(INGEST_VERSION));
}

/**
 * How many migration snapshots to keep. A real index runs to hundreds of megabytes, so this is a
 * disk budget as much as a retention rule: the pre-migration copy plus the one before it.
 */
export const MAX_BACKUPS = 2;

export function backupsDir(dir: string = resolveClanceyDir()): string {
  return path.join(dir, "backups");
}

/**
 * Snapshot the store before a migration rewrites it. A migration heals rows in place and drops
 * every ingest cursor; if the heal turns out to be wrong, the pre-migration shape is otherwise
 * unrecoverable — the transcripts it was derived from have already been re-read. The snapshot is
 * also the safe thing to run experiments against, since the live DB is being written by the
 * watcher and by every MCP call.
 *
 * `VACUUM INTO` takes a consistent copy under WAL without stopping writers, so this is safe to
 * call on a hot database. Failure is non-fatal: a missing backup must not block the migration.
 */
export function backupStore(db: Store, label: string): string | null {
  const source = db.name;
  const dir = backupsDir(path.dirname(source));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${path.basename(source, ".db")}-${label}-${stamp}.db`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    db.prepare(`VACUUM INTO ?`).run(dest);
  } catch (err) {
    logError("database backup failed", err);
    return null;
  }
  pruneBackups(dir);
  return dest;
}

/** Keep only the newest MAX_BACKUPS snapshots so migrations don't grow the data dir without bound. */
function pruneBackups(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const stale of files.slice(MAX_BACKUPS)) fs.rmSync(stale, { force: true });
  } catch (err) {
    logError("backup prune failed", err);
  }
}

/** Drop every ingest cursor so the next backfill re-reads all transcripts from scratch. */
export function clearAllIngestCursors(db: Store): void {
  db.exec(`DELETE FROM ingested`);
}

/**
 * Whether a full re-read is still owed. Cleared cursors alone can't say so: to a later backfill
 * they look identical to a first run, and re-reading every transcript is minutes of work that
 * must never land inside an MCP tool call. The watcher clears this when a full pass finishes.
 */
export function isReingestPending(db: Store): boolean {
  return getMeta(db, "reingest_pending") === "1";
}

export function setReingestPending(db: Store, pending: boolean): void {
  setMeta(db, "reingest_pending", pending ? "1" : "0");
}

/**
 * Repair repo attribution on rows already in the store, so scoped lookups work immediately
 * instead of waiting out a full re-ingest. Two passes:
 *
 * 1. Sessions whose messages have no repo but whose tool events do (the common shape: repo was
 *    only ever derived from the first tool event, so a session that edited nothing was unscoped).
 * 2. Every distinct repo value through `canonicalize`, collapsing worktrees, subdirectories and
 *    path-vs-`owner/name` spellings of the same repo onto one key.
 * 3. Notes back onto their own conversation's repo. A note is only ever as good as the session it
 *    points at, and `messages.repo` comes from the transcript's cwd, so it wins any disagreement.
 */
export function healRepoAttribution(
  db: Store,
  canonicalize: (repo: string) => string | null,
): { linked: number; canonicalized: number; renoted: number } {
  const linked = db
    .prepare(
      `UPDATE messages SET repo = (
         SELECT e.repo FROM events e
         WHERE e.session = messages.session AND e.repo IS NOT NULL AND e.repo <> ''
         LIMIT 1
       )
       WHERE (repo IS NULL OR repo = '')
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.session = messages.session AND e.repo IS NOT NULL AND e.repo <> ''
         )`,
    )
    .run().changes;

  let canonicalized = 0;
  for (const stored of listKnownRepos(db)) {
    const canonical = canonicalize(stored);
    if (!canonical || canonical === stored) continue;
    for (const table of ["messages", "events", "embeddings"]) {
      canonicalized += db
        .prepare(`UPDATE ${table} SET repo = @canonical WHERE repo = @stored`)
        .run({ canonical, stored }).changes;
    }
  }
  const renoted = db
    .prepare(
      `UPDATE events SET repo = (
         SELECT m.repo FROM messages m WHERE m.session = events.session AND m.repo IS NOT NULL LIMIT 1
       )
       WHERE type IN ('decision','learning')
         AND session IS NOT NULL AND session <> ''
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.session = events.session AND m.repo IS NOT NULL AND m.repo IS NOT events.repo
         )`,
    )
    .run().changes;

  // Same rule for the vectors, or a note and the embedding that finds it would answer to
  // different repo filters.
  db.prepare(
    `UPDATE embeddings SET repo = (
       SELECT m.repo FROM messages m WHERE m.session = embeddings.session AND m.repo IS NOT NULL LIMIT 1
     )
     WHERE EXISTS (
       SELECT 1 FROM messages m
       WHERE m.session = embeddings.session AND m.repo IS NOT NULL AND m.repo IS NOT embeddings.repo
     )`,
  ).run();

  return { linked, canonicalized, renoted };
}

/** How far a note's timestamp may sit from a session's activity and still belong to it. */
const NOTE_LINK_WINDOW_MINUTES = 45;

/**
 * Link recorded decisions/learnings that were saved without a session id back to the
 * conversation that produced them, by repo and time. Unanchored notes are the worst kind of
 * search hit: they assert something was decided but give the reader nothing to read back.
 */
export function healNoteSessions(db: Store): number {
  return db
    .prepare(
      `UPDATE events SET session = (
         SELECT m.session FROM messages m
         WHERE m.repo = events.repo
           AND m.session IS NOT NULL AND m.session <> ''
           AND ABS(julianday(m.ts) - julianday(events.ts)) * 1440 <= @window
         ORDER BY ABS(julianday(m.ts) - julianday(events.ts))
         LIMIT 1
       )
       WHERE type IN ('decision', 'learning')
         AND (session IS NULL OR session = '')
         AND repo IS NOT NULL AND repo <> ''`,
    )
    .run({ window: NOTE_LINK_WINDOW_MINUTES }).changes;
}

/** Bind `repo IN (...)` or `repo = @repo` from a single key or expanded list. */
function bindRepoFilter(
  col: string,
  opts: { repo?: string; repos?: string[] },
  params: Record<string, string | number>,
  prefix = "repo",
): string {
  const keys =
    opts.repos && opts.repos.length > 0
      ? [...new Set(opts.repos.filter(Boolean))]
      : opts.repo
        ? [opts.repo]
        : [];
  if (keys.length === 0) return "";
  if (keys.length === 1) {
    params[prefix] = keys[0];
    return `${col} = @${prefix}`;
  }
  const placeholders: string[] = [];
  keys.forEach((k, i) => {
    const p = `${prefix}${i}`;
    params[p] = k;
    placeholders.push(`@${p}`);
  });
  return `${col} IN (${placeholders.join(", ")})`;
}

function bindExcludeSessions(
  col: string,
  exclude: string[] | undefined,
  params: Record<string, string | number>,
  prefix = "exSes",
): string {
  const ids = [...new Set((exclude ?? []).filter(Boolean))];
  if (ids.length === 0) return "";
  const placeholders: string[] = [];
  ids.forEach((id, i) => {
    const p = `${prefix}${i}`;
    params[p] = id;
    placeholders.push(`@${p}`);
  });
  return `${col} NOT IN (${placeholders.join(", ")})`;
}

/**
 * Normalize MCP/CLI exclude args into a session-id list.
 * Accepts `exclude_session`, `exclude_sessions` (string or array), or `excludeSessions`.
 */
export function collectExcludeSessions(args: {
  exclude_session?: unknown;
  exclude_sessions?: unknown;
  excludeSessions?: unknown;
}): string[] | undefined {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.trim()) out.push(item.trim());
      }
    }
  };
  push(args.exclude_session);
  push(args.exclude_sessions);
  push(args.excludeSessions);
  const ids = [...new Set(out)];
  return ids.length ? ids : undefined;
}

/**
 * Resolve shipped lookup scope: expand `repo` path ↔ owner/name against known store keys,
 * and normalize session exclusion. Used by MCP handlers so tests can drive the same path.
 */
export function resolveLookupScope(
  db: Store,
  args: {
    repo?: string;
    branch?: string;
    host?: string;
    since?: string;
    until?: string;
    limit?: number;
    exclude_session?: unknown;
    exclude_sessions?: unknown;
    excludeSessions?: unknown;
  },
): SearchOptions {
  const repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
  const repos = repo ? expandRepoFilterKeys(repo, listKnownRepos(db)) : undefined;
  return {
    ...(repos && repos.length ? { repos } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.host ? { host: args.host } : {}),
    ...(args.since ? { since: args.since } : {}),
    ...(args.until ? { until: args.until } : {}),
    ...(args.limit != null ? { limit: args.limit } : {}),
    excludeSessions: collectExcludeSessions(args),
  };
}

export function recall(
  db: Store,
  opts: {
    repo?: string;
    repos?: string[];
    branch?: string;
    file?: string;
    host?: string;
    since?: string;
    until?: string;
    limit?: number;
    excludeSessions?: string[];
  } = {},
): WorkItem[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  const repoClause = bindRepoFilter("repo", opts, params);
  if (repoClause) where.push(repoClause);
  if (opts.branch) {
    where.push("branch = @branch");
    params.branch = opts.branch;
  }
  if (opts.file) {
    where.push("file LIKE @file");
    params.file = `%${opts.file}%`;
  }
  const host = normalizeHost(opts.host);
  if (host) {
    where.push("host = @host");
    params.host = host;
  }
  if (opts.since) {
    where.push("ts >= @since");
    params.since = opts.since;
  }
  if (opts.until) {
    where.push("ts < @until");
    params.until = opts.until;
  }
  const ex = bindExcludeSessions("session", opts.excludeSessions, params);
  if (ex) where.push(ex);
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
         ${host ? "AND host = @host" : ""}
         ${opts.since ? "AND ts >= @since" : ""}
         ${opts.until ? "AND ts < @until" : ""}
         ORDER BY ts`,
      )
      .all({ repo, branch, host, since: opts.since, until: opts.until }) as EventRow[];

    const sessions = new Set<string>();
    const files = new Set<string>();
    const hosts = new Set<Host>();
    const decisions: WorkItem["decisions"] = [];
    const learnings: WorkItem["learnings"] = [];
    let toolEventCount = 0;
    for (const r of rows) {
      if (r.session) sessions.add(r.session);
      const h = normalizeHost(r.host);
      if (h) hosts.add(h);
      if (r.type === "tool") {
        toolEventCount++;
        if (r.file) files.add(r.file);
      } else if (r.type === "decision" && r.decision) {
        decisions.push({ id: r.id, decision: r.decision, why: r.why, ts: r.ts, session: r.session });
      } else if (r.type === "learning" && r.decision) {
        learnings.push({ id: r.id, learning: r.decision, context: r.why, ts: r.ts, session: r.session });
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
      hosts: [...hosts],
    };
  });
}

export interface TurnHit {
  session: string;
  title: string | null;
  branch: string | null;
  ts: string;
  role: string;
  agent: string | null;
  snippet: string;
  /** Opening of the turn that came next — usually the answer to the turn that matched. */
  reply: string | null;
  host: Host | null;
  repo: string | null;
}

/**
 * Words that carry no signal in a conversation index but dominate an OR query — every
 * transcript contains "the" and "we", so including them ranks noise above real matches.
 */
const FTS_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "did", "do", "does", "for",
  "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "me", "of",
  "on", "or", "our", "so", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "to", "was", "we", "were", "what", "when", "where", "which", "why", "with", "you",
  "your",
]);

/**
 * Compile a free-text query into two FTS5 MATCH expressions, strict then loose.
 *
 * Strict ANDs the terms: a turn has to contain all of them, which is what someone asking for
 * "horde leave token" actually means. Loose ORs them as a fallback so a single absent word
 * can't empty the result. `"quoted runs"` stay phrases in both. Stopwords are dropped unless
 * that would leave nothing to search for.
 */
export function ftsQueries(raw: string): { strict: string; loose: string } | null {
  const phrases: string[] = [];
  const rest = raw.replace(/"([^"]+)"/g, (_m, inner: string) => {
    const words = (inner.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
    if (words) phrases.push(`"${words}"`);
    return " ";
  });

  const words = rest.match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningful = words.filter((w) => !FTS_STOPWORDS.has(w.toLowerCase()));
  const terms = [...phrases, ...(meaningful.length ? meaningful : words).map((w) => `"${w}"`)];
  if (terms.length === 0) return null;
  return { strict: terms.join(" AND "), loose: terms.join(" OR ") };
}

/**
 * Keyword/full-text search over the full conversation — every role and every subagent — the
 * fallback when semantic `search` misses something said (or done) in passing. Matches the raw
 * user prompts, the assistant's prose, and the verbatim scripts/code it wrote.
 */
function searchOptions(opts: number | SearchOptions): SearchOptions {
  return typeof opts === "number" ? { limit: opts } : opts;
}

function scopeWhere(
  alias: string,
  opts: SearchOptions,
  params: Record<string, string | number>,
): string {
  const where: string[] = [];
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  if (opts.since) {
    where.push(`${col("ts")} >= @since`);
    params.since = opts.since;
  }
  if (opts.until) {
    where.push(`${col("ts")} < @until`);
    params.until = opts.until;
  }
  const repoClause = bindRepoFilter(col("repo"), opts, params);
  if (repoClause) where.push(repoClause);
  if (opts.branch) {
    where.push(`${col("branch")} = @branch`);
    params.branch = opts.branch;
  }
  const host = normalizeHost(opts.host);
  if (host) {
    where.push(`${col("host")} = @host`);
    params.host = host;
  }
  const ex = bindExcludeSessions(col("session"), opts.excludeSessions, params);
  if (ex) where.push(ex);
  return where.length ? ` AND ${where.join(" AND ")}` : "";
}

/** At most this many hits from one conversation, so a chatty session can't fill the page. */
const MAX_HITS_PER_SESSION = 2;
/** FTS5 snippet width in tokens (its maximum) — a 16-token window cut off the useful part. */
const SNIPPET_TOKENS = 64;
const REPLY_PREVIEW_CHARS = 240;
/** Pull extra rows so per-session capping still fills the page. */
const OVERFETCH = 8;

export function grepTurns(db: Store, query: string, opts: number | SearchOptions = 8): TurnHit[] {
  const compiled = ftsQueries(query);
  if (!compiled) return [];
  const options = searchOptions(opts);
  const limit = options.limit ?? 8;

  const run = (match: string): RawTurnRow[] => {
    const params: Record<string, string | number> = { match, limit: limit * OVERFETCH };
    // Scope columns live on the joined `messages` row (alias m).
    // Keep messages_fts unaliased so MATCH/snippet/rank bind correctly under better-sqlite3.
    const scope = scopeWhere("m", options, params);
    // Prefer columns from `messages` (content table). FTS5 joined tables reject
    // messages_fts.col qualification in SELECT under better-sqlite3.
    return db
      .prepare(
        `SELECT m.id AS id, m.session AS session, m.branch AS branch, m.ts AS ts, m.role AS role,
                m.agent AS agent,
                snippet(messages_fts, 0, '«', '»', '…', ${SNIPPET_TOKENS}) AS snippet,
                m.host AS host, m.repo AS repo
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH @match
         ${scope}
         ORDER BY rank LIMIT @limit`,
      )
      .all(params) as RawTurnRow[];
  };

  // All words, then any word: an exact-ish match is worth far more than a turn that happened
  // to contain one common term, but a single missing word must not empty the result either.
  let rows = run(compiled.strict);
  if (rows.length === 0 && compiled.loose !== compiled.strict) rows = run(compiled.loose);

  const perSession = new Map<string, number>();
  const kept: RawTurnRow[] = [];
  for (const row of rows) {
    const seen = perSession.get(row.session) ?? 0;
    if (seen >= MAX_HITS_PER_SESSION) continue;
    perSession.set(row.session, seen + 1);
    kept.push(row);
    if (kept.length >= limit) break;
  }

  const titles = getSessionTitles(db, kept.map((r) => r.session));
  return kept.map((r) => ({
    session: r.session,
    title: titles.get(r.session) ?? null,
    branch: r.branch,
    ts: r.ts,
    role: r.role,
    agent: r.agent,
    snippet: r.snippet,
    reply: nextTurnPreview(db, r.id, r.session),
    host: normalizeHost(r.host),
    repo: r.repo,
  }));
}

interface RawTurnRow {
  id: number;
  session: string;
  branch: string | null;
  ts: string;
  role: string;
  agent: string | null;
  snippet: string;
  host: string | null;
  repo: string | null;
}

/**
 * Opening of the turn that followed a hit. A question found on its own is rarely the answer;
 * showing the reply is usually the difference between one grep and a follow-up read_turns.
 */
function nextTurnPreview(db: Store, id: number, session: string): string | null {
  const row = db
    .prepare(
      `SELECT role, agent, text FROM messages
       WHERE session = @session AND id > @id ORDER BY id LIMIT 1`,
    )
    .get({ session, id }) as { role: string; agent: string | null; text: string } | undefined;
  if (!row) return null;
  const who = row.agent ? `${row.role}·${row.agent}` : row.role;
  const body = row.text.replace(/\s+/g, " ").trim().slice(0, REPLY_PREVIEW_CHARS);
  return body ? `[${who}] ${body}${row.text.length > REPLY_PREVIEW_CHARS ? "…" : ""}` : null;
}

export function search(db: Store, queryVector: number[], opts: number | SearchOptions = 8): SearchHit[] {
  const options = searchOptions(opts);
  const params: Record<string, string | number> = {};
  const where: string[] = [];
  if (options.since) {
    where.push("ts >= @since");
    params.since = options.since;
  }
  if (options.until) {
    where.push("ts < @until");
    params.until = options.until;
  }
  const repoClause = bindRepoFilter("repo", options, params);
  if (repoClause) where.push(repoClause);
  if (options.branch) {
    where.push("branch = @branch");
    params.branch = options.branch;
  }
  const host = normalizeHost(options.host);
  if (host) {
    where.push("host = @host");
    params.host = host;
  }
  const ex = bindExcludeSessions("session", options.excludeSessions, params);
  if (ex) where.push(ex);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT session, repo, branch, kind, text, vector, host, ts FROM embeddings ${clause}`)
    .all(params) as {
    session: string;
    repo: string | null;
    branch: string | null;
    kind: string;
    text: string;
    vector: Buffer;
    host: string | null;
    ts: string;
  }[];

  const scored = rows
    .map((r) => ({
      session: r.session,
      title: null as string | null,
      repo: r.repo,
      branch: r.branch,
      kind: r.kind,
      text: r.text,
      score: cosineSimilarity(queryVector, blobToVector(r.vector)),
      host: normalizeHost(r.host),
      ts: r.ts as string | null,
      matched: ["semantic"] as ("semantic" | "keyword")[],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 8);
  const titles = getSessionTitles(db, scored.map((h) => h.session));
  for (const hit of scored) hit.title = titles.get(hit.session) ?? null;
  return scored;
}

/**
 * Rank-fusion constant. The standard reciprocal-rank-fusion damping: position 1 is worth
 * 1/61, position 10 worth 1/70 — close enough that agreement between retrievers outweighs
 * a narrow win in either one.
 */
const RRF_K = 60;
/** Candidates pulled from each retriever before fusion. */
const FUSION_CANDIDATES = 200;

/**
 * Search the conversation index by meaning *and* by wording.
 *
 * Pure vector search here ranks over framings and recorded notes only — about 1% of what's
 * stored — so anything said mid-conversation was unfindable and every result looked weak.
 * Fusing in a BM25 pass over the full turn text puts the other 99% back in play. Reciprocal
 * rank fusion is what merges them: it needs no shared score scale (cosine and BM25 have none),
 * and a session both retrievers like beats one that only either does. A third recency list
 * breaks ties toward work that is still relevant.
 */
export function hybridSearch(
  db: Store,
  queryText: string,
  queryVector: number[],
  opts: number | SearchOptions = 8,
): SearchHit[] {
  const options = searchOptions(opts);
  const limit = options.limit ?? 8;

  const semantic = search(db, queryVector, { ...options, limit: FUSION_CANDIDATES });
  const keyword = keywordCandidates(db, queryText, { ...options, limit: FUSION_CANDIDATES });

  const byKey = new Map<string, SearchHit>();
  const fused = new Map<string, number>();
  const addList = (hits: SearchHit[], weight: number) => {
    hits.forEach((hit, i) => {
      const key = hit.session || `${hit.kind}:${hit.text.slice(0, 64)}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...hit });
      } else if (!existing.matched.includes(hit.matched[0])) {
        existing.matched = [...existing.matched, ...hit.matched];
        // A framing or recorded decision says what the session was about; a matching turn only
        // proves the words occur. Keep the descriptive text, keep both signals.
        if (existing.kind === "turn" && hit.kind !== "turn") {
          existing.kind = hit.kind;
          existing.text = hit.text;
        }
      }
      fused.set(key, (fused.get(key) ?? 0) + weight / (RRF_K + i + 1));
    });
  };

  addList(semantic, 1);
  addList(keyword, 1);

  const recent = [...byKey.values()]
    .filter((h) => h.ts)
    .sort((a, b) => (a.ts! < b.ts! ? 1 : a.ts! > b.ts! ? -1 : 0));
  addList(recent, RECENCY_WEIGHT);

  return [...byKey.entries()]
    .map(([key, hit]) => ({ ...hit, score: fused.get(key) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Recency is a tiebreaker, not a ranking signal — a third of a retriever's vote. */
const RECENCY_WEIGHT = 0.33;

/** BM25-ranked turns, one per session, shaped as search hits for fusion. */
function keywordCandidates(db: Store, query: string, opts: SearchOptions): SearchHit[] {
  const turns = grepTurns(db, query, { ...opts, limit: opts.limit ?? FUSION_CANDIDATES });
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const t of turns) {
    if (seen.has(t.session)) continue;
    seen.add(t.session);
    hits.push({
      session: t.session,
      title: t.title,
      repo: t.repo,
      branch: t.branch,
      kind: "turn",
      text: t.snippet.replace(/\s+/g, " ").trim(),
      score: 0,
      host: t.host,
      ts: t.ts,
      matched: ["keyword"],
    });
  }
  return hits;
}

/**
 * Recent sessions by last activity (messages + tool events), optionally scoped by repo/host/time.
 */
export function listRecentSessions(
  db: Store,
  opts: SearchOptions = {},
): SessionSummary[] {
  const params: Record<string, string | number> = { limit: opts.limit ?? 20 };
  const filters: string[] = ["session IS NOT NULL", "session <> ''"];
  if (opts.since) {
    filters.push("ts >= @since");
    params.since = opts.since;
  }
  if (opts.until) {
    filters.push("ts < @until");
    params.until = opts.until;
  }
  const repoClause = bindRepoFilter("repo", opts, params);
  if (repoClause) filters.push(repoClause);
  if (opts.branch) {
    filters.push("branch = @branch");
    params.branch = opts.branch;
  }
  const host = normalizeHost(opts.host);
  if (host) {
    filters.push("host = @host");
    params.host = host;
  }
  const ex = bindExcludeSessions("session", opts.excludeSessions, params);
  if (ex) filters.push(ex);
  const where = `WHERE ${filters.join(" AND ")}`;
  const rows = db
    .prepare(
      `SELECT session,
              MAX(ts) AS lastTs,
              MIN(ts) AS firstTs,
              MAX(host) AS host,
              MAX(repo) AS repo,
              MAX(branch) AS branch
       FROM (
         SELECT session, ts, host, repo, branch FROM messages
         UNION ALL
         SELECT session, ts, host, repo, branch FROM events
           WHERE type = 'tool' OR type IN ('decision', 'learning')
       )
       ${where}
       GROUP BY session
       ORDER BY lastTs DESC
       LIMIT @limit`,
    )
    .all(params) as {
    session: string;
    lastTs: string;
    firstTs: string;
    host: string | null;
    repo: string | null;
    branch: string | null;
  }[];

  const ids = rows.map((r) => r.session);
  const titles = getSessionTitles(db, ids);
  const sizes = getSessionSizes(db, ids);
  return rows.map((r) => ({
    session: r.session,
    title: titles.get(r.session) ?? null,
    host: normalizeHost(r.host),
    repo: r.repo,
    branch: r.branch,
    firstTs: r.firstTs,
    lastTs: r.lastTs,
    turns: sizes.get(r.session)?.turns ?? 0,
    bytes: sizes.get(r.session)?.bytes ?? 0,
  }));
}

export interface NudgeState {
  last_branch: string | null;
  last_nudge_ts: string | null;
  /** When an event-specific nudge (commit/PR/push) last fired — its own cooldown clock. */
  last_event_ts: string | null;
}

export function getNudgeState(db: Store, session: string): NudgeState | undefined {
  return db
    .prepare(`SELECT last_branch, last_nudge_ts, last_event_ts FROM state WHERE session = ?`)
    .get(session) as NudgeState | undefined;
}

export function setNudgeState(
  db: Store,
  session: string,
  branch: string | null,
  ts: string,
  eventTs: string | null = null,
): void {
  db.prepare(
    `INSERT INTO state (session, last_branch, last_nudge_ts, last_event_ts)
     VALUES (@session, @branch, @ts, @eventTs)
     ON CONFLICT(session) DO UPDATE SET last_branch = @branch, last_nudge_ts = @ts, last_event_ts = @eventTs`,
  ).run({ session, branch, ts, eventTs });
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

/**
 * How much of one transcript stream (a parent transcript or a single subagent file) is
 * already in the store. `lastTs` is the timestamp of the last message we wrote, used to
 * confirm the stored rows really are a prefix of what we just parsed.
 */
export interface IngestCursor {
  msgCount: number;
  evCount: number;
  lastTs: string | null;
  /** Row id of the last message written, whose text may still grow (streamed turns). */
  lastId: number | null;
}

export function getIngestCursor(db: Store, filePath: string): IngestCursor | undefined {
  const row = db
    .prepare(`SELECT msg_count, ev_count, last_ts, last_id FROM ingested WHERE path = ?`)
    .get(filePath) as
    | { msg_count: number | null; ev_count: number | null; last_ts: string | null; last_id: number | null }
    | undefined;
  if (!row || row.msg_count === null || row.ev_count === null) return undefined;
  return { msgCount: row.msg_count, evCount: row.ev_count, lastTs: row.last_ts, lastId: row.last_id };
}

export function setIngestCursor(db: Store, filePath: string, mtimeMs: number, cursor: IngestCursor): void {
  db.prepare(
    `INSERT INTO ingested (path, mtime_ms, msg_count, ev_count, last_ts, last_id)
     VALUES (@path, @mtime, @msgCount, @evCount, @lastTs, @lastId)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       msg_count = excluded.msg_count,
       ev_count = excluded.ev_count,
       last_ts = excluded.last_ts,
       last_id = excluded.last_id`,
  ).run({ path: filePath, mtime: mtimeMs, ...cursor });
}

/** Text of a stored message, used to detect a streamed turn that grew since last ingest. */
export function getMessageText(db: Store, id: number): string | undefined {
  const row = db.prepare(`SELECT text FROM messages WHERE id = ?`).get(id) as { text: string } | undefined;
  return row?.text;
}

/** Rewrite a message in place, keeping its FTS entry in sync (external-content index). */
export function updateMessageText(db: Store, id: number, text: string): void {
  const prev = getMessageText(db, id);
  if (prev === undefined) return;
  // External-content FTS wants the OLD text on delete so the inverted index unwinds cleanly.
  db.prepare(`INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', @id, @prev)`).run({
    id,
    prev,
  });
  db.prepare(`UPDATE messages SET text = @text WHERE id = @id`).run({ id, text });
  db.prepare(`INSERT INTO messages_fts (rowid, text) VALUES (@id, @text)`).run({ id, text });
}

/** Drop the ingest cursors for a unit so the next pass rewrites it from scratch. */
export function clearIngestCursors(db: Store, filePaths: string[]): void {
  const stmt = db.prepare(
    `UPDATE ingested SET msg_count = NULL, ev_count = NULL, last_ts = NULL, last_id = NULL WHERE path = ?`,
  );
  for (const p of filePaths) stmt.run(p);
}

/** The stored framing text for a session, so an unchanged framing skips re-embedding. */
export function getFramingText(db: Store, session: string): string | undefined {
  const row = db
    .prepare(`SELECT text FROM embeddings WHERE session = ? AND kind = 'framing' LIMIT 1`)
    .get(session) as { text: string } | undefined;
  return row?.text;
}

/**
 * Remove all rows sourced from a transcript (idempotent re-ingest). `keepFraming` retains the
 * session's framing embedding when its text is unchanged, so a rewrite doesn't re-run the model.
 */
export function deleteSession(db: Store, session: string, opts: { keepFraming?: boolean } = {}): void {
  db.prepare(`DELETE FROM events WHERE session = ? AND type = 'tool'`).run(session);
  if (!opts.keepFraming) db.prepare(`DELETE FROM embeddings WHERE session = ? AND kind = 'framing'`).run(session);
  // Drop FTS rows by messages.id before deleting messages (external-content index).
  db.prepare(
    `DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session = ?)`,
  ).run(session);
  db.prepare(`DELETE FROM messages WHERE session = ?`).run(session);
}

/**
 * Retention safety valve. Drops raw history (messages, turns, tool events, framings) older than
 * `days`; recorded decisions and learnings are kept — they're the distilled long-term memory.
 * `days <= 0` is a no-op (the default: keep everything). Returns the message rows removed.
 */
export function pruneOlderThan(db: Store, days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE ts < @cutoff)`).run({ cutoff });
    const m = db.prepare(`DELETE FROM messages WHERE ts < @cutoff`).run({ cutoff });
    db.prepare(`DELETE FROM events WHERE type = 'tool' AND ts < @cutoff`).run({ cutoff });
    db.prepare(`DELETE FROM embeddings WHERE kind = 'framing' AND ts < @cutoff`).run({ cutoff });
    return m.changes;
  });
  return run();
}

/** The configured retention window in days, or 0 (unlimited) when unset/invalid. */
export function getRetentionDays(db: Store): number {
  const raw = getMeta(db, "retention_days");
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
