import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { intro, outro, log as clog, spinner, confirm, multiselect, isCancel, cancel } from "@clack/prompts";

const execFileAsync = promisify(execFile);
import {
  Store,
  openStore,
  insertToolEvent,
  insertEmbedding,
  insertMessage,
  setIngested,
  getIngestedMtime,
  deleteSession,
  pruneOlderThan,
  getRetentionDays,
  storeTotals,
  CLANCEY_DIR,
} from "./store.js";
import {
  listAllTranscripts,
  listSubagents,
  listGrokSubagents,
  listOpencodeUnitFiles,
  listGrokUnitFiles,
  listHermesUnitFiles,
  parseAny,
  parseSubagent,
  getOpencodeStorageDir,
  getGrokSessionsDir,
  getHermesHome,
  ParsedTranscript,
  SubagentRef,
} from "./parser.js";
import { embedOne } from "./embeddings.js";
import { repoKey } from "./git.js";
import { setConsoleSilent } from "./logger.js";

const tildify = (p: string) => p.replace(os.homedir(), "~");

/** A tool clancey can wire itself into. */
export type Target = "claude" | "codex" | "opencode" | "grok" | "hermes";

const POST_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|search_replace|run_terminal_command";
const FRAMING_MAX_CHARS = 2000;
const LEGACY_INDEX = path.join(CLANCEY_DIR, "conversations.lance");

/** Build the search anchor text for a session's framing embedding. */
function framingText(title: string | null, framing: string): string {
  return title ? `${title}\n\n${framing}` : framing;
}

/**
 * Ingest existing transcripts into the store. Incremental by mtime unless `force`.
 * Historical sessions have no recorded decisions, so coverage comes from a framing
 * embedding (title + first user turn) per session — keeping every session searchable.
 */
export async function backfill(
  db: Store,
  opts: { force?: boolean } = {},
): Promise<{ sessions: number; events: number; embeddings: number }> {
  const transcripts = await listAllTranscripts();
  const repoCache = new Map<string, string | null>();
  const resolveRepo = (cwd: string | null): string | null => {
    if (!cwd) return null;
    if (!repoCache.has(cwd)) {
      repoCache.set(cwd, fs.existsSync(cwd) ? repoKey(cwd) ?? cwd : cwd);
    }
    return repoCache.get(cwd) ?? null;
  };

  let sessions = 0;
  let events = 0;
  let embeddings = 0;

  for (const ref of transcripts) {
    const file = ref.path;

    // A session and its subagents are one ingest unit: subagent turns fold under the parent
    // session id, and deleteSession() wipes the whole unit before re-inserting. Gate on the
    // newest mtime across the parent transcript and all its subagent files so a change to any
    // of them re-ingests the unit and avoids partial folds. OpenCode and Grok spread one session
    // across many files, so their unit is the session metadata plus related files.
    const subRefs =
      ref.kind === "claude"
        ? await listSubagents(file)
        : ref.kind === "grok"
          ? await listGrokSubagents(file)
          : [];
    const unitFiles =
      ref.kind === "opencode"
        ? await listOpencodeUnitFiles(file)
        : ref.kind === "grok"
          ? await listGrokUnitFiles(file)
          : ref.kind === "hermes"
            ? listHermesUnitFiles(file)
            : [file, ...subRefs.map((s) => s.path)];
    const mtimes = await Promise.all(
      unitFiles.map((f) =>
        fs.promises.stat(f).then(
          (s) => s.mtimeMs,
          () => 0,
        ),
      ),
    );
    const unitMtime = Math.max(0, ...mtimes);
    if (unitMtime === 0) continue;
    if (!opts.force && getIngestedMtime(db, file) === unitMtime) continue;

    const parsed = await parseAny(ref);
    const subs: { ref: SubagentRef; parsed: ParsedTranscript }[] = await Promise.all(
      subRefs.map(async (s) => ({ ref: s, parsed: await parseSubagent(s) })),
    );

    const hasContent =
      parsed.toolEvents.length > 0 ||
      parsed.framing !== null ||
      parsed.messages.length > 0 ||
      subs.some((s) => s.parsed.messages.length > 0 || s.parsed.toolEvents.length > 0);
    if (!hasContent) {
      setIngested(db, file, unitMtime);
      continue;
    }

    let framingVec: number[] | null = null;
    if (parsed.framing) {
      framingVec = await embedOne(framingText(parsed.title, parsed.framing).slice(0, FRAMING_MAX_CHARS));
    }
    const first = parsed.toolEvents[0];

    const apply = db.transaction(() => {
      deleteSession(db, parsed.sessionId);

      const host = ref.kind;
      const insertEvents = (p: ParsedTranscript, agent: string | null) => {
        for (const e of p.toolEvents) {
          insertToolEvent(db, {
            session: parsed.sessionId,
            repo: resolveRepo(e.cwd),
            branch: e.branch,
            cwd: e.cwd,
            tool: e.tool,
            file: e.file,
            command: e.command,
            ts: e.timestamp,
            agent,
            host,
          });
          events++;
        }
      };
      const insertMessages = (p: ParsedTranscript) => {
        for (const m of p.messages) {
          const repo = resolveRepo(first?.cwd ?? null);
          insertMessage(db, {
            session: parsed.sessionId,
            ts: m.timestamp,
            branch: m.branch,
            role: m.role,
            agent: m.agent,
            agentId: m.agentId,
            text: m.text,
            host,
            repo,
          });
        }
      };

      insertEvents(parsed, null);
      insertMessages(parsed);
      for (const s of subs) {
        insertEvents(s.parsed, s.ref.agentType);
        insertMessages(s.parsed);
      }

      if (framingVec && parsed.framing) {
        insertEmbedding(db, {
          session: parsed.sessionId,
          repo: resolveRepo(first?.cwd ?? null),
          branch: first?.branch ?? null,
          kind: "framing",
          text: framingText(parsed.title, parsed.framing),
          vector: framingVec,
          ts: parsed.userTurns[0]?.timestamp ?? new Date().toISOString(),
          host,
        });
        embeddings++;
      }
      setIngested(db, file, unitMtime);
    });
    apply();
    sessions++;
  }

  const retentionDays = getRetentionDays(db);
  if (retentionDays > 0) pruneOlderThan(db, retentionDays);

  return { sessions, events, embeddings };
}

/**
 * Resolved launch target for hooks and MCP: a real `node` binary + absolute entrypoint.
 * Re-running setup re-pins every host to this install (no `npx -y clancey@…`).
 */
export interface ClanceyLaunch {
  node: string;
  entrypoint: string;
}

/** Shell-safe single-quoted string for hook command lines. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveLaunch(
  node: string = process.execPath,
  entrypoint: string = currentEntrypoint(),
): ClanceyLaunch {
  return {
    node: fs.realpathSync(node),
    entrypoint: fs.realpathSync(entrypoint),
  };
}

/** `node /abs/path/dist/index.js hook --host <host>` — used by Claude and Grok command hooks. */
export function renderHookCommand(launch: ClanceyLaunch, host: "claude" | "grok" | "opencode" = "claude"): string {
  return `${shellQuote(launch.node)} ${shellQuote(launch.entrypoint)} hook --host ${host}`;
}

/** Match any prior clancey hook form (npx pin, bare clancey, or node+entrypoint). */
const CLANCEY_HOOK_RE = /\bclancey(@\S+)?\s+hook\b|clancey[/\\]dist[/\\]index\.js['"]?\s+hook\b|clancey['"]?\s+hook\b/;

/** Add (or re-pin) the clancey hooks in the global Claude Code settings, idempotently. */
export function wireHooks(launch: ClanceyLaunch = resolveLaunch()): string {
  const hookCmd = renderHookCommand(launch, "claude");
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let settings: { hooks?: Record<string, HookGroup[]> } = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }
  settings.hooks ??= {};

  const ensure = (event: string, matcher?: string): void => {
    const groups = (settings.hooks![event] ??= []);
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (CLANCEY_HOOK_RE.test(h.command)) {
          h.command = hookCmd;
          return;
        }
      }
    }
    const group: HookGroup = { hooks: [{ type: "command", command: hookCmd }] };
    if (matcher) group.matcher = matcher;
    groups.push(group);
  };

  ensure("PostToolUse", POST_TOOL_MATCHER);
  ensure("SessionStart");

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return settingsPath;
}

interface HookGroup {
  matcher?: string;
  hooks?: { type: string; command: string }[];
}

const CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function currentEntrypoint(): string {
  const bin = process.argv[1];
  return fs.realpathSync(bin || fileURLToPath(import.meta.url));
}

export function renderCodexMcpBlock(
  entrypoint: string = currentEntrypoint(),
  node: string = process.execPath,
): string {
  return [
    "[mcp_servers.clancey]",
    `command = ${tomlString(node)}`,
    `args = [${[entrypoint].map(tomlString).join(", ")}]`,
    "",
  ].join("\n");
}

/** OpenCode's config dir, XDG-aware: $XDG_CONFIG_HOME/opencode (falls back to ~/.config). */
function opencodeConfigDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode");
}

/** The OpenCode config file to write — an existing opencode.jsonc/json, else a new opencode.json. */
function opencodeConfigPath(): string {
  const dir = opencodeConfigDir();
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, "opencode.json");
}

/** The generated OpenCode plugin file — OpenCode auto-loads any file under plugins/. */
function opencodePluginPath(): string {
  return path.join(opencodeConfigDir(), "plugins", "clancey.js");
}

/**
 * Render the OpenCode plugin that records live tool events (file edits + bash).
 *
 * OpenCode has no hook-command mechanism like Claude Code, but its plugin API exposes
 * tool.execute.after. The plugin shells out to the SAME node+entrypoint hook CLI Claude
 * Code uses, translating OpenCode tool calls into the Claude-shaped hook payload — so
 * live tool recording is shared. Decision/learning coaching lives in the Clancey skill
 * (not system-prompt or tool-output injection).
 *
 * Regenerated verbatim on every setup, so re-running re-pins the absolute paths.
 */
export function renderOpencodePlugin(launch: ClanceyLaunch = resolveLaunch()): string {
  return `// Generated by clancey setup — do not edit. Re-run \`clancey setup\` to update.
// Records OpenCode file/command tool events via the pinned node+entrypoint hook CLI.
import { spawn } from "node:child_process";

const NODE = ${JSON.stringify(launch.node)};
const ENTRY = ${JSON.stringify(launch.entrypoint)};

/** Invoke \`clancey hook\` with a Claude-shaped payload on stdin (fire-and-forget). */
function runHook(payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(NODE, [ENTRY, "hook", "--host", "opencode"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(null));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Map an OpenCode tool call to the Claude tool shape clancey's hook understands, or null to skip. */
function mapTool(tool, args) {
  args = args || {};
  if (tool === "bash" && typeof args.command === "string") {
    return { tool_name: "Bash", tool_input: { command: args.command } };
  }
  const filePath = args.filePath || args.file_path || args.path;
  if ((tool === "edit" || tool === "write") && typeof filePath === "string") {
    return { tool_name: tool === "write" ? "Write" : "Edit", tool_input: { file_path: filePath } };
  }
  return null;
}

export const ClanceyPlugin = async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd();

  return {
    "tool.execute.after": async (input) => {
      try {
        const mapped = mapTool(input.tool, input.args);
        if (!mapped) return;
        await runHook({
          hook_event_name: "PostToolUse",
          session_id: input.sessionID || "",
          cwd,
          tool_name: mapped.tool_name,
          tool_input: mapped.tool_input,
        });
      } catch {
        // never block a tool
      }
    },
  };
};
`;
}

/** Write (or re-pin) the clancey OpenCode plugin, idempotently. */
export function configureOpencodePlugin(
  launch: ClanceyLaunch = resolveLaunch(),
): { result: "added" | "updated"; file: string } {
  const file = opencodePluginPath();
  const had = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderOpencodePlugin(launch));
  return { result: had ? "updated" : "added", file };
}

async function hasClaude(): Promise<boolean> {
  try {
    await execFileAsync("claude", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function hasCodex(): boolean {
  return fs.existsSync(path.join(os.homedir(), ".codex"));
}

function hasOpencode(): boolean {
  return fs.existsSync(getOpencodeStorageDir()) || fs.existsSync(opencodeConfigDir());
}

function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function hasGrok(): boolean {
  return fs.existsSync(grokHome()) || fs.existsSync(getGrokSessionsDir());
}

function hasHermes(): boolean {
  return fs.existsSync(getHermesHome());
}

function hermesConfigPath(): string {
  return path.join(getHermesHome(), "config.yaml");
}

const GROK_CONFIG = (): string => path.join(grokHome(), "config.toml");
const GROK_HOOKS_DIR = (): string => path.join(grokHome(), "hooks");

/** Render the Grok Build MCP server block (stdio via node + absolute entrypoint). */
export function renderGrokMcpBlock(launch: ClanceyLaunch = resolveLaunch()): string {
  return [
    "[mcp_servers.clancey]",
    `command = ${tomlString(launch.node)}`,
    `args = [${[launch.entrypoint].map(tomlString).join(", ")}]`,
    "enabled = true",
    "",
  ].join("\n");
}

/** Add (or refresh) the clancey MCP server in Grok's config.toml, idempotently. */
export function configureGrok(launch: ClanceyLaunch = resolveLaunch()): "added" | "updated" {
  const configPath = GROK_CONFIG();
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
  const had = existing.includes("[mcp_servers.clancey]");
  const block = renderGrokMcpBlock(launch);

  const stripped = existing
    .replace(/\[mcp_servers\.clancey\][\s\S]*?(?=\n\[|$)/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const content = stripped ? `${stripped}\n\n${block}` : block;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content.endsWith("\n") ? content : content + "\n");
  return had ? "updated" : "added";
}

/**
 * Write (or re-pin) the Grok hooks file for silent live tool-event recording.
 * No agent coaching here — that lives in the Clancey skill installed alongside MCP.
 */
export function configureGrokHooks(
  launch: ClanceyLaunch = resolveLaunch(),
): { result: "added" | "updated"; file: string } {
  const file = path.join(GROK_HOOKS_DIR(), "clancey.json");
  const had = fs.existsSync(file);
  const hookCmd = renderHookCommand(launch, "grok");
  const body = {
    hooks: {
      PostToolUse: [
        {
          matcher: POST_TOOL_MATCHER,
          hooks: [{ type: "command", command: hookCmd, timeout: 15 }],
        },
      ],
      SessionStart: [
        {
          hooks: [{ type: "command", command: hookCmd, timeout: 15 }],
        },
      ],
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return { result: had ? "updated" : "added", file };
}

const SKILL_NAME = "clancey";

/**
 * Absolute path to the shipped `skills/clancey/SKILL.md`.
 * Works from both `src/` (tsx) and `dist/` (built package).
 */
export function skillSourcePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", SKILL_NAME, "SKILL.md");
}

/** Read the packaged Agent Skills SKILL.md, or throw if the package is incomplete. */
export function readSkillMarkdown(): string {
  const src = skillSourcePath();
  if (!fs.existsSync(src)) {
    throw new Error(`Clancey skill missing at ${src} — package is incomplete`);
  }
  return fs.readFileSync(src, "utf-8");
}

/**
 * Global skill directory for a host, following each tool's Agent Skills layout
 * (and the paths used by the open `skills` CLI).
 */
export function skillDirFor(target: Target): string {
  switch (target) {
    case "claude":
      return path.join(os.homedir(), ".claude", "skills", SKILL_NAME);
    case "codex":
      return path.join(os.homedir(), ".codex", "skills", SKILL_NAME);
    case "opencode":
      return path.join(opencodeConfigDir(), "skills", SKILL_NAME);
    case "grok":
      return path.join(grokHome(), "skills", SKILL_NAME);
    case "hermes":
      return path.join(getHermesHome(), "skills", SKILL_NAME);
  }
}

/**
 * Upsert `mcp_servers.clancey` in a Hermes config.yaml without a YAML library.
 * Replaces any existing clancey entry (including legacy `npx -y clancey@…` pins)
 * and leaves sibling MCP servers and the rest of the file intact.
 */
export function upsertHermesClanceyMcp(
  raw: string,
  launch: ClanceyLaunch,
): { text: string; had: boolean } {
  const clanceyLines = [
    "  clancey:",
    `    command: ${JSON.stringify(launch.node)}`,
    "    args:",
    `      - ${JSON.stringify(launch.entrypoint)}`,
  ];

  const lines = raw.length ? raw.split("\n") : [];
  // Drop a trailing empty line so joins stay tidy; restore a final newline at the end.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const isTopLevelKey = (line: string) => /^[^\s#]/.test(line) && line.trim() !== "";
  const isMcpServers = (line: string) => /^mcp_servers:\s*(#.*)?$/.test(line);
  const isClanceyKey = (line: string) => /^  clancey:\s*(#.*)?$/.test(line);
  // Next server key under mcp_servers (two-space indent, not deeper).
  const isMcpSiblingKey = (line: string) => /^  [^\s#]/.test(line) && !/^    /.test(line);

  let mcpIdx = lines.findIndex(isMcpServers);
  if (mcpIdx === -1) {
    const out = [...lines];
    if (out.length) out.push("");
    out.push("mcp_servers:", ...clanceyLines);
    return { text: out.join("\n") + "\n", had: false };
  }

  // Extent of the mcp_servers section: until the next top-level key.
  let sectionEnd = lines.length;
  for (let i = mcpIdx + 1; i < lines.length; i++) {
    if (isTopLevelKey(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let clanceyStart = -1;
  let clanceyEnd = -1;
  for (let i = mcpIdx + 1; i < sectionEnd; i++) {
    if (!isClanceyKey(lines[i])) continue;
    clanceyStart = i;
    clanceyEnd = sectionEnd;
    for (let j = i + 1; j < sectionEnd; j++) {
      const l = lines[j];
      if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
      if (isMcpSiblingKey(l)) {
        clanceyEnd = j;
        break;
      }
    }
    break;
  }

  const out = [...lines];
  const had = clanceyStart !== -1;
  if (had) {
    out.splice(clanceyStart, clanceyEnd - clanceyStart, ...clanceyLines);
  } else {
    out.splice(mcpIdx + 1, 0, ...clanceyLines);
  }
  return { text: out.join("\n") + "\n", had };
}

/** Add (or re-pin) the clancey MCP server in Hermes config.yaml, idempotently. */
export function configureHermes(
  launch: ClanceyLaunch = resolveLaunch(),
): { result: "added" | "updated"; file: string } {
  const file = hermesConfigPath();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const { text, had } = upsertHermesClanceyMcp(existing, launch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { result: had ? "updated" : "added", file };
}

/**
 * Install (or refresh) the Clancey skill for a host. Teaches cross-client conversation
 * lookup (and optional decision/learning enrichment) via the Agent Skills path —
 * not PostToolUse coaching text.
 */
export function configureSkill(target: Target): { result: "added" | "updated"; file: string } {
  const dir = skillDirFor(target);
  const file = path.join(dir, "SKILL.md");
  const had = fs.existsSync(file);
  const body = readSkillMarkdown();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n");
  return { result: had ? "updated" : "added", file };
}

/**
 * Strip line and block comments from JSONC without touching comment-like text inside strings
 * (the `$schema` value is a `https://` URL). Walks char-by-char tracking string/escape state.
 */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      if (i < input.length) out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++; // land on the trailing '/'
    } else {
      out += ch;
    }
  }
  return out;
}

/** Parse JSONC tolerantly: plain JSON first (the common case), comment-stripped only on failure. */
function parseJsonc(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  }
}

/** Add (or re-pin) the clancey MCP server in OpenCode's config, idempotently. */
export function configureOpencode(
  launch: ClanceyLaunch = resolveLaunch(),
): { result: "added" | "updated"; file: string } {
  const file = opencodeConfigPath();
  const config = fs.existsSync(file) ? parseJsonc(fs.readFileSync(file, "utf-8")) : {};
  config["$schema"] ??= "https://opencode.ai/config.json";
  const mcp = (config.mcp && typeof config.mcp === "object" ? config.mcp : {}) as Record<string, unknown>;
  const had = "clancey" in mcp;
  mcp.clancey = { type: "local", command: [launch.node, launch.entrypoint], enabled: true };
  config.mcp = mcp;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return { result: had ? "updated" : "added", file };
}

/** Add (or refresh) the clancey MCP server in Codex's config.toml, idempotently. */
export function configureCodex(launch: ClanceyLaunch = resolveLaunch()): "added" | "updated" {
  const existing = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, "utf-8") : "";
  const had = existing.includes("[mcp_servers.clancey]");
  const block = renderCodexMcpBlock(launch.entrypoint, launch.node);

  // Strip any existing clancey block so re-runs re-pin the entrypoint instead of duplicating.
  const stripped = existing.replace(/\[mcp_servers\.clancey\][\s\S]*?(?=\n\[|$)/, "").replace(/\n{3,}/g, "\n\n").trim();
  const content = stripped ? `${stripped}\n\n${block}` : block;

  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  fs.writeFileSync(CODEX_CONFIG, content);
  return had ? "updated" : "added";
}

/** Register (or re-pin) the MCP server at user scope via node + absolute entrypoint. */
async function registerMcp(launch: ClanceyLaunch): Promise<"added" | "updated" | "failed"> {
  let existed = false;
  try {
    await execFileAsync("claude", ["mcp", "get", "clancey"]);
    existed = true;
  } catch {
    // not registered yet
  }
  if (existed) {
    try {
      await execFileAsync("claude", ["mcp", "remove", "clancey"]);
    } catch {
      // best-effort; re-add below still re-pins
    }
  }
  try {
    await execFileAsync("claude", [
      "mcp",
      "add",
      "--scope",
      "user",
      "clancey",
      "--",
      launch.node,
      launch.entrypoint,
    ]);
    return existed ? "updated" : "added";
  } catch {
    return "failed";
  }
}

function dirSize(target: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(1)} ${units[u]}`;
}

/**
 * The v1 LanceDB index is faulty and large. Offer to delete it (default yes) once the new
 * store is built. Non-interactive runs only delete it when `clean` is set.
 */
async function cleanLegacyIndex(clean: boolean): Promise<void> {
  if (!fs.existsSync(LEGACY_INDEX)) return;
  const bytes = dirSize(LEGACY_INDEX);

  // The published v0 server recreates an empty index dir on every launch. An empty
  // husk holds no data, so there is nothing to prompt about — leave it untouched.
  if (bytes === 0) return;

  const size = formatBytes(bytes);
  let remove = clean;
  if (!clean) {
    if (!process.stdin.isTTY) {
      clog.info(`Legacy v1 index present (${size}). Re-run with --clean-legacy to remove it.`);
      return;
    }
    const answer = await confirm({
      message: `Delete the faulty legacy v1 index and free ${size}?`,
      initialValue: true,
    });
    if (isCancel(answer)) {
      cancel("Setup cancelled — the legacy index was left in place.");
      process.exit(0);
    }
    remove = answer;
  }

  if (remove) {
    const s = spinner();
    s.start(`Deleting legacy v1 index (${size})`);
    fs.rmSync(LEGACY_INDEX, { recursive: true, force: true });
    s.stop(`Removed legacy v1 index — ${size} freed`);
  } else {
    clog.info("Left the legacy v1 index in place.");
  }
}

/** Pick which tools to register the MCP server with — detected ones pre-selected. */
async function selectTargets(preset: Target[] | null): Promise<Target[]> {
  const detected = {
    claude: await hasClaude(),
    codex: hasCodex(),
    opencode: hasOpencode(),
    grok: hasGrok(),
    hermes: hasHermes(),
  };
  const installed = (["claude", "codex", "opencode", "grok", "hermes"] as const).filter((t) => detected[t]);

  if (preset) return preset;
  if (!process.stdin.isTTY) return [...installed];

  const selected = await multiselect<"all" | Target>({
    message: "Set up the MCP server for which tools?",
    options: [
      { value: "all", label: "All", hint: "every detected tool" },
      { value: "claude", label: "Claude Code", hint: detected.claude ? "MCP + skill + live capture" : "not detected" },
      { value: "codex", label: "Codex", hint: detected.codex ? "MCP + skill + history import" : "not detected" },
      { value: "opencode", label: "OpenCode", hint: detected.opencode ? "MCP + skill + live capture" : "not detected" },
      { value: "grok", label: "Grok Build", hint: detected.grok ? "MCP + skill + live capture" : "not detected" },
      { value: "hermes", label: "Hermes Agent", hint: detected.hermes ? "MCP + skill + history import" : "not detected" },
    ],
    initialValues: [...installed],
    required: false,
  });
  if (isCancel(selected)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  if (selected.includes("all")) return [...installed];
  return selected.filter((t): t is Target => t !== "all");
}

/** `clancey setup` — register the MCP server with the chosen tools, backfill, then clean the v1 index. */
export async function setup(opts: { cleanLegacy?: boolean; targets?: Target[] } = {}): Promise<void> {
  setConsoleSilent(true); // clack owns the terminal; log() keeps writing to the file
  intro("clancey setup");

  const targets = await selectTargets(opts.targets ?? null);
  const launch = resolveLaunch();
  const pinLabel = tildify(launch.entrypoint);

  if (targets.includes("claude")) {
    clog.success(`Wired live-capture hooks into ${tildify(wireHooks(launch))}`);
    const mcpSpin = spinner();
    mcpSpin.start("Registering Claude Code MCP server");
    const mcp = await registerMcp(launch);
    if (mcp === "added") mcpSpin.stop(`Registered Claude Code MCP server (${pinLabel}, user scope)`);
    else if (mcp === "updated") mcpSpin.stop(`Re-pinned Claude Code MCP server to ${pinLabel}`);
    else {
      mcpSpin.stop("Could not register Claude Code MCP server");
      clog.warn(
        `Add manually: claude mcp add --scope user clancey -- ${shellQuote(launch.node)} ${shellQuote(launch.entrypoint)}`,
      );
    }
    const skill = configureSkill("claude");
    clog.success(
      skill.result === "added"
        ? `Installed Clancey skill into ${tildify(skill.file)}`
        : `Refreshed Clancey skill in ${tildify(skill.file)}`,
    );
  }

  if (targets.includes("codex")) {
    const codex = configureCodex(launch);
    clog.success(
      codex === "added"
        ? `Registered Codex MCP server from this clancey install (${pinLabel}) in ${tildify(CODEX_CONFIG)}`
        : `Refreshed Codex MCP server for this clancey install (${pinLabel}) in ${tildify(CODEX_CONFIG)}`,
    );
    const skill = configureSkill("codex");
    clog.success(
      skill.result === "added"
        ? `Installed Clancey skill into ${tildify(skill.file)}`
        : `Refreshed Clancey skill in ${tildify(skill.file)}`,
    );
  }

  if (targets.includes("opencode")) {
    const { result, file } = configureOpencode(launch);
    clog.success(
      result === "added"
        ? `Registered OpenCode MCP server (${pinLabel}) in ${tildify(file)}`
        : `Re-pinned OpenCode MCP server to ${pinLabel} in ${tildify(file)}`,
    );
    const plugin = configureOpencodePlugin(launch);
    clog.success(
      plugin.result === "added"
        ? `Wired OpenCode live-recording plugin into ${tildify(plugin.file)}`
        : `Re-pinned OpenCode live-recording plugin in ${tildify(plugin.file)}`,
    );
    const skill = configureSkill("opencode");
    clog.success(
      skill.result === "added"
        ? `Installed Clancey skill into ${tildify(skill.file)}`
        : `Refreshed Clancey skill in ${tildify(skill.file)}`,
    );
  }

  if (targets.includes("grok")) {
    const grok = configureGrok(launch);
    clog.success(
      grok === "added"
        ? `Registered Grok Build MCP server (${pinLabel}) in ${tildify(GROK_CONFIG())}`
        : `Re-pinned Grok Build MCP server to ${pinLabel} in ${tildify(GROK_CONFIG())}`,
    );
    const hooks = configureGrokHooks(launch);
    clog.success(
      hooks.result === "added"
        ? `Wired Grok Build live-recording hooks into ${tildify(hooks.file)}`
        : `Re-pinned Grok Build live-recording hooks in ${tildify(hooks.file)}`,
    );
    const skill = configureSkill("grok");
    clog.success(
      skill.result === "added"
        ? `Installed Clancey skill into ${tildify(skill.file)}`
        : `Refreshed Clancey skill in ${tildify(skill.file)}`,
    );
  }

  if (targets.includes("hermes")) {
    const hermes = configureHermes(launch);
    clog.success(
      hermes.result === "added"
        ? `Registered Hermes MCP server (${pinLabel}) in ${tildify(hermes.file)}`
        : `Re-pinned Hermes MCP server to ${pinLabel} in ${tildify(hermes.file)}`,
    );
    const skill = configureSkill("hermes");
    clog.success(
      skill.result === "added"
        ? `Installed Clancey skill into ${tildify(skill.file)}`
        : `Refreshed Clancey skill in ${tildify(skill.file)}`,
    );
  }

  const backfillSpin = spinner();
  backfillSpin.start("Backfilling conversations");
  const db = openStore();
  let stats;
  let totals;
  try {
    stats = await backfill(db);
    totals = storeTotals(db);
  } finally {
    db.close();
  }
  backfillSpin.stop(
    `Backfilled ${stats.sessions} sessions — ${stats.events} events, ${stats.embeddings} embeddings ` +
      `(totals: ${totals.sessions} sessions, ${totals.events} events, ${totals.embeddings} embeddings)`,
  );

  // Only after the new store is built do we offer to remove the old index.
  await cleanLegacyIndex(opts.cleanLegacy ?? false);

  const label: Record<Target, string> = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    grok: "Grok Build",
    hermes: "Hermes Agent",
  };
  const restart = targets.map((t) => label[t]).join(" and ");
  outro(restart ? `Done — restart ${restart} to load the MCP server.` : "Done.");
}
