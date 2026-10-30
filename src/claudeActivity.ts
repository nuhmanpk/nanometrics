import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addUsage, dayOf, DEFAULT_PRICING, emptyUsage, formatCost, formatTokens, parseUsage, PriceTable, TokenUsage, totalTokens,
  UsageBucket, UsageTracker
} from './claudeUsage';
import type { ClaudeLimits } from './claudeLimits';

export interface ClaudeTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export type ToolCategory = 'read' | 'edit' | 'run' | 'web' | 'agent' | 'other';

export interface ClaudeStep {
  tool: string;
  detail: string;
  time: number;
  cat: ToolCategory;
}

export interface ClaudeFile {
  path: string;
  name: string;
  edits: number;
}

export interface ClaudeResearch {
  kind: 'search' | 'fetch';
  text: string;
  url: string;
  time: number;
}

export interface ClaudeError {
  tool: string;
  message: string;
  time: number;
}

export interface ClaudeModelUsage {
  model: string;
  tokens: string;
  cost: string;
  share: number;
}

export interface ClaudePastSession {
  id: string;
  // Full workspace folder path, where `claude --resume` has to run.
  cwd: string;
  title: string;
  updated: number;
  tokens: string;
  cost: string;
}

export interface ClaudeDay {
  day: string;
  label: string;
  tokens: number;
  cost: number;
}

export interface ClaudeContext {
  used: number;
  limit: number;
  percent: number;
  text: string;
}

export interface ClaudeAgent {
  id: string;
  description: string;
  type: string;
  state: 'working' | 'done';
  updated: number;
  toolCalls: number;
  tokens: string;
  cost: string;
}

export interface ClaudeSession {
  id: string;
  folder: string;
  title: string;
  // working: transcript written moments ago; waiting: quiet with a reply or tool call outstanding; idle: recent but quiet.
  state: 'working' | 'waiting' | 'idle';
  // While waiting: 'you' when Claude ended its turn, otherwise the tool it is blocked on (permission or a long run).
  waitingOn: string;
  updated: number;
  started: number;
  model: string;
  prompt: string;
  current: ClaudeStep | null;
  steps: ClaudeStep[];
  todos: ClaudeTodo[];
  toolCalls: number;
  failedCalls: number;
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
  hotFiles: ClaudeFile[];
  // Tool calls per category, and per minute over the last TIMELINE_MIN minutes (oldest first).
  toolMix: Record<ToolCategory, number>;
  timeline: Record<ToolCategory, number>[];
  context: ClaudeContext | null;
  // Web searches and fetched pages, and failed tool calls, newest first.
  research: ClaudeResearch[];
  errors: ClaudeError[];
  models: ClaudeModelUsage[];
  // Share of prompt tokens served from cache, and what that saved; null before any request.
  cacheHit: number | null;
  cacheSaved: string;
  // Whole-session totals, preformatted for display.
  tokens: string;
  tokenDetail: string;
  cost: string;
  costUsd: number | null;
  burnRate: string;
  // Subagents the session spawned, newest first. Their tokens and cost are included in the session totals.
  agents: ClaudeAgent[];
}

export interface ClaudeSnapshot {
  timestamp: number;
  sessions: ClaudeSession[];
  // Older sessions from the last week, newest first, and spend per day for the last seven days (oldest first).
  history: ClaudePastSession[];
  week: ClaudeDay[];
  today: { tokens: string; cost: string; sessions: number };
  // Tokens per minute across the workspace over the last hour, oldest first.
  tokenRate: number[];
  // Plan limits, filled in by the dashboard.
  limits?: ClaudeLimits;
}

// A session counts as live while its transcript changed this recently.
const WORKING_MS = 20_000;
const RECENT_MS = 30 * 60_000;
// Sessions untouched this long are left out of the history and the week chart.
const WEEK_MS = 7 * 24 * 60 * 60_000;
const MAX_HISTORY = 10;
const MAX_RESEARCH = 12;
const MAX_ERRORS = 5;
const RATE_MIN = 60;
const TAIL_BYTES = 1024 * 1024;
const MAX_STEPS = 8;
const MAX_HOT_FILES = 5;
const TIMELINE_MIN = 30;
// Burn rate is noise until the session has run a little while.
const BURN_MIN_MS = 5 * 60_000;
const CONTEXT_WINDOW = 200_000;
const CONTEXT_WINDOW_LARGE = 1_000_000;
// Models with a 1M token context window, matched as substrings of the model id. Older models have 200k.
const LARGE_CONTEXT = [
  'fable', 'mythos', 'opus-5', 'opus-4-8', 'opus-4-7', 'opus-4-6', 'sonnet-5', 'sonnet-4-6', 'haiku-5'
];

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);

const CATEGORIES: Record<string, ToolCategory> = {
  Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', NotebookRead: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'run', BashOutput: 'run', KillShell: 'run', KillBash: 'run', Monitor: 'run',
  WebFetch: 'web', WebSearch: 'web',
  Task: 'agent', Agent: 'agent', Workflow: 'agent'
};

export function categoryOf(tool: string): ToolCategory {
  // Own keys only: a tool named e.g. "constructor" must not resolve to Object.prototype.
  return Object.prototype.hasOwnProperty.call(CATEGORIES, tool) ? CATEGORIES[tool] : tool.startsWith('mcp__') ? 'web' : 'other';
}

const emptyMix = (): Record<ToolCategory, number> => ({ read: 0, edit: 0, run: 0, web: 0, agent: 0, other: 0 });

function lineCount(s: unknown): number {
  const text = typeof s === 'string' ? s : '';
  return text ? text.split('\n').length : 0;
}

/** Lines an edit adds and removes, counted as whole replaced blocks. Write can't know what it overwrote. */
function lineDelta(tool: string, input: any): [number, number] {
  switch (tool) {
    case 'Edit':
      return [lineCount(input?.new_string), lineCount(input?.old_string)];
    case 'MultiEdit':
      return (Array.isArray(input?.edits) ? input.edits : []).reduce(
        (acc: [number, number], e: any) => [acc[0] + lineCount(e?.new_string), acc[1] + lineCount(e?.old_string)], [0, 0]);
    case 'Write':
      return [lineCount(input?.content), 0];
    case 'NotebookEdit':
      return [lineCount(input?.new_source), 0];
    default:
      return [0, 0];
  }
}

function projectDir(folder: string): string {
  // Claude Code stores transcripts under the folder path with every non-alphanumeric character as '-'.
  return path.join(os.homedir(), '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));
}

function short(s: unknown, max = 90): string {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function base(p: unknown): string {
  return p ? path.basename(String(p)) : '';
}

function describe(tool: string, input: any): string {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return base(input?.file_path);
    case 'NotebookEdit':
      return base(input?.notebook_path);
    case 'Bash':
      return short(input?.description || input?.command);
    case 'Grep':
    case 'Glob':
      return short(input?.pattern);
    case 'Task':
    case 'Agent':
      return short(input?.description || input?.prompt);
    case 'WebFetch':
      return short(input?.url);
    case 'WebSearch':
      return short(input?.query);
    case 'TodoWrite':
      return 'Updating plan';
    default:
      return short(input?.description || input?.file_path || input?.path || input?.query || '');
  }
}

async function readTail(file: string, size: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    const text = buf.toString('utf8');
    // The first line is probably cut in half.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

interface FileUsage {
  offset: number;
  tracker: UsageTracker;
}

// Usage has to cover the whole transcript, not just the tail, so each file is read once and then only its new bytes.
const usageCache = new Map<string, FileUsage>();
const CHUNK_BYTES = 4 * 1024 * 1024;

async function readUsage(file: string, size: number, pricing: PriceTable): Promise<UsageTracker> {
  let entry = usageCache.get(file);
  if (!entry || size < entry.offset) {
    entry = { offset: 0, tracker: new UsageTracker(pricing) };
    usageCache.set(file, entry);
  }
  entry.tracker.setPricing(pricing);
  if (size === entry.offset) {
    return entry.tracker;
  }
  const handle = await fs.open(file, 'r');
  try {
    let carry: Buffer = Buffer.alloc(0);
    let pos = entry.offset;
    while (pos < size) {
      const length = Math.min(CHUNK_BYTES, size - pos);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, pos);
      if (bytesRead === 0) {
        break;
      }
      pos += bytesRead;
      const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      const end = data.lastIndexOf(0x0a);
      carry = end === -1 ? data : data.subarray(end + 1);
      if (end === -1) {
        continue;
      }
      for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"usage"')) {
          continue;
        }
        try {
          entry.tracker.ingest(JSON.parse(line));
        } catch {
          // Partial or corrupt line.
        }
      }
    }
    // An unfinished last line is re-read next time.
    entry.offset = pos - carry.length;
  } finally {
    await handle.close();
  }
  return entry.tracker;
}

interface Parsed {
  steps: ClaudeStep[];
  files: Map<string, number>;
  todos: ClaudeTodo[];
  title: string;
  lastPrompt: string;
  model: string;
  toolCalls: number;
  failed: number;
  added: number;
  removed: number;
  first: number;
  // Prompt size of the latest request: everything the model had in context.
  context: number;
  // Tool calls still without a result, oldest first, and whether the last thing written was Claude's reply.
  pending: string[];
  replied: boolean;
  research: ClaudeResearch[];
  errors: ClaudeError[];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content) ? content.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text ?? '')).join(' ') : '';
}

function promptText(content: unknown): string {
  const parts = typeof content === 'string' ? [content] :
    Array.isArray(content) ? content.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text ?? '')) : [];
  // Slash command echoes, hook output and reminders are wrapped in tags; they aren't something the user typed.
  return parts.map(t => t.trim()).filter(t => t && !t.startsWith('<') && !t.startsWith('[Request interrupted')).join(' ');
}

function parse(text: string, mtime: number): Parsed {
  const steps: ClaudeStep[] = [];
  const files = new Map<string, number>();
  const pending = new Map<string, string>();
  const names = new Map<string, string>();
  const research: ClaudeResearch[] = [];
  const errors: ClaudeError[] = [];
  let todos: ClaudeTodo[] = [];
  let title = '';
  let model = '';
  let toolCalls = 0;
  let lastPrompt = '';
  let failed = 0;
  let added = 0;
  let removed = 0;
  let first = 0;
  let context = 0;
  let replied = false;

  for (const line of text.split('\n')) {
    if (!line) {
      continue;
    }
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === 'ai-title' && row.aiTitle) {
      title = row.aiTitle;
    } else if (row.type === 'last-prompt' && row.lastPrompt) {
      lastPrompt = row.lastPrompt;
    } else if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      model = row.message.model || model;
      const time = Date.parse(row.timestamp) || mtime;
      first ||= time;
      const u = parseUsage(row.message.usage);
      if (u) {
        context = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
      }
      for (const part of row.message.content) {
        if (part?.type === 'text' && String(part.text ?? '').trim()) {
          replied = true;
        }
        if (part?.type !== 'tool_use') {
          continue;
        }
        replied = false;
        toolCalls++;
        const input = part.input ?? {};
        if (part.id) {
          pending.set(part.id, part.name);
          names.set(part.id, part.name);
        }
        if (part.name === 'WebSearch' && input.query) {
          research.push({ kind: 'search', text: short(input.query, 120), url: '', time });
        } else if (part.name === 'WebFetch' && /^https?:\/\//.test(String(input.url ?? ''))) {
          research.push({ kind: 'fetch', text: short(String(input.url).replace(/^https?:\/\/(www\.)?/, ''), 120), url: String(input.url), time });
        }
        if (part.name === 'TodoWrite' && Array.isArray(input.todos)) {
          todos = input.todos;
        }
        if (FILE_TOOLS.has(part.name)) {
          const file = String(input.file_path ?? input.notebook_path ?? '');
          files.set(file, (files.get(file) ?? 0) + 1);
          const [a, r] = lineDelta(part.name, input);
          added += a;
          removed += r;
        }
        steps.push({ tool: part.name, detail: describe(part.name, input), time, cat: categoryOf(part.name) });
      }
    } else if (row.type === 'user' && !row.isMeta) {
      const time = Date.parse(row.timestamp) || 0;
      first ||= time;
      const content = row.message?.content;
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type === 'tool_result') {
          pending.delete(part.tool_use_id);
          if (part.is_error) {
            failed++;
            errors.push({ tool: names.get(part.tool_use_id) ?? 'Tool', message: short(resultText(part.content), 160), time: time || mtime });
          }
        }
      }
      const typed = promptText(content);
      if (typed) {
        lastPrompt = typed;
      }
      replied = false;
    }
  }

  return {
    steps, files, todos, title, lastPrompt, model, toolCalls, failed, added, removed, first, context,
    pending: [...pending.values()], replied, research, errors
  };
}

interface AgentFile {
  file: string;
  mtime: number;
  size: number;
  // Creation time where the file system records it, else 0.
  born?: number;
}

/** Subagent transcripts live under <session>/subagents, workflow agents one level deeper per run. */
async function agentFiles(dir: string): Promise<AgentFile[]> {
  const out: AgentFile[] = [];
  const walk = async (d: string, depth: number) => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async e => {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) {
        await walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = await fs.stat(p);
          if (st.size > 0) {
            out.push({ file: p, mtime: st.mtimeMs, size: st.size });
          }
        } catch {
          // Removed while listing.
        }
      }
    }));
  };
  await walk(path.join(dir, 'subagents'), 0);
  return out;
}

async function readMeta(file: string): Promise<{ description?: string; agentType?: string }> {
  try {
    return JSON.parse(await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

function usageText(tracker: { usage: TokenUsage }) {
  const u = tracker.usage;
  return `Input ${formatTokens(u.input)} · Output ${formatTokens(u.output)} · ` +
    `Cache read ${formatTokens(u.cacheRead)} · Cache write ${formatTokens(u.cacheWrite5m + u.cacheWrite1h)}`;
}

/** The context window is a property of the model that served the latest request, not of the chat. */
export function contextWindow(model: string): number {
  const id = model.toLowerCase();
  return LARGE_CONTEXT.some(k => id.includes(k)) || id.includes('[1m]') ? CONTEXT_WINDOW_LARGE : CONTEXT_WINDOW;
}

function contextOf(used: number, model: string): ClaudeContext | null {
  if (!used) {
    return null;
  }
  // An unknown model past the standard window must have the large one.
  const limit = Math.max(contextWindow(model), used > CONTEXT_WINDOW ? CONTEXT_WINDOW_LARGE : 0);
  return { used, limit, percent: Math.min(100, (used / limit) * 100), text: `${formatTokens(used)} of ${formatTokens(limit)}` };
}

function timelineOf(steps: ClaudeStep[], now: number): Record<ToolCategory, number>[] {
  const buckets = Array.from({ length: TIMELINE_MIN }, emptyMix);
  for (const s of steps) {
    const age = Math.floor((now - s.time) / 60_000);
    if (age >= 0 && age < TIMELINE_MIN) {
      buckets[TIMELINE_MIN - 1 - age][s.cat]++;
    }
  }
  return buckets;
}

async function readSession(name: string, folder: string, main: AgentFile, subs: AgentFile[], pricing: PriceTable): Promise<ClaudeSession> {
  const now = Date.now();
  const [text, tracker] = await Promise.all([readTail(main.file, main.size), readUsage(main.file, main.size, pricing)]);
  const own = parse(text, main.mtime);

  const usage = emptyUsage();
  addUsage(usage, tracker.usage);
  let cost = tracker.totalCost;
  let toolCalls = own.toolCalls;
  let failedCalls = own.failed;
  let linesAdded = own.added;
  let linesRemoved = own.removed;
  const files = new Map(own.files);
  const steps = [...own.steps];
  const research = [...own.research];
  const errors = [...own.errors];
  const models = new Map<string, UsageBucket>();
  const addModels = (t: UsageTracker) => t.byModel.forEach((b, m) => {
    const into = models.get(m) ?? { tokens: 0, cost: 0 };
    into.tokens += b.tokens;
    into.cost += b.cost;
    models.set(m, into);
  });
  addModels(tracker);
  let saved = tracker.saved;
  let updated = main.mtime;

  const agents: ClaudeAgent[] = [];
  for (const sub of subs) {
    try {
      const [subText, subTracker, meta] = await Promise.all([
        readTail(sub.file, sub.size), readUsage(sub.file, sub.size, pricing), readMeta(sub.file)
      ]);
      const p = parse(subText, sub.mtime);
      addUsage(usage, subTracker.usage);
      if (subTracker.totalCost !== null) {
        cost = (cost ?? 0) + subTracker.totalCost;
      }
      toolCalls += p.toolCalls;
      failedCalls += p.failed;
      linesAdded += p.added;
      linesRemoved += p.removed;
      p.files.forEach((n, f) => files.set(f, (files.get(f) ?? 0) + n));
      steps.push(...p.steps);
      research.push(...p.research);
      errors.push(...p.errors);
      addModels(subTracker);
      saved += subTracker.saved;
      updated = Math.max(updated, sub.mtime);
      agents.push({
        id: path.basename(sub.file, '.jsonl'),
        description: short(meta.description || p.title || 'Subagent', 60),
        type: meta.agentType ?? '',
        state: now - sub.mtime < WORKING_MS ? 'working' : 'done',
        updated: sub.mtime,
        toolCalls: p.toolCalls,
        tokens: formatTokens(totalTokens(subTracker.usage)),
        cost: formatCost(subTracker.totalCost)
      });
    } catch {
      // Transcript rotated or unreadable.
    }
  }
  agents.sort((a, b) => b.updated - a.updated);

  const toolMix = emptyMix();
  steps.forEach(s => toolMix[s.cat]++);
  const timeline = timelineOf(steps, now);
  const recent = steps.sort((a, b) => a.time - b.time).slice(-MAX_STEPS).reverse();

  const hotFiles = [...files]
    .filter(([f]) => f)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_HOT_FILES)
    .map(([f, edits]) => ({ path: f, name: base(f), edits }));

  // An agent call stays open while the agent runs, so only other tools count as blocking.
  const blocking = own.pending.filter(t => !AGENT_TOOLS.has(t));
  const quiet = now - updated >= WORKING_MS;
  const waitingOn = !quiet ? '' : blocking.length ? blocking[blocking.length - 1] : own.replied ? 'you' : '';

  const started = Math.min(...[main.born, own.first, updated].filter((t): t is number => !!t && t > 0));
  const elapsed = updated - started;
  const prompted = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  const modelTokens = [...models.values()].reduce((n, b) => n + b.tokens, 0);
  const newest = <T extends { time: number }>(list: T[], max: number) => list.sort((a, b) => b.time - a.time).slice(0, max);

  const burnRate = cost !== null && elapsed >= BURN_MIN_MS ? `${formatCost(cost / (elapsed / 3_600_000))}/hr` : '—';

  return {
    id: name,
    folder,
    title: short(own.title || own.lastPrompt || 'Claude Code session', 70),
    state: !quiet ? 'working' : waitingOn ? 'waiting' : 'idle',
    waitingOn,
    updated,
    started,
    model: own.model.replace(/^claude-/, ''),
    prompt: short(own.lastPrompt, 160),
    current: recent[0] ?? null,
    steps: recent,
    todos: own.todos,
    toolCalls,
    failedCalls,
    filesTouched: [...files.keys()].filter(Boolean).length,
    linesAdded,
    linesRemoved,
    hotFiles,
    toolMix,
    timeline,
    context: contextOf(own.context, own.model),
    research: newest(research, MAX_RESEARCH),
    errors: newest(errors, MAX_ERRORS),
    models: [...models]
      .filter(([m, b]) => m && m !== '<synthetic>' && b.tokens > 0)
      .sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
      .map(([m, b]) => ({
        model: m.replace(/^claude-/, ''),
        tokens: formatTokens(b.tokens),
        cost: formatCost(b.cost),
        share: modelTokens ? (b.tokens / modelTokens) * 100 : 0
      })),
    cacheHit: prompted ? (usage.cacheRead / prompted) * 100 : null,
    cacheSaved: formatCost(saved),
    tokens: formatTokens(totalTokens(usage)),
    tokenDetail: usageText({ usage }),
    cost: formatCost(cost),
    costUsd: cost,
    burnRate,
    agents
  };
}

// Titles of past sessions, kept until their transcript changes.
const titleCache = new Map<string, { mtime: number; title: string }>();

async function titleOf(file: AgentFile): Promise<string> {
  const hit = titleCache.get(file.file);
  if (hit?.mtime === file.mtime) {
    return hit.title;
  }
  const p = parse(await readTail(file.file, file.size), file.mtime);
  const title = short(p.title || p.lastPrompt || 'Claude Code session', 70);
  titleCache.set(file.file, { mtime: file.mtime, title });
  return title;
}

function lastDays(n: number, now: number): ClaudeDay[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (n - 1 - i));
    const day = dayOf(d.toISOString());
    return { day, label: i === n - 1 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }), tokens: 0, cost: 0 };
  });
}

/** Reads Claude Code transcripts for the workspace folders and summarizes what each recent session is doing. */
export async function collectClaude(folders: string[], pricing: PriceTable = DEFAULT_PRICING): Promise<ClaudeSnapshot> {
  const sessions: ClaudeSession[] = [];
  const history: ClaudePastSession[] = [];
  const now = Date.now();
  const week = lastDays(7, now);
  const byDay = new Map(week.map(d => [d.day, d]));
  const today = week[week.length - 1].day;
  let todaySessions = 0;
  const tokenRate = new Array<number>(RATE_MIN).fill(0);

  for (const folder of folders) {
    const dir = projectDir(folder);
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter(n => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const stats = await Promise.all(names.map(async n => {
      try {
        const file = path.join(dir, n);
        const st = await fs.stat(file);
        if (st.size === 0 || now - st.mtimeMs > WEEK_MS) {
          return null;
        }
        const main: AgentFile = { file, mtime: st.mtimeMs, size: st.size, born: st.birthtimeMs };
        const subs = await agentFiles(path.join(dir, n.replace(/\.jsonl$/, '')));
        // A parent waiting on background agents stays quiet, so its agents count towards how recent it is.
        const mtime = Math.max(main.mtime, ...subs.map(s => s.mtime));
        return { name: n, main, subs, mtime };
      } catch {
        return null;
      }
    }));
    const all = stats.filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => b.mtime - a.mtime);
    const live = all.filter(s => now - s.mtime < RECENT_MS).slice(0, 3);

    for (const s of all) {
      try {
        const trackers = await Promise.all([s.main, ...s.subs].map(f => readUsage(f.file, f.size, pricing)));
        let usedToday = false;
        let tokens = 0;
        let cost: number | null = null;
        for (const t of trackers) {
          t.byDay.forEach((b, day) => {
            const d = byDay.get(day);
            if (d) {
              d.tokens += b.tokens;
              d.cost += b.cost;
            }
            usedToday ||= day === today && b.tokens > 0;
          });
          tokens += totalTokens(t.usage);
          if (t.totalCost !== null) {
            cost = (cost ?? 0) + t.totalCost;
          }
        }
        if (usedToday) {
          todaySessions++;
        }
        if (now - s.mtime < RATE_MIN * 60_000) {
          trackers.forEach(tr => tr.addPerMinute(tokenRate, now));
        }
        if (live.includes(s)) {
          sessions.push(await readSession(s.name.replace(/\.jsonl$/, ''), path.basename(folder), s.main, s.subs, pricing));
        } else if (history.length < MAX_HISTORY * folders.length) {
          history.push({
            id: s.name.replace(/\.jsonl$/, ''),
            cwd: folder,
            title: await titleOf(s.main),
            updated: s.mtime,
            tokens: formatTokens(tokens),
            cost: formatCost(cost)
          });
        }
      } catch {
        // Transcript rotated or unreadable.
      }
    }
  }

  sessions.sort((a, b) => b.updated - a.updated);
  history.sort((a, b) => b.updated - a.updated);
  const t = week[week.length - 1];
  return {
    timestamp: now,
    sessions,
    history: history.slice(0, MAX_HISTORY),
    week,
    today: { tokens: formatTokens(t.tokens), cost: formatCost(t.cost), sessions: todaySessions },
    tokenRate
  };
}
