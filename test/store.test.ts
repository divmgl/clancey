import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import {
  Store,
  openStore,
  insertToolEvent,
  insertNote,
  insertEmbedding,
  recall,
  search,
  grepTurns,
  getNudgeState,
  setNudgeState,
  insertTurn,
  getTurns,
  deleteSession,
  getNote,
  updateNote,
  deleteNote,
  noteText,
} from "../src/store.ts";

let dbPath: string;
let db: Store;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `clancey-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = openStore(dbPath);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
});

function tool(over: Partial<Parameters<typeof insertToolEvent>[1]> = {}) {
  insertToolEvent(db, {
    session: "s1",
    repo: "/repo",
    branch: "feature/x",
    cwd: "/repo",
    tool: "Edit",
    file: "/repo/src/a.ts",
    command: null,
    ts: "2026-01-01T00:00:00Z",
    ...over,
  });
}

describe("recall", () => {
  test("groups events by (repo, branch) with files, sessions, decisions, and learnings", () => {
    tool({ file: "/repo/src/a.ts", ts: "2026-01-01T00:00:01Z" });
    tool({ file: "/repo/src/b.ts", session: "s2", ts: "2026-01-01T00:00:02Z" });
    const decisionId = insertNote(db, {
      kind: "decision",
      session: "s1",
      repo: "/repo",
      branch: "feature/x",
      body: "Split auth module",
      detail: "It was tangled",
      files: ["/repo/src/a.ts"],
      ts: "2026-01-01T00:00:03Z",
    });
    const learningId = insertNote(db, {
      kind: "learning",
      session: "s1",
      repo: "/repo",
      branch: "feature/x",
      body: "Sessions are cookie-bound",
      detail: "The refresh token lives in an httpOnly cookie",
      files: null,
      ts: "2026-01-01T00:00:04Z",
    });

    const items = recall(db, { branch: "feature/x" });
    assert.equal(items.length, 1);
    const w = items[0];
    assert.equal(w.branch, "feature/x");
    assert.deepEqual(new Set(w.files), new Set(["/repo/src/a.ts", "/repo/src/b.ts"]));
    assert.deepEqual(new Set(w.sessions), new Set(["s1", "s2"]));
    assert.equal(w.toolEventCount, 2);
    assert.deepEqual(w.decisions, [
      { id: decisionId, decision: "Split auth module", why: "It was tangled", ts: "2026-01-01T00:00:03Z" },
    ]);
    assert.deepEqual(w.learnings, [
      {
        id: learningId,
        learning: "Sessions are cookie-bound",
        context: "The refresh token lives in an httpOnly cookie",
        ts: "2026-01-01T00:00:04Z",
      },
    ]);
  });

  test("filters by file substring and returns the full work item", () => {
    tool({ branch: "feature/x", file: "/repo/src/auth.ts" });
    tool({ branch: "feature/y", file: "/repo/src/unrelated.ts" });
    const items = recall(db, { file: "auth.ts" });
    assert.equal(items.length, 1);
    assert.equal(items[0].branch, "feature/x");
  });

  test("separates distinct branches", () => {
    tool({ branch: "feature/x" });
    tool({ branch: "feature/y" });
    assert.equal(recall(db).length, 2);
  });
});

describe("search", () => {
  test("ranks by cosine similarity descending", () => {
    insertEmbedding(db, { session: "s1", repo: "/repo", branch: "a", kind: "decision", text: "x axis", vector: [1, 0, 0], ts: "t" });
    insertEmbedding(db, { session: "s2", repo: "/repo", branch: "b", kind: "framing", text: "y axis", vector: [0, 1, 0], ts: "t" });
    insertEmbedding(db, { session: "s3", repo: "/repo", branch: "c", kind: "framing", text: "diagonal", vector: [0.7, 0.7, 0], ts: "t" });

    const hits = search(db, [1, 0, 0], 3);
    assert.deepEqual(hits.map((h) => h.session), ["s1", "s3", "s2"]);
    assert.ok(hits[0].score > hits[1].score);
    assert.ok(hits[1].score > hits[2].score);
  });

  test("respects the limit", () => {
    insertEmbedding(db, { session: "s1", repo: null, branch: null, kind: "decision", text: "a", vector: [1, 0], ts: "t" });
    insertEmbedding(db, { session: "s2", repo: null, branch: null, kind: "decision", text: "b", vector: [0, 1], ts: "t" });
    assert.equal(search(db, [1, 0], 1).length, 1);
  });
});

describe("turns", () => {
  test("stores and returns turns in chronological order", () => {
    insertTurn(db, { session: "s1", ts: "2026-01-01T00:00:02Z", branch: "feature/x", text: "second" });
    insertTurn(db, { session: "s1", ts: "2026-01-01T00:00:01Z", branch: "feature/x", text: "first" });
    assert.deepEqual(
      getTurns(db, "s1").map((t) => t.text),
      ["first", "second"],
    );
  });

  test("filters by branch", () => {
    insertTurn(db, { session: "s1", ts: "t1", branch: "feature/x", text: "x turn" });
    insertTurn(db, { session: "s1", ts: "t2", branch: "feature/y", text: "y turn" });
    assert.deepEqual(
      getTurns(db, "s1", "feature/y").map((t) => t.text),
      ["y turn"],
    );
  });

  test("deleteSession clears the session's turns", () => {
    insertTurn(db, { session: "s1", ts: "t1", branch: null, text: "gone" });
    insertTurn(db, { session: "s2", ts: "t1", branch: null, text: "kept" });
    deleteSession(db, "s1");
    assert.equal(getTurns(db, "s1").length, 0);
    assert.equal(getTurns(db, "s2").length, 1);
  });
});

describe("grepTurns", () => {
  test("finds a turn by keyword that semantic search would miss", () => {
    insertTurn(db, {
      session: "s1",
      ts: "t1",
      branch: "feature/x",
      text: "the effort label should be ez, normal, or heroic",
    });
    insertTurn(db, { session: "s2", ts: "t2", branch: "feature/y", text: "unrelated chatter about icons" });
    const hits = grepTurns(db, "effort label");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].session, "s1");
    assert.equal(hits[0].branch, "feature/x");
    assert.match(hits[0].snippet, /effort/);
  });

  test("matches any term and ranks turns hitting more of them first (OR semantics)", () => {
    insertTurn(db, { session: "s1", ts: "t1", branch: null, text: "effort and difficulty together" });
    insertTurn(db, { session: "s2", ts: "t2", branch: null, text: "effort alone" });
    insertTurn(db, { session: "s3", ts: "t3", branch: null, text: "nothing relevant here" });
    // Both s1 and s2 surface (a missing word doesn't wipe results); s1 ranks first.
    assert.deepEqual(
      grepTurns(db, "effort difficulty").map((h) => h.session),
      ["s1", "s2"],
    );
  });

  test("sanitizes punctuation and FTS operators instead of throwing", () => {
    insertTurn(db, { session: "s1", ts: "t1", branch: null, text: "the build broke on CI again" });
    assert.doesNotThrow(() => grepTurns(db, 'build AND "CI" OR (broke)*'));
    assert.deepEqual(
      grepTurns(db, "build CI broke").map((h) => h.session),
      ["s1"],
    );
  });

  test("returns nothing for a query with no searchable tokens", () => {
    insertTurn(db, { session: "s1", ts: "t1", branch: null, text: "anything" });
    assert.deepEqual(grepTurns(db, "  -- !! "), []);
  });

  test("deleteSession removes turns from the full-text index", () => {
    insertTurn(db, { session: "s1", ts: "t1", branch: null, text: "ephemeral note" });
    deleteSession(db, "s1");
    assert.deepEqual(grepTurns(db, "ephemeral"), []);
  });

  test("respects the limit", () => {
    insertTurn(db, { session: "s1", ts: "t1", branch: null, text: "shared keyword one" });
    insertTurn(db, { session: "s2", ts: "t2", branch: null, text: "shared keyword two" });
    assert.equal(grepTurns(db, "shared keyword", 1).length, 1);
  });
});

describe("nudge state", () => {
  test("upserts last branch and nudge timestamp", () => {
    assert.equal(getNudgeState(db, "s1"), undefined);
    setNudgeState(db, "s1", "feature/x", "2026-01-01T00:00:00Z");
    assert.deepEqual(getNudgeState(db, "s1"), { last_branch: "feature/x", last_nudge_ts: "2026-01-01T00:00:00Z" });
    setNudgeState(db, "s1", "feature/y", "2026-01-01T01:00:00Z");
    assert.deepEqual(getNudgeState(db, "s1"), { last_branch: "feature/y", last_nudge_ts: "2026-01-01T01:00:00Z" });
  });
});

describe("schema migration", () => {
  test("adds event_id to an embeddings table created before the column existed", () => {
    const p = path.join(os.tmpdir(), `clancey-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const old = new Database(p);
    old.exec(`CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, session TEXT, repo TEXT, branch TEXT, kind TEXT, text TEXT, vector BLOB)`);
    old.prepare(`INSERT INTO embeddings (ts, kind, text, vector) VALUES ('t', 'decision', 'legacy', x'00')`).run();
    old.close();

    const migrated = openStore(p);
    try {
      const cols = (migrated.prepare(`PRAGMA table_info(embeddings)`).all() as { name: string }[]).map((c) => c.name);
      assert.ok(cols.includes("event_id"));
      const row = migrated.prepare(`SELECT text, event_id FROM embeddings WHERE text = 'legacy'`).get() as {
        text: string;
        event_id: number | null;
      };
      assert.deepEqual(row, { text: "legacy", event_id: null });
    } finally {
      migrated.close();
      for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
    }
  });

  test("indexes pre-existing turns into turns_fts when the FTS table is first created", () => {
    const p = path.join(os.tmpdir(), `clancey-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const old = new Database(p);
    old.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, ts TEXT NOT NULL, branch TEXT, text TEXT NOT NULL)`);
    old.prepare(`INSERT INTO turns (session, ts, branch, text) VALUES ('s1', 't1', 'b', 'historical effort note')`).run();
    old.close();

    const migrated = openStore(p);
    try {
      assert.deepEqual(
        grepTurns(migrated, "historical effort").map((h) => h.session),
        ["s1"],
      );
    } finally {
      migrated.close();
      for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
    }
  });
});

describe("note editing", () => {
  function record(kind: "decision" | "learning", body: string, detail: string | null, eventLinked: boolean): number {
    const id = insertNote(db, { kind, session: null, repo: "/r", branch: "b", body, detail, files: null, ts: "t" });
    insertEmbedding(db, {
      session: "",
      repo: "/r",
      branch: "b",
      kind,
      text: noteText(body, detail),
      vector: [1, 0],
      ts: "t",
      eventId: eventLinked ? id : null,
    });
    return id;
  }

  function embeddings(kind: "decision" | "learning"): { text: string }[] {
    return db.prepare(`SELECT text FROM embeddings WHERE kind = ?`).all(kind) as { text: string }[];
  }

  test("insertNote returns an id that getNote resolves with its kind", () => {
    const id = record("decision", "D", "W", true);
    assert.deepEqual(getNote(db, id), { id, kind: "decision", body: "D", detail: "W", repo: "/r", branch: "b" });
  });

  test("getNote reports the learning kind", () => {
    const id = record("learning", "L", "C", true);
    assert.deepEqual(getNote(db, id), { id, kind: "learning", body: "L", detail: "C", repo: "/r", branch: "b" });
  });

  test("updateNote rewrites the event and replaces the linked embedding", () => {
    const id = record("decision", "old", "oldwhy", true);
    assert.equal(updateNote(db, id, { body: "new", detail: "newwhy" }, [0, 1]), true);
    assert.equal(getNote(db, id)?.body, "new");
    assert.deepEqual(embeddings("decision"), [{ text: "new — newwhy" }]);
  });

  test("updateNote on a learning keeps its kind embedding", () => {
    const id = record("learning", "old", null, true);
    assert.equal(updateNote(db, id, { body: "new", detail: "ctx" }, [0, 1]), true);
    assert.deepEqual(embeddings("learning"), [{ text: "new — ctx" }]);
  });

  test("deleteNote removes the event and its embedding", () => {
    const id = record("decision", "D", "W", true);
    assert.equal(deleteNote(db, id), true);
    assert.equal(getNote(db, id), undefined);
    assert.equal(embeddings("decision").length, 0);
  });

  test("removes a legacy embedding linked only by text (event_id null)", () => {
    const id = record("decision", "D", "W", false);
    assert.equal(deleteNote(db, id), true);
    assert.equal(embeddings("decision").length, 0);
  });

  test("returns false for a missing id", () => {
    assert.equal(deleteNote(db, 999), false);
    assert.equal(updateNote(db, 999, { body: "x", detail: null }, [0, 1]), false);
  });
});
