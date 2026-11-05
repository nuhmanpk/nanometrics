import * as assert from 'assert';
import { changesIn, insideRoots, restorePlan } from '../../claudeCheckpoints';
import { detectLoop, ToolResult } from '../../claudeActivity';

const row = (o: object) => JSON.stringify({ type: 'user', ...o });

suite('claudeCheckpoints', () => {
    const text = [
        row({ uuid: 'p1', timestamp: '2026-11-05T10:00:00Z', message: { content: 'first' } }),
        row({ timestamp: '2026-11-05T10:00:05Z', toolUseResult: { filePath: '/w/a.ts', originalFile: 'a0' } }),
        row({ uuid: 'p2', timestamp: '2026-11-05T10:01:00Z', message: { content: 'second' } }),
        row({ timestamp: '2026-11-05T10:01:05Z', toolUseResult: { filePath: '/w/a.ts', originalFile: 'a1' } }),
        row({ timestamp: '2026-11-05T10:01:06Z', toolUseResult: { filePath: '/w/a.ts', originalFile: 'a2' } }),
        row({ timestamp: '2026-11-05T10:01:07Z', toolUseResult: { type: 'create', filePath: '/w/new.ts', originalFile: null } }),
        row({ timestamp: '2026-11-05T10:01:08Z', toolUseResult: { filePath: '/w/odd.ts' } }),
        'not json'
    ].join('\n');

    test('restores each file to its content before the chosen prompt', () => {
        const { changes, turnTimes } = changesIn(text);
        const plan = restorePlan(changes, turnTimes.get('p2')!);
        assert.deepStrictEqual(plan.restores, [{ path: '/w/a.ts', original: 'a1' }, { path: '/w/new.ts', original: null }]);
        assert.deepStrictEqual(plan.unknown, ['/w/odd.ts']);
    });

    test('undoing from the first prompt reaches the oldest content', () => {
        const { changes, turnTimes } = changesIn(text);
        assert.strictEqual(restorePlan(changes, turnTimes.get('p1')!).restores[0].original, 'a0');
    });
});

suite('detectLoop', () => {
    const r = (tool: string, detail: string, error: boolean, file = ''): ToolResult => ({ tool, detail, error, file });

    test('flags the same call failing three times with no success between', () => {
        const loop = detectLoop([r('Bash', 'npm test', true), r('Read', 'a.ts', false), r('Bash', 'npm test', true), r('Bash', 'npm test', true)]);
        assert.ok(loop && /npm test failed 3×/.test(loop.text));
    });

    test('a success resets the count', () => {
        assert.strictEqual(detectLoop([r('Bash', 'npm test', true), r('Bash', 'npm test', true), r('Bash', 'npm test', false), r('Bash', 'npm test', true)]), null);
    });

    test('flags one file edited over and over while errors continue', () => {
        const edits = Array.from({ length: 5 }, () => r('Edit', 'a.ts', false, '/w/a.ts'));
        const loop = detectLoop([...edits, r('Bash', 'build', true), r('Bash', 'lint', true)]);
        assert.ok(loop && /a\.ts edited 5×/.test(loop.text));
    });
});

suite('insideRoots', () => {
    const os = require('os') as typeof import('os');
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');

    test('accepts workspace files and rejects escapes, including through a symlink', async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
        const root = path.join(base, 'ws');
        const outside = path.join(base, 'outside');
        fs.mkdirSync(root);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, 'link'));
        try {
            assert.strictEqual(await insideRoots(path.join(root, 'src', 'a.ts'), [root]), true);
            assert.strictEqual(await insideRoots(path.join(root, '..', 'outside', 'a.ts'), [root]), false);
            assert.strictEqual(await insideRoots(path.join(root, 'link', 'a.ts'), [root]), false);
            assert.strictEqual(await insideRoots(`${root}-other/a.ts`, [root]), false);
            assert.strictEqual(await insideRoots(root, [root]), false);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
});
