import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { categoryOf, collectClaude } from '../../claudeActivity';

suite('claudeActivity', () => {
    let home: string;
    let previousHome: string | undefined;
    let previousProfile: string | undefined;
    const folder = '/work/demo-app';
    let transcript: string;

    const assistant = (id: string, usage: object, extra: object[] = []) => JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { id, model: 'claude-sonnet-5-5', usage, content: extra }
    });

    setup(async () => {
        previousHome = process.env.HOME;
        previousProfile = process.env.USERPROFILE;
        home = await fs.mkdtemp(path.join(os.tmpdir(), 'nanometrics-'));
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        const dir = path.join(home, '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));
        await fs.mkdir(dir, { recursive: true });
        transcript = path.join(dir, 'session-1.jsonl');
    });

    teardown(async () => {
        process.env.HOME = previousHome;
        process.env.USERPROFILE = previousProfile;
        await fs.rm(home, { recursive: true, force: true });
    });

    test('reports tokens, cost, tool calls and edited files for a session', async () => {
        const lines = [
            JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the bug' }),
            assistant('m1', { input_tokens: 1_000_000, output_tokens: 0 }, [
                { type: 'tool_use', name: 'Edit', input: { file_path: '/work/demo-app/a.ts' } }
            ]),
            // Same message id written again for the next content block.
            assistant('m1', { input_tokens: 1_000_000, output_tokens: 100_000 }, [
                { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
            ])
        ];
        await fs.writeFile(transcript, lines.join('\n') + '\n');

        const { sessions } = await collectClaude([folder]);
        assert.strictEqual(sessions.length, 1);
        const s = sessions[0];
        assert.strictEqual(s.title, 'Fix the bug');
        assert.strictEqual(s.toolCalls, 2);
        assert.strictEqual(s.filesTouched, 1);
        assert.strictEqual(s.tokens, '1.1M');
        // 1M input at $2 + 100k output at $10.
        assert.strictEqual(s.cost, '$3.00');
    });

    test('picks up appended rows without double counting earlier ones', async () => {
        await fs.writeFile(transcript, assistant('m1', { input_tokens: 1000 }) + '\n');
        assert.strictEqual((await collectClaude([folder])).sessions[0].tokens, '1.0k');

        await fs.appendFile(transcript, assistant('m2', { input_tokens: 500 }) + '\n');
        assert.strictEqual((await collectClaude([folder])).sessions[0].tokens, '1.5k');
    });

    test('waits for a half written last line instead of dropping it', async () => {
        const full = assistant('m2', { input_tokens: 500 });
        await fs.writeFile(transcript, assistant('m1', { input_tokens: 1000 }) + '\n' + full.slice(0, 30));
        assert.strictEqual((await collectClaude([folder])).sessions[0].tokens, '1.0k');

        await fs.appendFile(transcript, full.slice(30) + '\n');
        assert.strictEqual((await collectClaude([folder])).sessions[0].tokens, '1.5k');
    });

    test('shows no cost for unknown models', async () => {
        await fs.writeFile(transcript, JSON.stringify({
            type: 'assistant',
            message: { id: 'z', model: 'mystery-1', usage: { input_tokens: 10 }, content: [] }
        }) + '\n');
        const s = (await collectClaude([folder])).sessions[0];
        assert.strictEqual(s.cost, '—');
        assert.strictEqual(s.tokens, '10');
    });

    test('rolls subagent and workflow agent transcripts into the session', async () => {
        await fs.writeFile(transcript, assistant('m1', { input_tokens: 1000 }) + '\n');
        const subs = path.join(path.dirname(transcript), 'session-1', 'subagents');
        await fs.mkdir(path.join(subs, 'workflows', 'wf_1'), { recursive: true });
        await fs.writeFile(path.join(subs, 'agent-a.jsonl'), assistant('s1', { input_tokens: 2000 }, [
            { type: 'tool_use', name: 'Write', input: { file_path: '/work/demo-app/b.ts' } }
        ]) + '\n');
        await fs.writeFile(path.join(subs, 'agent-a.meta.json'), JSON.stringify({ description: 'Build chapter', agentType: 'general-purpose' }));
        await fs.writeFile(path.join(subs, 'workflows', 'wf_1', 'agent-b.jsonl'), assistant('s2', { input_tokens: 500 }) + '\n');

        const s = (await collectClaude([folder])).sessions[0];
        assert.strictEqual(s.tokens, '3.5k');
        assert.strictEqual(s.toolCalls, 1);
        assert.strictEqual(s.filesTouched, 1);
        assert.strictEqual(s.agents.length, 2);
        const a = s.agents.find(x => x.id === 'agent-a')!;
        assert.strictEqual(a.description, 'Build chapter');
        assert.strictEqual(a.tokens, '2.0k');
        assert.strictEqual(a.state, 'working');
    });

    test('counts lines, failed calls, hot files, tool mix, context and the last prompt', async () => {
        const lines = [
            JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Add a login page' } }),
            assistant('m1', { input_tokens: 10, cache_read_input_tokens: 40_000 }, [
                { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/demo-app/a.ts', old_string: 'a\nb', new_string: 'a\nb\nc' } },
                { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/work/demo-app/b.ts', content: 'x\ny' } },
                { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/work/demo-app/a.ts', old_string: 'z', new_string: '' } },
                { type: 'tool_use', id: 't4', name: 'Grep', input: { pattern: 'login' } }
            ]),
            JSON.stringify({ type: 'user', message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 't1' },
                { type: 'tool_result', tool_use_id: 't2' },
                { type: 'tool_result', tool_use_id: 't3', is_error: true },
                { type: 'tool_result', tool_use_id: 't4' }
            ] } })
        ];
        await fs.writeFile(transcript, lines.join('\n') + '\n');

        const s = (await collectClaude([folder])).sessions[0];
        assert.strictEqual(s.state, 'working');
        assert.strictEqual(s.prompt, 'Add a login page');
        assert.strictEqual(s.linesAdded, 5);
        assert.strictEqual(s.linesRemoved, 3);
        assert.strictEqual(s.failedCalls, 1);
        assert.deepStrictEqual(s.hotFiles.map(f => [f.name, f.edits]), [['a.ts', 2], ['b.ts', 1]]);
        assert.strictEqual(s.toolMix.edit, 3);
        assert.strictEqual(s.toolMix.read, 1);
        assert.strictEqual(s.timeline[s.timeline.length - 1].edit, 3);
        assert.strictEqual(s.context?.used, 40_010);
        // Sonnet 5.5 has a 1M window.
        assert.strictEqual(s.context?.limit, 1_000_000);
    });

    test('context window follows the model of the latest request', async () => {
        const row = (id: string, model: string) => JSON.stringify({
            type: 'assistant',
            timestamp: new Date().toISOString(),
            message: { id, model, usage: { input_tokens: 50_000 }, content: [] }
        });
        await fs.writeFile(transcript, row('m1', 'claude-haiku-4-5') + '\n');
        assert.strictEqual((await collectClaude([folder])).sessions[0].context?.limit, 200_000);

        await fs.appendFile(transcript, row('m2', 'claude-opus-5-5') + '\n');
        assert.strictEqual((await collectClaude([folder])).sessions[0].context?.limit, 1_000_000);
    });

    test('reports waiting on the user after a reply and on a tool left without a result', async () => {
        const quiet = async () => {
            const t = new Date(Date.now() - 60_000);
            await fs.utimes(transcript, t, t);
        };
        await fs.writeFile(transcript, assistant('m1', { input_tokens: 10 }, [{ type: 'text', text: 'Done.' }]) + '\n');
        await quiet();
        let s = (await collectClaude([folder])).sessions[0];
        assert.strictEqual(s.state, 'waiting');
        assert.strictEqual(s.waitingOn, 'you');

        await fs.appendFile(transcript, assistant('m2', { input_tokens: 10 }, [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf build' } }
        ]) + '\n');
        await quiet();
        s = (await collectClaude([folder])).sessions[0];
        assert.strictEqual(s.waitingOn, 'Bash');

        await fs.appendFile(transcript, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }) + '\n');
        await quiet();
        s = (await collectClaude([folder])).sessions[0];
        assert.strictEqual(s.state, 'idle');
    });

    test('collects research and errors with their messages', async () => {
        const lines = [
            JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: 'Find the docs' } }),
            assistant('m1', { input_tokens: 10 }, [
                { type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'vscode webview api' } },
                { type: 'tool_use', id: 't2', name: 'WebFetch', input: { url: 'https://www.example.com/docs' } },
                { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'false' } }
            ]),
            JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [
                { type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'exit code 1' }
            ] } })
        ];
        await fs.writeFile(transcript, lines.join('\n') + '\n');
        const s = (await collectClaude([folder])).sessions[0];
        assert.deepStrictEqual(s.research.map(r => [r.kind, r.text, r.url]).sort(), [
            ['fetch', 'example.com/docs', 'https://www.example.com/docs'],
            ['search', 'vscode webview api', '']
        ]);
        assert.deepStrictEqual(s.errors.map(e => [e.tool, e.message]), [['Bash', 'exit code 1']]);
        assert.strictEqual(s.models[0].model, 'sonnet-5-5');
    });

    test('lists older sessions as history and adds up spend per day', async () => {
        await fs.writeFile(transcript, assistant('m1', { input_tokens: 1_000_000 }) + '\n');
        const old = path.join(path.dirname(transcript), 'session-0.jsonl');
        await fs.writeFile(old, [
            JSON.stringify({ type: 'ai-title', aiTitle: 'Yesterday work' }),
            assistant('m0', { input_tokens: 500_000 })
        ].join('\n') + '\n');
        const hourAgo = new Date(Date.now() - 60 * 60_000);
        await fs.utimes(old, hourAgo, hourAgo);

        const snap = await collectClaude([folder]);
        assert.strictEqual(snap.sessions.length, 1);
        assert.deepStrictEqual(snap.history.map(h => [h.id, h.title, h.cwd]), [['session-0', 'Yesterday work', folder]]);
        assert.strictEqual(snap.week.length, 7);
        assert.strictEqual(snap.week[6].tokens, 1_500_000);
        assert.strictEqual(snap.today.sessions, 2);
    });

    test('categoryOf ignores names inherited from Object.prototype', () => {
        assert.strictEqual(categoryOf('constructor'), 'other');
        assert.strictEqual(categoryOf('__proto__'), 'other');
        assert.strictEqual(categoryOf('Edit'), 'edit');
    });

    test('returns no sessions when the project has no transcripts', async () => {
        assert.deepStrictEqual((await collectClaude(['/somewhere/else'])).sessions, []);
    });
});
