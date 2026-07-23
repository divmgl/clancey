/**
 * Process-level lifecycle: two MCP-like clients, one watch owner, exit when empty.
 * Drives shipped register/watch/lock APIs under an isolated CLANCEY_HOME.
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { isPidAlive } from "../src/pid.ts";
import { watchLockPath } from "../src/paths.ts";
import { isWatchLockHeld } from "../src/watch-lock.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist", "index.js");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readLockPid(dir: string): number | null {
  try {
    const n = Number(fs.readFileSync(watchLockPath(dir), "utf-8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Minimal MCP-like client: register + heartbeat via shipped module under CLANCEY_HOME. */
function spawnClient(dir: string): ChildProcess {
  const script = `
    import { registerMcpClient, heartbeatMcpClient, unregisterMcpClient } from ${JSON.stringify(
      path.join(ROOT, "src/mcp-clients.ts"),
    )};
    import { ensureWatchRunning } from ${JSON.stringify(path.join(ROOT, "src/watch.ts"))};
    const dir = process.env.CLANCEY_HOME;
    const id = registerMcpClient({ dir });
    ensureWatchRunning({
      dir,
      node: process.execPath,
      entrypoint: ${JSON.stringify(DIST)},
    });
    const beat = setInterval(() => heartbeatMcpClient(id, { dir }), 400);
    const stop = () => {
      clearInterval(beat);
      try { unregisterMcpClient(id, { dir }); } catch {}
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    // Stay alive until signaled.
    setInterval(() => {}, 60_000);
  `;
  return spawn(process.execPath, ["--import", "tsx", "-e", script], {
    env: {
      ...process.env,
      CLANCEY_HOME: dir,
      // Watch must not run a full multi-host backfill in this test.
      CLANCEY_WATCH_DRY: "1",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

describe("watch lifecycle (process)", () => {
  const temps: string[] = [];
  const kids: ChildProcess[] = [];

  after(() => {
    for (const k of kids) {
      try {
        k.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  });

  test("single watch under two clients; survives one exit; stops after both", async () => {
    assert.ok(fs.existsSync(DIST), "dist/index.js must exist (run bun run build)");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-life-"));
    temps.push(dir);

    const a = spawnClient(dir);
    kids.push(a);
    await sleep(1200);

    const b = spawnClient(dir);
    kids.push(b);
    await sleep(2000);

    const pid1 = readLockPid(dir);
    assert.ok(pid1 && isPidAlive(pid1), `expected live watch pid, got ${pid1}`);

    // Second ensureWatch must not replace owner with a different forever-running second watch.
    await sleep(800);
    const pid2 = readLockPid(dir);
    assert.equal(pid2, pid1, "watch lock owner must stay stable with two clients");

    a.kill("SIGTERM");
    await sleep(400);
    try {
      a.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    await sleep(1500);
    assert.ok(isPidAlive(pid1!), "watch must survive after first client exits");
    assert.equal(readLockPid(dir), pid1);

    b.kill("SIGTERM");
    await sleep(400);
    try {
      b.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    // Client-check ~500ms; grace 8s from watch start — already elapsed by now.
    let gone = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const alive = isPidAlive(pid1!);
      const held = isWatchLockHeld(watchLockPath(dir));
      if (!alive && !held) {
        gone = true;
        break;
      }
    }
    assert.ok(gone, "watch should exit and release lock after last client unregisters");
  });
});
