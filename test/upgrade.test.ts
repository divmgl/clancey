import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Store, openStore, getMeta, setMeta } from "../src/store.ts";
import { isNewer, upgradeNotice } from "../src/upgrade.ts";

describe("isNewer", () => {
  test("compares semver numerically, not lexically", () => {
    assert.equal(isNewer("1.2.10", "1.2.9"), true);
    assert.equal(isNewer("1.3.0", "1.2.9"), true);
    assert.equal(isNewer("2.0.0", "1.9.9"), true);
  });

  test("equal or older is not newer", () => {
    assert.equal(isNewer("1.1.1", "1.1.1"), false);
    assert.equal(isNewer("1.0.0", "1.0.1"), false);
    assert.equal(isNewer("1.2.0", "1.2.0"), false);
  });
});

describe("upgradeNotice", () => {
  let dbPath: string;
  let db: Store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `clancey-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = openStore(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const ext of ["", "-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
  });

  test("returns a notice when a newer version is published", async () => {
    const notice = await upgradeNotice(db, "1.1.1", Date.now(), async () => "1.2.0");
    assert.ok(notice);
    assert.match(notice!, /1\.2\.0/);
    assert.match(notice!, /1\.1\.1/);
    assert.match(notice!, /clancey setup/);
  });

  test("returns null when already on the latest", async () => {
    assert.equal(await upgradeNotice(db, "1.2.0", Date.now(), async () => "1.2.0"), null);
  });

  test("throttles the network check to once a day, serving the cached latest", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return "1.2.0";
    };
    const now = Date.now();
    await upgradeNotice(db, "1.1.1", now, fetcher);
    const second = await upgradeNotice(db, "1.1.1", now + 60_000, fetcher);
    assert.equal(calls, 1, "second call within a day must not hit the network");
    assert.ok(second, "cached latest still yields a notice");
  });

  test("re-checks after the interval elapses", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return "1.2.0";
    };
    const now = Date.now();
    await upgradeNotice(db, "1.1.1", now, fetcher);
    await upgradeNotice(db, "1.1.1", now + 25 * 60 * 60 * 1000, fetcher);
    assert.equal(calls, 2);
  });

  test("a failed fetch yields no notice and does not throw", async () => {
    assert.equal(await upgradeNotice(db, "1.1.1", Date.now(), async () => null), null);
  });
});

describe("meta", () => {
  let dbPath: string;
  let db: Store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `clancey-meta-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = openStore(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const ext of ["", "-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
  });

  test("round-trips values and overwrites on conflict", () => {
    assert.equal(getMeta(db, "k"), undefined);
    setMeta(db, "k", "v1");
    assert.equal(getMeta(db, "k"), "v1");
    setMeta(db, "k", "v2");
    assert.equal(getMeta(db, "k"), "v2");
  });
});
