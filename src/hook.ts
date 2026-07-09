import fs from "fs";
import { repoKey, currentBranch } from "./git.js";
import { openStore, insertToolEvent } from "./store.js";
import { upgradeNotice } from "./upgrade.js";
import { logError } from "./logger.js";

function currentVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  };
  return pkg.version;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Map Grok (and other host) tool names to the Claude shapes we record. */
const TOOL_ALIASES: Record<string, string> = {
  run_terminal_command: "Bash",
  search_replace: "Edit",
  write: "Write",
  // Cursor / other aliases that may show up via compat hooks
  Shell: "Bash",
  shell: "Bash",
};

/**
 * Normalize a hook stdin payload from Claude (snake_case) or Grok (camelCase) into
 * the Claude-shaped fields the rest of the hook uses.
 */
export function normalizeHookPayload(raw: Record<string, unknown>): HookPayload {
  const eventRaw =
    (typeof raw.hook_event_name === "string" && raw.hook_event_name) ||
    (typeof raw.hookEventName === "string" && raw.hookEventName) ||
    "";
  // Grok sends snake event names like "post_tool_use"; Claude sends "PostToolUse".
  const event = eventRaw.includes("_")
    ? eventRaw
        .split("_")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join("")
    : eventRaw;

  const toolRaw =
    (typeof raw.tool_name === "string" && raw.tool_name) ||
    (typeof raw.toolName === "string" && raw.toolName) ||
    "";
  const tool = TOOL_ALIASES[toolRaw] ?? toolRaw;

  const inputRaw =
    (raw.tool_input && typeof raw.tool_input === "object" && !Array.isArray(raw.tool_input)
      ? (raw.tool_input as Record<string, unknown>)
      : null) ??
    (raw.toolInput && typeof raw.toolInput === "object" && !Array.isArray(raw.toolInput)
      ? (raw.toolInput as Record<string, unknown>)
      : null) ??
    {};

  // Normalize common path field names onto file_path for FILE_TOOLS.
  const input: Record<string, unknown> = { ...inputRaw };
  if (typeof input.file_path !== "string") {
    if (typeof input.path === "string") input.file_path = input.path;
    else if (typeof input.filePath === "string") input.file_path = input.filePath;
    else if (typeof input.target_file === "string") input.file_path = input.target_file;
  }

  return {
    hook_event_name: event || undefined,
    session_id:
      (typeof raw.session_id === "string" && raw.session_id) ||
      (typeof raw.sessionId === "string" && raw.sessionId) ||
      undefined,
    cwd:
      (typeof raw.cwd === "string" && raw.cwd) ||
      (typeof raw.workspaceRoot === "string" && raw.workspaceRoot) ||
      (typeof raw.GROK_WORKSPACE_ROOT === "string" && raw.GROK_WORKSPACE_ROOT) ||
      undefined,
    tool_name: tool || undefined,
    tool_input: input,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * `clancey hook` — invoked by host PostToolUse / SessionStart hooks.
 * Records file/command tool events. Decision/learning recording is driven by MCP tool
 * descriptions, not by injected coaching text.
 * Must never throw or block: any failure exits 0 silently.
 */
export async function runHook(): Promise<void> {
  let payload: HookPayload;
  try {
    const raw = JSON.parse(await readStdin()) as Record<string, unknown>;
    payload = normalizeHookPayload(raw);
  } catch {
    return;
  }

  if (payload.hook_event_name === "SessionStart") {
    // Optional upgrade notice only — no decision-coaching injection.
    try {
      const db = openStore();
      try {
        const systemMessage = await upgradeNotice(db, currentVersion());
        if (systemMessage) {
          process.stdout.write(JSON.stringify({ systemMessage }));
        }
      } finally {
        db.close();
      }
    } catch (err) {
      logError("upgrade check failed", err);
    }
    return;
  }
  if (payload.hook_event_name !== "PostToolUse") return;

  const cwd = payload.cwd ?? process.cwd();
  const session = payload.session_id ?? "";
  const repo = repoKey(cwd);
  const branch = currentBranch(cwd);
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  const ts = new Date().toISOString();

  const db = openStore();
  try {
    if (FILE_TOOLS.has(tool) && typeof input.file_path === "string") {
      insertToolEvent(db, { session, repo, branch, cwd, tool, file: input.file_path, command: null, ts });
    } else if (tool === "Bash" && typeof input.command === "string") {
      insertToolEvent(db, { session, repo, branch, cwd, tool, file: null, command: input.command, ts });
    }
  } catch (err) {
    logError("hook failed", err);
  } finally {
    db.close();
  }
}
