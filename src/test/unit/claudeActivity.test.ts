import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectClaude } from '../../claudeActivity';

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

    test('returns no sessions when the project has no transcripts', async () => {
        assert.deepStrictEqual((await collectClaude(['/somewhere/else'])).sessions, []);
    });
});
