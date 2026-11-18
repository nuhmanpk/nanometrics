// Rough cost of each refresh path. Usage: npm run compile && node --expose-gc scripts/bench.js
const path = require('path');
const out = path.join(__dirname, '..', 'out');
const { collectClaude, claudeResources } = require(path.join(out, 'claudeActivity'));
const { collectOtherAgents } = require(path.join(out, 'otherAgents'));
const { readLimits } = require(path.join(out, 'claudeLimits'));
const { collectSystem } = require(path.join(out, 'sysinfoMetrics'));
const { collectProject } = require(path.join(out, 'projectMetrics'));

const folders = [path.join(__dirname, '..')];
const mb = (n) => (n / 1048576).toFixed(1);

async function bench(name, fn, runs = 10) {
  global.gc && global.gc();
  const rss0 = process.memoryUsage().rss;
  const times = [];
  const cpu0 = process.cpuUsage();
  let peak = rss0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  const cpu = process.cpuUsage(cpu0);
  times.sort((a, b) => a - b);
  const first = times.length ? times[0] : 0;
  console.log(`${name.padEnd(22)} median ${times[Math.floor(runs / 2)].toFixed(1).padStart(7)}ms  max ${times[runs - 1].toFixed(1).padStart(7)}ms  cpu/run ${((cpu.user + cpu.system) / 1000 / runs).toFixed(1).padStart(6)}ms  rss +${mb(peak - rss0)}MB`);
}

(async () => {
  const t = performance.now();
  await collectClaude(folders);
  console.log(`collectClaude COLD (first scan, parses every transcript): ${(performance.now() - t).toFixed(0)}ms, rss ${mb(process.memoryUsage().rss)}MB, heap ${mb(process.memoryUsage().heapUsed)}MB`);
  await bench('collectClaude warm', () => collectClaude(folders));
  await bench('collectOtherAgents', () => collectOtherAgents(folders));
  await bench('claudeResources', () => claudeResources(), 5);
  await bench('readLimits', () => readLimits());
  await bench('collectSystem (all)', () => collectSystem({ network: true, battery: true, gpu: true, disk: true, temperature: true, services: [], processes: true }), 5);
  await bench('collectSystem (hidden)', () => collectSystem({ network: false, battery: false, gpu: false, disk: false, temperature: false, services: [] }), 5);
  await bench('collectProject', () => collectProject({ folders, terminals: [], extensionHostPid: process.pid, appBase: '' }), 5);
  console.log(`final rss ${mb(process.memoryUsage().rss)}MB heap ${mb(process.memoryUsage().heapUsed)}MB`);
})().catch((e) => { console.error(e); process.exit(1); });
