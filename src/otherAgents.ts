import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { costOf, DEFAULT_PRICING, emptyUsage, formatCost, formatTokens, PriceTable, totalTokens, TokenUsage } from './claudeUsage';

export type AgentKind = 'codex' | 'gemini';

export interface OtherAgentSession {
  agent: AgentKind;
  id: string;
  title: string;
  model: string;
  updated: number;
  tokens: number;
  tokensText: string;
  cost: number | null;
  costText: string;
  // True when the transcript was written in the last couple of minutes.
  live: boolean;
}

export interface OtherAgentSummary {
  agent: AgentKind;
  label: string;
  sessions: OtherAgentSession[];
  today: { tokens: number; tokensText: string; cost: number; costText: string; sessions: number };
}

const LIVE_MS = 2 * 60_000;
const MAX_FILES = 40;
const MAX_BYTES = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function walk(dir: string, match: (name: string) => boolean, depth: number, out: { file: string; mtime: number }[]) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) {
      await walk(full, match, depth - 1, out);
    } else if (e.isFile() && match(e.name)) {
      try {
        out.push({ file: full, mtime: (await fs.stat(full)).mtimeMs });
      } catch {
        // rotated
      }
    }
  }
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Pulls a short title out of a user prompt. */
function titleOf(text: unknown): string {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return t.length > 70 ? `${t.slice(0, 69)}…` : t;
}

export interface Parsed {
  title: string;
  model: string;
  cwd: string;
  usage: TokenUsage;
}

/**
 * Codex CLI rollout (JSONL). Token events carry running totals, so the last `total_token_usage` wins.
 * Codex's input_tokens already include cached tokens, so cached is split out to price it separately.
 */
export function parseCodex(text: string): Parsed {
  const out: Parsed = { title: '', model: '', cwd: '', usage: emptyUsage() };
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const p = row?.payload;
    if (!p || typeof p !== 'object') {
      continue;
    }
    if (row.type === 'session_meta' && typeof p.cwd === 'string') {
      out.cwd = p.cwd;
    }
    if (row.type === 'turn_context') {
      out.model = typeof p.model === 'string' ? p.model : out.model;
      out.cwd = typeof p.cwd === 'string' ? p.cwd : out.cwd;
    }
    if (row.type === 'event_msg' && p.type === 'user_message' && !out.title) {
      out.title = titleOf(p.message);
    }
    if (row.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const t = p.info.total_token_usage;
      const cached = Math.min(n(t.cached_input_tokens), n(t.input_tokens));
      out.usage = {
        input: n(t.input_tokens) - cached,
        // Reasoning tokens are billed as output and reported inside it.
        output: n(t.output_tokens),
        cacheRead: cached,
        cacheWrite5m: 0,
        cacheWrite1h: 0
      };
    }
  }
  return out;
}

/** Gemini CLI chat file (one JSON document). Each gemini message carries its own token counts. */
export function parseGemini(text: string): Parsed {
  const out: Parsed = { title: '', model: '', cwd: '', usage: emptyUsage() };
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  for (const m of Array.isArray(doc?.messages) ? doc.messages : []) {
    if (m?.type === 'user' && !out.title) {
      const c = Array.isArray(m.content) ? m.content.map((x: any) => x?.text ?? '').join(' ') : m.content;
      out.title = titleOf(c);
    }
    const t = m?.tokens;
    if (m?.type === 'gemini' && t) {
      const cached = n(t.cached);
      out.model = typeof m.model === 'string' ? m.model : out.model;
      out.usage.input += Math.max(0, n(t.input) - cached);
      out.usage.cacheRead += cached;
      // Thinking and tool tokens are billed as output.
      out.usage.output += n(t.output) + n(t.thoughts) + n(t.tool);
    }
  }
  return out;
}

// Parsed files are kept until they change, and a whole scan is reused for a few seconds, so the refresh loop stays cheap.
const parsedCache = new Map<string, { size: number; mtime: number; parsed: Parsed }>();
const SCAN_TTL = 10_000;
let scanCache: { key: string; at: number; value: Promise<OtherAgentSummary[]> } | undefined;

async function parseCached(file: string, mtime: number, parse: (text: string) => Parsed): Promise<Parsed> {
  const size = (await fs.stat(file)).size;
  const hit = parsedCache.get(file);
  if (hit && hit.size === size && hit.mtime === mtime) {
    return hit.parsed;
  }
  const parsed = parse(await readCapped(file));
  parsedCache.set(file, { size, mtime, parsed });
  return parsed;
}

async function readCapped(file: string): Promise<string> {
  const st = await fs.stat(file);
  if (st.size > MAX_BYTES) {
    return '';
  }
  return fs.readFile(file, 'utf8');
}

function summarize(agent: AgentKind, label: string, sessions: OtherAgentSession[], sinceToday: number): OtherAgentSummary {
  const todays = sessions.filter(s => s.updated >= sinceToday);
  const tokens = todays.reduce((a, s) => a + s.tokens, 0);
  const cost = todays.reduce((a, s) => a + (s.cost ?? 0), 0);
  return {
    agent,
    label,
    sessions,
    today: { tokens, tokensText: formatTokens(tokens), cost, costText: formatCost(cost), sessions: todays.length }
  };
}

function build(agent: AgentKind, id: string, mtime: number, p: Parsed, pricing: PriceTable, now: number): OtherAgentSession {
  const cost = p.model ? costOf(p.usage, p.model, pricing) : null;
  const tokens = totalTokens(p.usage);
  return {
    agent, id, title: p.title || 'Untitled session', model: p.model, updated: mtime, tokens, tokensText: formatTokens(tokens),
    cost, costText: formatCost(cost), live: now - mtime < LIVE_MS
  };
}

const inside = (cwd: string, folders: string[]) => !cwd || folders.some(f => cwd === f || cwd.startsWith(f + path.sep));

/** Codex CLI sessions for these folders from the last week: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
export async function collectCodex(folders: string[], pricing: PriceTable = DEFAULT_PRICING, home = os.homedir(), now = Date.now()): Promise<OtherAgentSummary | null> {
  const files: { file: string; mtime: number }[] = [];
  await walk(path.join(home, '.codex', 'sessions'), nm => nm.endsWith('.jsonl'), 4, files);
  if (!files.length) {
    return null;
  }
  const recent = files.filter(f => now - f.mtime < 7 * DAY_MS).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
  const sessions: OtherAgentSession[] = [];
  for (const f of recent) {
    try {
      const p = await parseCached(f.file, f.mtime, parseCodex);
      if (inside(p.cwd, folders)) {
        sessions.push(build('codex', path.basename(f.file, '.jsonl'), f.mtime, p, pricing, now));
      }
    } catch {
      // unreadable
    }
  }
  return summarize('codex', 'Codex CLI', sessions, startOfToday());
}

/** Gemini CLI chats: ~/.gemini/tmp/<project hash>/chats/session-*.json. Chats don't record a cwd, so all recent ones show. */
export async function collectGemini(pricing: PriceTable = DEFAULT_PRICING, home = os.homedir(), now = Date.now()): Promise<OtherAgentSummary | null> {
  const files: { file: string; mtime: number }[] = [];
  await walk(path.join(home, '.gemini', 'tmp'), nm => nm.startsWith('session-') && nm.endsWith('.json'), 3, files);
  if (!files.length) {
    return null;
  }
  const recent = files.filter(f => now - f.mtime < 7 * DAY_MS).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
  const sessions: OtherAgentSession[] = [];
  for (const f of recent) {
    try {
      sessions.push(build('gemini', path.basename(f.file, '.json'), f.mtime, await parseCached(f.file, f.mtime, parseGemini), pricing, now));
    } catch {
      // unreadable
    }
  }
  return summarize('gemini', 'Gemini CLI', sessions, startOfToday());
}

export function collectOtherAgents(folders: string[], pricing: PriceTable = DEFAULT_PRICING): Promise<OtherAgentSummary[]> {
  const key = folders.join('|') + JSON.stringify(pricing);
  if (!scanCache || scanCache.key !== key || Date.now() - scanCache.at > SCAN_TTL) {
    scanCache = {
      key,
      at: Date.now(),
      value: Promise.all([collectCodex(folders, pricing), collectGemini(pricing)])
        .then(found => found.filter((x): x is OtherAgentSummary => !!x && x.sessions.length > 0))
    };
  }
  return scanCache.value;
}
