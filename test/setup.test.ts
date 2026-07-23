import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  configureOpencode,
  configureOpencodePlugin,
  configureGrok,
  configureGrokHooks,
  configureSkill,
  readSkillMarkdown,
  renderCodexMcpBlock,
  renderGrokMcpBlock,
  renderHookCommand,
  renderOpencodePlugin,
  skillDirFor,
  wireHooks,
  type ClanceyLaunch,
} from "../src/setup.ts";

const LAUNCH: ClanceyLaunch = {
  node: "/usr/local/bin/node",
  entrypoint: "/opt/clancey/dist/index.js",
};

const LAUNCH_V2: ClanceyLaunch = {
  node: "/usr/local/bin/node",
  entrypoint: "/opt/clancey-v2/dist/index.js",
};

function assertNoNpxPin(text: string): void {
  assert.doesNotMatch(text, /npx\s+-y\s+clancey@/);
  assert.doesNotMatch(text, /["']npx["']/);
}

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

describe("renderHookCommand", () => {
  test("pins node + absolute entrypoint for hooks", () => {
    const cmd = renderHookCommand(LAUNCH);
    assert.equal(cmd, `'/usr/local/bin/node' '/opt/clancey/dist/index.js' hook`);
    assertNoNpxPin(cmd);
  });
});

describe("wireHooks (Claude)", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-claude-hooks-"));
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("writes PostToolUse + SessionStart hooks with node+entrypoint, not npx", () => {
    const settingsPath = wireHooks(LAUNCH);
    assert.equal(settingsPath, path.join(tmp, ".claude", "settings.json"));
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const post = settings.hooks.PostToolUse[0].hooks[0].command as string;
    const start = settings.hooks.SessionStart[0].hooks[0].command as string;
    assert.equal(post, renderHookCommand(LAUNCH));
    assert.equal(start, renderHookCommand(LAUNCH));
    assertNoNpxPin(post);
    assertNoNpxPin(JSON.stringify(settings));
  });

  test("re-pins a legacy npx hook command on re-run", () => {
    const dir = path.join(tmp, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ hooks: [{ type: "command", command: "npx -y clancey@1.9.0 hook" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "npx -y clancey@1.9.0 hook" }] }],
        },
      }),
    );
    wireHooks(LAUNCH);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, renderHookCommand(LAUNCH));
    assert.doesNotMatch(JSON.stringify(settings), /npx -y clancey@/);
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

  test("creates opencode.json with node+entrypoint MCP when no config exists", () => {
    const { result, file } = configureOpencode(LAUNCH);
    assert.equal(result, "added");
    assert.equal(file, path.join(tmp, "opencode", "opencode.json"));

    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(config["$schema"], "https://opencode.ai/config.json");
    assert.deepEqual(config.mcp.clancey, {
      type: "local",
      command: [LAUNCH.node, LAUNCH.entrypoint],
      enabled: true,
    });
    assertNoNpxPin(JSON.stringify(config));
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

    const { result, file } = configureOpencode(LAUNCH);
    assert.equal(result, "added"); // clancey wasn't there yet, even though `mcp` was
    assert.equal(file, jsonc); // writes back into the existing .jsonc

    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(config["$schema"], "https://opencode.ai/config.json");
    assert.equal(config.theme, "tokyonight");
    assert.ok(config.mcp.other, "pre-existing MCP server is preserved");
    assert.deepEqual(config.mcp.clancey.command, [LAUNCH.node, LAUNCH.entrypoint]);
    assertNoNpxPin(JSON.stringify(config.mcp.clancey));
  });

  test("re-pins idempotently, reporting 'updated' on a second run", () => {
    configureOpencode(LAUNCH);
    const { result, file } = configureOpencode(LAUNCH_V2);
    assert.equal(result, "updated");

    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.deepEqual(config.mcp.clancey.command, [LAUNCH_V2.node, LAUNCH_V2.entrypoint]);
    // No duplicate server blocks — still exactly one clancey entry.
    assert.equal(Object.keys(config.mcp).filter((k) => k === "clancey").length, 1);
  });
});

describe("renderOpencodePlugin", () => {
  test("bakes in node+entrypoint and records tools without coaching injection", () => {
    const src = renderOpencodePlugin(LAUNCH);
    assert.match(src, /const NODE = "\/usr\/local\/bin\/node";/);
    assert.match(src, /const ENTRY = "\/opt\/clancey\/dist\/index\.js";/);
    assert.match(src, /spawn\(NODE, \[ENTRY, "hook"\]/);
    assert.match(src, /export const ClanceyPlugin = async/);
    assert.match(src, /"tool\.execute\.after"/);
    assert.doesNotMatch(src, /experimental\.chat\.system\.transform/);
    assert.match(src, /"PostToolUse"/);
    assert.match(src, /tool === "bash"/);
    assert.match(src, /tool === "write" \? "Write" : "Edit"/);
    assertNoNpxPin(src);
  });
});

describe("renderGrokMcpBlock", () => {
  test("pins clancey via node + absolute entrypoint for Grok's config.toml", () => {
    const block = renderGrokMcpBlock(LAUNCH);
    assert.equal(
      block,
      `[mcp_servers.clancey]
command = "/usr/local/bin/node"
args = ["/opt/clancey/dist/index.js"]
enabled = true
`,
    );
    assertNoNpxPin(block);
  });
});

describe("configureGrok", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-grok-"));
    prevHome = process.env.GROK_HOME;
    process.env.GROK_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("creates config.toml with the pinned MCP server", () => {
    const result = configureGrok(LAUNCH);
    assert.equal(result, "added");
    const raw = fs.readFileSync(path.join(tmp, "config.toml"), "utf-8");
    assert.match(raw, /\[mcp_servers\.clancey\]/);
    assert.match(raw, /\/opt\/clancey\/dist\/index\.js/);
    assert.match(raw, /command = "\/usr\/local\/bin\/node"/);
    assertNoNpxPin(raw);
  });

  test("re-pins idempotently without duplicating the block", () => {
    configureGrok(LAUNCH);
    assert.equal(configureGrok(LAUNCH_V2), "updated");
    const raw = fs.readFileSync(path.join(tmp, "config.toml"), "utf-8");
    assert.match(raw, /\/opt\/clancey-v2\/dist\/index\.js/);
    assert.doesNotMatch(raw, /\/opt\/clancey\/dist\/index\.js/);
    assert.equal((raw.match(/\[mcp_servers\.clancey\]/g) ?? []).length, 1);
  });

  test("writes live-recording hooks under hooks/clancey.json with node+entrypoint", () => {
    const { result, file } = configureGrokHooks(LAUNCH);
    assert.equal(result, "added");
    assert.equal(file, path.join(tmp, "hooks", "clancey.json"));
    const body = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.ok(body.hooks.PostToolUse);
    assert.ok(body.hooks.SessionStart);
    const cmd = body.hooks.PostToolUse[0].hooks[0].command as string;
    assert.match(cmd, /\/opt\/clancey\/dist\/index\.js' hook$/);
    assert.match(cmd, /\/usr\/local\/bin\/node/);
    assertNoNpxPin(cmd);
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
    const { result, file } = configureOpencodePlugin(LAUNCH);
    assert.equal(result, "added");
    assert.equal(file, path.join(tmp, "opencode", "plugins", "clancey.js"));
    const src = fs.readFileSync(file, "utf-8");
    assert.match(src, /const ENTRY = "\/opt\/clancey\/dist\/index\.js";/);
    assertNoNpxPin(src);
  });

  test("re-pins idempotently, reporting 'updated' and leaving one file", () => {
    configureOpencodePlugin(LAUNCH);
    const { result, file } = configureOpencodePlugin(LAUNCH_V2);
    assert.equal(result, "updated");
    const src = fs.readFileSync(file, "utf-8");
    assert.match(src, /const ENTRY = "\/opt\/clancey-v2\/dist\/index\.js";/);
    assert.doesNotMatch(src, /\/opt\/clancey\/dist\/index\.js/);
  });
});

describe("configureSkill", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevXdg: string | undefined;
  let prevGrok: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-skill-"));
    prevHome = process.env.HOME;
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevGrok = process.env.GROK_HOME;
    // Isolate every host skill path under tmp (claude/codex use HOME; opencode XDG; grok GROK_HOME).
    process.env.HOME = tmp;
    process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
    process.env.GROK_HOME = path.join(tmp, "grok");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevGrok === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrok;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("ships a valid Agent Skills SKILL.md with name + description frontmatter", () => {
    const md = readSkillMarkdown();
    assert.match(md, /^---\nname: clancey\n/);
    assert.match(md, /description:/);
    assert.match(md, /record_decision/);
    assert.match(md, /record_learning/);
    // Coaching lives in the skill — not PostToolUse injection language.
    assert.doesNotMatch(md, /PostToolUse|additionalContext|hookSpecificOutput/);
  });

  test("installs into each host's standard skills directory", () => {
    const expected: Record<"claude" | "codex" | "opencode" | "grok", string> = {
      claude: path.join(tmp, ".claude", "skills", "clancey", "SKILL.md"),
      codex: path.join(tmp, ".codex", "skills", "clancey", "SKILL.md"),
      opencode: path.join(tmp, "xdg", "opencode", "skills", "clancey", "SKILL.md"),
      grok: path.join(tmp, "grok", "skills", "clancey", "SKILL.md"),
    };

    const body = readSkillMarkdown();
    const expectedBody = body.endsWith("\n") ? body : body + "\n";

    for (const target of ["claude", "codex", "opencode", "grok"] as const) {
      assert.equal(path.join(skillDirFor(target), "SKILL.md"), expected[target]);
      const { result, file } = configureSkill(target);
      assert.equal(result, "added");
      assert.equal(file, expected[target]);
      assert.equal(fs.readFileSync(file, "utf-8"), expectedBody);
    }
  });

  test("re-installs idempotently as updated", () => {
    configureSkill("claude");
    const { result, file } = configureSkill("claude");
    assert.equal(result, "updated");
    assert.match(fs.readFileSync(file, "utf-8"), /name: clancey/);
  });
});
