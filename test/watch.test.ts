import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  registerMcpClient,
  heartbeatMcpClient,
  unregisterMcpClient,
  listLiveMcpClients,
  reapMcpClients,
  readMcpClientsRaw,
} from "../src/mcp-clients.ts";
import { tryClaimWatchLock, isWatchLockHeld, readWatchLockPid } from "../src/watch-lock.ts";
import { runWatch, ensureWatchRunning, defaultWatchIngest } from "../src/watch.ts";
import { openStore, grepTurns } from "../src/store.ts";
import { watchLockPath, resolveDbPath } from "../src/paths.ts";
import { isPidAlive } from "../src/pid.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-watch-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("watch lock", () => {
  test("exactly one of two claimants owns the lock; release frees it", () => {
    const lock = watchLockPath(dir);
    const a = tryClaimWatchLock(lock);
    assert.equal(a.owned, true);
    const b = tryClaimWatchLock(lock);
    assert.equal(b.owned, false);
    assert.equal(isWatchLockHeld(lock), true);
    assert.equal(readWatchLockPid(lock), process.pid);
    a.release();
    assert.equal(isWatchLockHeld(lock), false);
    const c = tryClaimWatchLock(lock);
    assert.equal(c.owned, true);
    c.release();
  });
});

describe("MCP client registry", () => {
  test("register heartbeat unregister and reap by TTL", () => {
    let now = 1_000_000;
    const opts = { dir, nowMs: () => now, ttlMs: 1_000 };
    const id = registerMcpClient(opts);
    assert.deepEqual(listLiveMcpClients(opts), [id]);
    now += 500;
    assert.equal(heartbeatMcpClient(id, opts), true);
    now += 2_000; // past TTL without heartbeat
    assert.deepEqual(reapMcpClients(opts), []);
    assert.deepEqual(Object.keys(readMcpClientsRaw({ dir }).clients), []);
  });

  test("unregister removes client; second client keeps registry non-empty", () => {
    const a = registerMcpClient({ dir });
    const b = registerMcpClient({ dir });
    assert.equal(listLiveMcpClients({ dir }).length, 2);
    unregisterMcpClient(a, { dir });
    const live = listLiveMcpClients({ dir });
    assert.deepEqual(live, [b]);
    unregisterMcpClient(b, { dir });
    assert.deepEqual(listLiveMcpClients({ dir }), []);
  });
});

describe("runWatch supervisor", () => {
  test("not-owner when lock already held", async () => {
    const lock = tryClaimWatchLock(watchLockPath(dir));
    assert.equal(lock.owned, true);
    const result = await runWatch({
      dir,
      pollMs: 10,
      startGraceMs: 0,
      maxIterations: 1,
      ingest: async () => ({ sessions: 0 }),
    });
    assert.equal(result, "not-owner");
    lock.release();
  });

  test("exits when no live MCP clients after grace", async () => {
    // No registrations → after grace, exit empty.
    const result = await runWatch({
      dir,
      pollMs: 5,
      startGraceMs: 20,
      ingest: async () => ({ sessions: 0 }),
      sleep: async () => {},
    });
    assert.equal(result, "exited-empty");
    assert.equal(isWatchLockHeld(watchLockPath(dir)), false);
  });

  test("stays alive while a client is registered; exits after last unregister", async () => {
    const id = registerMcpClient({ dir });
    let loops = 0;
    const result = await runWatch({
      dir,
      pollMs: 5,
      startGraceMs: 0,
      ingest: async () => {
        loops++;
        if (loops === 2) unregisterMcpClient(id, { dir });
        return { sessions: 0 };
      },
      sleep: async () => {},
      maxIterations: 20,
    });
    assert.equal(result, "exited-empty");
    assert.ok(loops >= 2);
    assert.equal(isWatchLockHeld(watchLockPath(dir)), false);
  });

  test("survives first client exit when a second client remains", async () => {
    const a = registerMcpClient({ dir });
    const b = registerMcpClient({ dir });
    let loops = 0;
    const result = await runWatch({
      dir,
      pollMs: 0,
      clientCheckMs: 0,
      startGraceMs: 0,
      ingest: async () => {
        loops++;
        if (loops === 1) unregisterMcpClient(a, { dir });
        if (loops === 3) unregisterMcpClient(b, { dir });
        return { sessions: 0 };
      },
      sleep: async () => {},
      maxIterations: 30,
    });
    assert.equal(result, "exited-empty");
    assert.ok(loops >= 3, `expected >=3 loops, got ${loops}`);
  });
});

describe("incremental ingest path used by watch", () => {
  test("defaultWatchIngest/backfill picks up appended transcript text for grep_turns", async () => {
    // Isolate every host root so we only scan our fixture (not the developer machine).
    const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-hosts-"));
    const prev = {
      GROK_HOME: process.env.GROK_HOME,
      CLAUDE_HOME: process.env.CLAUDE_HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HERMES_HOME: process.env.HERMES_HOME,
      CLANCEY_WATCH_DRY: process.env.CLANCEY_WATCH_DRY,
    };
    process.env.GROK_HOME = path.join(hostRoot, "grok");
    process.env.CLAUDE_HOME = path.join(hostRoot, "claude");
    process.env.CODEX_HOME = path.join(hostRoot, "codex");
    process.env.XDG_DATA_HOME = path.join(hostRoot, "xdg");
    process.env.HERMES_HOME = path.join(hostRoot, "hermes");
    delete process.env.CLANCEY_WATCH_DRY;

    try {
      const cwdKey = encodeURIComponent("/repo/watch-fixture");
      const sessionDir = path.join(process.env.GROK_HOME, "sessions", cwdKey, "ses_watch_ingest");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "summary.json"),
        JSON.stringify({
          info: { id: "ses_watch_ingest", cwd: "/repo/watch-fixture" },
          generated_title: "Watch ingest fixture",
          session_summary: "Watch ingest fixture",
          head_branch: "main",
          session_kind: "primary",
          created_at: "2026-06-01T00:00:00Z",
        }) + "\n",
      );
      const updatesPath = path.join(sessionDir, "updates.jsonl");
      const line = (ts: number, text: string) =>
        JSON.stringify({
          timestamp: ts,
          method: "session/update",
          params: {
            sessionId: "ses_watch_ingest",
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text },
              _meta: { agentTimestampMs: ts * 1000 },
            },
          },
        });
      fs.writeFileSync(
        updatesPath,
        line(1717200000, "initial fixture turn about nothing special") + "\n",
      );

      const id = registerMcpClient({ dir });
      const dbPath = resolveDbPath(dir);

      // First watch pass: real defaultWatchIngest → backfill({ force: false })
      await runWatch({
        dir,
        pollMs: 0,
        clientCheckMs: 0,
        startGraceMs: 0,
        maxIterations: 1,
        sleep: async () => {},
        // Explicitly the shipped path (same as default when CLANCEY_WATCH_DRY unset).
        ingest: defaultWatchIngest,
      });

      const token = `hordeleavetoken${Date.now()}`;
      // Append new conversation text (mtime change) — what watch is for.
      fs.appendFileSync(
        updatesPath,
        line(1717200005, `We left off getting horde mode to work: ${token}`) + "\n",
      );
      // Ensure mtime advances on coarse FS clocks.
      const st = fs.statSync(updatesPath);
      fs.utimesSync(updatesPath, st.atime, new Date(st.mtimeMs + 2000));

      await runWatch({
        dir,
        pollMs: 0,
        clientCheckMs: 0,
        startGraceMs: 0,
        maxIterations: 1,
        sleep: async () => {},
        ingest: defaultWatchIngest,
      });
      unregisterMcpClient(id, { dir });

      const db = openStore(dbPath);
      try {
        const hits = grepTurns(db, token);
        assert.ok(hits.length >= 1, `expected grep hit for ${token}, got ${hits.length}`);
        assert.ok(
          hits.some((h) => h.session === "ses_watch_ingest" && h.snippet.replace(/«|»/g, "").includes(token)),
          `snippet should contain token: ${JSON.stringify(hits)}`,
        );
      } finally {
        db.close();
      }
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(hostRoot, { recursive: true, force: true });
    }
  });
});

describe("ensureWatchRunning", () => {
  test("reports watch-lock-held when a live owner exists", () => {
    const lock = tryClaimWatchLock(watchLockPath(dir));
    assert.equal(lock.owned, true);
    const r = ensureWatchRunning({ dir });
    assert.equal(r.spawned, false);
    assert.equal(r.reason, "watch-lock-held");
    lock.release();
  });
});

describe("isPidAlive", () => {
  test("current pid is alive; nonsense pid is not", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(999_999_999), false);
  });
});
