import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CodexLiveCapture,
  DEFAULT_MAX_FILE_BYTES,
  recoverCodexMetaFromTail,
  startCodexLiveCapture,
  tryClaimCodexLiveLock,
} from "../src/codex-live.ts";
import { openStore, recall, type Store } from "../src/store.ts";

let root: string;
let dbPath: string;
let db: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-codex-live-"));
  dbPath = path.join(root, "clancey.db");
  db = openStore(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function meta(cwd = "/repo", branch = "feature/live") {
  return {
    type: "session_meta",
    timestamp: "2026-02-01T10:00:00.000Z",
    payload: { cwd, git: { branch } },
  };
}

function shell(command: string, timestamp: string) {
  return {
    type: "response_item",
    timestamp,
    payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", command] }) },
  };
}

/** Spy: wrap fs.createReadStream to record byte ranges requested for a path. */
function installReadRangeSpy(targetFile: string): { ranges: { start: number; end: number }[]; restore: () => void } {
  const ranges: { start: number; end: number }[] = [];
  const orig = fs.createReadStream;
  const patched = function (this: unknown, pathOrFd: fs.PathLike | number, options?: fs.ReadStreamOptions | BufferEncoding) {
    const p = typeof pathOrFd === "string" ? pathOrFd : "";
    if (p === targetFile && options && typeof options === "object") {
      const start = typeof options.start === "number" ? options.start : 0;
      const end = typeof options.end === "number" ? options.end : Number.POSITIVE_INFINITY;
      ranges.push({ start, end });
    }
    return orig.call(fs, pathOrFd as never, options as never);
  } as typeof fs.createReadStream;
  fs.createReadStream = patched;
  return {
    ranges,
    restore: () => {
      fs.createReadStream = orig;
    },
  };
}

describe("CodexLiveCapture", () => {
  test("captures tool events from a newly discovered Codex transcript", async () => {
    const file = path.join(root, "rollout-new.jsonl");
    fs.writeFileSync(file, line(meta()) + line(shell("bun test", "2026-02-01T10:00:01.000Z")));

    const capture = new CodexLiveCapture(db, { listFiles: async () => [file], requireLock: false });
    await capture.pollNow();

    const [item] = recall(db, { branch: "feature/live" });
    assert.equal(item.sessions[0], "rollout-new");
    assert.equal(item.toolEventCount, 1);
    assert.equal(item.repo, "/repo");
  });

  test("does not replay existing transcripts but captures appended tool events with primed metadata", async () => {
    const file = path.join(root, "rollout-existing.jsonl");
    fs.writeFileSync(file, line(meta()) + line(shell("old command", "2026-02-01T10:00:01.000Z")));

    const capture = new CodexLiveCapture(db, { listFiles: async () => [file], requireLock: false });
    await capture.start();
    capture.stop();
    assert.deepEqual(recall(db), []);

    fs.appendFileSync(file, line(shell("new command", "2026-02-01T10:00:02.000Z")));
    await capture.pollNow();

    const [item] = recall(db, { branch: "feature/live" });
    assert.equal(item.sessions[0], "rollout-existing");
    assert.equal(item.toolEventCount, 1);
    assert.equal(item.firstTs, "2026-02-01T10:00:02.000Z");
    assert.equal(item.repo, "/repo");
  });

  test("prime only reads a bounded tail, never the whole multi-MB body", async () => {
    const file = path.join(root, "rollout-large-body.jsonl");
    const padding = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2MB of 'a' (not valid JSON lines)
    const head = line(meta()) + line(shell("old", "2026-02-01T10:00:01.000Z"));
    const tailMeta = line(meta("/repo", "feature/live"));
    fs.writeFileSync(file, Buffer.concat([Buffer.from(head), padding, Buffer.from(tailMeta)]));
    const size = fs.statSync(file).size;
    assert.ok(size > 2 * 1024 * 1024);

    const spy = installReadRangeSpy(file);
    try {
      const capture = new CodexLiveCapture(db, {
        listFiles: async () => [file],
        requireLock: false,
        tailBytes: 64 * 1024,
        maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      });
      await capture.start();
      capture.stop();
    } finally {
      spy.restore();
    }

    assert.deepEqual(recall(db), [], "prime must not insert historical tool events");
    assert.ok(spy.ranges.length >= 1, "expected at least one ranged read");
    for (const r of spy.ranges) {
      const bytes = r.end === Number.POSITIVE_INFINITY ? size - r.start : r.end - r.start + 1;
      assert.ok(bytes <= 64 * 1024 + 1, `read ${bytes} bytes, expected <= tail window`);
      assert.ok(r.start >= size - 64 * 1024 - 1, "read must start near end of file");
    }
  });

  test("files above maxFileBytes skip metadata recovery and still do not full-read", async () => {
    const file = path.join(root, "rollout-over-cap.jsonl");
    const cap = 32 * 1024; // tiny cap for the test
    const body = line(meta()) + line(shell("old", "2026-02-01T10:00:01.000Z")) + "x".repeat(cap + 1000) + "\n";
    fs.writeFileSync(file, body);
    const size = fs.statSync(file).size;
    assert.ok(size > cap);

    const spy = installReadRangeSpy(file);
    try {
      const metaState = await recoverCodexMetaFromTail(file, size, { maxFileBytes: cap, tailBytes: 8 * 1024 });
      assert.equal(metaState.cwd, null);
      assert.equal(metaState.branch, null);

      const capture = new CodexLiveCapture(db, {
        listFiles: async () => [file],
        requireLock: false,
        maxFileBytes: cap,
        tailBytes: 8 * 1024,
      });
      await capture.start();
      assert.equal(capture.trackedOffset(file), size);
      assert.deepEqual(capture.trackedMeta(file), { cwd: null, branch: null });
      capture.stop();
    } finally {
      spy.restore();
    }

    assert.deepEqual(recall(db), []);
    // No ranged reads when recovery is skipped entirely.
    assert.equal(spy.ranges.length, 0);
  });

  test("appended events after over-cap prime still capture without replaying history", async () => {
    const file = path.join(root, "rollout-over-cap-append.jsonl");
    const cap = 16 * 1024;
    // Meta lives only at the start (outside recovery for over-cap); appends carry no meta.
    fs.writeFileSync(
      file,
      line(meta()) + line(shell("old", "2026-02-01T10:00:01.000Z")) + "y".repeat(cap + 500) + "\n",
    );

    const capture = new CodexLiveCapture(db, {
      listFiles: async () => [file],
      requireLock: false,
      maxFileBytes: cap,
    });
    await capture.start();
    assert.deepEqual(recall(db), []);

    // Append meta + tool so recovery can happen from the append stream itself.
    fs.appendFileSync(file, line(meta("/repo", "feature/live")) + line(shell("new", "2026-02-01T10:00:02.000Z")));
    await capture.pollNow();
    capture.stop();

    const [item] = recall(db, { branch: "feature/live" });
    assert.equal(item.toolEventCount, 1);
    assert.equal(item.firstTs, "2026-02-01T10:00:02.000Z");
  });
});

describe("tryClaimCodexLiveLock / single-owner", () => {
  test("exactly one of two contenders becomes the active live-capture owner", async () => {
    const lockPath = path.join(root, "codex-live.lock");
    const listFiles = async () => [] as string[];

    const first = startCodexLiveCapture(db, { lockPath, listFiles, pollMs: 60_000 });
    assert.ok(first, "first contender must own the lock");

    const db2 = openStore(path.join(root, "clancey-2.db"));
    try {
      const second = startCodexLiveCapture(db2, { lockPath, listFiles, pollMs: 60_000 });
      assert.equal(second, null, "second contender must not start a poller");

      // Allow the owner's async start() to finish.
      await new Promise((r) => setImmediate(r));
      assert.equal(first!.isActive, true);
      first!.stop();
      assert.equal(first!.isActive, false);

      // After release, a new contender can own.
      const third = startCodexLiveCapture(db2, { lockPath, listFiles, pollMs: 60_000 });
      assert.ok(third, "lock must be reclaimable after stop");
      third!.stop();
    } finally {
      db2.close();
    }
  });

  test("stale lock from a dead pid is reclaimable", () => {
    const lockPath = path.join(root, "stale.lock");
    fs.writeFileSync(lockPath, "999999999\n"); // almost certainly not alive
    const claim = tryClaimCodexLiveLock(lockPath);
    assert.equal(claim.owned, true);
    claim.release();
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("two sequential tryClaim calls: only first owns", () => {
    const lockPath = path.join(root, "seq.lock");
    const a = tryClaimCodexLiveLock(lockPath);
    const b = tryClaimCodexLiveLock(lockPath);
    assert.equal(a.owned, true);
    assert.equal(b.owned, false);
    a.release();
    const c = tryClaimCodexLiveLock(lockPath);
    assert.equal(c.owned, true);
    c.release();
  });
});
