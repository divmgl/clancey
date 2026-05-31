import { repoKey, currentBranch } from "./git.js";
import { openStore, insertToolEvent, getNudgeState, setNudgeState } from "./store.js";
import { logError } from "./logger.js";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const NUDGE_INTERVAL_MS = 10 * 60 * 1000;

const SESSION_START_INSTRUCTION =
  "[clancey] Decision logging is active. As you work, copiously record significant decisions " +
  "with the clancey MCP tool record_decision({ repo, branch, decision, why }) — capture the why " +
  "and the alternatives you rejected, not just the what. Your current repo and branch are " +
  "provided back to you after tool calls.";

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function emitNudge(repo: string | null, branch: string | null, session: string): void {
  const additionalContext =
    `[clancey] Working in repo=${repo ?? "?"} on branch=${branch ?? "?"} (session ${session}). ` +
    `After any significant decision, call the clancey MCP tool record_decision(` +
    `{ repo: ${JSON.stringify(repo)}, branch: ${JSON.stringify(branch)}, decision, why }) — ` +
    `capture the rationale and the alternatives you rejected, copiously, not just what changed.`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }),
  );
}

/**
 * `clancey hook` — invoked by Claude Code hooks. Reads the hook JSON on stdin, records
 * file/command events, and (throttled) nudges the agent to record decisions.
 * Must never throw or block: any failure exits 0 silently.
 */
export async function runHook(): Promise<void> {
  let payload: HookPayload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }

  if (payload.hook_event_name === "SessionStart") {
    process.stdout.write(SESSION_START_INSTRUCTION);
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

    if (session && (repo || branch)) {
      const prev = getNudgeState(db, session);
      const branchChanged = !prev || prev.last_branch !== branch;
      const stale =
        !prev?.last_nudge_ts || Date.now() - Date.parse(prev.last_nudge_ts) > NUDGE_INTERVAL_MS;
      if (branchChanged || stale) {
        setNudgeState(db, session, branch, ts);
        emitNudge(repo, branch, session);
      }
    }
  } catch (err) {
    logError("hook failed", err);
  } finally {
    db.close();
  }
}
