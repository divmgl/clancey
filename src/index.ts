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
  listRecentSessions,
  getMessages,
  pruneOlderThan,
  getRetentionDays,
  setMeta,
  storeTotals,
  normalizeHost,
  resolveLookupScope,
  WorkItem,
  SearchHit,
  TurnHit,
  StoredMessage,
  SessionSummary,
} from "./store.js";
import { resolveSession, parseAny, listSubagents, parseSubagent, listGrokSubagents, ConvMessage } from "./parser.js";
import { embedOne } from "./embeddings.js";
import { runHook } from "./hook.js";
import { setup, backfill, Target } from "./setup.js";
import { log, logError, LOG_FILE } from "./logger.js";
import { resolveTimeFilter } from "./time.js";
import { startCodexLiveCapture } from "./codex-live.js";
import { registerMcpClient, heartbeatMcpClient, unregisterMcpClient } from "./mcp-clients.js";
import { ensureWatchRunning, runWatchCli } from "./watch.js";
import { resolveClanceyDir, resolveDbPath } from "./paths.js";

const EMPTY_LOOKUP_HINT =
  "No matches. If this work just happened or a recent session is missing, call refresh_index (or run `clancey backfill`) and try again.";

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
  if (items.length === 0) return EMPTY_LOOKUP_HINT;
  return items
    .map((w) => {
      const hostBit = w.hosts.length ? ` · hosts: ${w.hosts.join(", ")}` : "";
      const lines = [
        `### ${w.branch ?? "(no branch)"}  ·  ${w.repo ?? "(no repo)"}${hostBit}`,
        `- sessions: ${w.sessions.join(", ") || "(none)"}`,
        `- files (${w.files.length}): ${w.files.slice(0, 30).join(", ")}${w.files.length > 30 ? ", …" : ""}`,
        `- ${w.toolEventCount} tool events · ${w.firstTs} → ${w.lastTs}`,
      ];
      if (w.decisions.length) {
        lines.push(`- decisions:`);
        for (const d of w.decisions) {
          const sess = d.session ? ` session=${d.session}` : "";
          lines.push(`  - [#${d.id}]${sess} ${d.decision}${d.why ? ` — ${d.why}` : ""}`);
        }
      }
      if (w.learnings.length) {
        lines.push(`- learnings:`);
        for (const l of w.learnings) {
          const sess = l.session ? ` session=${l.session}` : "";
          lines.push(`  - [#${l.id}]${sess} ${l.learning}${l.context ? ` — ${l.context}` : ""}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Below this top cosine score, `search` nudges the agent toward the keyword fallback. */
const LOW_CONFIDENCE = 0.45;

/** Label a hit by who said it: `user`, `assistant`, or `assistant·Plan` for a subagent. */
function speaker(h: TurnHit): string {
  const role = h.role || "?";
  return h.agent ? `${role}·${h.agent}` : role;
}

function formatTurnHits(hits: TurnHit[]): string {
  if (hits.length === 0) return EMPTY_LOOKUP_HINT;
  return hits
    .map((h, i) => {
      const host = h.host ? ` host=${h.host}` : "";
      return `${i + 1}. (${h.branch ?? "?"}) [${speaker(h)}] session=${h.session}${host} · ${h.ts}\n   ${h.snippet.replace(/\s+/g, " ").trim()}`;
    })
    .join("\n\n");
}

function formatSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) return EMPTY_LOOKUP_HINT;
  return hits
    .map((h, i) => {
      const host = h.host ? `, ${h.host}` : "";
      const sess = h.session ? ` session=${h.session}` : "";
      return `${i + 1}. [${h.score.toFixed(3)}] (${h.branch ?? "?"}, ${h.kind}${host})${sess}\n   ${h.text.replace(/\s+/g, " ").slice(0, 280)}`;
    })
    .join("\n\n");
}

function formatSessions(rows: SessionSummary[]): string {
  if (rows.length === 0) return EMPTY_LOOKUP_HINT;
  return rows
    .map(
      (s, i) =>
        `${i + 1}. session=${s.session} host=${s.host ?? "?"} repo=${s.repo ?? "?"} branch=${s.branch ?? "?"} · ${s.firstTs} → ${s.lastTs}`,
    )
    .join("\n");
}

const SCOPE_PROPS = {
  repo: {
    type: "string",
    description:
      "Limit to this repo — absolute checkout path or short owner/name (both match when the remote is known)",
  },
  branch: { type: "string", description: "Exact branch name" },
  host: {
    type: "string",
    description: "Coding host: claude | codex | opencode | grok | hermes",
  },
  since: { type: "string", description: "ISO timestamp lower bound" },
  until: { type: "string", description: "ISO timestamp exclusive upper bound" },
  time: {
    type: "string",
    description:
      "Natural-language time window, e.g. 'last week', 'a week ago', 'yesterday', or 'Sep 12-13'. Explicit since/until override this.",
  },
  limit: { type: "number", description: "Max results" },
  exclude_session: {
    type: "string",
    description: "Omit this session id from results (e.g. the current conversation)",
  },
  exclude_sessions: {
    type: "array",
    items: { type: "string" },
    description: "Omit these session ids from results",
  },
} as const;

function buildServer(db: Store): Server {
  const server = new Server({ name: "clancey", version: getServerVersion() }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Lookup tools first — Clancey's primary job is cross-client conversation recovery.
    tools: [
      {
        name: "recall",
        description:
          "Find which coding sessions produced a branch, file, or repo across hosts. Returns sessions, files, hosts, and any recorded decisions/learnings (with session ids when stored). Start here to map a PR or path back to the conversation.",
        inputSchema: {
          type: "object",
          properties: {
            ...SCOPE_PROPS,
            file: { type: "string", description: "Substring of an edited file path" },
            limit: { type: "number", description: "Max work items (default: all)" },
          },
        },
      },
      {
        name: "search",
        description:
          "Semantic search over session framings and recorded decisions/learnings, ranked by similarity. Scope with repo/branch/host/time. If it misses, fall back to grep_turns.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural-language semantic query, without date/window words when using time filters",
            },
            ...SCOPE_PROPS,
            limit: { type: "number", description: "Max results (default: 8)" },
          },
          required: ["query"],
        },
      },
      {
        name: "grep_turns",
        description:
          "Keyword/full-text search over the full verbatim conversation — including subagent turns (labeled assistant·AgentType). Scope with repo/branch/host/time. Each hit carries session (and host when known) for read_turns.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keywords to match, without date/window words when using time filters",
            },
            ...SCOPE_PROPS,
            limit: { type: "number", description: "Max results (default: 8)" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_sessions",
        description:
          "List recent sessions by last activity. Filter by repo, branch, host, and/or time. Use a returned session id with read_turns.",
        inputSchema: {
          type: "object",
          properties: { ...SCOPE_PROPS, limit: { type: "number", description: "Max sessions (default: 20)" } },
        },
      },
      {
        name: "read_turns",
        description:
          "Read the full verbatim conversation from a session (main + subagents, labeled by speaker). Optionally only the branch slice. If the live transcript was pruned, serves the stored snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            session: { type: "string", description: "Session id" },
            branch: { type: "string", description: "Only turns recorded on this branch" },
          },
          required: ["session"],
        },
      },
      {
        name: "refresh_index",
        description:
          "Re-ingest changed coding-agent transcripts into Clancey so recent work is findable. Call when lookup looks stale or empty for work that should exist.",
        inputSchema: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description: "Re-ingest everything, ignoring the mtime cache (default false)",
            },
          },
        },
      },
      {
        name: "record_decision",
        description:
          "Optional: record a significant decision (why + alternatives rejected), anchored to repo/branch and optionally session/host, so future search is sharper.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repo key (e.g. owner/name from git remote, or absolute path)" },
            branch: { type: "string", description: "Current git branch" },
            session: { type: "string", description: "Session id this decision came from" },
            host: { type: "string", description: "Coding host: claude | codex | opencode | grok" },
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
          "Revise a recorded decision by its id (from recall). Pass the new decision and/or why; the embedding is re-generated so search reflects the edit.",
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
          "Delete a recorded decision by its id (from recall), including its embedding.",
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
          "Optional: record an incidental learning, anchored to repo/branch and optionally session/host.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repo key (e.g. owner/name from git remote, or absolute path)" },
            branch: { type: "string", description: "Current git branch" },
            session: { type: "string", description: "Session id this learning came from" },
            host: { type: "string", description: "Coding host: claude | codex | opencode | grok" },
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
          "Revise a recorded learning by its id (from recall). Pass the new learning and/or context; the embedding is re-generated.",
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
        description: "Delete a recorded learning by its id (from recall), including its embedding.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Learning id, shown as [#id] in recall output" },
          },
          required: ["id"],
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
          const session = (args.session as string) ?? null;
          const host = normalizeHost(args.host as string | undefined);
          const why = (args.why as string) ?? null;
          const files = (args.files as string[]) ?? null;
          const ts = new Date().toISOString();
          const id = insertNote(db, {
            kind: "decision",
            session,
            repo,
            branch,
            body: decision,
            detail: why,
            files,
            ts,
            host,
          });
          const vector = await embedOne(noteEmbedInput(decision, why));
          insertEmbedding(db, {
            session: session ?? "",
            repo,
            branch,
            kind: "decision",
            text: noteText(decision, why),
            vector,
            ts,
            eventId: id,
            host,
          });
          return text(
            `Recorded decision #${id} on ${branch ?? "(no branch)"}${session ? ` session=${session}` : ""}.`,
          );
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
          const session = (args.session as string) ?? null;
          const host = normalizeHost(args.host as string | undefined);
          const context = (args.context as string) ?? null;
          const files = (args.files as string[]) ?? null;
          const ts = new Date().toISOString();
          const id = insertNote(db, {
            kind: "learning",
            session,
            repo,
            branch,
            body: learning,
            detail: context,
            files,
            ts,
            host,
          });
          const vector = await embedOne(noteEmbedInput(learning, context));
          insertEmbedding(db, {
            session: session ?? "",
            repo,
            branch,
            kind: "learning",
            text: noteText(learning, context),
            vector,
            ts,
            eventId: id,
            host,
          });
          return text(
            `Recorded learning #${id} on ${branch ?? "(no branch)"}${session ? ` session=${session}` : ""}.`,
          );
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
          const time = resolveTimeFilter({
            time: args.time as string | undefined,
            since: args.since as string | undefined,
            until: args.until as string | undefined,
          });
          if (time.error) return { ...text(`Error: ${time.error}`), isError: true };
          const scope = resolveLookupScope(db, {
            repo: args.repo as string | undefined,
            branch: args.branch as string | undefined,
            host: args.host as string | undefined,
            limit: args.limit as number | undefined,
            exclude_session: args.exclude_session,
            exclude_sessions: args.exclude_sessions,
            ...time.filter,
          });
          const items = recall(db, {
            ...scope,
            file: args.file as string | undefined,
          });
          return text(formatWorkItems(items));
        }
        case "search": {
          const query = args.query as string;
          if (!query) return { ...text("Error: query is required"), isError: true };
          const time = resolveTimeFilter({
            time: args.time as string | undefined,
            since: args.since as string | undefined,
            until: args.until as string | undefined,
          });
          if (time.error) return { ...text(`Error: ${time.error}`), isError: true };
          const vector = await embedOne(query);
          const scope = resolveLookupScope(db, {
            repo: args.repo as string | undefined,
            branch: args.branch as string | undefined,
            host: args.host as string | undefined,
            limit: (args.limit as number) ?? 8,
            exclude_session: args.exclude_session,
            exclude_sessions: args.exclude_sessions,
            ...time.filter,
          });
          const hits = search(db, vector, scope);
          let out = formatSearchHits(hits);
          const top = hits[0]?.score ?? 0;
          if (hits.length > 0 && top < LOW_CONFIDENCE) {
            out += `\n\n(low confidence — top score ${top.toFixed(3)}. For literal wording, try grep_turns({ query }) — keyword search over the raw conversation.)`;
          }
          return text(out);
        }
        case "grep_turns": {
          const query = args.query as string;
          if (!query) return { ...text("Error: query is required"), isError: true };
          const time = resolveTimeFilter({
            time: args.time as string | undefined,
            since: args.since as string | undefined,
            until: args.until as string | undefined,
          });
          if (time.error) return { ...text(`Error: ${time.error}`), isError: true };
          const scope = resolveLookupScope(db, {
            repo: args.repo as string | undefined,
            branch: args.branch as string | undefined,
            host: args.host as string | undefined,
            limit: (args.limit as number) ?? 8,
            exclude_session: args.exclude_session,
            exclude_sessions: args.exclude_sessions,
            ...time.filter,
          });
          return text(formatTurnHits(grepTurns(db, query, scope)));
        }
        case "list_sessions": {
          const time = resolveTimeFilter({
            time: args.time as string | undefined,
            since: args.since as string | undefined,
            until: args.until as string | undefined,
          });
          if (time.error) return { ...text(`Error: ${time.error}`), isError: true };
          const scope = resolveLookupScope(db, {
            repo: args.repo as string | undefined,
            branch: args.branch as string | undefined,
            host: args.host as string | undefined,
            limit: (args.limit as number) ?? 20,
            exclude_session: args.exclude_session,
            exclude_sessions: args.exclude_sessions,
            ...time.filter,
          });
          return text(formatSessions(listRecentSessions(db, scope)));
        }
        case "refresh_index": {
          const force = Boolean(args.force);
          const stats = await backfill(db, { force });
          const totals = storeTotals(db);
          return text(
            `Index refreshed: ${stats.sessions} sessions, ${stats.events} events, ${stats.embeddings} embeddings ` +
              `(totals: ${totals.sessions} sessions, ${totals.events} events, ${totals.embeddings} embeddings)`,
          );
        }
        case "read_turns": {
          const session = args.session as string;
          if (!session) return { ...text("Error: session is required"), isError: true };
          const branch = args.branch as string | undefined;

          type Turn = { timestamp: string; role: string; agent: string | null; text: string };

          // The live transcript is freshest; fall back to the stored snapshot once it is pruned.
          let title: string | null = null;
          let turns: Turn[];
          let pruned = false;
          const ref = await resolveSession(session);
          if (ref) {
            const parsed = await parseAny(ref);
            title = parsed.title;
            // Fold in live subagent transcripts (Claude + Grok) so the full conversation is in time order.
            const subs =
              ref.kind === "claude"
                ? await listSubagents(ref.path)
                : ref.kind === "grok"
                  ? await listGrokSubagents(ref.path)
                  : [];
            const subMsgs = (await Promise.all(subs.map((s) => parseSubagent(s)))).flatMap((p) => p.messages);
            const all: ConvMessage[] = [...parsed.messages, ...subMsgs].sort((a, b) =>
              a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
            );
            const filtered = branch ? all.filter((m) => m.branch === branch) : all;
            turns = filtered.map((m) => ({ timestamp: m.timestamp, role: m.role, agent: m.agent, text: m.text }));
          } else {
            pruned = true;
            turns = getMessages(db, session, branch).map((m: StoredMessage) => ({
              timestamp: m.ts,
              role: m.role,
              agent: m.agent,
              text: m.text,
            }));
          }

          if (turns.length === 0) {
            return text(
              `No turns${branch ? ` on branch ${branch}` : ""} found for session ${session}. ${EMPTY_LOOKUP_HINT}`,
            );
          }
          const note = pruned ? "\n(transcript pruned; served from snapshot)" : "";
          const header = `Session ${session}${branch ? ` (branch ${branch})` : ""} — ${turns.length} turns${title ? `\nTitle: ${title}` : ""}${note}`;
          const label = (t: Turn) => (t.agent ? `${t.role}·${t.agent}` : t.role);
          const body = turns.map((t) => `--- ${t.timestamp} [${label(t)}] ---\n${t.text}`).join("\n\n");
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

const MCP_HEARTBEAT_MS = 5_000;

async function runServer(): Promise<void> {
  const dir = resolveClanceyDir();
  // Register before spawning watch so the watcher sees at least one live client.
  const clientId = registerMcpClient({ dir });
  const beat = setInterval(() => {
    try {
      heartbeatMcpClient(clientId, { dir });
    } catch {
      // ignore
    }
  }, MCP_HEARTBEAT_MS);
  beat.unref?.();

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(beat);
    try {
      unregisterMcpClient(clientId, { dir });
    } catch {
      // ignore
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  ensureWatchRunning({ dir });

  const db = openStore(resolveDbPath(dir));
  startCodexLiveCapture(db);
  const server = buildServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server running. Logs: ${LOG_FILE}`);
}

const HELP = `clancey — shared conversation index across AI coding clients

Usage:
  clancey                 Start the MCP server over stdio
  clancey setup           Wire MCP + skill (+ live capture) globally, clean legacy index, backfill
  clancey backfill        Ingest existing transcripts into the store
  clancey watch           Incremental indexer (auto-started by MCP; single instance)
  clancey prune           Drop conversation history older than the retention window
  clancey hook            Internal: silent live capture (reads stdin)

Look up conversations from Claude Code, Codex, OpenCode, Grok Build, and Hermes in one store.
MCP start registers this client and ensures one detached \`clancey watch\` keeps the index fresh.

Run "clancey <command> --help" for command-specific options.`;

const PRUNE_HELP = `clancey prune — drop conversation history older than a retention window

Deletes messages, turns, tool events, and framings older than the window; recorded
decisions and learnings are always kept. Retention is unlimited by default (keep
everything) — this is an opt-in safety valve.

Options:
  --days <N>   Retain the last N days; older history is pruned. Passing this also
               saves N as the retention window, applied automatically on each backfill.
               Omit to prune using the previously saved window.
  -h, --help   Show this help.`;

const SETUP_HELP = `clancey setup — wire clancey into your AI coding tools (global, idempotent)

Primary goal: one conversation index across clients. Every host gets the Clancey MCP
server and the Clancey skill (Agent Skills SKILL.md) that teaches agents how to look up
past sessions (and optionally record decisions/learnings).

Claude Code: MCP at user scope + skill in ~/.claude/skills/clancey/ + silent live-capture hooks.
OpenCode: MCP + skill under ~/.config/opencode/ + live-recording plugin.
Codex: MCP in ~/.codex/config.toml + skill in ~/.codex/skills/clancey/ (history import + live poller).
Grok Build: MCP in ~/.grok/config.toml + skill in ~/.grok/skills/clancey/ + silent live-capture hooks.
Hermes Agent: MCP in ~/.hermes/config.yaml + skill in ~/.hermes/skills/clancey/ (history import from state.db).

All hosts are pinned to this install's absolute entrypoint (node + path to dist/index.js),
not npx package specs. Re-run setup after upgrading clancey to re-pin every host.

Then offers to remove the legacy v1 index and backfills existing conversations from every
detected host.

Options:
  --tools <list>              Comma-separated tools to set up, non-interactively:
                              claude, codex, opencode, grok, hermes, or all (e.g. --tools hermes).
                              Skips the picker. Default is the interactive picker; with
                              no TTY, all detected tools.
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

/** Parse `--days N` (or `--days=N`) into a positive integer, or undefined when absent. */
function parseDays(args: string[]): number | undefined {
  const eq = args.find((a) => a.startsWith("--days="));
  const idx = args.indexOf("--days");
  const raw = eq ? eq.slice("--days=".length) : idx !== -1 ? args[idx + 1] : undefined;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Invalid --days value "${raw}" (expected a positive integer).`);
    process.exit(1);
  }
  return n;
}

/** Parse `--tools claude,codex,opencode,grok,hermes` (or `--tools=all`) into an explicit target list. */
function parseTools(args: string[]): Target[] | undefined {
  const eq = args.find((a) => a.startsWith("--tools="));
  const idx = args.indexOf("--tools");
  const raw = eq ? eq.slice("--tools=".length) : idx !== -1 ? args[idx + 1] : undefined;
  if (raw === undefined) return undefined;

  const all: Target[] = ["claude", "codex", "opencode", "grok", "hermes"];
  const out = new Set<Target>();
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (part === "all") {
      for (const t of all) out.add(t);
    } else if ((all as string[]).includes(part)) {
      out.add(part as Target);
    } else {
      console.error(`Unknown tool "${part}" for --tools (expected: claude, codex, opencode, grok, hermes, all)`);
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
    case "watch":
      await runWatchCli(rest);
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
    case "prune": {
      if (wantsHelp(rest)) {
        console.log(PRUNE_HELP);
        return;
      }
      const db = openStore();
      try {
        const days = parseDays(rest);
        if (days !== undefined) setMeta(db, "retention_days", String(days));
        const window = getRetentionDays(db);
        if (window <= 0) {
          console.error("No retention window set. Run `clancey prune --days <N>` to set one.");
          process.exitCode = 1;
          return;
        }
        const removed = pruneOlderThan(db, window);
        log(`Pruned ${removed} messages older than ${window} days (retention window: ${window} days).`);
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
