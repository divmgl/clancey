import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import {
  Store,
  openStore,
  insertNote,
  insertEmbedding,
  getNote,
  updateNote,
  deleteNote,
  noteText,
  noteEmbedInput,
  recall,
  search,
  grepTurns,
  getTurns,
  storeTotals,
  WorkItem,
  SearchHit,
  TurnHit,
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
          lines.push(`  - [#${d.id}] ${d.decision}${d.why ? ` — ${d.why}` : ""}`);
        }
      }
      if (w.learnings.length) {
        lines.push(`- learnings:`);
        for (const l of w.learnings) {
          lines.push(`  - [#${l.id}] ${l.learning}${l.context ? ` — ${l.context}` : ""}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Below this top cosine score, `search` nudges the agent toward the keyword fallback. */
const LOW_CONFIDENCE = 0.45;

function formatTurnHits(hits: TurnHit[]): string {
  if (hits.length === 0) {
    return "No matching turns. (Only backfilled sessions are indexed — run `clancey backfill` if a recent session is missing.)";
  }
  return hits
    .map(
      (h, i) =>
        `${i + 1}. (${h.branch ?? "?"}) session=${h.session} · ${h.ts}\n   ${h.snippet.replace(/\s+/g, " ").trim()}`,
    )
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
        name: "update_decision",
        description:
          "Revise a recorded decision by its id (from recall). Pass the new decision and/or why; the embedding is re-generated so search reflects the edit. Use this to fix or rephrase a decision instead of recording a duplicate.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Decision id, shown as [#id] in recall output" },
            decision: { type: "string", description: "New decision text (omit to keep)" },
            why: { type: "string", description: "New rationale (omit to keep)" },
          },
          required: ["id"],
        },
      },
      {
        name: "remove_decision",
        description:
          "Delete a recorded decision by its id (from recall), including its embedding. Use this to drop a wrong or duplicate decision so it stops surfacing in recall and search.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Decision id, shown as [#id] in recall output" },
          },
          required: ["id"],
        },
      },
      {
        name: "record_learning",
        description:
          "Record an incidental learning — a non-obvious fact you discovered about the system (a gotcha, a constraint, how a subsystem actually behaves) — anchored to the current repo and branch. Record these copiously as you work, separate from decisions: not what you chose, but what you found out.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repo key (provided in the clancey hook context)" },
            branch: { type: "string", description: "Branch (provided in the clancey hook context)" },
            learning: { type: "string", description: "What you learned" },
            context: { type: "string", description: "Where it applies and why it matters" },
            files: { type: "array", items: { type: "string" }, description: "Relevant file paths" },
          },
          required: ["learning"],
        },
      },
      {
        name: "update_learning",
        description:
          "Revise a recorded learning by its id (from recall). Pass the new learning and/or context; the embedding is re-generated so search reflects the edit. Use this to fix or rephrase a learning instead of recording a duplicate.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Learning id, shown as [#id] in recall output" },
            learning: { type: "string", description: "New learning text (omit to keep)" },
            context: { type: "string", description: "New context (omit to keep)" },
          },
          required: ["id"],
        },
      },
      {
        name: "remove_learning",
        description:
          "Delete a recorded learning by its id (from recall), including its embedding. Use this to drop a wrong or duplicate learning so it stops surfacing in recall and search.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Learning id, shown as [#id] in recall output" },
          },
          required: ["id"],
        },
      },
      {
        name: "recall",
        description:
          "Deterministically find the work (sessions, files, recorded decisions and learnings) for a branch, file, or repo. Use this to map a PR (its branch or changed files) to the sessions that produced it.",
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
          "Semantic search over recorded decisions, learnings, and session framings, ranked by similarity (descending). Use for the open case: 'what did I decide about X' or 'what did I learn about X' when you don't know the branch. Only covers what was recorded or framed — if it misses, fall back to grep_turns for literal keyword search over the raw conversation.",
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
        name: "grep_turns",
        description:
          "Keyword/full-text search over the verbatim conversation turns — the fallback when `search` (semantic) misses something said in passing that was never recorded as a decision or learning. Matches any of the query words, best matches first, so a turn hitting most of them still surfaces. Returns matching snippets with their session, so you can then read_turns that session for full context.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords to match (turns matching any word surface, ranked by relevance)" },
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
          const id = insertNote(db, { kind: "decision", session: null, repo, branch, body: decision, detail: why, files, ts });
          const vector = await embedOne(noteEmbedInput(decision, why));
          insertEmbedding(db, { session: "", repo, branch, kind: "decision", text: noteText(decision, why), vector, ts, eventId: id });
          return text(`Recorded decision #${id} on ${branch ?? "(no branch)"}.`);
        }
        case "update_decision": {
          const id = Number(args.id);
          if (!Number.isInteger(id)) return { ...text("Error: id (integer) is required"), isError: true };
          const existing = getNote(db, id);
          if (!existing || existing.kind !== "decision") return { ...text(`No decision #${id} found.`), isError: true };
          const decision = (args.decision as string | undefined) ?? existing.body;
          const why = args.why !== undefined ? (args.why as string | null) : existing.detail;
          const vector = await embedOne(noteEmbedInput(decision, why));
          updateNote(db, id, { body: decision, detail: why }, vector);
          return text(`Updated decision #${id}.`);
        }
        case "remove_decision": {
          const id = Number(args.id);
          if (!Number.isInteger(id)) return { ...text("Error: id (integer) is required"), isError: true };
          const existing = getNote(db, id);
          if (!existing || existing.kind !== "decision") return { ...text(`No decision #${id} found.`), isError: true };
          deleteNote(db, id);
          return text(`Removed decision #${id}.`);
        }
        case "record_learning": {
          const learning = args.learning as string;
          if (!learning) return { ...text("Error: learning is required"), isError: true };
          const repo = (args.repo as string) ?? null;
          const branch = (args.branch as string) ?? null;
          const context = (args.context as string) ?? null;
          const files = (args.files as string[]) ?? null;
          const ts = new Date().toISOString();
          const id = insertNote(db, { kind: "learning", session: null, repo, branch, body: learning, detail: context, files, ts });
          const vector = await embedOne(noteEmbedInput(learning, context));
          insertEmbedding(db, { session: "", repo, branch, kind: "learning", text: noteText(learning, context), vector, ts, eventId: id });
          return text(`Recorded learning #${id} on ${branch ?? "(no branch)"}.`);
        }
        case "update_learning": {
          const id = Number(args.id);
          if (!Number.isInteger(id)) return { ...text("Error: id (integer) is required"), isError: true };
          const existing = getNote(db, id);
          if (!existing || existing.kind !== "learning") return { ...text(`No learning #${id} found.`), isError: true };
          const learning = (args.learning as string | undefined) ?? existing.body;
          const context = args.context !== undefined ? (args.context as string | null) : existing.detail;
          const vector = await embedOne(noteEmbedInput(learning, context));
          updateNote(db, id, { body: learning, detail: context }, vector);
          return text(`Updated learning #${id}.`);
        }
        case "remove_learning": {
          const id = Number(args.id);
          if (!Number.isInteger(id)) return { ...text("Error: id (integer) is required"), isError: true };
          const existing = getNote(db, id);
          if (!existing || existing.kind !== "learning") return { ...text(`No learning #${id} found.`), isError: true };
          deleteNote(db, id);
          return text(`Removed learning #${id}.`);
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
          const hits = search(db, vector, (args.limit as number) ?? 8);
          let out = formatSearchHits(hits);
          const top = hits[0]?.score ?? 0;
          if (top < LOW_CONFIDENCE) {
            out += `\n\n(low confidence — top score ${top.toFixed(3)}. For literal wording, try grep_turns({ query }) — keyword search over the raw conversation.)`;
          }
          return text(out);
        }
        case "grep_turns": {
          const query = args.query as string;
          if (!query) return { ...text("Error: query is required"), isError: true };
          return text(formatTurnHits(grepTurns(db, query, (args.limit as number) ?? 8)));
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
