import * as assert from 'assert';
import {
    cacheSavingsOf, costOf, dayOf, formatCost, formatTokens, parseUsage, priceFor, sanitizePricing, totalTokens, UsageTracker
} from '../../claudeUsage';

const row = (id: string, usage: object, model = 'claude-sonnet-5-5') => ({
    type: 'assistant',
    message: { id, model, usage }
});

suite('claudeUsage', () => {
    test('parseUsage reads the cache write split', () => {
        const u = parseUsage({
            input_tokens: 2,
            output_tokens: 10,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 30,
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }
        });
        assert.deepStrictEqual(u, { input: 2, output: 10, cacheRead: 5, cacheWrite5m: 10, cacheWrite1h: 20 });
    });

    test('parseUsage falls back to the combined cache write figure', () => {
        const u = parseUsage({ cache_creation_input_tokens: 40 });
        assert.strictEqual(u?.cacheWrite5m, 40);
        assert.strictEqual(u?.cacheWrite1h, 0);
    });

    test('parseUsage rejects missing or junk input and ignores bad numbers', () => {
        assert.strictEqual(parseUsage(undefined), null);
        assert.strictEqual(parseUsage('x'), null);
        assert.strictEqual(totalTokens(parseUsage({ input_tokens: -5, output_tokens: 'a' })!), 0);
    });

    test('priceFor prefers the most specific model id and returns null for unknown models', () => {
        assert.deepStrictEqual(priceFor('claude-sonnet-5-5'), [2, 10, 0.1]);
        assert.deepStrictEqual(priceFor('claude-sonnet-5'), [2, 10]);
        assert.deepStrictEqual(priceFor('claude-sonnet-4-6'), [3, 15]);
        assert.deepStrictEqual(priceFor('CLAUDE-OPUS-5-5'), [4, 20, 0.2]);
        assert.deepStrictEqual(priceFor('claude-opus-4-8'), [5, 25]);
        assert.deepStrictEqual(priceFor('claude-opus-4-1-20250805'), [15, 75]);
        assert.deepStrictEqual(priceFor('claude-fable-5-1'), [10, 50, 0.25]);
        assert.deepStrictEqual(priceFor('claude-haiku-5-5'), [0.1, 0.5]);
        assert.strictEqual(priceFor('gpt-x'), null);
    });

    test('costOf applies cache multipliers', () => {
        // 1M input at $3, 1M output at $15, 1M cache read at $0.30, 1M 5m write at $3.75, 1M 1h write at $6.
        const cost = costOf(
            { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 },
            'claude-sonnet-4-6'
        );
        assert.ok(Math.abs(cost! - 28.05) < 1e-9);
        assert.strictEqual(costOf({ input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 'mystery'), null);
    });

    test('costOf uses the model specific cache read price', () => {
        // Opus 5.5: 1M cache read at $0.20 rather than 0.1x of $4.
        const cost = costOf({ input: 0, output: 0, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 }, 'claude-opus-5-5');
        assert.ok(Math.abs(cost! - 0.2) < 1e-9);
    });

    test('costOf bills long Haiku 5.5 prompts at the higher rate', () => {
        const short = costOf({ input: 50_000, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 'claude-haiku-5-5');
        const long = costOf({ input: 50_000, output: 1e6, cacheRead: 60_000, cacheWrite5m: 0, cacheWrite1h: 0 }, 'claude-haiku-5-5');
        assert.ok(Math.abs(short! - 0.505) < 1e-9);
        // 50k input at $0.50, 1M output at $2.50, 60k cache read at $0.05.
        assert.ok(Math.abs(long! - 2.528) < 1e-9);
    });

    test('sanitizePricing keeps defaults, applies valid overrides first and drops malformed ones', () => {
        const t = sanitizePricing({ sonnet: [1, 2], opus: 'free', haiku: [1], custom: [10, 50, 1] });
        assert.deepStrictEqual(t.sonnet, [1, 2]);
        assert.deepStrictEqual(t.opus, [5, 25]);
        assert.deepStrictEqual(t.haiku, [1, 5]);
        assert.deepStrictEqual(t.custom, [10, 50, 1]);
        assert.deepStrictEqual(priceFor('claude-sonnet-5-5', t), [1, 2]);
        assert.deepStrictEqual(sanitizePricing(null).sonnet, [3, 15]);
    });

    test('UsageTracker counts a message id once and lets later rows replace earlier ones', () => {
        const t = new UsageTracker();
        t.ingest(row('m1', { input_tokens: 100, output_tokens: 1 }));
        t.ingest(row('m1', { input_tokens: 100, output_tokens: 50 }));
        t.ingest(row('m2', { input_tokens: 10, output_tokens: 5 }));
        assert.strictEqual(t.usage.input, 110);
        assert.strictEqual(t.usage.output, 55);
    });

    test('UsageTracker splits usage by model and day, and tracks cache savings once per message', () => {
        const t = new UsageTracker();
        const at = (id: string, model: string, timestamp: string, usage: object) =>
            ({ type: 'assistant', timestamp, message: { id, model, usage } });
        t.ingest(at('m1', 'claude-opus-5-5', '2026-10-30T10:00:00Z', { input_tokens: 1_000_000 }));
        t.ingest(at('m1', 'claude-opus-5-5', '2026-10-30T10:00:01Z', { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }));
        t.ingest(at('m2', 'claude-haiku-5-5', '2026-10-29T10:00:00Z', { input_tokens: 1_000_000 }));
        assert.strictEqual(t.byModel.get('claude-opus-5-5')!.tokens, 2_000_000);
        assert.ok(Math.abs(t.byModel.get('claude-opus-5-5')!.cost - 4.2) < 1e-9);
        assert.strictEqual(t.byDay.get(dayOf('2026-10-30T10:00:00Z'))!.tokens, 2_000_000);
        assert.strictEqual(t.byDay.get(dayOf('2026-10-29T10:00:00Z'))!.tokens, 1_000_000);
        // 1M cache reads on Opus 5.5: $4 input minus $0.20 cache read.
        assert.ok(Math.abs(t.saved - 3.8) < 1e-9);
    });

    test('addPerMinute buckets tokens by message time', () => {
        const t = new UsageTracker();
        const now = Date.parse('2026-10-30T12:00:30Z');
        t.ingest({ type: 'assistant', timestamp: '2026-10-30T12:00:10Z', message: { id: 'a', model: 'claude-opus-5-5', usage: { input_tokens: 100 } } });
        t.ingest({ type: 'assistant', timestamp: '2026-10-30T11:58:10Z', message: { id: 'b', model: 'claude-opus-5-5', usage: { input_tokens: 40 } } });
        t.ingest({ type: 'assistant', timestamp: '2026-10-30T09:00:00Z', message: { id: 'c', model: 'claude-opus-5-5', usage: { input_tokens: 999 } } });
        const rate = new Array<number>(5).fill(0);
        t.addPerMinute(rate, now);
        assert.deepStrictEqual(rate, [0, 0, 40, 0, 100]);
    });

    test('sanitizePricing ignores a __proto__ key', () => {
        const table = sanitizePricing(JSON.parse('{"__proto__": [1, 2], "x": [3, 4]}'));
        assert.strictEqual(Object.getPrototypeOf(table), Object.prototype);
        assert.deepStrictEqual(table.x, [3, 4]);
    });

    test('cacheSavingsOf is null for unknown models', () => {
        assert.strictEqual(cacheSavingsOf({ input: 0, output: 0, cacheRead: 10, cacheWrite5m: 0, cacheWrite1h: 0 }, 'mystery'), null);
    });

    test('UsageTracker ignores non-assistant rows and rows without usage', () => {
        const t = new UsageTracker();
        t.ingest({ type: 'user', message: { usage: { input_tokens: 9 } } });
        t.ingest({ type: 'assistant', message: { id: 'a' } });
        t.ingest(null);
        assert.strictEqual(totalTokens(t.usage), 0);
        assert.strictEqual(t.totalCost, null);
    });

    test('UsageTracker cost follows replaced rows and stays null for unpriced models', () => {
        const t = new UsageTracker();
        t.ingest(row('m1', { input_tokens: 1_000_000 }));
        t.ingest(row('m1', { input_tokens: 2_000_000 }));
        assert.ok(Math.abs(t.totalCost! - 4) < 1e-9);

        const unpriced = new UsageTracker();
        unpriced.ingest(row('x', { input_tokens: 5 }, 'mystery-model'));
        assert.strictEqual(unpriced.totalCost, null);
        assert.strictEqual(unpriced.usage.input, 5);
    });

    test('formatTokens', () => {
        assert.strictEqual(formatTokens(0), '0');
        assert.strictEqual(formatTokens(999), '999');
        assert.strictEqual(formatTokens(1500), '1.5k');
        assert.strictEqual(formatTokens(250_000), '250k');
        assert.strictEqual(formatTokens(2_400_000), '2.4M');
        assert.strictEqual(formatTokens(1_250_000_000), '1.3B');
        assert.strictEqual(formatTokens(42_000_000_000), '42B');
    });

    test('formatCost', () => {
        assert.strictEqual(formatCost(null), '—');
        assert.strictEqual(formatCost(0), '$0.00');
        assert.strictEqual(formatCost(0.004), '<$0.01');
        assert.strictEqual(formatCost(12.345), '$12.35');
    });
});
