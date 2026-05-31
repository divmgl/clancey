import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  Store,
  openStore,
  insertToolEvent,
  insertDecision,
  insertEmbedding,
  recall,
  search,
  getNudgeState,
  setNudgeState,
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
  test("groups events by (repo, branch) with files, sessions, and decisions", () => {
    tool({ file: "/repo/src/a.ts", ts: "2026-01-01T00:00:01Z" });
    tool({ file: "/repo/src/b.ts", session: "s2", ts: "2026-01-01T00:00:02Z" });
    insertDecision(db, {
      session: "s1",
      repo: "/repo",
      branch: "feature/x",
      decision: "Split auth module",
      why: "It was tangled",
      files: ["/repo/src/a.ts"],
      ts: "2026-01-01T00:00:03Z",
    });

    const items = recall(db, { branch: "feature/x" });
    assert.equal(items.length, 1);
    const w = items[0];
    assert.equal(w.branch, "feature/x");
    assert.deepEqual(new Set(w.files), new Set(["/repo/src/a.ts", "/repo/src/b.ts"]));
    assert.deepEqual(new Set(w.sessions), new Set(["s1", "s2"]));
    assert.equal(w.toolEventCount, 2);
    assert.deepEqual(w.decisions, [{ decision: "Split auth module", why: "It was tangled", ts: "2026-01-01T00:00:03Z" }]);
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

describe("nudge state", () => {
  test("upserts last branch and nudge timestamp", () => {
    assert.equal(getNudgeState(db, "s1"), undefined);
    setNudgeState(db, "s1", "feature/x", "2026-01-01T00:00:00Z");
    assert.deepEqual(getNudgeState(db, "s1"), { last_branch: "feature/x", last_nudge_ts: "2026-01-01T00:00:00Z" });
    setNudgeState(db, "s1", "feature/y", "2026-01-01T01:00:00Z");
    assert.deepEqual(getNudgeState(db, "s1"), { last_branch: "feature/y", last_nudge_ts: "2026-01-01T01:00:00Z" });
  });
});
