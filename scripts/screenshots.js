// Regenerates images/claude_dashboard.svg from the REAL dashboard UI (media/dashboard.js + css) in headless Chrome,
// fed with real collectClaude() output for this workspace, scrubbed of prompts, titles, paths and errors.
// Usage: npm run compile && node scripts/screenshots.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { collectClaude } = require(path.join(root, 'out', 'claudeActivity'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 620;

const PROMPTS = ['add a dark mode toggle to the settings page', 'fix the failing login test', 'why is the build slow?', 'rename the user service and update imports', 'write docs for the API client'];
const TITLES = ['Add dark mode toggle', 'Fix login test', 'Speed up the build', 'Refactor user service', 'Document the API client', 'Agent tracking and cost limits'];
const FILES = ['app.ts', 'index.css', 'Settings.tsx', 'api.ts'];
const FAKE_ROOT = '/Users/dev/my-app';

function scrub(d) {
  const clean = JSON.parse(JSON.stringify(d));
  let n = 0;
  const pick = (list) => list[n++ % list.length];
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') { return; }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (k === 'title') { o[k] = pick(TITLES); }
        else if (k === 'prompt') { o[k] = pick(PROMPTS); }
        else if (k === 'cwd' || k === 'path') { o[k] = FAKE_ROOT + '/' + (o.name || 'src'); }
        else if (k === 'folder') { o[k] = 'my-app'; }
        else if (k === 'detail' && /[\s/]/.test(v) && o.tool === 'Bash') { o[k] = 'npm test'; }
        else if (k === 'detail' && o.tool !== 'Bash' && /\.\w+$/.test(v)) { o[k] = FILES[v.length % FILES.length]; }
        else if (k === 'name' && /\.\w+$/.test(v)) { o[k] = FILES[v.length % FILES.length]; }
        else if (k === 'file' && /\.\w+$/.test(v)) { o[k] = FILES[v.length % FILES.length]; }
        else if (k === 'message') { o[k] = 'Command failed'; }
        else if (k === 'id') { o[k] = 'demo-' + n; }
      } else if (typeof v === 'object') { walk(v); }
    }
  };
  walk(clean);
  clean.sessions.forEach((s) => { s.errors = []; s.files = (s.files || []).map((f) => FAKE_ROOT + '/' + FILES[String(f).length % FILES.length]); });
  if (clean.project) { clean.project.since = Date.now() - 27 * 864e5; }
  return clean;
}

const THEME = `:root{--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#0b0b0d;--vscode-editor-background:#0b0b0d;--vscode-font-family:-apple-system,"SF Pro Text","Segoe UI",Helvetica,Arial,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:"SF Mono",Menlo,Consolas,monospace;--vscode-focusBorder:#007fd4;--vscode-charts-blue:#6ea8ff;--vscode-charts-green:#7ddc8c;--vscode-charts-yellow:#e0b341;--vscode-charts-orange:#f0a35e;--vscode-charts-red:#f47070;--vscode-charts-purple:#b79cf0;--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;--vscode-editorWidget-border:#2b2b30}`;
const INIT = { type: 'init', paused: false, showGraph: true, interval: 2000, warning: 85, budget: 0, tokenLimit: 0, planPrice: 0, pricing: [], info: [{ name: 'my-app', branch: 'main', packageManager: 'npm' }], hasWorkspace: true, force: true };

/** Renders the real dashboard on `tab` with these messages; returns the PNG path and its CSS height. */
function capture(tab, msgs, scale = 2) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-shot-'));
  const page = path.join(tmp, 'index.html');
  const all = [{ ...INIT, tab }, ...msgs];
  fs.writeFileSync(page, `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${THEME}</style>
<link rel="stylesheet" href="file://${root}/media/dashboard.css"></head>
<body data-mode="full" data-platform="darwin"><div id="app"></div>
<script>window.acquireVsCodeApi=()=>({getState:()=>({tab:'${tab}'}),setState(){},postMessage(){}});</script>
<script src="file://${root}/media/dashboard.js"></script>
<script>${all.map((m) => `window.postMessage(${JSON.stringify(m)},'*');`).join('')}
setTimeout(()=>{const r={h:document.getElementById('app').scrollHeight,b:{}};
document.querySelectorAll('[data-blk],.section,.card').forEach((e,i)=>{const b=e.getBoundingClientRect();const k=e.dataset.blk||((e.querySelector('.section-title span')||{}).textContent)||e.className.split(' ').join('.')+'#'+i;if(!r.b[k])r.b[k]=[Math.round(b.top),Math.round(b.height)];});
document.title='J'+JSON.stringify(r);},300);</script></body></html>`);
  const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', `--window-size=${WIDTH},800`, '--virtual-time-budget=2000', '--dump-dom', 'file://' + page]).toString();
  const info = JSON.parse((/<title>J(.*?)<\/title>/s.exec(dom)?.[1] || '{"h":1800,"b":{}}').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  const h = info.h + 40;
  const png = path.join(tmp, 'shot.png');
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`,
    `--window-size=${WIDTH},${h}`, '--virtual-time-budget=2000', `--screenshot=${png}`, 'file://' + page], { stdio: 'pipe' });
  return { png, h, blocks: info.b };
}

async function main() {
  const data = scrub(await collectClaude([root]));
  const { png, h } = capture('claude', [{ type: 'claude', data }]);
  const b64 = fs.readFileSync(png).toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${WIDTH} ${h}" width="${WIDTH}" height="${h}" role="img" aria-label="Nano Metrics Claude tab: cost, tokens, context and activity">
<title>Nano Metrics Claude tab</title>
<image width="${WIDTH}" height="${h}" href="data:image/png;base64,${b64}"/>
</svg>
`;
  fs.writeFileSync(path.join(root, 'images', 'claude_dashboard.svg'), svg);
  console.log(`wrote images/claude_dashboard.svg (${WIDTH}x${h}, ${(svg.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
