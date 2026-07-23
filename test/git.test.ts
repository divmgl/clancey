import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  parseRemoteShortKey,
  looksLikeRemoteShortKey,
  remoteShortKey,
  repoKey,
  expandRepoFilterKeys,
} from "../src/git.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function tempGitRepo(remoteUrl: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-git-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("parseRemoteShortKey", () => {
  test("parses ssh, https, and scp-style remotes", () => {
    assert.equal(parseRemoteShortKey("git@github.com:fifthdoor/gaia.git"), "fifthdoor/gaia");
    assert.equal(parseRemoteShortKey("git@github.com:fifthdoor/gaia"), "fifthdoor/gaia");
    assert.equal(parseRemoteShortKey("https://github.com/divmgl/clancey.git"), "divmgl/clancey");
    assert.equal(parseRemoteShortKey("https://github.com/divmgl/clancey"), "divmgl/clancey");
    assert.equal(parseRemoteShortKey("ssh://git@github.com/org/repo.git"), "org/repo");
    assert.equal(parseRemoteShortKey("not-a-url"), null);
    assert.equal(parseRemoteShortKey("https://github.com/onlyone"), null);
  });
});

describe("looksLikeRemoteShortKey", () => {
  test("accepts owner/name and rejects paths", () => {
    assert.equal(looksLikeRemoteShortKey("fifthdoor/gaia"), true);
    assert.equal(looksLikeRemoteShortKey("divmgl/clancey"), true);
    assert.equal(looksLikeRemoteShortKey("/Users/dimgl/dev/gaia"), false);
    assert.equal(looksLikeRemoteShortKey("~/dev/gaia"), false);
    assert.equal(looksLikeRemoteShortKey("C:\\Users\\x\\repo"), false);
    assert.equal(looksLikeRemoteShortKey("owner/name/extra"), false);
    assert.equal(looksLikeRemoteShortKey("noslash"), false);
  });
});

describe("remoteShortKey + expandRepoFilterKeys", () => {
  test("path expands to git root and origin short key", () => {
    const dir = tempGitRepo("git@github.com:fifthdoor/gaia.git");
    const root = repoKey(dir);
    assert.ok(root);
    assert.equal(remoteShortKey(root!), "fifthdoor/gaia");

    const keys = expandRepoFilterKeys(dir);
    assert.ok(keys.includes(root!));
    assert.ok(keys.includes("fifthdoor/gaia"));
    assert.ok(keys.includes(dir) || keys.includes(root!));
  });

  test("short key expands to known absolute checkouts with matching origin", () => {
    const dir = tempGitRepo("https://github.com/fifthdoor/gaia.git");
    const root = repoKey(dir)!;
    const keys = expandRepoFilterKeys("fifthdoor/gaia", [root, "/unrelated/path"]);
    assert.ok(keys.includes("fifthdoor/gaia"));
    assert.ok(keys.includes(root), `expected root ${root} in ${JSON.stringify(keys)}`);
  });

  test("short key does not claim unrelated known paths", () => {
    const other = tempGitRepo("git@github.com:other/thing.git");
    const root = repoKey(other)!;
    const keys = expandRepoFilterKeys("fifthdoor/gaia", [root]);
    assert.deepEqual(keys, ["fifthdoor/gaia"]);
  });
});
