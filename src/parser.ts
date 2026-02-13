import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface Conversation {
  sessionId: string;
  project: string;
  messages: Message[];
  filePath: string;
  lastModified: number;
}

export interface ConversationChunk {
  id: string;
  sessionId: string;
  project: string;
  content: string;
  timestamp: string;
  chunkIndex: number;
}

export function getClaudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

export function getProjectsDir(): string {
  return path.join(getClaudeDir(), "projects");
}

export function getCodexDir(): string {
  return path.join(os.homedir(), ".codex");
}

export function getCodexSessionsDir(): string {
  return path.join(getCodexDir(), "sessions");
}

export function getConversationWatchDirs(): string[] {
  return [getProjectsDir(), getCodexSessionsDir()].filter((dir) => fs.existsSync(dir));
}

function isCodexConversationFile(filePath: string): boolean {
  const codexSessionsDir = path.normalize(getCodexSessionsDir());
  const normalized = path.normalize(filePath);
  return normalized.startsWith(`${codexSessionsDir}${path.sep}`);
}

function decodeClaudeProject(projectDir: string): string {
  return projectDir.startsWith("-")
    ? "/" + projectDir.slice(1).replace(/-/g, "/")
    : projectDir;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .filter(
        (block: any) =>
          typeof block?.text === "string" &&
          (block.type === "text" || block.type === "input_text" || block.type === "output_text")
      )
      .map((block: any) => block.text)
      .join("\n")
      .trim();
  }

  return "";
}

function isCodexBoilerplateMessage(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<collaboration_mode>") ||
    trimmed.startsWith("<user_instructions>")
  );
}

async function listClaudeConversationFiles(): Promise<string[]> {
  const projectsDir = getProjectsDir();
  const files: string[] = [];

  if (!fs.existsSync(projectsDir)) {
    return files;
  }

  let projects: string[] = [];
  try {
    projects = await fs.promises.readdir(projectsDir);
  } catch {
    return files;
  }

  for (const project of projects) {
    const projectPath = path.join(projectsDir, project);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(projectPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    let projectFiles: string[] = [];
    try {
      projectFiles = await fs.promises.readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of projectFiles) {
      if (file.endsWith(".jsonl")) {
        files.push(path.join(projectPath, file));
      }
    }
  }

  return files;
}

async function collectJsonlFilesRecursive(dir: string, files: string[]): Promise<void> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await collectJsonlFilesRecursive(fullPath, files);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

async function listCodexConversationFiles(): Promise<string[]> {
  const sessionsDir = getCodexSessionsDir();
  const files: string[] = [];

  if (!fs.existsSync(sessionsDir)) {
    return files;
  }

  await collectJsonlFilesRecursive(sessionsDir, files);
  return files;
}

/**
 * List all conversation files across all projects
 */
export async function listConversationFiles(): Promise<string[]> {
  const [claudeFiles, codexFiles] = await Promise.all([
    listClaudeConversationFiles(),
    listCodexConversationFiles(),
  ]);

  return Array.from(new Set([...claudeFiles, ...codexFiles]));
}

async function parseClaudeConversation(filePath: string, stat: fs.Stats): Promise<Conversation | null> {
  const sessionId = path.basename(filePath, ".jsonl");
  const projectDir = path.basename(path.dirname(filePath));
  const project = decodeClaudeProject(projectDir);
  const messages: Message[] = [];

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      if (obj.isMeta) continue;
      if (obj.type === "file-history-snapshot") continue;
      if (obj.type === "summary") continue;
      if (obj.type !== "user" && obj.type !== "assistant") continue;

      const content = obj.message?.content;
      const textContent = extractTextContent(content);

      if (!textContent) continue;
      if (textContent.startsWith("<command-name>")) continue;
      if (textContent.startsWith("<local-command")) continue;
      if (textContent.length < 20) continue;

      messages.push({
        role: obj.type as "user" | "assistant",
        content: textContent,
        timestamp: obj.timestamp || new Date().toISOString(),
      });
    } catch {
      continue;
    }
  }

  if (messages.length === 0) {
    return null;
  }

  return {
    sessionId,
    project,
    messages,
    filePath,
    lastModified: stat.mtimeMs,
  };
}

async function parseCodexConversation(filePath: string, stat: fs.Stats): Promise<Conversation | null> {
  const sessionId = path.basename(filePath, ".jsonl");
  const messages: Message[] = [];
  let project = "codex";

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      if (obj.type === "session_meta") {
        const cwd = obj.payload?.cwd;
        if (typeof cwd === "string" && cwd.length > 0) {
          project = cwd;
        }
        continue;
      }

      if (obj.type !== "response_item") continue;
      if (obj.payload?.type !== "message") continue;

      const role = obj.payload?.role;
      if (role !== "user" && role !== "assistant") continue;

      const textContent = extractTextContent(obj.payload?.content);
      if (!textContent) continue;
      if (isCodexBoilerplateMessage(textContent)) continue;
      if (textContent.length < 20) continue;

      messages.push({
        role,
        content: textContent,
        timestamp: obj.timestamp || new Date().toISOString(),
      });
    } catch {
      continue;
    }
  }

  if (messages.length === 0) {
    return null;
  }

  return {
    sessionId,
    project,
    messages,
    filePath,
    lastModified: stat.mtimeMs,
  };
}

/**
 * Parse a single conversation JSONL file
 */
export async function parseConversation(filePath: string): Promise<Conversation | null> {
  const stat = await fs.promises.stat(filePath);
  if (isCodexConversationFile(filePath)) {
    return parseCodexConversation(filePath, stat);
  }

  return parseClaudeConversation(filePath, stat);
}

/**
 * Chunk a conversation into smaller pieces for embedding
 */
export function chunkConversation(conversation: Conversation, maxChunkSize = 2000): ConversationChunk[] {
  const chunks: ConversationChunk[] = [];
  let currentChunk = "";
  let chunkIndex = 0;
  let chunkTimestamp = conversation.messages[0]?.timestamp || new Date().toISOString();

  for (const message of conversation.messages) {
    const prefix = message.role === "user" ? "User: " : "Assistant: ";
    const messageText = `${prefix}${message.content}\n\n`;

    // If adding this message would exceed max size, save current chunk
    if (currentChunk.length + messageText.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push({
        id: `${conversation.sessionId}-${chunkIndex}`,
        sessionId: conversation.sessionId,
        project: conversation.project,
        content: currentChunk.trim(),
        timestamp: chunkTimestamp,
        chunkIndex,
      });
      currentChunk = "";
      chunkIndex++;
      chunkTimestamp = message.timestamp;
    }

    currentChunk += messageText;
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      id: `${conversation.sessionId}-${chunkIndex}`,
      sessionId: conversation.sessionId,
      project: conversation.project,
      content: currentChunk.trim(),
      timestamp: chunkTimestamp,
      chunkIndex,
    });
  }

  return chunks;
}
