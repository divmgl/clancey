import { getMeta, setMeta, type Store } from "./store.js";

const REGISTRY_URL = "https://registry.npmjs.org/clancey/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

/** True when `latest` is a higher semver than `current` (numeric major.minor.patch). */
export function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function fetchLatest(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * A user-facing notice when a newer Clancey is published, else null. The registry check
 * is throttled to once a day via the `meta` table, runs only on SessionStart (never the
 * per-tool path), and never throws. Setup pins each install to a version, so this is the
 * only thing that tells a user a newer one exists.
 */
export async function upgradeNotice(
  db: Store,
  current: string,
  now: number = Date.now(),
  fetcher: () => Promise<string | null> = fetchLatest,
): Promise<string | null> {
  try {
    const lastCheck = Number(getMeta(db, "upgrade_last_check") ?? 0);
    let latest = getMeta(db, "upgrade_latest") ?? null;

    if (now - lastCheck > CHECK_INTERVAL_MS) {
      setMeta(db, "upgrade_last_check", String(now));
      const fetched = await fetcher();
      if (fetched) {
        latest = fetched;
        setMeta(db, "upgrade_latest", fetched);
      }
    }

    if (latest && isNewer(latest, current)) {
      return `Clancey ${latest} is available (you're on ${current}). Run: npx -y clancey setup`;
    }
    return null;
  } catch {
    return null;
  }
}
