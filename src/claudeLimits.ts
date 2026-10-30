import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ClaudeLimit {
  key: string;
  label: string;
  percent: number;
  // Epoch ms, or 0 when unknown.
  resetsAt: number;
}

export interface ClaudeLimits {
  // When Claude Code last fetched the limits (epoch ms), 0 when never.
  updated: number;
  limits: ClaudeLimit[];
}

export const USAGE_URL = 'https://claude.ai/new#settings/usage';

const LABELS: Record<string, string> = {
  session: 'Current session',
  five_hour: 'Current session',
  weekly_all: 'Weekly',
  seven_day: 'Weekly',
  weekly_opus: 'Weekly · Opus',
  seven_day_opus: 'Weekly · Opus',
  weekly_sonnet: 'Weekly · Sonnet',
  seven_day_sonnet: 'Weekly · Sonnet'
};
// Older caches only carry the per-window objects, not the `limits` list.
const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

function labelOf(key: string): string {
  const text = key.replace(/_/g, ' ');
  return Object.prototype.hasOwnProperty.call(LABELS, key) ? LABELS[key] : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Claude Code keeps its global state, including the last /usage result, in ~/.claude.json. */
function configFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

let cache: { file: string; mtime: number; raw: any } | undefined;

async function readCached(): Promise<any> {
  const file = configFile();
  const st = await fs.stat(file);
  if (cache?.file !== file || cache.mtime !== st.mtimeMs) {
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    const usage = config?.cachedUsageUtilization;
    const account = config?.oauthAccount?.accountUuid;
    // Logged into a different account since the cache was written: those numbers aren't yours any more.
    const stale = account && usage?.accountUuid && account !== usage.accountUuid;
    cache = { file, mtime: st.mtimeMs, raw: stale ? null : usage };
  }
  return cache.raw;
}

/**
 * Plan limits as Claude Code last fetched them for /usage. Read from its local cache, so nothing is requested.
 * Windows past their reset time count as fresh.
 */
export async function readLimits(now = Date.now()): Promise<ClaudeLimits> {
  let usage: any;
  try {
    usage = await readCached();
  } catch {
    return { updated: 0, limits: [] };
  }
  const u = usage?.utilization;
  if (!u) {
    return { updated: 0, limits: [] };
  }
  const entries: { key: string; percent: unknown; resets: unknown }[] = Array.isArray(u.limits)
    ? u.limits.map((l: any) => ({ key: String(l?.kind ?? ''), percent: l?.percent, resets: l?.resets_at }))
    : WINDOWS.filter(k => u[k]).map(k => ({ key: k, percent: u[k].utilization, resets: u[k].resets_at }));

  const limits: ClaudeLimit[] = [];
  for (const e of entries) {
    const percent = Number(e.percent);
    if (!e.key || e.percent === null || !Number.isFinite(percent)) {
      continue;
    }
    const resetsAt = typeof e.resets === 'string' ? Date.parse(e.resets) || 0 : Number(e.resets) > 0 ? Number(e.resets) * 1000 : 0;
    const reset = resetsAt > 0 && resetsAt <= now;
    limits.push({ key: e.key, label: labelOf(e.key), percent: reset ? 0 : Math.max(0, percent), resetsAt: reset ? 0 : resetsAt });
  }
  return { updated: Number(usage.fetchedAtMs) || 0, limits };
}
