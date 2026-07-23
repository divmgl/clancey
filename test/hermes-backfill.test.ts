import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { backfill } from "../src/setup.ts";
import { openStore, getMessages, type Store } from "../src/store.ts";
import { listHermesFiles, parseAny } from "../src/parser.ts";

/**
 * Minimal Hermes state.db used by the backfill path. Built in-process so the test
 * drives the real list → parse → store pipeline against fixture content (not the
 * live ~/.hermes DB).
 */
function buildHermesHome(home: string): {
  sessionId: string;
  framing: string;
  terminalCmd: string;
  writePath: string;
  writeBody: string;
  cwd: string;
} {
  fs.mkdirSync(home, { recursive: true });
  const db = new Database(path.join(home, "state.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      cwd TEXT,
      title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      timestamp REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);

  const sessionId = "ses_backfill_hermes";
  const framing = "Backfill should import this Hermes session about the auth helper.";
  const terminalCmd = "bun test";
  const writePath = "/repo/src/auth.ts";
  const writeBody = "export const ok = true;\n";
  const cwd = "/repo";
  const ts = 1_700_100_000;

  db.prepare(
    `INSERT INTO sessions (id, source, parent_session_id, started_at, cwd, title)
     VALUES (?, 'cli', NULL, ?, ?, ?)`,
  ).run(sessionId, ts, cwd, "Hermes backfill fixture");

  db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active)
     VALUES (?, 'user', ?, NULL, ?, 1)`,
  ).run(sessionId, framing, ts);

  const toolCalls = JSON.stringify([
    {
      id: "c1",
      type: "function",
      function: { name: "terminal", arguments: JSON.stringify({ command: terminalCmd }) },
    },
    {
      id: "c2",
      type: "function",
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: writePath, content: writeBody }),
      },
    },
  ]);

  db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active)
     VALUES (?, 'assistant', ?, ?, ?, 1)`,
  ).run(sessionId, "Writing the auth helper now.", toolCalls, ts + 1);

  db.close();
  return { sessionId, framing, terminalCmd, writePath, writeBody, cwd };
}

describe("Hermes backfill", () => {
  let tmp: string;
  let storePath: string;
  let db: Store;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-hermes-bf-"));
    const hermesHome = path.join(tmp, "hermes");
    const emptyHome = path.join(tmp, "empty-home");
    fs.mkdirSync(emptyHome, { recursive: true });
    buildHermesHome(hermesHome);

    // Isolate every host root so listAllTranscripts only sees the fixture Hermes DB.
    prev = {
      HOME: process.env.HOME,
      HERMES_HOME: process.env.HERMES_HOME,
      GROK_HOME: process.env.GROK_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.HOME = emptyHome;
    process.env.HERMES_HOME = hermesHome;
    process.env.GROK_HOME = path.join(tmp, "no-grok");
    process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data");
    process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config");

    storePath = path.join(tmp, "clancey.db");
    db = openStore(storePath);
  });

  afterEach(() => {
    db.close();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("list + parse fixture yields the session before backfill", async () => {
    const refs = await listHermesFiles();
    assert.equal(refs.length, 1);
    const parsed = await parseAny(refs[0]);
    assert.equal(parsed.sessionId, "ses_backfill_hermes");
    assert.match(parsed.framing ?? "", /Backfill should import this Hermes session/);
    assert.ok(parsed.toolEvents.some((e) => e.tool === "terminal" && e.command === "bun test"));
    assert.ok(parsed.toolEvents.some((e) => e.tool === "write_file" && e.file === "/repo/src/auth.ts"));
  });

  test(
    "backfill ingests Hermes messages and tool events with host=hermes",
    { timeout: 120_000 },
    async () => {
      const stats = await backfill(db, { force: true });
      assert.ok(stats.sessions >= 1, `expected ≥1 session ingested, got ${stats.sessions}`);
      assert.ok(stats.events >= 2, `expected ≥2 tool events, got ${stats.events}`);

      const messages = getMessages(db, "ses_backfill_hermes");
      assert.ok(messages.length >= 2, `expected stored messages, got ${messages.length}`);
      assert.ok(messages.some((m) => m.role === "user" && m.text.includes("Backfill should import")));
      assert.ok(
        messages.some(
          (m) =>
            m.role === "assistant" &&
            m.text.includes("Writing the auth helper") &&
            m.text.includes("「terminal」") &&
            m.text.includes("bun test") &&
            m.text.includes("「write_file /repo/src/auth.ts」"),
        ),
      );

      const messageHosts = db
        .prepare(`SELECT host FROM messages WHERE session = ?`)
        .all("ses_backfill_hermes") as Array<{ host: string | null }>;
      assert.ok(messageHosts.length >= 2);
      assert.ok(messageHosts.every((m) => m.host === "hermes"), "all messages tagged host=hermes");

      const events = db
        .prepare(`SELECT tool, file, command, host FROM events WHERE session = ? AND type = 'tool'`)
        .all("ses_backfill_hermes") as Array<{
        tool: string;
        file: string | null;
        command: string | null;
        host: string | null;
      }>;
      assert.ok(events.some((e) => e.tool === "terminal" && e.command === "bun test"));
      assert.ok(events.some((e) => e.tool === "write_file" && e.file === "/repo/src/auth.ts"));
      assert.ok(events.every((e) => e.host === "hermes"));
    },
  );
});
