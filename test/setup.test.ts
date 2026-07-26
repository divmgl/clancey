import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  AUTO_REFRESH_PACE,
  autoRefreshBackfill,
  backfill,
  pacingDebtMs,
  payPacingDebt,
  type BackfillOptions,
  configureOpencode,
  configureOpencodePlugin,
  configureGrok,
  configureGrokHooks,
  configureHermes,
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
import { openStore, type Store } from "../src/store.ts";
import { isPidLockHeld, tryClaimPidLock } from "../src/file-lock.ts";
import { refreshLockPath } from "../src/paths.ts";

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
  test("pins node + absolute entrypoint for hooks with host tag", () => {
    const cmd = renderHookCommand(LAUNCH, "claude");
    assert.equal(cmd, `'/usr/local/bin/node' '/opt/clancey/dist/index.js' hook --host claude`);
    assertNoNpxPin(cmd);
    assert.match(renderHookCommand(LAUNCH, "grok"), /--host grok/);
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
    assert.match(src, /spawn\(NODE, \[ENTRY, "hook", "--host", "opencode"\]/);
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
    assert.match(cmd, /\/opt\/clancey\/dist\/index\.js' hook --host grok$/);
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

describe("configureHermes", () => {
  let tmp: string;
  let prevHermes: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-hermes-setup-"));
    prevHermes = process.env.HERMES_HOME;
    process.env.HERMES_HOME = tmp;
  });

  afterEach(() => {
    if (prevHermes === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevHermes;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("creates config.yaml with node+entrypoint MCP (not npx) and installs the skill", () => {
    const { result, file } = configureHermes(LAUNCH);
    assert.equal(result, "added");
    assert.equal(file, path.join(tmp, "config.yaml"));
    const raw = fs.readFileSync(file, "utf-8");
    assert.match(raw, /^mcp_servers:\n/m);
    assert.match(raw, /command: "\/usr\/local\/bin\/node"/);
    assert.match(raw, /\/opt\/clancey\/dist\/index\.js/);
    assertNoNpxPin(raw);

    const skill = configureSkill("hermes");
    assert.equal(skill.result, "added");
    assert.equal(skill.file, path.join(tmp, "skills", "clancey", "SKILL.md"));
    const body = readSkillMarkdown();
    const expectedBody = body.endsWith("\n") ? body : body + "\n";
    assert.equal(fs.readFileSync(skill.file, "utf-8"), expectedBody);
  });

  test("re-pins a legacy npx clancey block and reports updated; second run is idempotent", () => {
    fs.writeFileSync(
      path.join(tmp, "config.yaml"),
      `model:
  default: grok-4.5
mcp_servers:
  clancey:
    command: npx
    args:
      - -y
      - clancey@1.6.0
  other:
    command: echo
    args:
      - hi
skills:
  external_dirs: []
`,
    );

    const first = configureHermes(LAUNCH);
    assert.equal(first.result, "updated");
    let raw = fs.readFileSync(path.join(tmp, "config.yaml"), "utf-8");
    assert.match(raw, /command: "\/usr\/local\/bin\/node"/);
    assert.match(raw, /\/opt\/clancey\/dist\/index\.js/);
    assert.doesNotMatch(raw, /npx|clancey@1\.6\.0/);
    // Sibling MCP server and unrelated keys survive.
    assert.match(raw, /^  other:\n/m);
    assert.match(raw, /^model:\n/m);
    assert.match(raw, /^skills:\n/m);

    const second = configureHermes(LAUNCH_V2);
    assert.equal(second.result, "updated");
    raw = fs.readFileSync(path.join(tmp, "config.yaml"), "utf-8");
    assert.match(raw, /\/opt\/clancey-v2\/dist\/index\.js/);
    assert.doesNotMatch(raw, /\/opt\/clancey\/dist\/index\.js/);
    assert.equal((raw.match(/^  clancey:\s*$/gm) ?? []).length, 1);

    const skill1 = configureSkill("hermes");
    const skill2 = configureSkill("hermes");
    assert.equal(skill1.result, "added");
    assert.equal(skill2.result, "updated");
  });
});

describe("configureSkill", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevXdg: string | undefined;
  let prevGrok: string | undefined;
  let prevHermes: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-skill-"));
    prevHome = process.env.HOME;
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevGrok = process.env.GROK_HOME;
    prevHermes = process.env.HERMES_HOME;
    // Isolate every host skill path under tmp (claude/codex use HOME; opencode XDG; grok/hermes env homes).
    process.env.HOME = tmp;
    process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
    process.env.GROK_HOME = path.join(tmp, "grok");
    process.env.HERMES_HOME = path.join(tmp, "hermes");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevGrok === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrok;
    if (prevHermes === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevHermes;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("ships a timeless Agent Skills SKILL.md centered on conversation lookup", () => {
    const md = readSkillMarkdown();
    assert.match(md, /^---\nname: clancey\n/);
    assert.match(md, /description:/);
    // Lookup workflow is the core of the skill.
    assert.match(md, /recall/);
    assert.match(md, /search/);
    assert.match(md, /grep_turns/);
    assert.match(md, /read_turns/);
    // Worked examples: user intent → tool calls (not volume nudges).
    assert.match(md, /### Examples/);
    assert.match(md, /feature\/auth/);
    assert.match(md, /GameRepository/);
    assert.match(md, /last week/);
    assert.match(md, /a week ago/);
    assert.match(md, /last 7 days/);
    assert.match(md, /record_decision\(\{/);
    assert.match(md, /record_learning\(\{/);
    assert.match(md, /read_turns\(\{ session: "<id>", branch: "main" \}\)/);
    assert.match(md, /assistant·AgentType|assistant·Plan/);
    assert.match(md, /snapshot/i);
    assert.match(md, /recall\(\{ repo:/);
    assert.match(md, /refresh_index/);
    assert.match(md, /Mine a session for decisions/i);
    assert.match(md, /list_sessions/);
    assert.match(md, /host: "codex"/);
    assert.match(md, /owner\/name/);
    assert.match(md, /exclude_session/);
    assert.match(md, /Prior sessions/i);
    // Prefer quality over the old "copiously" volume nudge.
    assert.doesNotMatch(md, /copious/i);
    // Recording is enrichment, still documented.
    assert.match(md, /record_decision/);
    assert.match(md, /record_learning/);
    // No ephemeral wiring, host-version, or path coupling in the skill body.
    assert.doesNotMatch(md, /PostToolUse|additionalContext|hookSpecificOutput/);
    assert.doesNotMatch(md, /~\/\.clancey|npx |clancey@\d/);
    assert.doesNotMatch(md, /\b20\d{2}\b|v\d+\.\d+\.\d+/);
  });

  test("installs into each host's standard skills directory", () => {
    const expected: Record<"claude" | "codex" | "opencode" | "grok" | "hermes", string> = {
      claude: path.join(tmp, ".claude", "skills", "clancey", "SKILL.md"),
      codex: path.join(tmp, ".codex", "skills", "clancey", "SKILL.md"),
      opencode: path.join(tmp, "xdg", "opencode", "skills", "clancey", "SKILL.md"),
      grok: path.join(tmp, "grok", "skills", "clancey", "SKILL.md"),
      hermes: path.join(tmp, "hermes", "skills", "clancey", "SKILL.md"),
    };

    const body = readSkillMarkdown();
    const expectedBody = body.endsWith("\n") ? body : body + "\n";

    for (const target of ["claude", "codex", "opencode", "grok", "hermes"] as const) {
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

describe("pacing (CLA-2)", () => {
  test("debt is proportional to work at any size — the old 2s cap voided the pace setting", () => {
    // A 50% pace means resting as long as you worked, however long that was. Clamping the rest
    // was the bug: a 22s unit rested 2s, a 92% duty cycle from a 50% setting.
    for (const worked of [100, 2_000, 10_000, 22_000]) {
      const rest = pacingDebtMs(worked, 0.5);
      assert.equal(rest, worked);
      const duty = worked / (worked + rest);
      assert.ok(Math.abs(duty - 0.5) < 0.01, `duty ${duty} for worked=${worked}`);
    }
    assert.equal(pacingDebtMs(1_000, 0.25), 3_000);
    assert.equal(pacingDebtMs(10_000, 1), 0);
  });

  test("a debt is paid in full when nothing interrupts it", async () => {
    const start = Date.now();
    const owed = await payPacingDebt(600);
    assert.equal(owed, 0);
    assert.ok(Date.now() - start >= 550, `slept ${Date.now() - start}ms`);
  });

  test("a stop request lands mid-rest and the unpaid remainder is carried, not written off", async () => {
    const start = Date.now();
    let stop = false;
    setTimeout(() => {
      stop = true;
    }, 100);
    const owed = await payPacingDebt(30_000, () => stop);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2_000, `rest should abort promptly, took ${elapsed}ms`);
    assert.ok(owed > 25_000, `remaining debt should survive the abort, got ${owed}`);
  });
});

describe("autoRefreshBackfill (CLA-1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-refresh-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("runs the scan paced well below a full core", async () => {
    const seen: BackfillOptions[] = [];
    const result = await autoRefreshBackfill(null as unknown as Store, {
      dir,
      run: async (_db, o) => {
        seen.push(o);
        return { sessions: 0, events: 0, embeddings: 0 };
      },
    });
    assert.deepEqual(result, { migrating: false, refreshed: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pace, AUTO_REFRESH_PACE);
    assert.ok(AUTO_REFRESH_PACE < 1, "auto-refresh must never run at full speed");
    assert.equal(seen[0].migration, "defer");
  });

  test("skips entirely while another process holds the refresh lock", async () => {
    const held = tryClaimPidLock(refreshLockPath(dir));
    assert.equal(held.owned, true);

    let calls = 0;
    const skipped = await autoRefreshBackfill(null as unknown as Store, {
      dir,
      run: async () => {
        calls++;
        return { sessions: 0, events: 0, embeddings: 0 };
      },
    });
    assert.deepEqual(skipped, { migrating: false, refreshed: false });
    assert.equal(calls, 0, "a second client must not rescan the same corpus");

    // Released: the next caller becomes the single owner.
    held.release();
    const ran = await autoRefreshBackfill(null as unknown as Store, {
      dir,
      run: async () => {
        calls++;
        return { sessions: 0, events: 0, embeddings: 0 };
      },
    });
    assert.equal(ran.refreshed, true);
    assert.equal(calls, 1);
  });

  test("releases the lock even when the scan throws", async () => {
    await assert.rejects(
      autoRefreshBackfill(null as unknown as Store, {
        dir,
        run: async () => {
          throw new Error("scan blew up");
        },
      }),
      /scan blew up/,
    );
    assert.equal(isPidLockHeld(refreshLockPath(dir)), false);
  });
});

describe("backfill abort (CLA-5)", () => {
  let dir: string;
  let hostRoot: string;
  const HOST_ENV = ["GROK_HOME", "CLAUDE_HOME", "CODEX_HOME", "XDG_DATA_HOME", "HERMES_HOME"] as const;
  let prev: Record<string, string | undefined>;

  /** One Grok session unit: summary + a single user turn. */
  function writeGrokSession(id: string): void {
    const sessionDir = path.join(process.env.GROK_HOME!, "sessions", encodeURIComponent("/repo/abort"), id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id, cwd: "/repo/abort" },
        generated_title: `Abort fixture ${id}`,
        session_summary: `Abort fixture ${id}`,
        head_branch: "main",
        session_kind: "primary",
        created_at: "2026-06-01T00:00:00Z",
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(sessionDir, "updates.jsonl"),
      JSON.stringify({
        timestamp: 1717200000,
        method: "session/update",
        params: {
          sessionId: id,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: `a substantial user turn recorded in session ${id}` },
            _meta: { agentTimestampMs: 1717200000000 },
          },
        },
      }) + "\n",
    );
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-abort-"));
    hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-abort-hosts-"));
    prev = Object.fromEntries(HOST_ENV.map((k) => [k, process.env[k]]));
    for (const k of HOST_ENV) process.env[k] = path.join(hostRoot, k.toLowerCase());
    for (const id of ["ses_a", "ses_b", "ses_c", "ses_d"]) writeGrokSession(id);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hostRoot, { recursive: true, force: true });
  });

  test("stops mid-scan on request and the next pass resumes where it left off", async () => {
    const db = openStore(path.join(dir, "clancey.db"));
    try {
      // True after the first unit: a stop must not have to wait out the whole corpus, which on a
      // real machine is minutes of parsing (the first SIGTERM looked swallowed).
      let ingested = 0;
      const stopped = await backfill(db, { shouldStop: () => ingested++ >= 1 });
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.sessions, 1, "should abandon the pass after one unit");

      // Cursors are per unit, so the abandoned pass costs nothing: the rest land next time.
      const rest = await backfill(db, {});
      assert.equal(rest.stopped, undefined);
      assert.equal(rest.sessions, 3);

      const sessions = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
      assert.equal(sessions.n, 4);

      // And a third pass re-reads nothing — the stopped pass's work was durably recorded.
      assert.equal((await backfill(db, {})).sessions, 0);
    } finally {
      db.close();
    }
  });
});
