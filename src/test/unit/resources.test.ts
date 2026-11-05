import * as assert from 'assert';
import { isClaudeCommand } from '../../claudeActivity';
import { groupProcesses } from '../../sysinfoMetrics';

suite('resources', () => {
    test('isClaudeCommand matches the CLI, not lookalikes', () => {
        assert.ok(isClaudeCommand('claude --output-format stream-json'));
        assert.ok(isClaudeCommand('/Users/me/.local/bin/claude'));
        assert.ok(isClaudeCommand('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'));
        assert.ok(!isClaudeCommand('/Applications/Claude.app/Contents/MacOS/Claude'));
        assert.ok(!isClaudeCommand('vim claude.md'));
    });

    test('groupProcesses folds helpers of one app together', () => {
        const g = groupProcesses([
            { name: 'Code Helper (Renderer)', cpu: 2, memRss: 100, mem: 1 },
            { name: 'Code Helper', cpu: 3, memRss: 50, mem: 0.5 },
            { name: 'node', cpu: 1, memRss: 10, mem: 0.1 },
            { name: '', cpu: 9, memRss: 9, mem: 9 }
        ]);
        const code = g.find(p => p.name === 'Code Helper');
        assert.strictEqual(g.length, 2);
        assert.strictEqual(code?.count, 2);
        assert.strictEqual(code?.cpu, 5);
        assert.strictEqual(code?.memRss, 150 * 1024);
    });
});
