import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { configureOpencode, configureOpencodePlugin, renderCodexMcpBlock, renderOpencodePlugin } from "../src/setup.ts";

describe("renderCodexMcpBlock", () => {
  test("uses a direct node entrypoint instead of an npm launcher", () => {
    const block = renderCodexMcpBlock("/tmp/clancey/dist/index.js", "/usr/local/bin/node");

    assert.equal(
      block,
      `[mcp_servers.clancey]
command = "/usr/local/bin/node"
args = ["/tmp/clancey/dist/index.js"]
`,
    );
    assert.doesNotMatch(block, /npx|npm/);
  });
});

describe("configureOpencode", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-oc-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("creates opencode.json with the pinned MCP server when no config exists", () => {
    const { result, file } = configureOpencode("clancey@9.9.9");
    assert.equal(result, "added");
    assert.equal(file, path.join(tmp, "opencode", "opencode.json"));

    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(config["$schema"], "https://opencode.ai/config.json");
    assert.deepEqual(config.mcp.clancey, {
      type: "local",
      command: ["npx", "-y", "clancey@9.9.9"],
      enabled: true,
    });
  });

  test("merges into an existing commented opencode.jsonc without corrupting the $schema URL or losing keys", () => {
    const dir = path.join(tmp, "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const jsonc = path.join(dir, "opencode.jsonc");
    fs.writeFileSync(
      jsonc,
      `{
  // the // in this URL must survive comment stripping
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight", /* keep me */
  "mcp": {
    "other": { "type": "local", "command": ["x"], "enabled": true }
  }
}
`,
    );

    const { result, file } = configureOpencode("clancey@1.0.0");
    assert.equal(result, "added"); // clancey wasn't there yet, even though `mcp` was
    assert.equal(file, jsonc); // writes back into the existing .jsonc

    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(config["$schema"], "https://opencode.ai/config.json");
    assert.equal(config.theme, "tokyonight");
    assert.ok(config.mcp.other, "pre-existing MCP server is preserved");
    assert.deepEqual(config.mcp.clancey.command, ["npx", "-y", "clancey@1.0.0"]);
  });

  test("re-pins idempotently, reporting 'updated' on a second run", () => {
    configureOpencode("clancey@1.0.0");
    const { result, file } = configureOpencode("clancey@2.0.0");
    assert.equal(result, "updated");

    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.deepEqual(config.mcp.clancey.command, ["npx", "-y", "clancey@2.0.0"]);
    // No duplicate server blocks — still exactly one clancey entry.
    assert.equal(Object.keys(config.mcp).filter((k) => k === "clancey").length, 1);
  });
});

describe("renderOpencodePlugin", () => {
  test("bakes in the pinned spec and is valid ESM exposing the parity hooks", () => {
    const src = renderOpencodePlugin("clancey@3.1.4");
    // The spec is pinned (used as the npx arg, JSON-quoted).
    assert.match(src, /const SPEC = "clancey@3\.1\.4";/);
    assert.match(src, /export const ClanceyPlugin = async/);
    // The two injection points that give Claude Code parity.
    assert.match(src, /"experimental\.chat\.system\.transform"/);
    assert.match(src, /"tool\.execute\.after"/);
    // Bridges to the same hook CLI with the Claude-shaped event names.
    assert.match(src, /"SessionStart"/);
    assert.match(src, /"PostToolUse"/);
    // Maps OpenCode tool names to the Claude shapes the hook understands.
    assert.match(src, /tool === "bash"/);
    assert.match(src, /tool === "write" \? "Write" : "Edit"/);
  });
});

describe("configureOpencodePlugin", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-ocp-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("writes the pinned plugin under plugins/ when none exists", () => {
    const { result, file } = configureOpencodePlugin("clancey@9.9.9");
    assert.equal(result, "added");
    assert.equal(file, path.join(tmp, "opencode", "plugins", "clancey.js"));
    const src = fs.readFileSync(file, "utf-8");
    assert.match(src, /const SPEC = "clancey@9\.9\.9";/);
  });

  test("re-pins idempotently, reporting 'updated' and leaving one file", () => {
    configureOpencodePlugin("clancey@1.0.0");
    const { result, file } = configureOpencodePlugin("clancey@2.0.0");
    assert.equal(result, "updated");
    const src = fs.readFileSync(file, "utf-8");
    assert.match(src, /const SPEC = "clancey@2\.0\.0";/);
    assert.doesNotMatch(src, /clancey@1\.0\.0/);
  });
});
