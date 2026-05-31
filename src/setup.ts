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
  setIngested,
  getIngestedMtime,
  deleteSession,
  storeTotals,
  CLANCEY_DIR,
} from "./store.js";
import { listAllTranscripts, parseAny } from "./parser.js";
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
    const stat = await fs.promises.stat(file);
    if (!opts.force && getIngestedMtime(db, file) === stat.mtimeMs) continue;

    const parsed = await parseAny(ref);
    if (parsed.toolEvents.length === 0 && !parsed.framing) {
      setIngested(db, file, stat.mtimeMs);
      continue;
    }

    let framingVec: number[] | null = null;
    if (parsed.framing) {
      framingVec = await embedOne(framingText(parsed.title, parsed.framing).slice(0, FRAMING_MAX_CHARS));
    }
    const first = parsed.toolEvents[0];

    const apply = db.transaction(() => {
      deleteSession(db, parsed.sessionId);
      for (const e of parsed.toolEvents) {
        insertToolEvent(db, {
          session: parsed.sessionId,
          repo: resolveRepo(e.cwd),
          branch: e.branch,
          cwd: e.cwd,
          tool: e.tool,
          file: e.file,
          command: e.command,
          ts: e.timestamp,
        });
        events++;
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
      setIngested(db, file, stat.mtimeMs);
    });
    apply();
    sessions++;
  }

  return { sessions, events, embeddings };
}

/** Add the clancey hooks to the global Claude Code settings, idempotently. */
function wireHooks(): string {
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
    const already = groups.some((g) => (g.hooks ?? []).some((h) => h.command === "clancey hook"));
    if (already) return;
    const group: HookGroup = { hooks: [{ type: "command", command: "clancey hook" }] };
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

/** Add the clancey MCP server to Codex's config.toml, idempotently. */
function configureCodex(): "added" | "exists" {
  const existing = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, "utf-8") : "";
  if (existing.includes("[mcp_servers.clancey]")) return "exists";
  const block = `${existing.endsWith("\n") || existing === "" ? "" : "\n"}\n[mcp_servers.clancey]\ncommand = "clancey"\nargs = []\n`;
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  fs.appendFileSync(CODEX_CONFIG, block);
  return "added";
}

/** Register the MCP server at user scope. Checks for an existing registration first. */
async function registerMcp(): Promise<"added" | "exists" | "failed"> {
  try {
    await execFileAsync("claude", ["mcp", "get", "clancey"]);
    return "exists";
  } catch {
    // not registered yet
  }
  try {
    await execFileAsync("claude", ["mcp", "add", "--scope", "user", "clancey", "--", "clancey"]);
    return "added";
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

  if (targets.includes("claude")) {
    clog.success(`Wired hooks into ${tildify(wireHooks())}`);
    const mcpSpin = spinner();
    mcpSpin.start("Registering Claude Code MCP server");
    const mcp = await registerMcp();
    if (mcp === "added") mcpSpin.stop("Registered Claude Code MCP server (user scope)");
    else if (mcp === "exists") mcpSpin.stop("Claude Code MCP server already registered");
    else {
      mcpSpin.stop("Could not register Claude Code MCP server");
      clog.warn("Add manually: claude mcp add --scope user clancey -- clancey");
    }
  }

  if (targets.includes("codex")) {
    const codex = configureCodex();
    clog.success(
      codex === "added"
        ? `Registered Codex MCP server in ${tildify(CODEX_CONFIG)}`
        : "Codex MCP server already registered",
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
