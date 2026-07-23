import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { vectorToBlob, blobToVector, cosineSimilarity } from "./embeddings.js";
import { expandRepoFilterKeys } from "./git.js";
import { resolveClanceyDir, resolveDbPath } from "./paths.js";

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
  repo: string | null;
  branch: string | null;
  kind: string;
  text: string;
  score: number;
  host: Host | null;
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
  host: Host | null;
  repo: string | null;
  branch: string | null;
  firstTs: string;
  lastTs: string;
}

export function openStore(dbPath: string = resolveDbPath()): Store {
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

/** Snapshot a full conversation message (any role, including subagents) and index it for grep. */
export function insertMessage(db: Store, m: MessageInput): void {
  const info = db
    .prepare(
      `INSERT INTO messages (session, ts, branch, role, agent, agent_id, text, host, repo)
       VALUES (@session, @ts, @branch, @role, @agent, @agentId, @text, @host, @repo)`,
    )
    .run({ ...m, host: m.host ?? null, repo: m.repo ?? null });
  db.prepare(`INSERT INTO messages_fts (rowid, text) VALUES (@rowid, @text)`).run({
    rowid: Number(info.lastInsertRowid),
    text: m.text,
  });
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
  branch: string | null;
  ts: string;
  role: string;
  agent: string | null;
  snippet: string;
  host: Host | null;
  repo: string | null;
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression: extract word tokens,
 * quote each (so punctuation and FTS operators can't break the syntax), and OR them.
 * OR (not AND) keeps this a forgiving fallback — a turn matching most of the words
 * still surfaces, ranked above weaker matches by BM25, instead of one absent word
 * wiping out every result. Returns null when the query has no searchable tokens.
 */
function ftsQuery(raw: string): string | null {
  const terms = raw.match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
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

export function grepTurns(db: Store, query: string, opts: number | SearchOptions = 8): TurnHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const options = searchOptions(opts);
  const params: Record<string, string | number> = { match, limit: options.limit ?? 8 };
  // Scope columns live on the joined `messages` row (alias m).
  // Keep messages_fts unaliased so MATCH/snippet/rank bind correctly under better-sqlite3.
  const scope = scopeWhere("m", options, params);
  // Prefer columns from `messages` (content table). FTS5 joined tables reject
  // messages_fts.col qualification in SELECT under better-sqlite3.
  const rows = db
    .prepare(
      `SELECT m.session AS session, m.branch AS branch, m.ts AS ts, m.role AS role, m.agent AS agent,
              snippet(messages_fts, 0, '«', '»', '…', 16) AS snippet,
              m.host AS host, m.repo AS repo
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH @match
       ${scope}
       ORDER BY rank LIMIT @limit`,
    )
    .all(params) as {
    session: string;
    branch: string | null;
    ts: string;
    role: string;
    agent: string | null;
    snippet: string;
    host: string | null;
    repo: string | null;
  }[];
  return rows.map((r) => ({
    session: r.session,
    branch: r.branch,
    ts: r.ts,
    role: r.role,
    agent: r.agent,
    snippet: r.snippet,
    host: normalizeHost(r.host),
    repo: r.repo,
  }));
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
    .prepare(`SELECT session, repo, branch, kind, text, vector, host FROM embeddings ${clause}`)
    .all(params) as {
    session: string;
    repo: string | null;
    branch: string | null;
    kind: string;
    text: string;
    vector: Buffer;
    host: string | null;
  }[];

  return rows
    .map((r) => ({
      session: r.session,
      repo: r.repo,
      branch: r.branch,
      kind: r.kind,
      text: r.text,
      score: cosineSimilarity(queryVector, blobToVector(r.vector)),
      host: normalizeHost(r.host),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 8);
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

  return rows.map((r) => ({
    session: r.session,
    host: normalizeHost(r.host),
    repo: r.repo,
    branch: r.branch,
    firstTs: r.firstTs,
    lastTs: r.lastTs,
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

/** Remove all rows sourced from a transcript (idempotent re-ingest). */
export function deleteSession(db: Store, session: string): void {
  db.prepare(`DELETE FROM events WHERE session = ? AND type = 'tool'`).run(session);
  db.prepare(`DELETE FROM embeddings WHERE session = ? AND kind = 'framing'`).run(session);
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
