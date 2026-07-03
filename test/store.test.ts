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
  insertMessage,
  getMessages,
  pruneOlderThan,
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

  test("filters returned work to an exclusive time window", () => {
    tool({ session: "old", file: "/repo/src/old.ts", ts: "2026-01-01T00:00:00.000Z" });
    tool({ session: "inside", file: "/repo/src/inside.ts", ts: "2026-01-02T00:00:00.000Z" });
    tool({ session: "after", file: "/repo/src/after.ts", ts: "2026-01-03T00:00:00.000Z" });

    const items = recall(db, {
      branch: "feature/x",
      since: "2026-01-02T00:00:00.000Z",
      until: "2026-01-03T00:00:00.000Z",
    });

    assert.equal(items.length, 1);
    assert.deepEqual(items[0].sessions, ["inside"]);
    assert.deepEqual(items[0].files, ["/repo/src/inside.ts"]);
    assert.equal(items[0].firstTs, "2026-01-02T00:00:00.000Z");
    assert.equal(items[0].lastTs, "2026-01-02T00:00:00.000Z");
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

  test("filters embeddings by exclusive time window before ranking", () => {
    insertEmbedding(db, {
      session: "old",
      repo: "/repo",
      branch: "a",
      kind: "decision",
      text: "best but too old",
      vector: [1, 0],
      ts: "2026-01-01T00:00:00.000Z",
    });
    insertEmbedding(db, {
      session: "inside",
      repo: "/repo",
      branch: "b",
      kind: "decision",
      text: "inside window",
      vector: [0.8, 0.2],
      ts: "2026-01-02T00:00:00.000Z",
    });
    insertEmbedding(db, {
      session: "after",
      repo: "/repo",
      branch: "c",
      kind: "decision",
      text: "boundary excluded",
      vector: [1, 0],
      ts: "2026-01-03T00:00:00.000Z",
    });

    const hits = search(db, [1, 0], {
      since: "2026-01-02T00:00:00.000Z",
      until: "2026-01-03T00:00:00.000Z",
      limit: 8,
    });

    assert.deepEqual(hits.map((h) => h.session), ["inside"]);
  });
});

function msg(over: Partial<Parameters<typeof insertMessage>[1]> = {}) {
  insertMessage(db, {
    session: "s1",
    ts: "2026-01-01T00:00:00Z",
    branch: "feature/x",
    role: "user",
    agent: null,
    agentId: null,
    text: "hello there",
    ...over,
  });
}

describe("messages", () => {
  test("stores and returns the full conversation in chronological order", () => {
    msg({ ts: "2026-01-01T00:00:02Z", role: "assistant", text: "second" });
    msg({ ts: "2026-01-01T00:00:01Z", text: "first" });
    assert.deepEqual(
      getMessages(db, "s1").map((m) => m.text),
      ["first", "second"],
    );
  });

  test("preserves role and subagent attribution", () => {
    msg({ ts: "t1", role: "user", text: "ask" });
    msg({ ts: "t2", role: "assistant", agent: "Explore", text: "explored" });
    const got = getMessages(db, "s1");
    assert.deepEqual(
      got.map((m) => [m.role, m.agent]),
      [
        ["user", null],
        ["assistant", "Explore"],
      ],
    );
  });

  test("filters by branch", () => {
    msg({ ts: "t1", branch: "feature/x", text: "x turn" });
    msg({ ts: "t2", branch: "feature/y", text: "y turn" });
    assert.deepEqual(
      getMessages(db, "s1", "feature/y").map((m) => m.text),
      ["y turn"],
    );
  });

  test("deleteSession clears the session's messages", () => {
    msg({ ts: "t1", text: "gone" });
    msg({ session: "s2", ts: "t1", text: "kept" });
    deleteSession(db, "s1");
    assert.equal(getMessages(db, "s1").length, 0);
    assert.equal(getMessages(db, "s2").length, 1);
  });
});

describe("grepTurns", () => {
  test("finds an assistant-authored script body the user never typed", () => {
    msg({ session: "s1", ts: "t1", role: "assistant", text: "「Bash」\nnode run-cohort.ts --count 6" });
    msg({ session: "s2", ts: "t2", role: "assistant", text: "unrelated chatter about icons" });
    const hits = grepTurns(db, "cohort");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].session, "s1");
    assert.equal(hits[0].role, "assistant");
    assert.match(hits[0].snippet, /cohort/);
  });

  test("surfaces subagent turns with their agent attribution", () => {
    msg({ session: "s1", ts: "t1", role: "assistant", agent: "Explore", text: "found the entrypoint in run-headless-agent" });
    const hits = grepTurns(db, "entrypoint");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].role, "assistant");
    assert.equal(hits[0].agent, "Explore");
  });

  test("matches any term and ranks turns hitting more of them first (OR semantics)", () => {
    msg({ session: "s1", ts: "t1", branch: null, text: "effort and difficulty together" });
    msg({ session: "s2", ts: "t2", branch: null, text: "effort alone" });
    msg({ session: "s3", ts: "t3", branch: null, text: "nothing relevant here" });
    // Both s1 and s2 surface (a missing word doesn't wipe results); s1 ranks first.
    assert.deepEqual(
      grepTurns(db, "effort difficulty").map((h) => h.session),
      ["s1", "s2"],
    );
  });

  test("sanitizes punctuation and FTS operators instead of throwing", () => {
    msg({ session: "s1", ts: "t1", branch: null, text: "the build broke on CI again" });
    assert.doesNotThrow(() => grepTurns(db, 'build AND "CI" OR (broke)*'));
    assert.deepEqual(
      grepTurns(db, "build CI broke").map((h) => h.session),
      ["s1"],
    );
  });

  test("returns nothing for a query with no searchable tokens", () => {
    msg({ session: "s1", ts: "t1", branch: null, text: "anything" });
    assert.deepEqual(grepTurns(db, "  -- !! "), []);
  });

  test("deleteSession removes messages from the full-text index", () => {
    msg({ session: "s1", ts: "t1", branch: null, text: "ephemeral note" });
    deleteSession(db, "s1");
    assert.deepEqual(grepTurns(db, "ephemeral"), []);
  });

  test("respects the limit", () => {
    msg({ session: "s1", ts: "t1", branch: null, text: "shared keyword one" });
    msg({ session: "s2", ts: "t2", branch: null, text: "shared keyword two" });
    assert.equal(grepTurns(db, "shared keyword", 1).length, 1);
  });

  test("filters turns by exclusive time window", () => {
    msg({ session: "old", ts: "2026-01-01T00:00:00.000Z", branch: null, text: "shared keyword old" });
    msg({ session: "inside", ts: "2026-01-02T00:00:00.000Z", branch: null, text: "shared keyword inside" });
    msg({ session: "after", ts: "2026-01-03T00:00:00.000Z", branch: null, text: "shared keyword after" });

    const hits = grepTurns(db, "shared keyword", {
      since: "2026-01-02T00:00:00.000Z",
      until: "2026-01-03T00:00:00.000Z",
      limit: 8,
    });

    assert.deepEqual(hits.map((h) => h.session), ["inside"]);
  });
});

describe("pruneOlderThan", () => {
  test("drops history older than the window but keeps recent rows and recorded notes", () => {
    const old = "2020-01-01T00:00:00Z";
    const recent = new Date().toISOString();
    msg({ session: "s1", ts: old, text: "ancient turn" });
    msg({ session: "s1", ts: recent, text: "fresh turn" });
    insertNote(db, { kind: "decision", session: "s1", repo: "/r", branch: "b", body: "kept decision", detail: null, files: null, ts: old });

    const removed = pruneOlderThan(db, 30);
    assert.equal(removed, 1);
    assert.deepEqual(
      getMessages(db, "s1").map((m) => m.text),
      ["fresh turn"],
    );
    assert.deepEqual(grepTurns(db, "ancient"), []);
    // Recorded decisions are the distilled long-term memory — never pruned.
    assert.equal(recall(db, { branch: "b" })[0].decisions.length, 1);
  });

  test("is a no-op for a non-positive window", () => {
    msg({ session: "s1", ts: "2020-01-01T00:00:00Z", text: "ancient" });
    assert.equal(pruneOlderThan(db, 0), 0);
    assert.equal(getMessages(db, "s1").length, 1);
  });
});

describe("nudge state", () => {
  test("upserts last branch and nudge timestamp", () => {
    assert.equal(getNudgeState(db, "s1"), undefined);
    setNudgeState(db, "s1", "feature/x", "2026-01-01T00:00:00Z");
    assert.deepEqual(getNudgeState(db, "s1"), {
      last_branch: "feature/x",
      last_nudge_ts: "2026-01-01T00:00:00Z",
      last_event_ts: null,
    });
    setNudgeState(db, "s1", "feature/y", "2026-01-01T01:00:00Z");
    assert.deepEqual(getNudgeState(db, "s1"), {
      last_branch: "feature/y",
      last_nudge_ts: "2026-01-01T01:00:00Z",
      last_event_ts: null,
    });
  });

  test("records an event timestamp independently of the generic nudge timestamp", () => {
    setNudgeState(db, "s1", "feature/x", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z");
    assert.deepEqual(getNudgeState(db, "s1"), {
      last_branch: "feature/x",
      last_nudge_ts: "2026-01-01T00:00:00Z",
      last_event_ts: "2026-01-01T00:05:00Z",
    });
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

  test("indexes pre-existing messages into messages_fts when the FTS table is first created", () => {
    const p = path.join(os.tmpdir(), `clancey-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const old = new Database(p);
    old.exec(
      `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, ts TEXT NOT NULL, branch TEXT, role TEXT NOT NULL, agent TEXT, agent_id TEXT, text TEXT NOT NULL)`,
    );
    old
      .prepare(`INSERT INTO messages (session, ts, branch, role, agent, agent_id, text) VALUES ('s1', 't1', 'b', 'assistant', NULL, NULL, 'historical effort note')`)
      .run();
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

  test("adds messages/events.agent and drops the legacy turns table on an old db", () => {
    const p = path.join(os.tmpdir(), `clancey-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const old = new Database(p);
    old.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, session TEXT, repo TEXT, branch TEXT, cwd TEXT, tool TEXT, file TEXT, command TEXT, decision TEXT, why TEXT, files_json TEXT)`);
    old.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, ts TEXT NOT NULL, branch TEXT, text TEXT NOT NULL)`);
    old.close();

    const migrated = openStore(p);
    try {
      const tables = (migrated.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','virtual')`).all() as { name: string }[]).map((t) => t.name);
      assert.ok(tables.includes("messages"));
      assert.ok(!tables.includes("turns"), "legacy turns table is dropped");
      const eventCols = (migrated.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map((c) => c.name);
      assert.ok(eventCols.includes("agent"));
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
