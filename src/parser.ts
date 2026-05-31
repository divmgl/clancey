import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

export interface ParsedTranscript {
  sessionId: string;
  title: string | null;
  toolEvents: ToolEvent[];
  userTurns: UserTurn[];
  /** First substantive human turn — the session's framing, used as a search anchor. */
  framing: string | null;
}

export function getProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function getCodexSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export type TranscriptKind = "claude" | "codex";

export interface TranscriptRef {
  path: string;
  kind: TranscriptKind;
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

/** All ingestable transcripts across Claude Code and Codex, tagged by kind. */
export async function listAllTranscripts(): Promise<TranscriptRef[]> {
  const [claude, codex] = await Promise.all([listConversationFiles(), listCodexFiles()]);
  return [
    ...claude.map((p): TranscriptRef => ({ path: p, kind: "claude" })),
    ...codex.map((p): TranscriptRef => ({ path: p, kind: "codex" })),
  ];
}

/** Resolve a session id to its transcript (searches Claude then Codex), or null. */
export async function resolveSession(sessionId: string): Promise<TranscriptRef | null> {
  const all = await listAllTranscripts();
  return all.find((r) => path.basename(r.path, ".jsonl") === sessionId) ?? null;
}

/** Parse one transcript into tool events, human turns, title, and framing. */
export async function parseTranscript(filePath: string): Promise<ParsedTranscript> {
  const sessionId = path.basename(filePath, ".jsonl");
  const toolEvents: ToolEvent[] = [];
  const userTurns: UserTurn[] = [];
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
      if (!Array.isArray(content)) continue;
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
      continue;
    }

    if (obj.type === "user") {
      if (obj.isMeta) continue;
      const text = extractTextContent(obj.message?.content);
      if (!text || isNoiseUserText(text)) continue;
      userTurns.push({ text, branch, timestamp });
    }
  }

  return { sessionId, title, toolEvents, userTurns, framing: userTurns[0]?.text ?? null };
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

  return { sessionId, title: null, toolEvents, userTurns, framing: userTurns[0]?.text ?? null };
}

/** Parse any transcript by kind. */
export function parseAny(ref: TranscriptRef): Promise<ParsedTranscript> {
  return ref.kind === "codex" ? parseCodexTranscript(ref.path) : parseTranscript(ref.path);
}
