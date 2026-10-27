import * as assert from 'assert';
import { statusView } from '../../statusText';

suite('statusText', () => {
    const base = { cpu: 12.4, memory: 45.6, warning: 85 };

    test('full style shows both icons', () => {
        const v = statusView({ ...base, style: 'full' });
        assert.strictEqual(v.text, '$(pulse) 12%  $(server) 46%');
        assert.strictEqual(v.warn, false);
    });

    test('compact style is shorter', () => {
        const full = statusView({ ...base, style: 'full' });
        const compact = statusView({ ...base, style: 'compact' });
        assert.strictEqual(compact.text, '$(pulse) 12·46%');
        assert.ok(compact.text.length < full.text.length);
    });

    test('warns when either value reaches the threshold', () => {
        assert.strictEqual(statusView({ ...base, cpu: 85, style: 'full' }).warn, true);
        assert.strictEqual(statusView({ ...base, memory: 90, style: 'compact' }).warn, true);
        assert.strictEqual(statusView({ ...base, cpu: 84.4, style: 'full' }).warn, false);
    });

    test('tooltip keeps the full readout in both styles', () => {
        assert.ok(statusView({ ...base, style: 'compact' }).tooltip.includes('CPU 12% · Memory 46%'));
    });
});
