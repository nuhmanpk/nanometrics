import * as assert from 'assert';
import { parseCodex, parseGemini } from '../../otherAgents';
import { costOf } from '../../claudeUsage';

suite('otherAgents', () => {
    test('parseCodex takes the last running total and splits cached input', () => {
        const text = [
            { type: 'session_meta', payload: { cwd: '/p' } },
            { type: 'turn_context', payload: { model: 'gpt-5-codex' } },
            { type: 'event_msg', payload: { type: 'user_message', message: 'fix it' } },
            { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } } } },
            { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 30 } } } }
        ].map(r => JSON.stringify(r)).join('\n');
        const p = parseCodex(text);
        assert.strictEqual(p.cwd, '/p');
        assert.strictEqual(p.title, 'fix it');
        assert.deepStrictEqual(p.usage, { input: 100, output: 30, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0 });
        assert.ok((costOf(p.usage, p.model) ?? 0) > 0);
    });

    test('parseGemini sums message tokens and survives junk', () => {
        const p = parseGemini(JSON.stringify({ messages: [
            { type: 'user', content: 'hi' },
            { type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 50, cached: 10, output: 5, thoughts: 3, tool: 2 } }
        ] }));
        assert.strictEqual(p.usage.input, 40);
        assert.strictEqual(p.usage.output, 10);
        assert.strictEqual(parseGemini('nope').usage.input, 0);
    });

    test('dotted model ids match dashed price keys', () => {
        assert.notStrictEqual(costOf({ input: 1000, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 'gemini-2.5-pro'), null);
    });
});
