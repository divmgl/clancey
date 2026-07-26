import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { isPidLockHeld, readPidLock, sleepSync, tryClaimPidLock } from "../src/file-lock.ts";
import { tryClaimWatchLock, isWatchLockHeld, readWatchLockPid } from "../src/watch-lock.ts";
import { registerMcpClient, listLiveMcpClients, readMcpClientsRaw } from "../src/mcp-clients.ts";
import { mcpClientsPath } from "../src/paths.ts";

let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-lock-"));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A process that is alive for the duration of the test but is not us. */
function spawnLiveProcess(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  children.push(child);
  return child.pid!;
}

/** A PID that is guaranteed gone: spawn and wait for exit. */
async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid!;
}

describe("tryClaimPidLock", () => {
  test("reclaims a lock whose owner PID is dead", async () => {
    const lock = path.join(dir, "stale.lock");
    fs.writeFileSync(lock, `${await spawnDeadPid()}\n`);

    const claim = tryClaimPidLock(lock);
    assert.equal(claim.owned, true);
    assert.equal(readPidLock(lock), process.pid);
    claim.release();
    assert.equal(fs.existsSync(lock), false);
  });

  test("does not steal a lock whose owner PID is alive", () => {
    const lock = path.join(dir, "live.lock");
    const alive = spawnLiveProcess();
    fs.writeFileSync(lock, `${alive}\n`);

    const claim = tryClaimPidLock(lock);
    assert.equal(claim.owned, false);
    assert.equal(isPidLockHeld(lock), true);
    // The rejected claimant must leave the owner's lock exactly as it found it — the CLA-4 bug
    // was a recovery path that unlinked first and asked questions later.
    assert.equal(readPidLock(lock), alive);
    claim.release();
    assert.equal(readPidLock(lock), alive);
  });

  test("release by a non-owner leaves the lock intact", () => {
    const lock = path.join(dir, "owned.lock");
    const a = tryClaimPidLock(lock);
    const b = tryClaimPidLock(lock);
    assert.equal(a.owned, true);
    assert.equal(b.owned, false);
    b.release();
    assert.equal(isPidLockHeld(lock), true);
    a.release();
    assert.equal(fs.existsSync(lock), false);
  });

  test("no claim leftovers remain after a contended steal", async () => {
    const lock = path.join(dir, "sweep.lock");
    fs.writeFileSync(lock, `${await spawnDeadPid()}\n`);
    const claim = tryClaimPidLock(lock);
    assert.equal(claim.owned, true);
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.includes(".claim.")),
      [],
    );
    claim.release();
  });
});

describe("sleepSync", () => {
  test("waits in real time without burning CPU", () => {
    const startCpu = process.cpuUsage();
    const startMs = Date.now();
    sleepSync(200);
    const elapsedMs = Date.now() - startMs;
    const cpuMs = (process.cpuUsage(startCpu).user + process.cpuUsage(startCpu).system) / 1000;

    assert.ok(elapsedMs >= 150, `expected a real wait, slept ${elapsedMs}ms`);
    // A busy-wait would report CPU time roughly equal to wall time; a futex sleep reports ~0.
    assert.ok(cpuMs < elapsedMs / 2, `sleepSync burned ${cpuMs}ms CPU over ${elapsedMs}ms wall`);
  });
});

describe("watch lock stale recovery", () => {
  test("a lock left by a dead PID is reclaimed, a live one is not", async () => {
    const lock = path.join(dir, "watch.lock");
    fs.writeFileSync(lock, `${await spawnDeadPid()}\n`);
    const reclaimed = tryClaimWatchLock(lock);
    assert.equal(reclaimed.owned, true);
    assert.equal(readWatchLockPid(lock), process.pid);
    reclaimed.release();

    fs.writeFileSync(lock, `${spawnLiveProcess()}\n`);
    assert.equal(isWatchLockHeld(lock), true);
    assert.equal(tryClaimWatchLock(lock).owned, false);
  });
});

describe("MCP client registry locking", () => {
  test("recovers from an orphaned lock file left by a dead PID instead of spinning", async () => {
    const file = mcpClientsPath(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.lock`, `${await spawnDeadPid()}\n`);

    const startCpu = process.cpuUsage();
    const startMs = Date.now();
    const id = registerMcpClient({ dir });
    const elapsedMs = Date.now() - startMs;
    const cpuMs = (process.cpuUsage(startCpu).user + process.cpuUsage(startCpu).system) / 1000;

    // Before CLA-3 was fixed this spun a full core for the entire 5s timeout and then wrote
    // without a lock at all.
    assert.ok(elapsedMs < 1_000, `registration took ${elapsedMs}ms`);
    assert.ok(cpuMs < 1_000, `registration burned ${cpuMs}ms CPU`);
    assert.deepEqual(listLiveMcpClients({ dir }), [id]);
    assert.equal(fs.existsSync(`${file}.lock`), false, "lock must be released after the write");
  });

  test("recovers from a legacy zero-byte lock file with no owner recorded", () => {
    const file = mcpClientsPath(dir);
    fs.mkdirSync(dir, { recursive: true });
    // Shape left behind by the pre-CLA-3 implementation, which opened the lock "wx" and never
    // wrote an owner into it. Those locks are on disk right now and must not block forever.
    fs.writeFileSync(`${file}.lock`, "");

    const startMs = Date.now();
    const id = registerMcpClient({ dir });
    assert.ok(Date.now() - startMs < 1_000);
    assert.deepEqual(listLiveMcpClients({ dir }), [id]);
  });

  test("waits for a live holder and still completes once it exits", () => {
    const file = mcpClientsPath(dir);
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = `${file}.lock`;
    // Holder writes its own PID then exits, so the lock is live at first contact and stale a
    // few hundred ms later — the case the retry loop exists for. It has to be a *grandchild*:
    // a direct child that exits while we are blocked in sleepSync stays a zombie (we never get
    // to reap it), and a zombie PID still answers kill(pid, 0), so it would look alive forever.
    const holderScript =
      `require("fs").writeFileSync(${JSON.stringify(lockPath)}, process.pid + "\\n"); setTimeout(() => {}, 400)`;
    spawn(
      process.execPath,
      [
        "-e",
        `const c = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(holderScript)}], { detached: true, stdio: "ignore" }); c.unref();`,
      ],
      { stdio: "ignore" },
    ).unref();
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(lockPath) && Date.now() < deadline) sleepSync(10);
    assert.equal(isPidLockHeld(lockPath), true);

    const startCpu = process.cpuUsage();
    const startMs = Date.now();
    const id = registerMcpClient({ dir });
    const elapsedMs = Date.now() - startMs;
    const cpuMs = (process.cpuUsage(startCpu).user + process.cpuUsage(startCpu).system) / 1000;

    assert.ok(elapsedMs < 4_000, `waiter should acquire well inside the timeout, took ${elapsedMs}ms`);
    assert.ok(cpuMs < elapsedMs / 2, `waiter burned ${cpuMs}ms CPU over ${elapsedMs}ms wall`);
    assert.ok(readMcpClientsRaw({ dir }).clients[id], "registration must have been written");
  });

  test("sweeps orphaned .tmp files from dead writers but keeps live ones", async () => {
    const file = mcpClientsPath(dir);
    fs.mkdirSync(dir, { recursive: true });
    const deadTmp = `${file}.${await spawnDeadPid()}.tmp`;
    const liveTmp = `${file}.${spawnLiveProcess()}.tmp`;
    const unrelated = path.join(dir, "something-else.tmp");
    fs.writeFileSync(deadTmp, "{}");
    fs.writeFileSync(liveTmp, "{}");
    fs.writeFileSync(unrelated, "{}");

    registerMcpClient({ dir });

    assert.equal(fs.existsSync(deadTmp), false, "temp leaked by a dead writer must be swept");
    assert.equal(fs.existsSync(liveTmp), true, "a live writer's in-flight temp must survive");
    assert.equal(fs.existsSync(unrelated), true);
  });
});
