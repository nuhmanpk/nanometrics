export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** USD per million tokens: [input, output, cache read]. Cache read defaults to 0.1x input when left out. */
export type Price = [number, number] | [number, number, number];
export type PriceTable = Record<string, Price>;

// Anthropic API list prices, keyed by a substring of the model id. The first matching key wins, so specific ids
// come before family fallbacks. Override with the nanometrics.claudePricing setting.
export const DEFAULT_PRICING: PriceTable = {
  'fable-5-1': [10, 50, 0.25],
  'mythos-5-1': [10, 50, 0.25],
  fable: [10, 50],
  mythos: [10, 50],
  'opus-5-5': [4, 20, 0.2],
  'opus-4-1': [15, 75],
  'opus-4-2025': [15, 75],
  'sonnet-5-5': [2, 10, 0.1],
  'sonnet-5': [2, 10],
  'haiku-5-5': [0.1, 0.5],
  'haiku-4-5': [1, 5],
  '3-5-haiku': [0.8, 4],
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5]
};

// Prompt caching multipliers relative to the input price.
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

// Claude Haiku 5.5 bills a request whose prompt exceeds 100k tokens at 5x every rate.
const LONG_PROMPT = { key: 'haiku-5-5', threshold: 100_000, factor: 5 };

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Reads the `usage` object of a transcript message; returns null when there is none. */
export function parseUsage(raw: any): TokenUsage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const created = num(raw.cache_creation_input_tokens);
  const split = raw.cache_creation;
  const w5 = num(split?.ephemeral_5m_input_tokens);
  const w1 = num(split?.ephemeral_1h_input_tokens);
  const hasSplit = w5 + w1 > 0;
  return {
    input: num(raw.input_tokens),
    output: num(raw.output_tokens),
    cacheRead: num(raw.cache_read_input_tokens),
    // Older transcripts only carry the combined figure; treat it as 5 minute writes.
    cacheWrite5m: hasSplit ? w5 : created,
    cacheWrite1h: hasSplit ? w1 : 0
  };
}

export function addUsage(into: TokenUsage, u: TokenUsage, sign = 1): void {
  into.input += sign * u.input;
  into.output += sign * u.output;
  into.cacheRead += sign * u.cacheRead;
  into.cacheWrite5m += sign * u.cacheWrite5m;
  into.cacheWrite1h += sign * u.cacheWrite1h;
}

function match(model: string, table: PriceTable): [string, Price] | null {
  const id = model.toLowerCase();
  for (const [key, price] of Object.entries(table)) {
    if (id.includes(key.toLowerCase())) {
      return [key, price];
    }
  }
  return null;
}

export function priceFor(model: string, table: PriceTable = DEFAULT_PRICING): Price | null {
  return match(model, table)?.[1] ?? null;
}

/** Estimated USD cost of one message, or null when the model has no known price. */
export function costOf(u: TokenUsage, model: string, table: PriceTable = DEFAULT_PRICING): number | null {
  const found = match(model, table);
  if (!found) {
    return null;
  }
  const [key, [inPrice, outPrice, readPrice = inPrice * CACHE_READ]] = found;
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const factor = key === LONG_PROMPT.key && prompt > LONG_PROMPT.threshold ? LONG_PROMPT.factor : 1;
  return factor * (
    u.input * inPrice +
    u.output * outPrice +
    u.cacheRead * readPrice +
    u.cacheWrite5m * inPrice * CACHE_WRITE_5M +
    u.cacheWrite1h * inPrice * CACHE_WRITE_1H
  ) / 1_000_000;
}

/** Accepts only well formed overrides, so a bad setting can't break the dashboard. Overrides are matched first. */
export function sanitizePricing(raw: unknown): PriceTable {
  const overrides: PriceTable = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (
        Array.isArray(value) &&
        (value.length === 2 || value.length === 3) &&
        value.every(v => typeof v === 'number' && v >= 0)
      ) {
        overrides[key] = value as Price;
      }
    }
  }
  return { ...overrides, ...Object.fromEntries(Object.entries(DEFAULT_PRICING).filter(([k]) => !(k in overrides))) };
}

interface Counted {
  usage: TokenUsage;
  cost: number | null;
}

/**
 * Accumulates usage across a transcript as it grows. Claude Code writes one row per content block, all repeating
 * the same message id and usage, so each id is counted once and later rows replace earlier ones.
 */
export class UsageTracker {
  readonly usage = emptyUsage();
  cost: number | null = null;
  private seen = new Map<string, Counted>();
  private priced = false;

  constructor(private pricing: PriceTable = DEFAULT_PRICING) {}

  setPricing(pricing: PriceTable) {
    this.pricing = pricing;
  }

  ingest(row: any): void {
    const msg = row?.message;
    if (row?.type !== 'assistant' || !msg) {
      return;
    }
    const usage = parseUsage(msg.usage);
    if (!usage) {
      return;
    }
    const id: string = msg.id ?? row.uuid ?? '';
    const previous = id ? this.seen.get(id) : undefined;
    if (previous) {
      addUsage(this.usage, previous.usage, -1);
      if (previous.cost !== null) {
        this.cost = (this.cost ?? 0) - previous.cost;
      }
    }
    const cost = costOf(usage, String(msg.model ?? ''), this.pricing);
    addUsage(this.usage, usage);
    if (cost !== null) {
      this.cost = (this.cost ?? 0) + cost;
      this.priced = true;
    }
    if (id) {
      this.seen.set(id, { usage, cost });
    }
  }

  /** Total estimated cost, or null when no message had a known price. */
  get totalCost(): number | null {
    return this.priced && this.cost !== null ? Math.max(0, this.cost) : null;
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  }
  return String(Math.round(n));
}

export function formatCost(usd: number | null): string {
  if (usd === null) {
    return '—';
  }
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
