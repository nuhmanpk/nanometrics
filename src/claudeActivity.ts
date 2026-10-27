import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addUsage, DEFAULT_PRICING, emptyUsage, formatCost, formatTokens, PriceTable, TokenUsage, totalTokens, UsageTracker
} from './claudeUsage';

export interface ClaudeTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface ClaudeStep {
  tool: string;
  detail: string;
  time: number;
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
  // working: transcript written moments ago; idle: recent but quiet.
  state: 'working' | 'idle';
  updated: number;
  model: string;
  current: ClaudeStep | null;
  steps: ClaudeStep[];
  todos: ClaudeTodo[];
  toolCalls: number;
  filesTouched: number;
  // Whole-session totals, preformatted for display.
  tokens: string;
  tokenDetail: string;
  cost: string;
  // Subagents the session spawned, newest first. Their tokens and cost are included in the session totals.
  agents: ClaudeAgent[];
}

export interface ClaudeSnapshot {
  timestamp: number;
  sessions: ClaudeSession[];
}

// A session counts as live while its transcript changed this recently.
const WORKING_MS = 20_000;
const RECENT_MS = 30 * 60_000;
// Sessions untouched this long are not checked for running subagents.
const STALE_MS = 24 * 60 * 60_000;
const TAIL_BYTES = 1024 * 1024;
const MAX_STEPS = 8;

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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
  files: Set<string>;
  todos: ClaudeTodo[];
  title: string;
  lastPrompt: string;
  model: string;
  toolCalls: number;
}

function parse(text: string, mtime: number): Parsed {
  const steps: ClaudeStep[] = [];
  const files = new Set<string>();
  let todos: ClaudeTodo[] = [];
  let title = '';
  let model = '';
  let toolCalls = 0;
  let lastPrompt = '';

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
      for (const part of row.message.content) {
        if (part?.type !== 'tool_use') {
          continue;
        }
        toolCalls++;
        const input = part.input ?? {};
        if (part.name === 'TodoWrite' && Array.isArray(input.todos)) {
          todos = input.todos;
        }
        if (FILE_TOOLS.has(part.name)) {
          files.add(String(input.file_path ?? input.notebook_path ?? ''));
        }
        steps.push({ tool: part.name, detail: describe(part.name, input), time });
      }
    }
  }

  return { steps, files, todos, title, lastPrompt, model, toolCalls };
}

interface AgentFile {
  file: string;
  mtime: number;
  size: number;
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

async function readSession(name: string, folder: string, main: AgentFile, subs: AgentFile[], pricing: PriceTable): Promise<ClaudeSession> {
  const now = Date.now();
  const [text, tracker] = await Promise.all([readTail(main.file, main.size), readUsage(main.file, main.size, pricing)]);
  const own = parse(text, main.mtime);

  const usage = emptyUsage();
  addUsage(usage, tracker.usage);
  let cost = tracker.totalCost;
  let toolCalls = own.toolCalls;
  const files = new Set(own.files);
  const steps = [...own.steps];
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
      p.files.forEach(f => files.add(f));
      steps.push(...p.steps);
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

  const recent = steps.sort((a, b) => a.time - b.time).slice(-MAX_STEPS).reverse();
  return {
    id: name,
    folder,
    title: short(own.title || own.lastPrompt || 'Claude Code session', 70),
    state: now - updated < WORKING_MS ? 'working' : 'idle',
    updated,
    model: own.model.replace(/^claude-/, ''),
    current: recent[0] ?? null,
    steps: recent,
    todos: own.todos,
    toolCalls,
    filesTouched: files.size,
    tokens: formatTokens(totalTokens(usage)),
    tokenDetail: usageText({ usage }),
    cost: formatCost(cost),
    agents
  };
}

/** Reads Claude Code transcripts for the workspace folders and summarizes what each recent session is doing. */
export async function collectClaude(folders: string[], pricing: PriceTable = DEFAULT_PRICING): Promise<ClaudeSnapshot> {
  const sessions: ClaudeSession[] = [];
  const now = Date.now();

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
        if (st.size === 0 || now - st.mtimeMs > STALE_MS) {
          return null;
        }
        const main: AgentFile = { file, mtime: st.mtimeMs, size: st.size };
        const subs = await agentFiles(path.join(dir, n.replace(/\.jsonl$/, '')));
        // A parent waiting on background agents stays quiet, so its agents count towards how recent it is.
        const mtime = Math.max(main.mtime, ...subs.map(s => s.mtime));
        return { name: n, main, subs, mtime };
      } catch {
        return null;
      }
    }));
    const recent = stats
      .filter((s): s is NonNullable<typeof s> => !!s && now - s.mtime < RECENT_MS)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);
    for (const s of recent) {
      try {
        sessions.push(await readSession(s.name.replace(/\.jsonl$/, ''), path.basename(folder), s.main, s.subs, pricing));
      } catch {
        // Transcript rotated or unreadable.
      }
    }
  }

  sessions.sort((a, b) => b.updated - a.updated);
  return { timestamp: now, sessions };
}
