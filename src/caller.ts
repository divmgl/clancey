import { execFileSync } from "child_process";
import { Store, Host, normalizeHost } from "./store.js";
import { canonicalRepo, currentBranch } from "./git.js";

/**
 * Who is calling us. Every tool that takes `repo` / `branch` / `session` can fill them in from
 * here, which matters because agents mostly didn't: 1,241 of 1,242 recorded notes had no session
 * id, making them dead ends in search results.
 */
export interface CallerContext {
  host: Host | null;
  cwd: string;
  repo: string | null;
  branch: string | null;
  session: string | null;
  /** How we know the session: the host told us, or we guessed from cwd + recency. */
  sessionSource: "env" | "inferred" | null;
}

/** Session ids the shell exports for unrelated reasons — never a conversation. */
const SESSION_ENV_DENYLIST = /^(TERM|ITERM|SECURITYSESSION|STARSHIP|XDG|DBUS)/i;
const UUID_ISH = /^[0-9a-f-]{16,}$/i;

/** A session id the host put in our environment (Claude Code exports CLAUDE_CODE_SESSION_ID). */
function sessionFromEnv(env: NodeJS.ProcessEnv): string | null {
  for (const [key, value] of Object.entries(env)) {
    if (!value || !/SESSION_ID$/i.test(key) || SESSION_ENV_DENYLIST.test(key)) continue;
    if (UUID_ISH.test(value)) return value;
  }
  return null;
}

/** Full command line of a pid, or null. */
function processCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Which coding agent spawned this MCP server. Env first (unambiguous), then the parent process —
 * hosts launch us as a direct child, so its command line names the client.
 */
export function detectHost(env: NodeJS.ProcessEnv = process.env, ppid: number = process.ppid): Host | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_PROJECT_DIR) return "claude";
  const parent = processCommand(ppid);
  if (!parent) return null;
  if (/\bcodex\b/.test(parent)) return "codex";
  if (/\bopencode\b/.test(parent)) return "opencode";
  if (/\.hermes\b|hermes-agent/.test(parent)) return "hermes";
  if (/\bgrok\b/.test(parent)) return "grok";
  if (/\bclaude\b/.test(parent)) return "claude";
  return null;
}

/** Sessions quieter than this are not plausibly the conversation happening right now. */
const RECENT_SESSION_MS = 6 * 60 * 60 * 1000;

/**
 * Best guess at the caller's session when the host doesn't say: the most recently active
 * conversation from the same client in the same directory. Used only to label and demote a
 * conversation's own turns in its results — never to hide them.
 */
function inferSession(db: Store, host: Host | null, repo: string | null, nowMs: number): string | null {
  if (!host || !repo) return null;
  const row = db
    .prepare(
      `SELECT session, MAX(ts) AS lastTs FROM messages
       WHERE host = @host AND repo = @repo AND session IS NOT NULL AND session <> ''
       GROUP BY session ORDER BY lastTs DESC LIMIT 1`,
    )
    .get({ host, repo }) as { session: string; lastTs: string } | undefined;
  if (!row) return null;
  const last = Date.parse(row.lastTs);
  if (!Number.isFinite(last) || nowMs - last > RECENT_SESSION_MS) return null;
  return row.session;
}

/** Git and `ps` calls are not free; the answer can't change often within one conversation. */
const CACHE_TTL_MS = 30_000;
let cached: { at: number; value: CallerContext } | null = null;

export function inferCaller(db: Store, opts: { now?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): CallerContext {
  const now = opts.now ?? Date.now();
  if (!opts.cwd && !opts.env && cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const host = normalizeHost(detectHost(env));
  const repo = canonicalRepo(cwd);
  const envSession = sessionFromEnv(env);
  const session = envSession ?? inferSession(db, host, repo, now);

  const value: CallerContext = {
    host,
    cwd,
    repo,
    branch: currentBranch(cwd),
    session,
    sessionSource: envSession ? "env" : session ? "inferred" : null,
  };
  if (!opts.cwd && !opts.env) cached = { at: now, value };
  return value;
}

/** Test seam: forget the memoized context. */
export function resetCallerCache(): void {
  cached = null;
}
