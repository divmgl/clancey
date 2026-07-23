import path from "path";
import os from "os";

/**
 * Clancey data directory. Override with CLANCEY_HOME or CLANCEY_DIR (tests / multi-instance).
 * Resolved on each call so env set before process start is honored.
 */
export function resolveClanceyDir(): string {
  const env = process.env.CLANCEY_HOME || process.env.CLANCEY_DIR;
  if (env?.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), ".clancey");
}

export function resolveDbPath(dir: string = resolveClanceyDir()): string {
  return path.join(dir, "clancey.db");
}

export function watchLockPath(dir: string = resolveClanceyDir()): string {
  return path.join(dir, "watch.lock");
}

export function mcpClientsPath(dir: string = resolveClanceyDir()): string {
  return path.join(dir, "mcp-clients.json");
}

export function watchLogPath(dir: string = resolveClanceyDir()): string {
  return path.join(dir, "watch.log");
}
