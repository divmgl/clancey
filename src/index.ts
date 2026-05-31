import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import {
  Store,
  openStore,
  insertDecision,
  insertEmbedding,
  recall,
  search,
  getTurns,
  storeTotals,
  WorkItem,
  SearchHit,
} from "./store.js";
import { resolveSession, parseAny } from "./parser.js";
import { embedOne } from "./embeddings.js";
import { runHook } from "./hook.js";
import { setup, backfill } from "./setup.js";
import { log, logError, LOG_FILE } from "./logger.js";

function getServerVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function text(s: string) {
  return { content: [{ type: "text", text: s }] };
}

function formatWorkItems(items: WorkItem[]): string {
  if (items.length === 0) return "No matching work found.";
  return items
    .map((w) => {
      const lines = [
        `### ${w.branch ?? "(no branch)"}  ·  ${w.repo ?? "(no repo)"}`,
        `- sessions: ${w.sessions.join(", ") || "(none)"}`,
        `- files (${w.files.length}): ${w.files.slice(0, 30).join(", ")}${w.files.length > 30 ? ", …" : ""}`,
        `- ${w.toolEventCount} tool events · ${w.firstTs} → ${w.lastTs}`,
      ];
      if (w.decisions.length) {
        lines.push(`- decisions:`);
        for (const d of w.decisions) {
          lines.push(`  - ${d.decision}${d.why ? ` — ${d.why}` : ""}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No results.";
  return hits
    .map(
      (h, i) =>
        `${i + 1}. [${h.score.toFixed(3)}] (${h.branch ?? "?"}, ${h.kind}) session=${h.session}\n   ${h.text.replace(/\s+/g, " ").slice(0, 280)}`,
    )
    .join("\n\n");
}

function buildServer(db: Store): Server {
  const server = new Server({ name: "clancey", version: getServerVersion() }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "record_decision",
        description:
          "Record a significant decision and its rationale, anchored to the current repo and branch. Call this copiously as you work — capture the why and the alternatives rejected, not just what changed.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repo key (provided in the clancey hook context)" },
            branch: { type: "string", description: "Branch (provided in the clancey hook context)" },
            decision: { type: "string", description: "What was decided" },
            why: { type: "string", description: "Rationale and alternatives rejected" },
            files: { type: "array", items: { type: "string" }, description: "Relevant file paths" },
          },
          required: ["decision"],
        },
      },
      {
        name: "recall",
        description:
          "Deterministically find the work (sessions, files, recorded decisions) for a branch, file, or repo. Use this to map a PR (its branch or changed files) to the sessions that produced it.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string" },
            branch: { type: "string", description: "Exact branch name, e.g. a PR head ref" },
            file: { type: "string", description: "Substring of an edited file path" },
            since: { type: "string", description: "ISO timestamp lower bound" },
            limit: { type: "number", description: "Max work items (default: all)" },
          },
        },
      },
      {
        name: "search",
        description:
          "Semantic search over recorded decisions and session framings, ranked by similarity (descending). Use for the open case: 'what did I decide about X' when you don't know the branch.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural-language query" },
            limit: { type: "number", description: "Max results (default: 8)" },
          },
          required: ["query"],
        },
      },
      {
        name: "read_turns",
        description:
          "Read the verbatim human turns from a session transcript, optionally only the slice where a given branch was active. The deep dive that recovers a PR's motivation in the user's own words.",
        inputSchema: {
          type: "object",
          properties: {
            session: { type: "string", description: "Session id" },
            branch: { type: "string", description: "Only turns recorded on this branch" },
          },
          required: ["session"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "record_decision": {
          const decision = args.decision as string;
          if (!decision) return { ...text("Error: decision is required"), isError: true };
          const repo = (args.repo as string) ?? null;
          const branch = (args.branch as string) ?? null;
          const why = (args.why as string) ?? null;
          const files = (args.files as string[]) ?? null;
          const ts = new Date().toISOString();
          insertDecision(db, { session: null, repo, branch, decision, why, files, ts });
          const vector = await embedOne(why ? `${decision}\n\n${why}` : decision);
          insertEmbedding(db, { session: "", repo, branch, kind: "decision", text: why ? `${decision} — ${why}` : decision, vector, ts });
          return text(`Recorded decision on ${branch ?? "(no branch)"}.`);
        }
        case "recall": {
          const items = recall(db, {
            repo: args.repo as string | undefined,
            branch: args.branch as string | undefined,
            file: args.file as string | undefined,
            since: args.since as string | undefined,
            limit: args.limit as number | undefined,
          });
          return text(formatWorkItems(items));
        }
        case "search": {
          const query = args.query as string;
          if (!query) return { ...text("Error: query is required"), isError: true };
          const vector = await embedOne(query);
          return text(formatSearchHits(search(db, vector, (args.limit as number) ?? 8)));
        }
        case "read_turns": {
          const session = args.session as string;
          if (!session) return { ...text("Error: session is required"), isError: true };
          const branch = args.branch as string | undefined;

          // The live transcript is freshest; fall back to the stored snapshot once it is pruned.
          let title: string | null = null;
          let turns: { timestamp: string; text: string }[];
          let pruned = false;
          const ref = await resolveSession(session);
          if (ref) {
            const parsed = await parseAny(ref);
            title = parsed.title;
            const filtered = branch ? parsed.userTurns.filter((t) => t.branch === branch) : parsed.userTurns;
            turns = filtered.map((t) => ({ timestamp: t.timestamp, text: t.text }));
          } else {
            pruned = true;
            turns = getTurns(db, session, branch).map((t) => ({ timestamp: t.ts, text: t.text }));
          }

          if (turns.length === 0) {
            return text(`No human turns${branch ? ` on branch ${branch}` : ""} found for session ${session}.`);
          }
          const note = pruned ? "\n(transcript pruned; served from snapshot)" : "";
          const header = `Session ${session}${branch ? ` (branch ${branch})` : ""} — ${turns.length} turns${title ? `\nTitle: ${title}` : ""}${note}`;
          const body = turns.map((t) => `--- ${t.timestamp} ---\n${t.text}`).join("\n\n");
          return text(`${header}\n\n${body}`);
        }
        default:
          return { ...text(`Unknown tool: ${name}`), isError: true };
      }
    } catch (err) {
      logError(`tool ${name} failed`, err);
      return { ...text(`Error: ${err instanceof Error ? err.message : String(err)}`), isError: true };
    }
  });

  return server;
}

async function runServer(): Promise<void> {
  const db = openStore();
  const server = buildServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server running. Logs: ${LOG_FILE}`);
}

const HELP = `clancey — a memory for your Claude Code conversations

Usage:
  clancey                 Start the MCP server over stdio (how Claude Code runs it)
  clancey setup           Wire hooks + MCP globally, clean legacy index, backfill
  clancey backfill        Ingest existing transcripts into the store
  clancey hook            Internal: invoked by Claude Code hooks (reads stdin)

Run "clancey <command> --help" for command-specific options.`;

const SETUP_HELP = `clancey setup — wire clancey into Claude Code (global, idempotent)

Adds PostToolUse + SessionStart hooks to ~/.claude/settings.json, registers the
MCP server at user scope, offers to remove the legacy v1 index, then backfills
existing conversations.

Options:
  --tools <list>              Comma-separated tools to set up, non-interactively:
                              claude, codex, or all (e.g. --tools codex). Skips the
                              picker. Default is the interactive picker; with no TTY,
                              all detected tools.
  --clean-legacy, --yes, -y   Delete the legacy v1 index (~/.clancey/conversations.lance)
                              without prompting. Default is an interactive [Y/n] prompt;
                              with no TTY it is never deleted.
  -h, --help                  Show this help.`;

const BACKFILL_HELP = `clancey backfill — ingest existing transcripts into the store

Incrementally ingests transcripts changed since the last run.

Options:
  --force      Re-ingest all transcripts, ignoring the incremental mtime cache.
  -h, --help   Show this help.`;

function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** Parse `--tools claude,codex` (or `--tools=all`) into an explicit target list. */
function parseTools(args: string[]): ("claude" | "codex")[] | undefined {
  const eq = args.find((a) => a.startsWith("--tools="));
  const idx = args.indexOf("--tools");
  const raw = eq ? eq.slice("--tools=".length) : idx !== -1 ? args[idx + 1] : undefined;
  if (raw === undefined) return undefined;

  const out = new Set<"claude" | "codex">();
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (part === "all") {
      out.add("claude");
      out.add("codex");
    } else if (part === "claude" || part === "codex") {
      out.add(part);
    } else {
      console.error(`Unknown tool "${part}" for --tools (expected: claude, codex, all)`);
      process.exit(1);
    }
  }
  return [...out];
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined) {
    await runServer();
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "hook":
      await runHook();
      return;
    case "setup": {
      if (wantsHelp(rest)) {
        console.log(SETUP_HELP);
        return;
      }
      const cleanLegacy = rest.includes("--clean-legacy") || rest.includes("--yes") || rest.includes("-y");
      await setup({ cleanLegacy, targets: parseTools(rest) });
      return;
    }
    case "backfill": {
      if (wantsHelp(rest)) {
        console.log(BACKFILL_HELP);
        return;
      }
      const db = openStore();
      try {
        const stats = await backfill(db, { force: rest.includes("--force") });
        const totals = storeTotals(db);
        log(
          `Backfill complete: ${stats.sessions} sessions, ${stats.events} events, ${stats.embeddings} embeddings ` +
            `(totals: ${totals.sessions} sessions, ${totals.events} events, ${totals.embeddings} embeddings)`,
        );
      } finally {
        db.close();
      }
      return;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  logError("Fatal error", error);
  process.exit(1);
});
