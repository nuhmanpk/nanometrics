import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readLimits } from '../../claudeLimits';

suite('claudeLimits', () => {
    let dir: string;
    let previousConfig: string | undefined;
    const now = Date.parse('2026-10-30T12:00:00Z');

    const write = (config: object) => fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify(config));

    setup(async () => {
        previousConfig = process.env.CLAUDE_CONFIG_DIR;
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nanometrics-'));
        process.env.CLAUDE_CONFIG_DIR = dir;
    });

    teardown(async () => {
        if (previousConfig === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = previousConfig;
        }
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('reads the limits Claude Code cached for /usage', async () => {
        await write({
            oauthAccount: { accountUuid: 'a1' },
            cachedUsageUtilization: {
                fetchedAtMs: now - 60_000,
                accountUuid: 'a1',
                utilization: {
                    five_hour: { utilization: 44, resets_at: '2026-10-30T15:30:00+00:00' },
                    limits: [
                        { kind: 'session', percent: 44, resets_at: '2026-10-30T15:30:00+00:00' },
                        { kind: 'weekly_all', percent: 78, resets_at: '2026-10-31T21:00:00+00:00' },
                        { kind: 'weekly_opus', percent: null, resets_at: null }
                    ]
                }
            }
        });
        const l = await readLimits(now);
        assert.strictEqual(l.updated, now - 60_000);
        assert.deepStrictEqual(l.limits.map(x => [x.label, x.percent]), [['Current session', 44], ['Weekly', 78]]);
        assert.strictEqual(l.limits[0].resetsAt, Date.parse('2026-10-30T15:30:00Z'));
    });

    test('falls back to the per-window objects and treats past resets as fresh', async () => {
        await write({
            cachedUsageUtilization: {
                fetchedAtMs: now,
                utilization: {
                    five_hour: { utilization: 90, resets_at: '2026-10-30T11:00:00+00:00' },
                    seven_day: { utilization: 30, resets_at: '2026-11-02T00:00:00+00:00' },
                    seven_day_opus: null
                }
            }
        });
        const l = await readLimits(now);
        assert.deepStrictEqual(l.limits.map(x => [x.key, x.percent, x.resetsAt > 0]), [['five_hour', 0, false], ['seven_day', 30, true]]);
    });

    test('ignores limits cached for a different account', async () => {
        await write({
            oauthAccount: { accountUuid: 'new' },
            cachedUsageUtilization: { fetchedAtMs: now, accountUuid: 'old', utilization: { limits: [{ kind: 'session', percent: 10 }] } }
        });
        assert.deepStrictEqual((await readLimits(now)).limits, []);
    });

    test('returns no limits without a config file', async () => {
        assert.deepStrictEqual(await readLimits(now), { updated: 0, limits: [] });
    });
});
