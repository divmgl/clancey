import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Whether to keep assistant reasoning. Off by default: thinking is high-volume and
 * is not the verbatim artifact we care about. Flip to re-include it everywhere.
 */
const CAPTURE_THINKING = false;

export interface ToolEvent {
  tool: string;
  file: string | null;
  command: string | null;
  branch: string | null;
  cwd: string | null;
  timestamp: string;
}

export interface UserTurn {
  text: string;
  branch: string | null;
  timestamp: string;
}

export type Role = "user" | "assistant";

/** One conversation turn we store verbatim and index for keyword search. */
export interface ConvMessage {
  role: Role;
  /** null = main session; otherwise the subagent's type (e.g. "Plan", "Explore"). */
  agent: string | null;
  agentId: string | null;
  branch: string | null;
  timestamp: string;
  text: string;
}

export interface ParsedTranscript {
  sessionId: string;
  title: string | null;
  toolEvents: ToolEvent[];
  userTurns: UserTurn[];
  /** Full conversation — user + assistant turns, with verbatim scripts/code inline. */
  messages: ConvMessage[];
  /** First substantive human turn — the session's framing, used as a search anchor. */
  framing: string | null;
}

/** Attribution + identity overrides used when a transcript is a subagent of a parent session. */
export interface ParseAttribution {
  sessionId: string;
  agent: string;
  agentId: string;
}

export function getProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function getCodexSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

/** OpenCode's session store, XDG-aware: $XDG_DATA_HOME/opencode/storage (falls back to ~/.local/share). */
export function getOpencodeStorageDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "storage");
}

export type TranscriptKind = "claude" | "codex" | "opencode";

export interface TranscriptRef {
  path: string;
  kind: TranscriptKind;
}

/** A subagent (Task) transcript, linked to the parent session that spawned it. */
export interface SubagentRef {
  path: string;
  parentSessionId: string;
  agentId: string;
  agentType: string;
}

export function decodeClaudeProject(projectDir: string): string {
  return projectDir.startsWith("-")
    ? "/" + projectDir.slice(1).replace(/-/g, "/")
    : projectDir;
}

/** Extract plain text from a message's content (string, or an array of text blocks). */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .filter(
        (block: { type?: string; text?: unknown }) =>
          typeof block?.text === "string" &&
          (block.type === "text" || block.type === "input_text" || block.type === "output_text"),
      )
      .map((block: { text: string }) => block.text)
      .join("\n")
      .trim();
  }

  return "";
}

/** A very long whitespace-free run is almost certainly base64/binary, not prose or code. */
function looksBinary(s: string): boolean {
  return /\S{800,}/.test(s);
}

/** Render a verbatim tool input (the scripts/code we want to keep), or null to skip it. */
function renderToolUse(name: string, input: Record<string, unknown>): string | null {
  const file = typeof input.file_path === "string" ? input.file_path : "";
  const keep = (label: string, body: string): string | null =>
    !body || looksBinary(body) ? null : `「${label}」\n${body}`;

  if (name === "Bash" && typeof input.command === "string") return keep("Bash", input.command);
  if (name === "Write" && typeof input.content === "string") return keep(`Write ${file}`.trim(), input.content);
  if (name === "Edit" && typeof input.new_string === "string") return keep(`Edit ${file}`.trim(), input.new_string);
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const body = (input.edits as Array<{ new_string?: unknown }>)
      .map((e) => (typeof e?.new_string === "string" ? e.new_string : ""))
      .filter(Boolean)
      .join("\n");
    return keep(`MultiEdit ${file}`.trim(), body);
  }
  return null;
}

/**
 * Render one message's content into the text we store + index: prose plus the verbatim
 * tool inputs that hold scripts/code. Tool *outputs* (tool_result), images, and (by
 * default) thinking are dropped — they are the high-volume, low-signal bulk of a transcript.
 */
function renderMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown }>) {
    const type = block?.type;
    if (type === "text" || type === "input_text" || type === "output_text") {
      if (typeof block.text === "string") parts.push(block.text);
    } else if (type === "thinking") {
      if (CAPTURE_THINKING && typeof block.thinking === "string") parts.push(block.thinking);
    } else if (type === "tool_use" && typeof block.name === "string") {
      const rendered = renderToolUse(block.name, (block.input ?? {}) as Record<string, unknown>);
      if (rendered) parts.push(rendered);
    }
    // tool_result, image, and anything else: dropped as noise.
  }
  return parts.join("\n").trim();
}

/** Boilerplate / non-human user entries that carry no decision signal. */
function isNoiseUserText(text: string): boolean {
  return (
    text.length < 20 ||
    text.startsWith("<command-name>") ||
    text.startsWith("<local-command") ||
    text.startsWith("<bash-") ||
    text.startsWith("<system-reminder") ||
    text.startsWith("<task-notification") ||
    text.startsWith("Caveat:") ||
    text.startsWith("This session is being continued")
  );
}

/**
 * List session transcript files: the `<sessionId>.jsonl` files directly under each project
 * directory in ~/.claude/projects. Skips nested `subagents/` transcripts and the memory dir.
 */
export async function listConversationFiles(): Promise<string[]> {
  const projectsDir = getProjectsDir();
  const files: string[] = [];

  let projects: string[];
  try {
    projects = await fs.promises.readdir(projectsDir);
  } catch {
    return files;
  }

  for (const project of projects) {
    const projectPath = path.join(projectsDir, project);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(projectPath, entry.name));
      }
    }
  }

  return files;
}

/**
 * Discover a Claude session's subagent transcripts. They live in a sibling directory
 * `<sessionId>/subagents/agent-<id>.jsonl`, each with an `agent-<id>.meta.json` carrying the
 * agent type. Parent linkage comes from the directory name, which is more robust than matching
 * the `toolUseId`; the meta only supplies the human-readable agent label.
 */
export async function listSubagents(parentSessionFile: string): Promise<SubagentRef[]> {
  const subdir = path.join(parentSessionFile.replace(/\.jsonl$/, ""), "subagents");
  const parentSessionId = path.basename(parentSessionFile, ".jsonl");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(subdir, { withFileTypes: true });
  } catch {
    return [];
  }
  const refs: SubagentRef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(subdir, entry.name);
    const agentId = entry.name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    let agentType = "agent";
    try {
      const meta = JSON.parse(await fs.promises.readFile(full.replace(/\.jsonl$/, ".meta.json"), "utf-8")) as {
        agentType?: unknown;
      };
      if (typeof meta?.agentType === "string" && meta.agentType) agentType = meta.agentType;
    } catch {
      // no/unreadable meta — fall back to the generic "agent" label.
    }
    refs.push({ path: full, parentSessionId, agentId, agentType });
  }
  return refs;
}

/** Parse a subagent transcript, folding it under the parent session with agent attribution. */
export function parseSubagent(ref: SubagentRef): Promise<ParsedTranscript> {
  return parseTranscript(ref.path, { sessionId: ref.parentSessionId, agent: ref.agentType, agentId: ref.agentId });
}

async function collectJsonl(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/** Codex stores sessions nested by date under ~/.codex/sessions. */
export async function listCodexFiles(): Promise<string[]> {
  const files: string[] = [];
  await collectJsonl(getCodexSessionsDir(), files);
  return files;
}

/**
 * OpenCode keeps one `<sessionId>.json` per session under `storage/session/<projectId>/`. The
 * conversation itself lives elsewhere (storage/message/<sessionId>/ and storage/part/<msgId>/),
 * so the ref's path is the session-metadata file and the parser locates the rest from it.
 */
export async function listOpencodeFiles(): Promise<string[]> {
  const sessionRoot = path.join(getOpencodeStorageDir(), "session");
  const files: string[] = [];
  let projects: fs.Dirent[];
  try {
    projects = await fs.promises.readdir(sessionRoot, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await fs.promises.readdir(path.join(sessionRoot, project.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".json")) files.push(path.join(sessionRoot, project.name, entry));
    }
  }
  return files;
}

/** Session id for a transcript ref — OpenCode files end in `.json`, the others in `.jsonl`. */
export function sessionIdOf(ref: TranscriptRef): string {
  return path.basename(ref.path, ref.kind === "opencode" ? ".json" : ".jsonl");
}

/** All ingestable transcripts across Claude Code, Codex, and OpenCode, tagged by kind. */
export async function listAllTranscripts(): Promise<TranscriptRef[]> {
  const [claude, codex, opencode] = await Promise.all([
    listConversationFiles(),
    listCodexFiles(),
    listOpencodeFiles(),
  ]);
  return [
    ...claude.map((p): TranscriptRef => ({ path: p, kind: "claude" })),
    ...codex.map((p): TranscriptRef => ({ path: p, kind: "codex" })),
    ...opencode.map((p): TranscriptRef => ({ path: p, kind: "opencode" })),
  ];
}

/** Resolve a session id to its transcript (searches Claude, Codex, then OpenCode), or null. */
export async function resolveSession(sessionId: string): Promise<TranscriptRef | null> {
  const all = await listAllTranscripts();
  return all.find((r) => sessionIdOf(r) === sessionId) ?? null;
}

/** Parse one transcript into tool events, conversation messages, human turns, title, and framing. */
export async function parseTranscript(filePath: string, attribution?: ParseAttribution): Promise<ParsedTranscript> {
  const sessionId = attribution?.sessionId ?? path.basename(filePath, ".jsonl");
  const agent = attribution?.agent ?? null;
  const agentId = attribution?.agentId ?? null;
  const toolEvents: ToolEvent[] = [];
  const userTurns: UserTurn[] = [];
  const messages: ConvMessage[] = [];
  let title: string | null = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj: {
      type?: string;
      isMeta?: boolean;
      aiTitle?: unknown;
      gitBranch?: unknown;
      cwd?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof obj.aiTitle === "string") title = obj.aiTitle;

    const branch = typeof obj.gitBranch === "string" ? obj.gitBranch : null;
    const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";

    if (obj.type === "assistant") {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
          if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
          const tool = block.name;
          const input = block.input ?? {};
          if (FILE_TOOLS.has(tool) && typeof input.file_path === "string") {
            toolEvents.push({ tool, file: input.file_path, command: null, branch, cwd, timestamp });
          } else if (tool === "Bash" && typeof input.command === "string") {
            toolEvents.push({ tool, file: null, command: input.command, branch, cwd, timestamp });
          }
        }
      }
      const text = renderMessageText(content);
      if (text) messages.push({ role: "assistant", agent, agentId, branch, timestamp, text });
      continue;
    }

    if (obj.type === "user") {
      if (obj.isMeta) continue;
      const text = extractTextContent(obj.message?.content);
      if (!text || isNoiseUserText(text)) continue;
      userTurns.push({ text, branch, timestamp });
      messages.push({ role: "user", agent, agentId, branch, timestamp, text });
    }
  }

  return { sessionId, title, toolEvents, userTurns, messages, framing: userTurns[0]?.text ?? null };
}

/** Codex command tools, across versions: `shell` (array cmd), `exec_command`/`shell_command` (string cmd). */
const CODEX_COMMAND_TOOLS = new Set(["shell", "exec_command", "shell_command"]);

/** Codex injects AGENTS.md and environment context as user messages — not human turns. */
function isCodexBoilerplate(text: string): boolean {
  return (
    text.startsWith("# AGENTS.md instructions for ") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<user_instructions>") ||
    text.startsWith("<INSTRUCTIONS>")
  );
}

/** File paths touched by an apply_patch body (`*** Add/Update/Delete File: <path>`). */
function extractPatchFiles(text: string): string[] {
  const files: string[] = [];
  const re = /\*\*\* (?:Add|Update|Delete) File: (.+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) files.push(m[1].trim());
  return files;
}

/**
 * Parse a Codex session transcript. Repo + branch come from `session_meta` (one per
 * session); file/command events come from `shell` function calls (and the apply_patch
 * bodies inside them). Codex has no hook, so this is backfill-only.
 */
export async function parseCodexTranscript(filePath: string): Promise<ParsedTranscript> {
  const sessionId = path.basename(filePath, ".jsonl");
  const toolEvents: ToolEvent[] = [];
  const userTurns: UserTurn[] = [];
  const messages: ConvMessage[] = [];
  let cwd: string | null = null;
  let branch: string | null = null;

  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: {
      type?: string;
      timestamp?: unknown;
      payload?: {
        type?: string;
        role?: string;
        name?: string;
        arguments?: unknown;
        input?: unknown;
        content?: unknown;
        cwd?: unknown;
        git?: { branch?: unknown };
      };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === "session_meta") {
      if (typeof obj.payload?.cwd === "string") cwd = obj.payload.cwd;
      if (typeof obj.payload?.git?.branch === "string") branch = obj.payload.git.branch;
      continue;
    }
    if (obj.type !== "response_item") continue;

    const p = obj.payload;
    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";

    if (p?.type === "message" && p.role === "user") {
      const text = extractTextContent(p.content);
      if (!text || isNoiseUserText(text) || isCodexBoilerplate(text)) continue;
      userTurns.push({ text, branch, timestamp });
      messages.push({ role: "user", agent: null, agentId: null, branch, timestamp, text });
    } else if (p?.type === "message" && p.role === "assistant") {
      const text = extractTextContent(p.content);
      if (text) messages.push({ role: "assistant", agent: null, agentId: null, branch, timestamp, text });
    } else if (p?.type === "function_call" && typeof p.name === "string" && CODEX_COMMAND_TOOLS.has(p.name)) {
      let command: string | null = null;
      let workdir: string | null = null;
      try {
        const args = (typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments) as {
          command?: unknown;
          cmd?: unknown;
          workdir?: unknown;
        };
        if (Array.isArray(args?.command)) command = args.command.join(" ");
        else if (typeof args?.command === "string") command = args.command;
        else if (typeof args?.cmd === "string") command = args.cmd;
        if (typeof args?.workdir === "string") workdir = args.workdir;
      } catch {
        command = null;
      }
      if (command) {
        const evCwd = workdir ?? cwd;
        toolEvents.push({ tool: p.name, file: null, command, branch, cwd: evCwd, timestamp });
        for (const file of extractPatchFiles(command)) {
          toolEvents.push({ tool: "apply_patch", file, command: null, branch, cwd: evCwd, timestamp });
        }
      }
    } else if (p?.type === "custom_tool_call" && p.name === "apply_patch") {
      const patch = typeof p.input === "string" ? p.input : "";
      for (const file of extractPatchFiles(patch)) {
        toolEvents.push({ tool: "apply_patch", file, command: null, branch, cwd, timestamp });
      }
    }
  }

  return { sessionId, title: null, toolEvents, userTurns, messages, framing: userTurns[0]?.text ?? null };
}

/** OpenCode tools that touch a file (its input carries `filePath`). */
const OPENCODE_FILE_TOOLS = new Set(["edit", "write"]);

/** Render an OpenCode tool's verbatim input (the scripts/code we keep), or null to skip it. */
function renderOpencodeTool(tool: string, input: Record<string, unknown>): string | null {
  const file = typeof input.filePath === "string" ? input.filePath : "";
  const keep = (label: string, body: string): string | null =>
    !body || looksBinary(body) ? null : `「${label}」\n${body}`;

  if (tool === "bash" && typeof input.command === "string") return keep("Bash", input.command);
  if (tool === "write" && typeof input.content === "string") return keep(`Write ${file}`.trim(), input.content);
  if (tool === "edit" && typeof input.newString === "string") return keep(`Edit ${file}`.trim(), input.newString);
  return null;
}

interface OpencodePart {
  type?: string;
  text?: unknown;
  synthetic?: unknown;
  tool?: unknown;
  state?: { input?: unknown };
}

/** Read + JSON-parse every `*.json` in a directory, sorted by filename; missing dir → []. */
async function readJsonDir<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await fs.promises.readFile(path.join(dir, name), "utf-8")) as T);
    } catch {
      // skip unreadable/corrupt files
    }
  }
  return out;
}

/** Locate the storage root from a session file at `<root>/session/<projectId>/<sessionId>.json`. */
function opencodeStorageRoot(sessionFile: string): string {
  return path.dirname(path.dirname(path.dirname(sessionFile)));
}

/**
 * Every file that makes up one OpenCode session — the session-metadata file plus its message
 * files. Backfill takes the newest mtime across these so a new turn (a new message file, and the
 * message's rewrite when it completes) re-ingests the session. Part files are not walked: a new
 * turn always writes a new message file, which is enough of a change signal.
 */
export async function listOpencodeUnitFiles(sessionFile: string): Promise<string[]> {
  const sessionId = path.basename(sessionFile, ".json");
  const messageDir = path.join(opencodeStorageRoot(sessionFile), "message", sessionId);
  let messages: string[] = [];
  try {
    messages = (await fs.promises.readdir(messageDir))
      .filter((n) => n.endsWith(".json"))
      .map((n) => path.join(messageDir, n));
  } catch {
    // no messages yet
  }
  return [sessionFile, ...messages];
}

/**
 * Parse an OpenCode session. Unlike Claude/Codex's single JSONL file, an OpenCode conversation is
 * spread across `session/<id>.json` (title + cwd), `message/<id>/*.json` (one file per turn), and
 * `part/<msgId>/*.json` (the turn's content). Repo/cwd come from the session's `directory`; there
 * is no branch in OpenCode storage, so events are branch-less. Backfill-only — OpenCode has no hook.
 */
export async function parseOpencodeTranscript(sessionFile: string): Promise<ParsedTranscript> {
  const root = opencodeStorageRoot(sessionFile);
  let meta: { id?: unknown; title?: unknown; directory?: unknown } = {};
  try {
    meta = JSON.parse(await fs.promises.readFile(sessionFile, "utf-8"));
  } catch {
    // missing/corrupt session file — fall through to an empty parse
  }
  const sessionId = typeof meta.id === "string" ? meta.id : path.basename(sessionFile, ".json");
  const title = typeof meta.title === "string" ? meta.title : null;
  const cwd = typeof meta.directory === "string" ? meta.directory : null;

  const toolEvents: ToolEvent[] = [];
  const userTurns: UserTurn[] = [];
  const messages: ConvMessage[] = [];

  const msgMetas = await readJsonDir<{ id?: unknown; role?: unknown; time?: { created?: unknown } }>(
    path.join(root, "message", sessionId),
  );
  const createdMs = (m: { time?: { created?: unknown } }) =>
    typeof m.time?.created === "number" ? m.time.created : 0;
  const idOf = (m: { id?: unknown }) => (typeof m.id === "string" ? m.id : "");
  msgMetas.sort((a, b) => createdMs(a) - createdMs(b) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));

  for (const m of msgMetas) {
    const role: Role | null = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
    const id = idOf(m);
    if (!role || !id) continue;
    const timestamp = createdMs(m) ? new Date(createdMs(m)).toISOString() : "";

    const parts = await readJsonDir<OpencodePart>(path.join(root, "part", id));
    const rendered: string[] = []; // prose + verbatim tool bodies → the stored message
    const prose: string[] = []; // text-only → the human turn / framing

    for (const part of parts) {
      if (part.type === "text") {
        // Synthetic text is OpenCode-injected file dumps, not authored prose — drop it.
        if (part.synthetic || typeof part.text !== "string" || !part.text.trim()) continue;
        rendered.push(part.text);
        if (role === "user") prose.push(part.text);
      } else if (part.type === "tool") {
        const tool = typeof part.tool === "string" ? part.tool : "";
        const input = (part.state?.input ?? {}) as Record<string, unknown>;
        if (OPENCODE_FILE_TOOLS.has(tool) && typeof input.filePath === "string") {
          toolEvents.push({ tool, file: input.filePath, command: null, branch: null, cwd, timestamp });
        } else if (tool === "bash" && typeof input.command === "string") {
          toolEvents.push({ tool, file: null, command: input.command, branch: null, cwd, timestamp });
        }
        const body = renderOpencodeTool(tool, input);
        if (body) rendered.push(body);
      }
      // reasoning (thinking), patch (files already covered by edit/write), step-*, file: dropped.
    }

    if (role === "user") {
      const turn = prose.join("\n").trim();
      if (!turn || isNoiseUserText(turn)) continue; // also drops the message for noise turns
      userTurns.push({ text: turn, branch: null, timestamp });
    }
    const text = rendered.join("\n").trim();
    if (text) messages.push({ role, agent: null, agentId: null, branch: null, timestamp, text });
  }

  return { sessionId, title, toolEvents, userTurns, messages, framing: userTurns[0]?.text ?? null };
}

/** Parse any transcript by kind. */
export function parseAny(ref: TranscriptRef): Promise<ParsedTranscript> {
  if (ref.kind === "codex") return parseCodexTranscript(ref.path);
  if (ref.kind === "opencode") return parseOpencodeTranscript(ref.path);
  return parseTranscript(ref.path);
}
