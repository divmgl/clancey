import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { CodexLiveCapture } from "../src/codex-live.ts";
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

function meta() {
  return {
    type: "session_meta",
    timestamp: "2026-02-01T10:00:00.000Z",
    payload: { cwd: "/repo", git: { branch: "feature/live" } },
  };
}

function shell(command: string, timestamp: string) {
  return {
    type: "response_item",
    timestamp,
    payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", command] }) },
  };
}

describe("CodexLiveCapture", () => {
  test("captures tool events from a newly discovered Codex transcript", async () => {
    const file = path.join(root, "rollout-new.jsonl");
    fs.writeFileSync(file, line(meta()) + line(shell("bun test", "2026-02-01T10:00:01.000Z")));

    const capture = new CodexLiveCapture(db, { listFiles: async () => [file] });
    await capture.pollNow();

    const [item] = recall(db, { branch: "feature/live" });
    assert.equal(item.sessions[0], "rollout-new");
    assert.equal(item.toolEventCount, 1);
    assert.equal(item.repo, "/repo");
  });

  test("does not replay existing transcripts but captures appended tool events with primed metadata", async () => {
    const file = path.join(root, "rollout-existing.jsonl");
    fs.writeFileSync(file, line(meta()) + line(shell("old command", "2026-02-01T10:00:01.000Z")));

    const capture = new CodexLiveCapture(db, { listFiles: async () => [file] });
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
});
