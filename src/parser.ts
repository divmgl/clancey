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

/**
 * List all conversation files across all projects
 */
export async function listConversationFiles(): Promise<string[]> {
  const projectsDir = getProjectsDir();
  const files: string[] = [];

  if (!fs.existsSync(projectsDir)) {
    return files;
  }

  const projects = await fs.promises.readdir(projectsDir);

  for (const project of projects) {
    const projectPath = path.join(projectsDir, project);
    const stat = await fs.promises.stat(projectPath);

    if (!stat.isDirectory()) continue;

    const projectFiles = await fs.promises.readdir(projectPath);

    for (const file of projectFiles) {
      if (file.endsWith(".jsonl")) {
        files.push(path.join(projectPath, file));
      }
    }
  }

  return files;
}

/**
 * Parse a single conversation JSONL file
 */
export async function parseConversation(filePath: string): Promise<Conversation | null> {
  const stat = await fs.promises.stat(filePath);
  const sessionId = path.basename(filePath, ".jsonl");
  const projectDir = path.basename(path.dirname(filePath));

  // Decode project path (replace dashes with slashes)
  const project = projectDir.startsWith("-")
    ? "/" + projectDir.slice(1).replace(/-/g, "/")
    : projectDir;

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

      // Skip meta messages, file snapshots, etc.
      if (obj.isMeta) continue;
      if (obj.type === "file-history-snapshot") continue;
      if (obj.type === "summary") continue;

      if (obj.type === "user" || obj.type === "assistant") {
        const content = obj.message?.content;

        // Skip empty or command-only messages
        if (!content) continue;
        if (typeof content === "string" && content.startsWith("<command-name>")) continue;
        if (typeof content === "string" && content.startsWith("<local-command")) continue;

        // Handle content that might be an array (tool calls, etc.)
        let textContent: string;
        if (typeof content === "string") {
          textContent = content;
        } else if (Array.isArray(content)) {
          // Extract text from content blocks
          textContent = content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("\n");
        } else {
          continue;
        }

        // Skip very short messages
        if (textContent.length < 20) continue;

        messages.push({
          role: obj.type as "user" | "assistant",
          content: textContent,
          timestamp: obj.timestamp || new Date().toISOString(),
        });
      }
    } catch {
      // Skip malformed lines
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
