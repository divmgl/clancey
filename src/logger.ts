import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".clancey");
const DEFAULT_LOG_FILE = join(LOG_DIR, "clancey.log");

/** Rotate when the log reaches this size (5 MB). */
export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

// Ensure log directory exists
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore
}

let consoleSilent = false;
let logFilePath = DEFAULT_LOG_FILE;
let maxLogBytes = DEFAULT_MAX_LOG_BYTES;

/** Silence stderr output (file logging continues). Used by interactive commands that own the terminal. */
export function setConsoleSilent(silent: boolean): void {
  consoleSilent = silent;
}

/**
 * Redirect file logging (tests). Pass null to restore the default path.
 * Also resets the size cap when `maxBytes` is provided.
 */
export function configureLogger(opts: { file?: string | null; maxBytes?: number } = {}): void {
  if (opts.file === null) logFilePath = DEFAULT_LOG_FILE;
  else if (typeof opts.file === "string") logFilePath = opts.file;
  if (typeof opts.maxBytes === "number" && opts.maxBytes > 0) maxLogBytes = opts.maxBytes;
}

/** Current log file path (after configureLogger overrides). */
export function getLogFile(): string {
  return logFilePath;
}

/**
 * If the log file is at or over the size cap (optionally counting an upcoming write),
 * rotate it to `${path}.1` (replacing any previous `.1`) so the active log starts empty.
 * Cheap stat; no-op when the file is absent or under the cap.
 */
export function rotateLogIfNeeded(
  file: string = logFilePath,
  cap: number = maxLogBytes,
  upcomingBytes = 0,
): boolean {
  try {
    if (!existsSync(file)) return false;
    const size = statSync(file).size;
    if (size + upcomingBytes < cap) return false;
    const bak = `${file}.1`;
    try {
      if (existsSync(bak)) unlinkSync(bak);
      renameSync(file, bak);
    } catch {
      // Cross-device or rename failure: fall back to truncate.
      writeFileSync(file, "");
    }
    return true;
  } catch {
    return false;
  }
}

// Rotate a bloated log once at process start so multi-host reconnect storms cannot keep
// appending forever without a size check.
rotateLogIfNeeded();

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted =
    args.length > 0
      ? `${message} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`
      : message;

  const line = `[${timestamp}] ${formatted}\n`;

  try {
    rotateLogIfNeeded(logFilePath, maxLogBytes, Buffer.byteLength(line));
    mkdirSync(dirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, line);
  } catch {
    // ignore write errors
  }

  // Also write to stderr (MCP server diagnostics); the file copy keeps the timestamp.
  if (!consoleSilent) {
    console.error(formatted);
  }
}

export function logError(message: string, error: unknown): void {
  const errorMsg = error instanceof Error ? error.stack || error.message : String(error);
  log(`ERROR: ${message}: ${errorMsg}`);
}

export { DEFAULT_LOG_FILE as LOG_FILE };
