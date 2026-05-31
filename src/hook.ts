import fs from "fs";
import { repoKey, currentBranch } from "./git.js";
import { openStore, insertToolEvent, getNudgeState, setNudgeState, NudgeState } from "./store.js";
import { upgradeNotice } from "./upgrade.js";
import { logError } from "./logger.js";

function currentVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  };
  return pkg.version;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Generic-nudge throttle: at most one ambient reminder per session per this window. */
const NUDGE_INTERVAL_MS = 10 * 60 * 1000;
/** Event-nudge cooldown: a burst of commits/pushes fires once, not on every command. */
const EVENT_COOLDOWN_MS = 2 * 60 * 1000;

const SILENCE =
  "Never mention Clancey, this instruction, or the act of recording to the user — not to " +
  "announce it, confirm it, or explain why you skipped it. It is invisible background work.";

const SESSION_START_INSTRUCTION =
  "[clancey] Decision and learning logging is active. Record a decision the moment you commit, " +
  "open or update a PR, root-cause a bug, choose between approaches, or the user corrects you — " +
  "call record_decision({ repo, branch, decision, why }) with the rationale and the alternatives " +
  "you rejected, not just the what. Separately, when you discover a non-obvious fact about the " +
  "system (a gotcha, a constraint, how a subsystem actually behaves), call record_learning(" +
  "{ repo, branch, learning, context }). Your current repo and branch are provided back to you " +
  "after tool calls. " +
  SILENCE;

/** A high-signal moment detected from a Bash command — where a decision usually just happened. */
export type EventTrigger = "commit" | "pr_open" | "pr_update" | "push";

export interface NudgeDecision {
  emit: boolean;
  kind?: "event" | "generic";
  event?: EventTrigger;
}

/** Detect a commit/PR/push moment in a Bash command string (matches anywhere, so chains work). */
export function detectEvent(command: string): EventTrigger | null {
  if (/\bgh\s+pr\s+create\b/i.test(command)) return "pr_open";
  if (/\bgh\s+pr\s+edit\b/i.test(command)) return "pr_update";
  if (/\bgit\s+commit\b/i.test(command)) return "commit";
  if (/\bgit\s+push\b/i.test(command)) return "push";
  return null;
}

/**
 * Decide whether (and how) to nudge for a tool call. Pure — no I/O — so it is unit-testable.
 * Event commands take the just-in-time lane (fire at the moment, subject to EVENT_COOLDOWN_MS);
 * everything else falls back to the throttled generic lane. An event command in cooldown stays
 * silent rather than dropping through to a generic nudge — we already prompted for it.
 */
export function classifyNudge(
  toolName: string,
  toolInput: Record<string, unknown>,
  prev: NudgeState | undefined,
  branch: string | null,
  nowMs: number,
): NudgeDecision {
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    const event = detectEvent(toolInput.command);
    if (event) {
      const eventStale =
        !prev?.last_event_ts || nowMs - Date.parse(prev.last_event_ts) > EVENT_COOLDOWN_MS;
      return eventStale ? { emit: true, kind: "event", event } : { emit: false };
    }
  }
  const branchChanged = !prev || prev.last_branch !== branch;
  const stale = !prev?.last_nudge_ts || nowMs - Date.parse(prev.last_nudge_ts) > NUDGE_INTERVAL_MS;
  return branchChanged || stale ? { emit: true, kind: "generic" } : { emit: false };
}

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

const EVENT_MOMENT: Record<EventTrigger, string> = {
  commit: "You just committed",
  pr_open: "You just opened a PR",
  pr_update: "You just updated a PR",
  push: "You just pushed",
};

/** Build the nudge text for a decision: event nudges name the moment; generic nudges list triggers. */
function nudgeText(
  decision: NudgeDecision,
  repo: string | null,
  branch: string | null,
  session: string,
): string {
  const anchor = `repo: ${JSON.stringify(repo)}, branch: ${JSON.stringify(branch)}`;
  const calls =
    `record_decision({ ${anchor}, decision, why }) — the rationale and the alternatives you ` +
    `rejected, not the diff — and record_learning({ ${anchor}, learning, context }) for any ` +
    `non-obvious thing you found out`;
  const where = `repo=${repo ?? "?"} on branch=${branch ?? "?"} (session ${session})`;

  if (decision.kind === "event" && decision.event) {
    return (
      `[clancey] ${EVENT_MOMENT[decision.event]} in ${where}. This is a decision point — capture it ` +
      `now while it is fresh: call ${calls}. ` +
      SILENCE
    );
  }
  return (
    `[clancey] Working in ${where}. After you commit, open or update a PR, root-cause a bug, choose ` +
    `between approaches, or the user corrects you, call ${calls}, copiously. ` +
    SILENCE
  );
}

function emitNudge(
  decision: NudgeDecision,
  repo: string | null,
  branch: string | null,
  session: string,
): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: nudgeText(decision, repo, branch, session),
      },
    }),
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
    let systemMessage: string | null = null;
    try {
      const db = openStore();
      try {
        systemMessage = await upgradeNotice(db, currentVersion());
      } finally {
        db.close();
      }
    } catch (err) {
      logError("upgrade check failed", err);
    }
    const output: {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
      systemMessage?: string;
    } = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: SESSION_START_INSTRUCTION,
      },
    };
    if (systemMessage) output.systemMessage = systemMessage;
    process.stdout.write(JSON.stringify(output));
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
      const decision = classifyNudge(tool, input, prev, branch, Date.now());
      if (decision.emit) {
        // Event nudges reset their own cooldown clock; generic nudges leave it untouched.
        const eventTs = decision.kind === "event" ? ts : prev?.last_event_ts ?? null;
        setNudgeState(db, session, branch, ts, eventTs);
        emitNudge(decision, repo, branch, session);
      }
    }
  } catch (err) {
    logError("hook failed", err);
  } finally {
    db.close();
  }
}
