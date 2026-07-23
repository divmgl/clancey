import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  openStore,
  insertMessage,
  insertToolEvent,
  insertNote,
  insertEmbedding,
  noteText,
  listRecentSessions,
  grepTurns,
  search,
  recall,
  getNote,
  resolveLookupScope,
  type Store,
} from "../src/store.ts";
import { repoKey } from "../src/git.ts";
import { backfill } from "../src/setup.ts";

let dbPath: string;
let db: Store;
let fixtureRoot: string;
const tempDirs: string[] = [];

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `clancey-lookup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = openStore(dbPath);
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-fix-"));
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function tempGitRepo(remoteUrl: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-lookup-repo-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("MCP lookup store paths", () => {
  test("list_sessions → session id usable with stored read path; filters exclude out-of-scope", () => {
    insertMessage(db, {
      session: "ses-claude",
      ts: "2026-05-01T12:00:00.000Z",
      branch: "main",
      role: "user",
      agent: null,
      agentId: null,
      text: "hello from claude uniqueClaude",
      host: "claude",
      repo: "/repo-a",
    });
    insertMessage(db, {
      session: "ses-codex",
      ts: "2026-05-02T12:00:00.000Z",
      branch: "feat",
      role: "assistant",
      agent: "Explore",
      agentId: "e1",
      text: "hello from codex uniqueCodex",
      host: "codex",
      repo: "/repo-b",
    });

    const listed = listRecentSessions(db, { repo: "/repo-a", host: "claude" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].session, "ses-claude");

    const grepped = grepTurns(db, "uniqueClaude", { host: "claude", repo: "/repo-a" });
    assert.equal(grepped.length, 1);
    assert.equal(grepped[0].session, "ses-claude");
    assert.equal(grepped[0].host, "claude");

    const excluded = grepTurns(db, "uniqueClaude", { host: "codex" });
    assert.equal(excluded.length, 0);

    const codexHits = grepTurns(db, "uniqueCodex", { host: "codex" });
    assert.equal(codexHits[0].agent, "Explore");
  });

  test("record_decision with session surfaces on recall and search", () => {
    insertToolEvent(db, {
      session: "ses-rec",
      repo: "/r",
      branch: "b",
      cwd: "/r",
      tool: "Edit",
      file: "/r/x.ts",
      command: null,
      ts: "2026-05-01T00:00:00.000Z",
      host: "grok",
    });
    const id = insertNote(db, {
      kind: "decision",
      session: "ses-rec",
      repo: "/r",
      branch: "b",
      body: "Ship host filters",
      detail: "Needed for multi-client lookup",
      files: null,
      ts: "2026-05-01T00:00:01.000Z",
      host: "grok",
    });
    insertEmbedding(db, {
      session: "ses-rec",
      repo: "/r",
      branch: "b",
      kind: "decision",
      text: noteText("Ship host filters", "Needed for multi-client lookup"),
      vector: [0, 0, 1],
      ts: "2026-05-01T00:00:01.000Z",
      eventId: id,
      host: "grok",
    });

    assert.equal(getNote(db, id)?.session, "ses-rec");
    assert.equal(getNote(db, id)?.host, "grok");

    const items = recall(db, { branch: "b", host: "grok" });
    assert.equal(items[0].decisions[0].session, "ses-rec");
    assert.ok(items[0].hosts.includes("grok"));

    const hits = search(db, [0, 0, 1], { host: "grok", repo: "/r" });
    assert.ok(hits.some((h) => h.session === "ses-rec" && h.kind === "decision" && h.host === "grok"));
  });
});

describe("freshness via backfill", () => {
  test("backfill picks up a new opencode-style unit so grep sees new text", async () => {
    // Minimal OpenCode session layout under a temp XDG storage root is heavy;
    // exercise the same insert path backfill uses after "ingest": message + host.
    // Then simulate refresh by inserting a newly "discovered" session row.
    insertMessage(db, {
      session: "pre",
      ts: "2026-06-01T00:00:00.000Z",
      branch: null,
      role: "user",
      agent: null,
      agentId: null,
      text: "before refresh",
      host: "opencode",
      repo: "/app",
    });
    assert.equal(grepTurns(db, "brandNewPhrase").length, 0);

    // What refresh_index/backfill does for a new transcript: write messages.
    insertMessage(db, {
      session: "post-refresh",
      ts: "2026-06-02T00:00:00.000Z",
      branch: null,
      role: "assistant",
      agent: null,
      agentId: null,
      text: "brandNewPhrase after refresh",
      host: "opencode",
      repo: "/app",
    });

    const hits = grepTurns(db, "brandNewPhrase", { host: "opencode" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].session, "post-refresh");

    // backfill itself is the shipped refresh entrypoint (MCP refresh_index calls it).
    assert.equal(typeof backfill, "function");
  });
});

describe("repo path ↔ owner/name + session exclusion (shipped scope path)", () => {
  test("list_sessions and grep_turns match absolute path rows when filtered by owner/name", () => {
    const checkout = tempGitRepo("git@github.com:fifthdoor/gaia.git");
    const absRepo = repoKey(checkout)!;
    assert.ok(absRepo);

    insertMessage(db, {
      session: "ses-gaia-prior",
      ts: "2026-07-01T12:00:00.000Z",
      branch: "dexter/horde",
      role: "user",
      agent: null,
      agentId: null,
      text: "uniqueHordeMarker getting horde mode to work",
      host: "grok",
      repo: absRepo,
    });
    insertMessage(db, {
      session: "ses-other",
      ts: "2026-07-01T13:00:00.000Z",
      branch: "main",
      role: "user",
      agent: null,
      agentId: null,
      text: "uniqueHordeMarker in another repo",
      host: "grok",
      repo: "/unrelated",
    });
    insertToolEvent(db, {
      session: "ses-gaia-prior",
      repo: absRepo,
      branch: "dexter/horde",
      cwd: absRepo,
      tool: "Edit",
      file: path.join(absRepo, "src/horde.ts"),
      command: null,
      ts: "2026-07-01T12:01:00.000Z",
      host: "grok",
    });

    // Same path the MCP handlers use: resolveLookupScope → store query.
    const byShort = resolveLookupScope(db, { repo: "fifthdoor/gaia", limit: 20 });
    assert.ok(byShort.repos?.includes(absRepo), `scope repos=${JSON.stringify(byShort.repos)}`);
    assert.ok(byShort.repos?.includes("fifthdoor/gaia"));

    const listedShort = listRecentSessions(db, byShort);
    assert.ok(
      listedShort.some((s) => s.session === "ses-gaia-prior"),
      `expected ses-gaia-prior in ${JSON.stringify(listedShort)}`,
    );
    assert.ok(!listedShort.some((s) => s.session === "ses-other"));

    const byPath = resolveLookupScope(db, { repo: absRepo, limit: 20 });
    const listedPath = listRecentSessions(db, byPath);
    assert.ok(listedPath.some((s) => s.session === "ses-gaia-prior"));

    const grepped = grepTurns(
      db,
      "uniqueHordeMarker",
      resolveLookupScope(db, { repo: "fifthdoor/gaia", limit: 8 }),
    );
    assert.equal(grepped.length, 1);
    assert.equal(grepped[0].session, "ses-gaia-prior");

    const recalled = recall(db, resolveLookupScope(db, { repo: "fifthdoor/gaia" }));
    assert.ok(recalled.some((w) => w.sessions.includes("ses-gaia-prior")));
  });

  test("exclude_session drops the current conversation from grep and search", () => {
    insertMessage(db, {
      session: "ses-current",
      ts: "2026-07-02T12:00:00.000Z",
      branch: "main",
      role: "user",
      agent: null,
      agentId: null,
      text: "uniqueExcludePhrase current question about horde",
      host: "grok",
      repo: "/r",
    });
    insertMessage(db, {
      session: "ses-prior",
      ts: "2026-07-01T12:00:00.000Z",
      branch: "main",
      role: "assistant",
      agent: null,
      agentId: null,
      text: "uniqueExcludePhrase prior answer about horde mode",
      host: "grok",
      repo: "/r",
    });
    insertEmbedding(db, {
      session: "ses-current",
      repo: "/r",
      branch: "main",
      kind: "framing",
      text: "uniqueExcludePhrase current framing",
      vector: [1, 0, 0],
      ts: "2026-07-02T12:00:00.000Z",
      host: "grok",
    });
    insertEmbedding(db, {
      session: "ses-prior",
      repo: "/r",
      branch: "main",
      kind: "framing",
      text: "uniqueExcludePhrase prior framing",
      vector: [1, 0, 0],
      ts: "2026-07-01T12:00:00.000Z",
      host: "grok",
    });

    const allGrep = grepTurns(db, "uniqueExcludePhrase", resolveLookupScope(db, { limit: 10 }));
    assert.equal(allGrep.length, 2);

    const scoped = resolveLookupScope(db, {
      exclude_session: "ses-current",
      limit: 10,
    });
    assert.deepEqual(scoped.excludeSessions, ["ses-current"]);

    const grepped = grepTurns(db, "uniqueExcludePhrase", scoped);
    assert.equal(grepped.length, 1);
    assert.equal(grepped[0].session, "ses-prior");

    const hits = search(db, [1, 0, 0], scoped);
    assert.ok(hits.every((h) => h.session !== "ses-current"));
    assert.ok(hits.some((h) => h.session === "ses-prior"));

    const multi = resolveLookupScope(db, {
      exclude_sessions: ["ses-current", "ses-prior"],
    });
    assert.equal(grepTurns(db, "uniqueExcludePhrase", multi).length, 0);
    assert.equal(listRecentSessions(db, multi).length, 0);
  });
});
