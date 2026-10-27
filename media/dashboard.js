// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  const state = {
    tab: saved.tab || 'system',
    paused: false,
    showGraph: true,
    warning: 85,
    hasWorkspace: true,
    info: [],
    system: null,
    project: null,
    claude: null,
    history: { cpu: [], memory: [], rx: [], tx: [], temp: [], projectCpu: [], projectMem: [] },
    isMac: false,
    expanded: new Set(saved.expanded || []),
    showIdle: new Set(saved.showIdle || []),
    error: ''
  };

  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const compact = document.body.dataset.mode === 'compact';
  state.isMac = document.body.dataset.platform === 'darwin';

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
  const pct = (v) => (v == null || isNaN(v) ? '–' : Math.round(v));
  const bytes = (b) => {
    if (b == null || isNaN(b)) { return '–'; }
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
  };
  const rate = (b) => `${bytes(b)}/s`;
  const duration = (s) => {
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const level = (v) => (v >= state.warning ? 'var(--red)' : v >= state.warning * 0.7 ? 'var(--yellow)' : null);
  const loadColor = (v, base) => level(v) || base;

  // ---------- primitives ----------
  function ring(value, color) {
    const r = 20, c = 2 * Math.PI * r;
    const v = Math.max(0, Math.min(100, value || 0));
    return `<svg class="ring" viewBox="0 0 46 46" aria-hidden="true">
      <circle class="track" cx="23" cy="23" r="${r}"></circle>
      <circle class="value" cx="23" cy="23" r="${r}" stroke="${color}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - v / 100)).toFixed(2)}"></circle>
    </svg>`;
  }

  /** Sparkline of one or more series sharing a y-scale. */
  function spark(series, { max, height = 34 } = {}) {
    if (!state.showGraph) { return ''; }
    const W = 100, H = height;
    const all = series.flatMap((s) => s.values);
    const top = max ?? Math.max(1, ...all) * 1.15;
    const paths = series.map((s) => {
      const vals = s.values.length ? s.values : [0];
      const n = Math.max(vals.length - 1, 1);
      const pts = vals.map((v, i) => [(i / n) * W, H - (Math.min(v, top) / top) * (H - 2) - 1]);
      if (pts.length === 1) { pts.push([W, pts[0][1]]); pts[0][0] = 0; }
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('');
      const area = `${line}L${W},${H}L0,${H}Z`;
      return `<path class="area" d="${area}" fill="${s.color}"></path><path class="line" d="${line}" stroke="${s.color}"></path>`;
    }).join('');
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true">${paths}</svg>`;
  }

  const bar = (v, color) => `<div class="bar"><div style="width:${Math.max(0, Math.min(100, v))}%;background:${loadColor(v, color)}"></div></div>`;
  const chevron = '<svg width="10" height="10" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  const cross = '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const section = (title, body, aside = '') => `<div class="section"><div class="section-title"><span>${title}</span>${aside ? `<span class="aside">${aside}</span>` : ''}</div>${body}</div>`;

  // ---------- system tab ----------
  function systemView() {
    const s = state.system;
    if (!s) { return '<div class="grid2"><div class="skeleton"></div><div class="skeleton"></div></div><div class="skeleton" style="margin-top:10px"></div>'; }
    const h = state.history;
    const cpuColor = loadColor(s.cpu.load, 'var(--blue)');
    const memColor = loadColor(s.memory.percent, 'var(--purple)');

    let out = `<div class="grid2">
      <div class="card gauge-card">
        <div class="gauge-head">${ring(s.cpu.load, cpuColor)}
          <div class="gauge-label"><div class="name">CPU</div><div class="big num">${pct(s.cpu.load)}<small>%</small></div>
          <div class="sub num" title="User ${pct(s.cpu.user)}% · System ${pct(s.cpu.system)}%">${pct(s.cpu.user)}% user</div></div>
        </div>
        ${spark([{ values: h.cpu, color: cpuColor }], { max: 100 })}
      </div>
      <div class="card gauge-card">
        <div class="gauge-head">${ring(s.memory.percent, memColor)}
          <div class="gauge-label"><div class="name">Memory</div><div class="big num">${pct(s.memory.percent)}<small>%</small></div>
          <div class="sub num" title="${bytes(s.memory.used)} of ${bytes(s.memory.total)}">${bytes(s.memory.used)} of ${bytes(s.memory.total)}</div></div>
        </div>
        ${spark([{ values: h.memory, color: memColor }], { max: 100 })}
      </div>
    </div>`;

    const cores = s.cpu.cores.map((v, i) => {
      const c = loadColor(v, 'var(--blue)');
      return `<div class="core" title="Core ${i + 1}: ${pct(v)}%"><div class="fill" style="height:${Math.max(4, v)}%;background:color-mix(in srgb, ${c} 55%, transparent)"></div><span class="num">${pct(v)}</span></div>`;
    }).join('');
    const n = s.cpu.cores.length;
    const cols = n <= 8 ? n : Math.ceil(n / Math.ceil(n / 8));
    out += section('Cores', `<div class="card"><div class="cores" style="grid-template-columns:repeat(${cols},1fr)">${cores}</div></div>`, `${s.cpu.cores.length} logical${s.cpu.temperature ? ` · ${Math.round(s.cpu.temperature)}°C` : ''}`);

    if (s.network) {
      out += section('Network', `<div class="card">
        <div class="net">
          <div><div class="dir"><span class="legend" style="background:var(--green)"></span>Download</div><div class="rate num">${rate(s.network.rxSec)}</div></div>
          <div><div class="dir"><span class="legend" style="background:var(--orange)"></span>Upload</div><div class="rate num">${rate(s.network.txSec)}</div></div>
        </div>
        ${spark([{ values: h.rx, color: 'var(--green)' }, { values: h.tx, color: 'var(--orange)' }])}
      </div>`, esc([s.network.iface, s.network.ip4].filter(Boolean).join(' · ')));
    }

    if (s.memory.swapTotal > 0 || (s.disk && s.disk.length)) {
      const rows = [];
      if (s.memory.swapTotal > 0) {
        const sp = (s.memory.swapUsed / s.memory.swapTotal) * 100;
        rows.push(`<div><div class="row-head"><span class="label">Swap</span><span class="muted num">${bytes(s.memory.swapUsed)} / ${bytes(s.memory.swapTotal)}</span></div>${bar(sp, 'var(--purple)')}</div>`);
      }
      for (const d of s.disk || []) {
        rows.push(`<div><div class="row-head"><span class="label mono" title="${esc(d.mount)}">${esc(d.mount)}</span><span class="muted num">${bytes(d.used)} / ${bytes(d.size)}</span></div>${bar(d.percent, 'var(--blue)')}</div>`);
      }
      out += section('Storage', `<div class="card rows">${rows.join('')}</div>`);
    }

    const extras = [];
    if (s.battery) {
      const b = s.battery;
      const status = b.charging ? 'Charging' : b.acConnected ? 'Plugged in' : b.timeRemaining ? `${duration(b.timeRemaining * 60)} left` : 'On battery';
      const color = b.percent <= 20 ? 'var(--red)' : 'var(--green)';
      extras.push(`<div><div class="row-head"><span class="label">Battery · ${status}</span><span class="num">${pct(b.percent)}%</span></div><div class="bar"><div style="width:${b.percent}%;background:${color}"></div></div></div>`);
    }
    for (const g of s.gpu || []) {
      extras.push(`<div class="kv"><span class="k">GPU</span><span>${esc(g.model)}${g.vram ? ` · ${bytes(g.vram * 1024 * 1024)}` : ''}${g.utilization != null ? ` · ${pct(g.utilization)}%` : ''}</span></div>`);
    }
    if (extras.length) { out += section('Hardware', `<div class="card rows">${extras.join('')}</div>`); }

    if (s.services && s.services.length) {
      const chips = s.services.map((sv) => `<span class="chip ${sv.running ? 'on' : ''}" title="${sv.running ? `PID ${sv.pids.join(', ')}` : 'Not running'}"><span class="dot"></span>${esc(sv.name)}${sv.running ? `<span class="meta num">${pct(sv.cpu)}% · ${pct(sv.mem)}%</span>` : '<span class="meta">off</span>'}</span>`).join('');
      out += section('Services', `<div class="chips">${chips}</div>`, `${s.services.filter((x) => x.running).length}/${s.services.length} running`);
    }

    out += `<div class="footer"><span title="${esc(s.cpu.brand)}">${esc(s.cpu.brand)}${s.cpu.speed ? ` · ${s.cpu.speed} GHz` : ''}</span><span class="num">up ${duration(s.uptime)}</span></div>`;
    return out;
  }

  // ---------- project tab ----------
  function procNode(p, depth) {
    const open = state.expanded.has(p.pid);
    const hasKids = p.children.length > 0;
    const cpu = hasKids ? p.totalCpu : p.cpu;
    const mem = hasKids ? p.totalMem : p.memRss;
    const originTag = depth === 0
      ? (p.origin === 'terminal'
        ? `<button class="origin terminal" data-action="showTerminal" data-name="${esc(p.originLabel)}" title="Show terminal">${esc(p.originLabel)}</button>`
        : `<span class="origin ${p.origin}" title="${originHint(p.origin)}">${esc(p.originLabel)}</span>`)
      : '';
    const ports = p.ports.length
      ? `<div class="ports">${p.ports.map((port) => `<button class="port" data-action="openPort" data-port="${port}" title="Open http://localhost:${port}">:${port}</button>`).join('')}</div>`
      : '';
    const kids = hasKids ? `<div class="children">${p.children.map((c) => procNode(c, depth + 1)).join('')}</div>` : '';
    return `<div class="proc ${open ? 'open' : ''}">
      <div class="proc-row" ${hasKids ? `data-action="toggle" data-pid="${p.pid}"` : ''}>
        <span class="twisty ${hasKids ? '' : 'empty'}">${chevron}</span>
        <div class="proc-main">
          <div class="proc-title"><span class="pname">${esc(p.name)}</span>${originTag}${hasKids ? `<span class="muted" style="font-size:11px">+${countAll(p) - 1}</span>` : ''}</div>
          <div class="proc-cmd" title="${esc(p.command)}">${esc(p.command)}</div>
          ${ports}
        </div>
        <div class="proc-metrics">
          <div class="m num" title="CPU · memory${hasKids ? ' (including children)' : ''}"><b style="color:${loadColor(cpu, 'inherit')}">${cpu.toFixed(1)}%</b><span class="muted">${bytes(mem)}</span></div>
          <button class="icon-btn" data-action="kill" data-pid="${p.pid}" data-name="${esc(p.name)}" title="Stop process${hasKids ? ' tree' : ''}" aria-label="Stop ${esc(p.name)}">${cross}</button>
        </div>
      </div>
      ${kids}
    </div>`;
  }

  const hasPorts = (p) => p.ports.length > 0 || p.children.some(hasPorts);
  const isIdle = (p) => p.totalCpu < 0.5 && !hasPorts(p);

  const countAll = (p) => 1 + p.children.reduce((n, c) => n + countAll(c), 0);

  function originHint(o) {
    return {
      tooling: 'Spawned by extensions in this window (language servers, linters, watchers)',
      workspace: 'Working directory is inside this workspace',
      command: 'Command line references this workspace'
    }[o] || '';
  }

  // ---------- Claude Code window ----------
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  };
  const todoIcon = { completed: '✓', in_progress: '●', pending: '○' };

  function claudeSession(c, first) {
    const working = c.state === 'working';
    const done = c.todos.filter((t) => t.status === 'completed').length;
    const total = c.todos.length;
    const open = first || state.expanded.has(c.id);
    const cur = c.current;
    const progress = total
      ? `<div class="cc-progress"><div class="row-head"><span class="label">Progress</span><span class="muted num">${done}/${total} tasks</span></div>
          <div class="bar"><div style="width:${(done / total) * 100}%;background:var(--green)"></div></div>
          <div class="cc-todos">${c.todos.map((t) => `<div class="cc-todo ${t.status}"><span class="ico">${todoIcon[t.status] || '○'}</span><span>${esc(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</span></div>`).join('')}</div>
        </div>`
      : '';
    const steps = c.steps.length
      ? `<div class="cc-steps">${c.steps.map((s) => `<div class="cc-step"><span class="tool">${esc(s.tool)}</span><span class="detail" title="${esc(s.detail)}">${esc(s.detail)}</span><span class="muted">${ago(s.time)}</span></div>`).join('')}</div>`
      : '';
    const agents = c.agents || [];
    const running = agents.filter((a) => a.state === 'working').length;
    const agentList = agents.length
      ? `<div class="cc-label">Agents · ${running ? `${running} running · ` : ''}${agents.length} total</div>
        <div class="cc-steps">${agents.slice(0, open ? agents.length : 3).map((a) => `<div class="cc-step"><span class="cc-pulse ${a.state === 'working' ? 'on' : ''}"></span><span class="detail" title="${esc(a.type)}">${esc(a.description)}</span><span class="muted num">${a.toolCalls} calls · ${esc(a.tokens)} · ${esc(a.cost)}</span></div>`).join('')}</div>`
      : '';
    return `<div class="card cc-session ${working ? 'working' : ''}">
      <div class="cc-head" data-action="toggle" data-pid="${esc(c.id)}">
        <span class="cc-pulse ${working ? 'on' : ''}"></span>
        <div class="proc-main">
          <div class="proc-title"><span class="pname" title="${esc(c.title)}">${esc(c.title)}</span></div>
          <div class="proc-cmd">${working ? 'Working' : 'Idle'} · ${ago(c.updated)}${c.model ? ` · ${esc(c.model)}` : ''}</div>
        </div>
      </div>
      ${cur ? `<div class="cc-now"><span class="tool">${esc(cur.tool)}</span><span class="detail" title="${esc(cur.detail)}">${esc(cur.detail)}</span></div>` : ''}
      ${progress}
      <div class="stats cc-stats">
        <div class="stat"><div class="v num">${c.toolCalls}</div><div class="l">Tool calls</div></div>
        <div class="stat"><div class="v num">${c.filesTouched}</div><div class="l">Files edited</div></div>
        <div class="stat" title="${esc(c.tokenDetail)}"><div class="v num">${esc(c.tokens)}</div><div class="l">Tokens</div></div>
        <div class="stat" title="Estimated from token usage and model pricing"><div class="v num">${esc(c.cost)}</div><div class="l">Est. cost</div></div>
      </div>
      ${agentList}
      ${open && steps ? `<div class="cc-label">Recent activity</div>${steps}` : ''}
    </div>`;
  }

  function claudeView() {
    const c = state.claude;
    if (!c || !c.sessions.length) { return ''; }
    const live = c.sessions.filter((s) => s.state === 'working').length;
    return section('Claude Code', c.sessions.map((s, i) => claudeSession(s, i === 0)).join(''), live ? `${live} working` : 'idle');
  }

  function projectView() {
    if (!state.hasWorkspace) {
      return `<div class="empty-state"><div class="title">No folder open</div>Open a folder or workspace to monitor the processes, ports and resources your project uses.</div>`;
    }
    const p = state.project;
    const info = state.info;
    const h = state.history;
    const name = info.length ? info.map((i) => i.name).join(', ') : 'Workspace';
    const branch = info.find((i) => i.branch)?.branch;

    let out = `<div class="card project-head">
      <div class="project-name"><strong title="${esc(info.map((i) => i.folder).join('\n'))}">${esc(name)}</strong>${branch ? `<span class="badge" title="Git branch">⎇ ${esc(branch)}</span>` : ''}</div>`;
    if (!p) {
      out += `<div class="skeleton" style="height:60px"></div></div>`;
      return out;
    }
    out += `<div class="stats">
        <div class="stat"><div class="v num" style="color:${loadColor(p.cpu, 'inherit')}">${p.cpu.toFixed(1)}%</div><div class="l">CPU</div></div>
        <div class="stat"><div class="v num">${bytes(p.memRss)}</div><div class="l">Memory</div></div>
        <div class="stat"><div class="v num">${p.processCount}</div><div class="l">Processes</div></div>
      </div>
      ${spark([{ values: h.projectCpu, color: 'var(--blue)' }])}
    </div>`;

    out += claudeView();

    if (p.ports.length) {
      const chips = p.ports.map((x) => `<button class="chip" data-action="openPort" data-port="${x.port}" title="${esc(x.name)} (PID ${x.pid}) — open in browser"><span class="dot" style="background:var(--green)"></span><span class="mono">localhost:${x.port}</span><span class="meta">${esc(x.name)}</span></button>`).join('');
      out += section('Listening ports', `<div class="chips">${chips}</div>`);
    }

    const groups = [
      ['Running', p.roots.filter((r) => r.origin !== 'tooling')],
      ['Editor tooling', p.roots.filter((r) => r.origin === 'tooling')]
    ];
    for (const [title, roots] of groups) {
      if (title === 'Running' && !roots.length) {
        out += section('Running', `<div class="empty-state"><div class="title">Nothing running</div>Start a dev server, watcher or test run in a terminal and it shows up here with its CPU, memory and ports.</div>`);
        continue;
      }
      if (!roots.length) { continue; }
      const cpu = roots.reduce((s, r) => s + r.totalCpu, 0);
      const mem = roots.reduce((s, r) => s + r.totalMem, 0);
      // Idle shells and sleeping helpers are noise; fold them away unless asked for.
      const key = String(title);
      const active = roots.filter((r) => !isIdle(r));
      const idle = roots.filter(isIdle);
      const showIdle = state.showIdle.has(key) || !active.length;
      const list = (showIdle ? [...active, ...idle] : active).map((r) => procNode(r, 0)).join('');
      const toggle = idle.length && active.length
        ? `<button class="more" data-action="idle" data-key="${esc(key)}">${showIdle ? 'Hide' : 'Show'} ${idle.length} idle</button>`
        : '';
      out += section(title, `<div class="proc-list">${list}${toggle}</div>`, `${cpu.toFixed(1)}% · ${bytes(mem)}`);
    }

    const withScripts = info.filter((i) => i.scripts.length);
    for (const i of withScripts) {
      const btns = i.scripts.map((s) => `<button class="chip script" data-action="runScript" data-folder="${esc(i.folder)}" data-script="${esc(s)}" title="${esc(`${i.packageManager} run ${s}`)}">${esc(s)}</button>`).join('');
      out += section(withScripts.length > 1 ? `Scripts · ${esc(i.name)}` : 'Scripts', `<div class="chips scripts">${btns}</div>`, esc(i.packageManager || ''));
    }
    return out;
  }

  // ---------- compact (Explorer) view ----------
  // One line per metric, sized like a tree item; details live in the tooltip.
  function mrow({ label, value, color, percent, text, history, max, tab = 'system', title = '' }) {
    const middle = percent != null
      ? `<div class="bar">${percent > 0 ? `<div style="width:${Math.max(0, Math.min(100, percent))}%;background:${color}"></div>` : ''}</div>`
      : `<span class="mtext">${text || ''}</span>`;
    return `<div class="mrow" data-action="open" data-tab="${tab}" title="${esc(title)}">
      <span class="mlabel"><span class="mdot" style="background:${color}"></span>${label}</span>
      ${middle}
      <span class="mval num">${value}</span>
      <span class="mspark">${history ? spark(history, { max, height: 14 }) : ''}</span>
    </div>`;
  }

  function compactView() {
    const s = state.system;
    if (!s) { return '<div class="mrow muted">Loading…</div>'; }
    const h = state.history;
    const cpuColor = loadColor(s.cpu.load, 'var(--blue)');
    const memColor = loadColor(s.memory.percent, 'var(--purple)');
    const short = (b) => bytes(b).replace(' ', '');
    const rows = [
      mrow({ label: 'CPU', value: `${pct(s.cpu.load)}%`, color: cpuColor, percent: s.cpu.load, history: [{ values: h.cpu, color: cpuColor }], max: 100,
        title: `CPU ${pct(s.cpu.load)}% · user ${pct(s.cpu.user)}% · system ${pct(s.cpu.system)}%\n${s.cpu.cores.length} cores · ${s.cpu.brand}` }),
      mrow({ label: 'MEM', value: `${pct(s.memory.percent)}%`, color: memColor, percent: s.memory.percent, history: [{ values: h.memory, color: memColor }], max: 100,
        title: `Memory ${bytes(s.memory.used)} of ${bytes(s.memory.total)}` })
    ];
    if (s.cpu.temperature != null) {
      const t = s.cpu.temperature;
      const tColor = t >= 85 ? 'var(--red)' : t >= 70 ? 'var(--yellow)' : 'var(--green)';
      rows.push(mrow({ label: 'TMP', value: `${Math.round(t)}°`, color: tColor, percent: t, history: [{ values: h.temp || [], color: tColor }],
        title: `CPU die ${Math.round(t)}°C hottest · ${Math.round(s.cpu.temperatureAvg ?? t)}°C average` }));
    }
    for (const g of state.isMac ? [] : s.gpu || []) {
      rows.push(g.utilization != null
        ? mrow({ label: 'GPU', value: `${pct(g.utilization)}%`, color: 'var(--green)', percent: g.utilization, title: g.model })
        : mrow({ label: 'GPU', value: '', color: 'var(--green)', text: esc(g.model), title: `${g.model}${g.vram ? ` · ${bytes(g.vram * 1024 * 1024)}` : ' · shared memory'}` }));
    }
    if (s.network) {
      rows.push(mrow({ label: 'NET', value: '', color: 'var(--orange)',
        text: `<span style="color:var(--green)">↓</span>${short(s.network.rxSec)} <span style="color:var(--orange)">↑</span>${short(s.network.txSec)}`,
        history: [{ values: h.rx, color: 'var(--green)' }, { values: h.tx, color: 'var(--orange)' }],
        title: `Download ${rate(s.network.rxSec)} · Upload ${rate(s.network.txSec)}\n${[s.network.iface, s.network.ip4].filter(Boolean).join(' · ')}` }));
    }
    const p = state.project;
    if (state.hasWorkspace && p) {
      const name = state.info.map((i) => i.name).join(', ') || 'Workspace';
      const branch = state.info.find((i) => i.branch)?.branch;
      const running = p.roots.filter((r) => r.origin !== 'tooling' && !isIdle(r)).length;
      const ports = p.ports.slice(0, 3).map((x) => `<button class="port" data-action="openPort" data-port="${x.port}" title="${esc(x.name)} — open in browser">:${x.port}</button>`).join('');
      rows.push(mrow({ label: 'PRJ', value: `${p.cpu.toFixed(0)}%`, color: 'var(--blue)', tab: 'project',
        text: ports || `${running} running · ${short(p.memRss)}`,
        history: [{ values: h.projectCpu, color: 'var(--blue)' }],
        title: `${name}${branch ? ` (${branch})` : ''}\n${running} running · ${p.processCount} processes · ${bytes(p.memRss)}\nClick to open project monitor` }));
    }
    return rows.join('');
  }

  // ---------- render ----------
  const regions = {};
  function region(id, html) {
    let el = regions[id];
    if (!el) {
      el = regions[id] = document.createElement('div');
      el.id = id;
      app.appendChild(el);
    }
    // Skip DOM work when nothing changed, so hover and focus survive refreshes.
    if (el.__html !== html) {
      el.__html = html;
      el.innerHTML = html;
    }
    return el;
  }

  function render() {
    if (compact) {
      region('compact', compactView());
      return;
    }
    region('top', `<div class="topbar">
      <div class="tabs" role="tablist">
        <button class="tab ${state.tab === 'system' ? 'active' : ''}" role="tab" aria-selected="${state.tab === 'system'}" data-action="tab" data-tab="system">System</button>
        <button class="tab ${state.tab === 'project' ? 'active' : ''}" role="tab" aria-selected="${state.tab === 'project'}" data-action="tab" data-tab="project">Project</button>
      </div>
      <button class="live ${state.paused ? 'paused' : ''}" data-action="pause" title="${state.paused ? 'Resume' : 'Pause'} monitoring"><span class="dot"></span>${state.paused ? 'Paused' : 'Live'}</button>
    </div>${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}`);
    region('system', systemView()).hidden = state.tab !== 'system';
    region('project', state.tab === 'project' ? projectView() : '').hidden = state.tab !== 'project';
  }

  function persist() {
    vscode.setState({ tab: state.tab, expanded: [...state.expanded], showIdle: [...state.showIdle] });
  }

  app.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const el = /** @type {HTMLElement | null} */ (target.closest('[data-action]'));
    if (!el) { return; }
    const d = el.dataset;
    switch (d.action) {
      case 'tab':
        state.tab = d.tab || 'system';
        vscode.postMessage({ type: 'tab', tab: state.tab });
        break;
      case 'pause':
        vscode.postMessage({ type: 'pause' });
        break;
      case 'open':
        vscode.postMessage({ type: 'open', tab: d.tab });
        return;
      case 'toggle': {
        const pid = /^\d+$/.test(d.pid || '') ? Number(d.pid) : d.pid;
        state.expanded.has(pid) ? state.expanded.delete(pid) : state.expanded.add(pid);
        break;
      }
      case 'idle': {
        const key = d.key || '';
        state.showIdle.has(key) ? state.showIdle.delete(key) : state.showIdle.add(key);
        break;
      }
      case 'kill':
        e.stopPropagation();
        vscode.postMessage({ type: 'kill', pid: Number(d.pid), name: d.name });
        return;
      case 'openPort':
        e.stopPropagation();
        vscode.postMessage({ type: 'openPort', port: Number(d.port) });
        return;
      case 'runScript':
        vscode.postMessage({ type: 'runScript', folder: d.folder, script: d.script });
        return;
      case 'showTerminal':
        e.stopPropagation();
        vscode.postMessage({ type: 'showTerminal', name: d.name });
        return;
    }
    persist();
    render();
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'init':
        state.paused = m.paused;
        state.showGraph = m.showGraph;
        state.warning = m.warning;
        state.info = m.info;
        state.hasWorkspace = m.hasWorkspace;
        if (!compact && m.tab !== state.tab) { vscode.postMessage({ type: 'tab', tab: state.tab }); }
        break;
      case 'tab':
        if (compact) { break; }
        state.tab = m.tab;
        persist();
        break;
      case 'paused':
        state.paused = m.paused;
        break;
      case 'system':
        state.system = m.data;
        state.history = m.history;
        state.error = '';
        break;
      case 'project':
        state.project = m.data;
        state.history = m.history;
        state.error = '';
        break;
      case 'claude':
        state.claude = m.data;
        break;
      case 'projectInfo':
        state.info = m.info;
        state.hasWorkspace = m.hasWorkspace;
        break;
      case 'error':
        state.error = m.message;
        break;
    }
    render();
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
