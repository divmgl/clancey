import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  configureLogger,
  getLogFile,
  log,
  rotateLogIfNeeded,
  setConsoleSilent,
} from "../src/logger.ts";

describe("logger rotate/truncate", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-log-"));
    logPath = path.join(tmp, "clancey.log");
    configureLogger({ file: logPath, maxBytes: 200 });
    setConsoleSilent(true);
  });

  afterEach(() => {
    configureLogger({ file: null, maxBytes: 5 * 1024 * 1024 });
    setConsoleSilent(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("rotateLogIfNeeded renames an over-cap file to .1", () => {
    fs.writeFileSync(logPath, "x".repeat(250));
    assert.equal(rotateLogIfNeeded(logPath, 200), true);
    assert.equal(fs.existsSync(logPath), false);
    assert.ok(fs.existsSync(`${logPath}.1`));
    assert.equal(fs.statSync(`${logPath}.1`).size, 250);
  });

  test("log() rotates when writing past the size cap so the active file stays under the cap", () => {
    // Fill past the cap.
    fs.writeFileSync(logPath, "y".repeat(180));
    log("hello from clancey logger rotation test");
    assert.equal(getLogFile(), logPath);
    assert.ok(fs.existsSync(logPath), "active log recreated after rotate");
    const activeSize = fs.statSync(logPath).size;
    assert.ok(activeSize < 200, `active log size ${activeSize} should be under cap after rotate`);
    assert.ok(fs.existsSync(`${logPath}.1`), "previous content rotated to .1");
    assert.match(fs.readFileSync(logPath, "utf-8"), /hello from clancey logger rotation test/);
  });

  test("repeated writes after rotate do not leave the active file over the cap from one line", () => {
    fs.writeFileSync(logPath, "z".repeat(199));
    log("one");
    log("two");
    const size = fs.statSync(logPath).size;
    // Cap is 200; after rotate each append is a short timestamped line.
    assert.ok(size < 200 || fs.existsSync(`${logPath}.1`));
    // Drive enough volume that rotation must have fired at least once.
    for (let i = 0; i < 50; i++) log(`noise line ${i} ${"n".repeat(40)}`);
    assert.ok(fs.statSync(logPath).size < 200 + 120, "active log stays near the cap");
  });
});
