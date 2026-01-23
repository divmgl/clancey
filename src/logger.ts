import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".clancey");
const LOG_FILE = join(LOG_DIR, "clancey.log");

// Ensure log directory exists
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`
    : message;

  const line = `[${timestamp}] ${formatted}\n`;

  // Write to file
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore write errors
  }

  // Also write to stderr for MCP
  console.error(`[clancey] ${formatted}`);
}

export function logError(message: string, error: unknown): void {
  const errorMsg = error instanceof Error ? error.stack || error.message : String(error);
  log(`ERROR: ${message}: ${errorMsg}`);
}

export { LOG_FILE };
