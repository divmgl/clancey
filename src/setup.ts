import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
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
import { listAllTranscripts, listSubagents, parseAny, parseSubagent, ParsedTranscript, SubagentRef } from "./parser.js";
import { embedOne } from "./embeddings.js";
import { repoKey } from "./git.js";
import { setConsoleSilent } from "./logger.js";

const tildify = (p: string) => p.replace(os.homedir(), "~");

const POST_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash";
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
    // of them re-ingests the unit and avoids partial folds.
    const subRefs = ref.kind === "claude" ? await listSubagents(file) : [];
    const unitFiles = [file, ...subRefs.map((s) => s.path)];
    const mtimes = await Promise.all(unitFiles.map((f) => fs.promises.stat(f).then((s) => s.mtimeMs)));
    const unitMtime = Math.max(...mtimes);
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
          });
          events++;
        }
      };
      const insertMessages = (p: ParsedTranscript) => {
        for (const m of p.messages) {
          insertMessage(db, {
            session: parsed.sessionId,
            ts: m.timestamp,
            branch: m.branch,
            role: m.role,
            agent: m.agent,
            agentId: m.agentId,
            text: m.text,
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
 * The pinned package spec (`clancey@<version>`) that all wiring runs through `npx`.
 * Pinning means a user's hooks and MCP keep working on the version that set them up,
 * even after newer releases ship; re-running setup re-pins to the current version.
 */
function clanceySpec(): string {
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version as string;
  return `clancey@${version}`;
}

/** A hook command that invokes clancey (any pinned version, or the legacy bare form). */
const CLANCEY_HOOK_RE = /\bclancey(@\S+)?\s+hook\b/;

/** Add (or re-pin) the clancey hooks in the global Claude Code settings, idempotently. */
function wireHooks(spec: string): string {
  const hookCmd = `npx -y ${spec} hook`;
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

/** Add (or re-pin) the clancey MCP server in Codex's config.toml, idempotently. */
function configureCodex(spec: string): "added" | "updated" {
  const existing = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, "utf-8") : "";
  const had = existing.includes("[mcp_servers.clancey]");
  const block = `[mcp_servers.clancey]\ncommand = "npx"\nargs = ["-y", "${spec}"]\n`;

  // Strip any existing clancey block so re-runs re-pin the version instead of duplicating.
  const stripped = existing.replace(/\[mcp_servers\.clancey\][\s\S]*?(?=\n\[|$)/, "").replace(/\n{3,}/g, "\n\n").trim();
  const content = stripped ? `${stripped}\n\n${block}` : block;

  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  fs.writeFileSync(CODEX_CONFIG, content);
  return had ? "updated" : "added";
}

/** Register (or re-pin) the MCP server at user scope via pinned npx. */
async function registerMcp(spec: string): Promise<"added" | "updated" | "failed"> {
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
    await execFileAsync("claude", ["mcp", "add", "--scope", "user", "clancey", "--", "npx", "-y", spec]);
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
async function selectTargets(preset: ("claude" | "codex")[] | null): Promise<("claude" | "codex")[]> {
  const detected = { claude: await hasClaude(), codex: hasCodex() };
  const installed = (["claude", "codex"] as const).filter((t) => detected[t]);

  if (preset) return preset;
  if (!process.stdin.isTTY) return [...installed];

  const selected = await multiselect<"all" | "claude" | "codex">({
    message: "Set up the MCP server for which tools?",
    options: [
      { value: "all", label: "All", hint: "every detected tool" },
      { value: "claude", label: "Claude Code", hint: detected.claude ? "hooks + MCP" : "not detected" },
      { value: "codex", label: "Codex", hint: detected.codex ? "MCP, backfill-only" : "not detected" },
    ],
    initialValues: [...installed],
    required: false,
  });
  if (isCancel(selected)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  if (selected.includes("all")) return [...installed];
  return selected.filter((t): t is "claude" | "codex" => t !== "all");
}

/** `clancey setup` — register the MCP server with the chosen tools, backfill, then clean the v1 index. */
export async function setup(opts: { cleanLegacy?: boolean; targets?: ("claude" | "codex")[] } = {}): Promise<void> {
  setConsoleSilent(true); // clack owns the terminal; log() keeps writing to the file
  intro("clancey setup");

  const targets = await selectTargets(opts.targets ?? null);
  const spec = clanceySpec();

  if (targets.includes("claude")) {
    clog.success(`Wired hooks into ${tildify(wireHooks(spec))}`);
    const mcpSpin = spinner();
    mcpSpin.start("Registering Claude Code MCP server");
    const mcp = await registerMcp(spec);
    if (mcp === "added") mcpSpin.stop(`Registered Claude Code MCP server (${spec}, user scope)`);
    else if (mcp === "updated") mcpSpin.stop(`Re-pinned Claude Code MCP server to ${spec}`);
    else {
      mcpSpin.stop("Could not register Claude Code MCP server");
      clog.warn(`Add manually: claude mcp add --scope user clancey -- npx -y ${spec}`);
    }
  }

  if (targets.includes("codex")) {
    const codex = configureCodex(spec);
    clog.success(
      codex === "added"
        ? `Registered Codex MCP server (${spec}) in ${tildify(CODEX_CONFIG)}`
        : `Re-pinned Codex MCP server to ${spec} in ${tildify(CODEX_CONFIG)}`,
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

  const restart = targets.map((t) => (t === "claude" ? "Claude Code" : "Codex")).join(" and ");
  outro(restart ? `Done — restart ${restart} to load the MCP server.` : "Done.");
}
