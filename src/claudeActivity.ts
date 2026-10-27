import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_PRICING, formatCost, formatTokens, PriceTable, totalTokens, UsageTracker } from './claudeUsage';

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
}

export interface ClaudeSnapshot {
  timestamp: number;
  sessions: ClaudeSession[];
}

// A session counts as live while its transcript changed this recently.
const WORKING_MS = 20_000;
const RECENT_MS = 30 * 60_000;
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

function parse(text: string, id: string, folder: string, mtime: number, tracker: UsageTracker): ClaudeSession {
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

  const recent = steps.slice(-MAX_STEPS).reverse();
  const working = Date.now() - mtime < WORKING_MS;
  return {
    id,
    folder,
    title: short(title || lastPrompt || 'Claude Code session', 70),
    state: working ? 'working' : 'idle',
    updated: mtime,
    model: model.replace(/^claude-/, ''),
    current: recent[0] ?? null,
    steps: recent,
    todos,
    toolCalls,
    filesTouched: files.size,
    tokens: formatTokens(totalTokens(tracker.usage)),
    tokenDetail: `Input ${formatTokens(tracker.usage.input)} · Output ${formatTokens(tracker.usage.output)} · ` +
      `Cache read ${formatTokens(tracker.usage.cacheRead)} · Cache write ${formatTokens(tracker.usage.cacheWrite5m + tracker.usage.cacheWrite1h)}`,
    cost: formatCost(tracker.totalCost)
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
        const st = await fs.stat(path.join(dir, n));
        return { name: n, mtime: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    }));
    const recent = stats
      .filter((s): s is NonNullable<typeof s> => !!s && now - s.mtime < RECENT_MS && s.size > 0)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);
    for (const s of recent) {
      try {
        const file = path.join(dir, s.name);
        const [text, tracker] = await Promise.all([readTail(file, s.size), readUsage(file, s.size, pricing)]);
        sessions.push(parse(text, s.name.replace(/\.jsonl$/, ''), path.basename(folder), s.mtime, tracker));
      } catch {
        // Transcript rotated or unreadable.
      }
    }
  }

  sessions.sort((a, b) => b.updated - a.updated);
  return { timestamp: now, sessions };
}
