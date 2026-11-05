// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  const state = {
    tab: saved.tab || 'system',
    paused: false,
    showGraph: true,
    interval: 2000,
    warning: 85,
    budget: 0,
    hasWorkspace: true,
    info: [],
    system: null,
    project: null,
    claude: null,
    history: { cpu: [], memory: [], rx: [], tx: [], temp: [], limit: [], projectCpu: [], projectMem: [] },
    procSort: saved.procSort === 'mem' ? 'mem' : 'cpu',
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
  /** Hover text for the n-th of n history samples, e.g. "CPU 45% · 12s ago". */
  const sampleTips = (n, fmt) => Array.from({ length: n }, (_, i) => {
    const s = Math.round(((n - 1 - i) * state.interval) / 1000);
    return `${fmt(i)} · ${s ? (s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`) : 'now'}`;
  });
  // Wraps a chart so the shared tooltip can show one line per sample.
  const hoverable = (svg, tips) => (tips && tips.length ? `<div class="chart" data-tips="${esc(JSON.stringify(tips))}">${svg}</div>` : svg);

  function spark(series, { max, height = 34, tips } = {}) {
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
    return hoverable(`<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true">${paths}</svg>`, tips);
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
        ${spark([{ values: h.cpu, color: cpuColor }], { max: 100, tips: sampleTips(h.cpu.length, (i) => `CPU ${pct(h.cpu[i])}%`) })}
      </div>
      <div class="card gauge-card">
        <div class="gauge-head">${ring(s.memory.percent, memColor)}
          <div class="gauge-label"><div class="name">Memory</div><div class="big num">${pct(s.memory.percent)}<small>%</small></div>
          <div class="sub num" title="${bytes(s.memory.used)} of ${bytes(s.memory.total)}">${bytes(s.memory.used)} / ${bytes(s.memory.total)}</div></div>
        </div>
        ${spark([{ values: h.memory, color: memColor }], { max: 100, tips: sampleTips(h.memory.length, (i) => `Memory ${pct(h.memory[i])}%`) })}
      </div>
    </div>`;

    const cores = s.cpu.cores.map((v, i) => {
      const c = loadColor(v, 'var(--blue)');
      return `<div class="core" title="Core ${i + 1}: ${pct(v)}%"><div class="fill" style="height:${Math.max(4, v)}%;background:color-mix(in srgb, ${c} 55%, transparent)"></div><span class="num">${pct(v)}</span></div>`;
    }).join('');
    const n = s.cpu.cores.length;
    const cols = n <= 8 ? n : Math.ceil(n / Math.ceil(n / 8));
    out += section('Cores', `<div class="card"><div class="cores" style="grid-template-columns:repeat(${cols},1fr)">${cores}</div></div>`, [`${s.cpu.cores.length} logical`, s.cpu.temperature ? `${Math.round(s.cpu.temperature)}°C` : '',
      s.cpu.loadAvg ? `<span title="Load average · 1, 5 and 15 min: ${s.cpu.loadAvg.map((v) => v.toFixed(2)).join(' · ')}">load ${s.cpu.loadAvg[0].toFixed(1)}</span>` : ''].filter(Boolean).join(' · '));

    out += processesView(s.processes);

    if (s.network) {
      out += section('Network', `<div class="card">
        <div class="net">
          <div><div class="dir"><span class="legend" style="background:var(--green)"></span>Download</div><div class="rate num">${rate(s.network.rxSec)}</div></div>
          <div><div class="dir"><span class="legend" style="background:var(--orange)"></span>Upload</div><div class="rate num">${rate(s.network.txSec)}</div></div>
        </div>
        ${spark([{ values: h.rx, color: 'var(--green)' }, { values: h.tx, color: 'var(--orange)' }], { tips: sampleTips(h.rx.length, (i) => `↓ ${rate(h.rx[i])}  ↑ ${rate(h.tx[i])}`) })}
      </div>`, esc([s.network.iface, s.network.ip4].filter(Boolean).join(' · ')));
    }

    const rows = [];
    {
      if (s.memory.swapTotal > 0) {
        const sp = (s.memory.swapUsed / s.memory.swapTotal) * 100;
        rows.push(`<div><div class="row-head"><span class="label">Swap</span><span class="muted num">${bytes(s.memory.swapUsed)} / ${bytes(s.memory.swapTotal)}</span></div>${bar(sp, 'var(--purple)')}</div>`);
      }
      for (const d of s.disk || []) {
        rows.push(`<div><div class="row-head"><span class="label mono" title="${esc(d.mount)}">${esc(d.mount)}</span><span class="muted num">${bytes(d.used)} / ${bytes(d.size)}</span></div>${bar(d.percent, 'var(--blue)')}</div>`);
      }
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
    if (rows.length || extras.length) {
      out += section(extras.length ? (rows.length ? 'Storage & hardware' : 'Hardware') : 'Storage', `<div class="card rows">${[...rows, ...extras].join('')}</div>`);
    }

    if (s.services && s.services.length) {
      // Running services get a chip each; the rest fold into one line so they don't eat the panel.
      const on = s.services.filter((x) => x.running);
      const off = s.services.filter((x) => !x.running);
      const chips = on.map((sv) => `<span class="chip on" title="PID ${sv.pids.join(', ')} · CPU ${pct(sv.cpu)}% · memory ${pct(sv.mem)}%"><span class="dot"></span>${esc(sv.name)}<span class="meta num">${pct(sv.cpu)}% · ${pct(sv.mem)}%</span></span>`).join('');
      const offLine = off.length ? `<div class="svc-off"><span class="dot"></span>Off · ${off.map((x) => esc(x.name)).join(', ')}</div>` : '';
      out += section('Services', `${on.length ? `<div class="chips">${chips}</div>` : ''}${offLine}`, `${on.length}/${s.services.length} running`);
    }

    out += `<div class="footer"><span title="${esc(s.cpu.brand)}">${esc(s.cpu.brand)}${s.cpu.speed ? ` · ${s.cpu.speed} GHz` : ''}</span><span class="num">up ${duration(s.uptime)}</span></div>`;
    return out;
  }

  /** Heaviest apps right now, sortable by CPU or memory. */
  function processesView(list) {
    if (!list || !list.length) { return ''; }
    const byMem = state.procSort === 'mem';
    const top = [...list].sort((a, b) => byMem ? b.memRss - a.memRss : b.cpu - a.cpu).slice(0, 6);
    const max = Math.max(byMem ? 1 : 0.1, ...top.map((p) => byMem ? p.memRss : p.cpu));
    const rows = top.map((p) => {
      const v = byMem ? p.memRss : p.cpu;
      const color = byMem ? 'var(--purple)' : 'var(--blue)';
      return `<div class="top-proc" title="${esc(p.name)}${p.count > 1 ? ` · ${p.count} processes` : ''} · CPU ${p.cpu.toFixed(1)}% · ${bytes(p.memRss)} (${p.memPercent.toFixed(1)}%)">
        <span class="pname">${esc(p.name)}${p.count > 1 ? `<span class="muted"> ×${p.count}</span>` : ''}</span>
        <span class="cc-heat"><span style="width:${(v / max) * 100}%;background:${color}"></span></span>
        <span class="num ${byMem ? 'muted' : ''}">${p.cpu.toFixed(1)}%</span>
        <span class="num ${byMem ? '' : 'muted'}">${bytes(p.memRss)}</span>
      </div>`;
    }).join('');
    const sort = `<span class="seg"><button class="${byMem ? '' : 'on'}" data-action="procSort" data-sort="cpu">CPU</button><button class="${byMem ? 'on' : ''}" data-action="procSort" data-sort="mem">MEM</button></span>`;
    return section('Top apps', `<div class="card top-procs">${rows}</div>`, sort);
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
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  };
  const todoIcon = { completed: '✓', in_progress: '●', pending: '○' };
  const CATS = [
    ['read', 'Explore', 'var(--blue)'],
    ['edit', 'Edit', 'var(--green)'],
    ['run', 'Run', 'var(--orange)'],
    ['web', 'Web', 'var(--purple)'],
    ['agent', 'Agents', 'var(--yellow)'],
    ['other', 'Other', 'var(--muted)']
  ];
  const catColor = Object.fromEntries(CATS.map(([k, , c]) => [k, c]));
  const count = (n) => {
    for (const [v, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
      if (n >= v) { return `${(n / v).toFixed(n >= v * 10 ? 0 : 1)}${u}`; }
    }
    return String(Math.round(n));
  };
  const toolTag = (s) => `<span class="tool" style="color:${catColor[s.cat] || 'var(--blue)'}">${esc(s.tool)}</span>`;

  function statusOf(c) {
    if (c.state === 'working') { return { cls: 'working', label: 'Working' }; }
    if (c.state === 'waiting') {
      return c.waitingOn === 'you' ? { cls: 'waiting', label: 'Your turn' } : { cls: 'waiting', label: `Waiting on ${c.waitingOn}` };
    }
    return { cls: '', label: 'Idle' };
  }

  /** Tool calls per minute, stacked by category, oldest on the left; zoomed to the session when it is younger than the window. */
  function timeline(all, started) {
    const age = started ? Math.ceil((Date.now() - started) / 60000) : all.length;
    const buckets = all.slice(-Math.min(all.length, Math.max(10, age)));
    const W = 300, H = 34, n = buckets.length, gap = 2, bw = W / n - gap;
    const totals = buckets.map((b) => CATS.reduce((sum, [k]) => sum + (b[k] || 0), 0));
    const top = Math.max(1, ...totals);
    const bars = buckets.map((b, i) => {
      let y = H;
      const x = (i * W) / n;
      const rects = CATS.map(([k, , color]) => {
        const v = b[k] || 0;
        if (!v) { return ''; }
        const h = Math.max(2, (v / top) * (H - 2));
        y -= h;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${color}"></rect>`;
      }).join('');
      const empty = totals[i] ? '' : `<rect x="${x.toFixed(1)}" y="${H - 2}" width="${bw.toFixed(1)}" height="2" rx="1" class="cc-empty"></rect>`;
      return `<g>${rects}${empty}</g>`;
    }).join('');
    const tips = buckets.map((b, i) => {
      const when = n - i - 1 ? `${n - i - 1}m ago` : 'This minute';
      const kinds = CATS.filter(([k]) => b[k]).map(([k, label]) => `${label} ${b[k]}`).join(' · ');
      return `${when} · ${totals[i]} call${totals[i] === 1 ? '' : 's'}${kinds ? `\n${kinds}` : ''}`;
    });
    return { n, html: hoverable(`<svg class="cc-timeline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`, tips) };
  }

  /** How the context filled up over the session, resampled to even steps; sharp drops are compactions. */
  function contextChart(c) {
    const series = c.contextSeries || [];
    if (!c.context || series.length < 2 || !state.showGraph) { return ''; }
    const limit = c.context.limit;
    const t0 = series[0][0], t1 = Math.max(c.updated, series[series.length - 1][0] + 1);
    const N = 60, W = 300, H = 36;
    const vals = [], marks = new Set();
    let j = 0, last = series[0][1];
    for (let i = 0; i < N; i++) {
      const until = t0 + ((i + 1) / N) * (t1 - t0);
      let low = last;
      while (j < series.length && series[j][0] <= until) {
        if (series[j][1] < last * 0.6) { marks.add(i); }
        last = series[j][1];
        low = Math.min(low, last);
        j++;
      }
      vals.push(last);
    }
    const y = (v) => H - (Math.min(v, limit) / limit) * (H - 2) - 1;
    const pts = vals.map((v, i) => [((i + 0.5) / N) * W, y(v)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const color = loadColor(c.context.percent, 'var(--blue)');
    const warn = y(limit * 0.8);
    const dots = [...marks].map((i) => `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="2.2" class="cc-compact"></circle>`).join('');
    const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const tips = vals.map((v, i) => `${clock(t0 + ((i + 1) / N) * (t1 - t0))} · ${count(v)} of ${count(limit)} (${Math.round((v / limit) * 100)}%)${marks.has(i) ? '\nCompacted' : ''}`);
    const svg = `<svg class="spark cc-ctx-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true">
      <line x1="0" x2="${W}" y1="${warn.toFixed(1)}" y2="${warn.toFixed(1)}" class="cc-warn-line"></line>
      <path class="area" d="${line}L${W},${H}L0,${H}Z" fill="${color}"></path><path class="line" d="${line}" stroke="${color}"></path>${dots}</svg>`;
    return `${hoverable(svg, tips)}<div class="axis"><span>${clock(t0)}</span>${marks.size ? `<span class="cc-compact-key">● ${marks.size} compaction${marks.size === 1 ? '' : 's'}</span>` : ''}<span>now</span></div>`;
  }

  function claudeSession(c, first) {
    const st = statusOf(c);
    const done = c.todos.filter((t) => t.status === 'completed').length;
    const total = c.todos.length;
    const open = first || state.expanded.has(c.id);
    const cur = c.current;
    const meta = [
      `<span class="cc-state ${st.cls}">${esc(st.label)}</span>`,
      ago(c.updated),
      c.model ? esc(c.model) : '',
      c.started ? `<span title="Session started ${esc(new Date(c.started).toLocaleTimeString())}">⏱ ${duration((c.updated - c.started) / 1000)}</span>` : '',
      c.failedCalls ? `<span class="cc-err" title="Tool calls that returned an error">${c.failedCalls} failed</span>` : ''
    ].filter(Boolean).join(' · ');

    let now = '';
    if (c.state === 'waiting') {
      now = `<div class="cc-now waiting">${c.waitingOn === 'you'
        ? '<span class="tool">Your turn</span><span class="detail">Claude finished — waiting for your next prompt</span>'
        : `<span class="tool">${esc(c.waitingOn)}</span><span class="detail">Needs approval or is still running${cur && cur.tool === c.waitingOn ? ` · ${esc(cur.detail)}` : ''}</span>`}</div>`;
    } else if (cur && c.state === 'working') {
      now = `<div class="cc-now">${toolTag(cur)}<span class="detail" title="${esc(cur.detail)}">${esc(cur.detail)}</span></div>`;
    }

    const ctx = c.context
      ? `<div class="cc-context" title="Prompt size of the latest request, including cached context"><div class="row-head"><span class="label">Context</span><span class="muted num">${esc(c.context.text)} · ${Math.round(c.context.percent)}%</span></div>${bar(c.context.percent, 'var(--blue)')}</div>`
      : '';

    const progress = total
      ? `<div class="cc-progress"><div class="row-head"><span class="label">Plan</span><span class="muted num">${done}/${total} tasks</span></div>
          <div class="bar"><div style="width:${(done / total) * 100}%;background:var(--green)"></div></div>
          <div class="cc-todos">${c.todos.map((t) => `<div class="cc-todo ${esc(todoIcon[t.status] ? t.status : 'pending')}"><span class="ico">${todoIcon[t.status] || '○'}</span><span>${esc(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</span></div>`).join('')}</div>
        </div>`
      : '';

    const mix = CATS.filter(([k]) => c.toolMix[k]).map(([k, label, color]) =>
      `<span class="cc-mix"><span class="legend" style="background:${color}"></span>${label} <b class="num">${c.toolMix[k]}</b></span>`).join('');
    const activity = c.toolCalls
      ? (() => { const tl = timeline(c.timeline, c.started); return `<div><div class="cc-label">Activity · last ${tl.n} min</div>${tl.html}<div class="cc-mixes">${mix}</div></div>`; })()
      : '';

    const hot = c.hotFiles.length
      ? `<div class="cc-label">Hot files</div><div class="cc-steps">${c.hotFiles.map((f) => {
          const w = (f.edits / c.hotFiles[0].edits) * 100;
          return `<button class="cc-file" data-action="openFile" data-path="${esc(f.path)}" title="Open ${esc(f.path)}"><span class="detail">${esc(f.name)}</span><span class="cc-heat"><span style="width:${w}%"></span></span><span class="muted num">${f.edits}×</span></button>`;
        }).join('')}</div>`
      : '';

    const models = c.models.length
      ? `<div><div class="cc-label">Models${c.cacheHit != null ? ` · cache ${Math.round(c.cacheHit)}% hit · saved ${esc(c.cacheSaved)}` : ''}</div>
          <div class="cc-steps">${c.models.map((m) => `<div class="cc-model"><span class="detail">${esc(m.model)}</span><span class="cc-heat"><span style="width:${m.share}%;background:var(--purple)"></span></span><span class="muted num">${esc(m.tokens)} · ${esc(m.cost)}</span></div>`).join('')}</div></div>`
      : '';
    const research = c.research.length
      ? `<div><div class="cc-label">Research · ${c.research.length}</div><div class="cc-steps">${c.research.map((r) => r.kind === 'fetch'
          ? `<button class="cc-step cc-link-row" data-action="openLink" data-url="${esc(r.url)}" title="Open ${esc(r.url)}"><span class="cc-ico" style="color:var(--purple)">↗</span><span class="detail">${esc(r.text)}</span><span class="muted">${ago(r.time)}</span></button>`
          : `<div class="cc-step"><span class="cc-ico" style="color:var(--purple)">⌕</span><span class="detail" title="${esc(r.text)}">${esc(r.text)}</span><span class="muted">${ago(r.time)}</span></div>`).join('')}</div></div>`
      : '';
    const errors = c.errors.length
      ? `<div><div class="cc-label">Errors · ${c.failedCalls}</div><div class="cc-steps">${c.errors.map((e) => `<div class="cc-step"><span class="tool" style="color:var(--red)">${esc(e.tool)}</span><span class="detail" title="${esc(e.message)}">${esc(e.message)}</span><span class="muted">${ago(e.time)}</span></div>`).join('')}</div></div>`
      : '';

    const steps = c.steps.length
      ? `<div class="cc-steps">${c.steps.map((s) => `<div class="cc-step">${toolTag(s)}<span class="detail" title="${esc(s.detail)}">${esc(s.detail)}</span><span class="muted">${ago(s.time)}</span></div>`).join('')}</div>`
      : '';
    const agents = c.agents || [];
    const running = agents.filter((a) => a.state === 'working').length;
    const agentList = agents.length
      ? `<div class="cc-label">Agents · ${running ? `${running} running · ` : ''}${agents.length} total</div>
        <div class="cc-steps">${agents.slice(0, open ? agents.length : 3).map((a) => `<div class="cc-step"><span class="cc-pulse ${a.state === 'working' ? 'on' : ''}"></span><span class="detail" title="${esc(a.type)}">${esc(a.description)}</span><span class="muted num">${a.toolCalls} calls · ${esc(a.tokens)} · ${esc(a.cost)}</span></div>`).join('')}</div>`
      : '';
    const loop = c.loop
      ? `<div class="cc-loop" title="The same call keeps failing, or a file keeps being edited while errors continue"><span class="ico">⟳</span><span><b>Looks stuck</b> · ${esc(c.loop.text)}</span></div>`
      : '';
    const turns = c.turns || [];
    const checkpoints = turns.length
      ? `<div><div class="cc-label">Checkpoints · undo Claude's edits back to before a prompt</div><div class="cc-steps">${turns.map((t) => `<div class="cc-turn">
          <div class="proc-main"><div class="cc-turn-prompt" title="${esc(t.prompt)}">› ${esc(t.prompt)}</div>
            <div class="proc-cmd" title="${esc(t.files.join('\n'))}">${t.files.length} file${t.files.length === 1 ? '' : 's'} · ${esc(t.files.slice(0, 3).map((f) => f.split(/[\\/]/).pop()).join(', '))}${t.files.length > 3 ? '…' : ''} · ${ago(t.time)}</div></div>
          <button class="chip cc-undo" data-action="undoTurn" data-session="${esc(c.id)}" data-turn="${esc(t.id)}" title="Restore the files Claude changed from this prompt on (asks first)">↶ Undo</button>
        </div>`).join('')}</div></div>`
      : '';
    const lines = c.linesAdded || c.linesRemoved
      ? `<span class="add">+${count(c.linesAdded)}</span> <span class="del">−${count(c.linesRemoved)}</span>`
      : '0';

    return `<div class="card cc-session ${st.cls}">
      <div class="cc-head" data-action="toggle" data-pid="${esc(c.id)}">
        <span class="cc-pulse ${st.cls === 'working' ? 'on' : st.cls}"></span>
        <div class="proc-main">
          <div class="proc-title"><span class="pname" title="${esc(c.title)}">${esc(c.title)}</span>${c.folder && state.info.length > 1 ? `<span class="badge">${esc(c.folder)}</span>` : ''}</div>
          <div class="proc-cmd">${meta}</div>
        </div>
        <span class="twisty ${open ? 'down' : ''}">${chevron}</span>
      </div>
      ${c.prompt ? `<div class="cc-prompt" title="${esc(c.prompt)}">${esc(c.prompt)}</div>` : ''}
      ${now}
      ${loop}
      <div class="stats cc-stats">
        <div class="stat" title="${esc(c.tokenDetail)}"><div class="v num">${esc(c.tokens)}</div><div class="l">Tokens</div></div>
        <div class="stat" title="Billing amount if this usage were paid through the Anthropic API"><div class="v num">${esc(c.cost)}</div><div class="l">Est. cost</div></div>
        <div class="stat" title="Billing amount per hour if paid through the Anthropic API"><div class="v num">${esc(c.burnRate)}</div><div class="l">Burn rate</div></div>
      </div>
      ${ctx}
      ${open ? contextChart(c) : ''}
      <div class="stats cc-stats cc-minor">
        <div class="stat"><div class="v num">${c.toolCalls}</div><div class="l">Tool calls</div></div>
        <div class="stat"><div class="v num">${c.filesTouched}</div><div class="l">Files edited</div></div>
        <div class="stat" title="Lines written and replaced by edits"><div class="v num">${lines}</div><div class="l">Lines</div></div>
      </div>
      ${open ? activity : ''}
      ${progress}
      ${open ? models : ''}
      ${open ? research : ''}
      ${agentList}
      ${open ? checkpoints : ''}
      ${open ? hot : ''}
      ${open ? errors : ''}
      ${open && steps ? `<div class="cc-label">Recent activity</div>${steps}` : ''}
    </div>`;
  }

  // ---------- plan limits ----------
  const limitColor = (v) => (v >= 90 ? 'var(--red)' : v >= 70 ? 'var(--yellow)' : 'var(--green)');

  function resetText(t) {
    if (!t) { return 'resets with your next message'; }
    const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
    const d = new Date(t);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay = d.toDateString() === new Date().toDateString();
    const when = sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
    const left = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
    return `resets in ${left} · ${when}`;
  }

  // Every window past its reset reads 0% with no reset time: nothing worth a section.
  const limitsUseful = (l) => !!(l && l.limits.length && l.limits.some((x) => x.percent > 0 || x.resetsAt > 0));

  const overBudget = () => !!(state.budget > 0 && state.claude && state.claude.today && state.claude.today.costUsd > state.budget);

  function limitsView() {
    const l = state.claude && state.claude.limits;
    const link = '<button class="chip script" data-action="checkUsage" title="Open Claude Code with /usage filled in, to refresh these numbers">/usage</button>';
    // Read from Claude Code's internal cache; when that isn't there or changed shape, leave the section out.
    if (!limitsUseful(l)) { return ''; }
    const rows = l.limits.map((x) => `<div title="${esc(x.label)}: ${Math.round(x.percent)}% used">
        <div class="row-head"><span class="label">${esc(x.label)}</span><span class="muted num">${Math.round(x.percent)}% · ${esc(resetText(x.resetsAt))}</span></div>
        <div class="bar"><div style="width:${Math.min(100, x.percent)}%;background:${limitColor(x.percent)}"></div></div>
      </div>`).join('');
    return section('Plan usage', `<div class="card rows cc-limits">${rows}<div class="cc-limits-actions"><span class="muted">Updated ${ago(l.updated)}</span>${link}</div></div>`);
  }

  function claudeTotals(c) {
    const sessions = c ? c.sessions : [];
    const costs = sessions.map((s) => s.costUsd).filter((v) => v != null);
    return {
      sessions,
      working: sessions.filter((s) => s.state === 'working').length,
      waiting: sessions.filter((s) => s.state === 'waiting').length,
      cost: costs.length ? `$${costs.reduce((a, b) => a + b, 0).toFixed(2)}` : '—',
      calls: sessions.reduce((n, s) => n + s.toolCalls, 0),
      files: sessions.reduce((n, s) => n + s.filesTouched, 0)
    };
  }

  function claudeView() {
    return limitsView() + projectTotalsView() + claudeSessions();
  }

  /** What Claude Code has spent on this project, over every chat it kept. */
  function projectTotalsView() {
    const c = state.claude;
    if (!state.hasWorkspace || !c || !c.project || !c.project.sessions) { return ''; }
    const p = c.project;
    const name = state.info.length ? state.info.map((i) => i.name).join(', ') : 'This project';
    const total = Math.max(1, p.toolCalls);
    const segs = CATS.filter(([k]) => p.toolMix[k]).map(([k, label, color]) =>
      `<span style="width:${(p.toolMix[k] / total) * 100}%;background:${color}" title="${label} · ${p.toolMix[k]} calls"></span>`).join('');
    const mix = CATS.filter(([k]) => p.toolMix[k]).map(([k, label, color]) =>
      `<span class="cc-mix"><span class="legend" style="background:${color}"></span>${label} <b class="num">${count(p.toolMix[k])}</b></span>`).join('');
    const since = p.since ? new Date(p.since).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(p.since).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '';
    return `<div class="card cc-project">
      <div class="cc-project-head"><strong title="${esc(name)}">${esc(name)}</strong><span class="muted">${p.sessions} chat${p.sessions === 1 ? '' : 's'}${since ? ` · since ${esc(since)}` : ''}</span></div>
      <div class="stats">
        <div class="stat" title="${API_NOTE}"><div class="v num">${esc(p.cost)}</div><div class="l">Est. cost</div></div>
        <div class="stat" title="${esc(p.tokenDetail)}"><div class="v num">${esc(p.tokens)}</div><div class="l">Tokens</div></div>
        <div class="stat"><div class="v num">${count(p.toolCalls)}</div><div class="l">Tool calls</div></div>
      </div>
      ${p.toolCalls ? `<div class="mixbar">${segs}</div><div class="cc-mixes">${mix}</div>` : ''}
    </div>`;
  }

  function claudeSessions() {
    if (!state.hasWorkspace) {
      return `<div class="empty-state"><div class="title">No folder open</div>Open the folder you run Claude Code in to follow its sessions here.</div>`;
    }
    if (!state.claude) { return '<div class="skeleton" style="height:120px"></div>'; }
    const t = claudeTotals(state.claude);
    if (!t.sessions.length) {
      const empty = `<div class="empty-state"><div class="title">No active Claude Code session</div>Run <span class="mono">claude</span> in this workspace. Live tool calls, context, cost and edited files show up here.</div>`;
      return (state.claude.week && state.claude.week.some((d) => d.cost) ? weekView(t) : '') + resourceView() + historyView() + empty;
    }
    const aside = [t.working ? `${t.working} working` : '', t.waiting ? `${t.waiting} waiting` : ''].filter(Boolean).join(' · ') || 'idle';
    return weekView(t) + resourceView() + agentsView(t.sessions) + section('Sessions', t.sessions.map((s, i) => claudeSession(s, i === 0)).join(''), aside) + historyView();
  }

  const API_NOTE = 'Billing amount if this usage were paid through the Anthropic API';

  /** Today at a glance, and spend per day over the last week. */
  function weekView(t) {
    const c = state.claude;
    const week = c.week || [];
    const top = Math.max(0.01, ...week.map((d) => d.cost));
    const total = week.reduce((n, d) => n + d.cost, 0);
    const avg = total / Math.max(1, week.length);
    const prev = c.prevWeek && c.prevWeek.cost;
    const delta = prev >= 0.01 ? Math.round(((total - prev) / prev) * 100) : null;
    const trend = delta == null ? '' : `<span class="trend ${delta > 0 ? 'up' : 'down'}" data-tip="${esc(`Previous 7 days: $${prev.toFixed(2)}`)}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span>`;
    const bars = week.map((d) => `<div class="cc-day ${d.label === 'Today' ? 'today' : ''}" data-tip="${esc(`${d.label} · $${d.cost.toFixed(2)} · ${count(d.tokens)} tokens${avg >= 0.01 ? `\n${d.cost >= avg ? `${(d.cost / avg).toFixed(1)}× ` : ''}${d.cost >= avg ? 'the' : 'below the'} daily average of $${avg.toFixed(2)}` : ''}`)}">
        <span class="cc-day-cost num">${d.cost >= 0.01 ? `$${d.cost < 10 ? d.cost.toFixed(2) : Math.round(d.cost)}` : ''}</span>
        <span class="cc-day-bar"><span style="height:${Math.max(d.cost ? 4 : 0, (d.cost / top) * 100)}%"></span></span>
        <span class="cc-day-label">${esc(d.label)}</span>
      </div>`).join('');
    const live = t.sessions.length
      ? `<div class="stats">
        <div class="stat"><div class="v num">${t.working}<small class="muted"> / ${t.sessions.length}</small></div><div class="l">Working</div></div>
        <div class="stat"><div class="v num ${t.waiting ? 'cc-attn' : ''}">${t.waiting}</div><div class="l">Waiting on you</div></div>
        <div class="stat" title="${API_NOTE}"><div class="v num">${esc(c.today.cost)}</div><div class="l">Today · ${c.today.sessions} chat${c.today.sessions === 1 ? '' : 's'}</div></div>
      </div>`
      : `<div class="cc-label cc-week-label cc-first"><span>Today · ${c.today.sessions} chat${c.today.sessions === 1 ? '' : 's'}</span><span class="num" title="${API_NOTE}">${esc(c.today.cost)} · ${esc(c.today.tokens)} tokens</span></div>`;
    return `<div class="card cc-overview">
      ${live}
      ${tokenGraph(c.tokenSplit)}
      ${week.length ? `<div class="cc-label cc-week-label"><span>Last 7 days</span><span class="num" title="${API_NOTE}">${trend}$${total.toFixed(2)}</span></div><div class="cc-week">${bars}</div>` : ''}
    </div>`;
  }

  /** Subagents running right now across the live chats: what each one is and which tool it is using. Hidden when none run. */
  function agentsView(sessions) {
    const running = sessions
      .flatMap((s) => (s.agents || []).map((a) => ({ ...a, parent: s })))
      .filter((a) => a.state === 'working')
      .sort((a, b) => a.started - b.started);
    if (!running.length) { return ''; }
    const many = new Set(running.map((a) => a.parent.id)).size > 1;
    const rows = running.map((a) => {
      const doing = a.current
        ? `<span class="tool" style="color:${catColor[a.current.cat] || 'var(--blue)'}">${esc(a.current.tool)}</span><span class="detail">${esc(a.current.detail)}</span>`
        : '<span class="detail muted">Starting…</span>';
      return `<div class="cc-agent" data-tip="${esc(`${a.description}${a.type ? ` · ${a.type}` : ''}\nIn: ${a.parent.title}\n${a.toolCalls} tool calls · ${a.tokens} tokens · ${a.cost}`)}">
        <span class="cc-pulse on"></span>
        <div class="proc-main">
          <div class="cc-agent-head"><span class="pname">${esc(a.description)}</span>${a.type ? `<span class="badge cc-agent-type">${esc(a.type)}</span>` : ''}</div>
          <div class="cc-agent-now">${doing}</div>
          ${many ? `<div class="proc-cmd">↳ ${esc(a.parent.title)}</div>` : ''}
        </div>
        <div class="cc-agent-meta num"><b>${duration(Math.max(0, (Date.now() - a.started) / 1000))}</b><span class="muted">${a.toolCalls} calls</span></div>
      </div>`;
    }).join('');
    return section('Agents', `<div class="card cc-agents">${rows}</div>`, `${running.length} running`);
  }

  /** How hard Claude Code's own processes work this machine, against everything else running. */
  function resourceView() {
    const r = state.claude && state.claude.resources;
    const s = state.system;
    if (!r || !r.count) { return ''; }
    const sysCpu = s ? s.cpu.load : null;
    const memShare = r.memTotal ? (r.memRss / r.memTotal) * 100 : 0;
    const sysMem = s ? s.memory.percent : null;
    const rate = (state.claude.tokenRate || []);
    const now = rate[rate.length - 1] || 0;
    const busy = rate.slice(-10).filter(Boolean);
    const avg = busy.length ? busy.reduce((a, b) => a + b, 0) / busy.length : 0;
    // Claude's slice drawn over the whole system load, so "is it Claude or something else?" reads at a glance.
    const stack = (own, total, color) => `<div class="bar stack">${total != null ? `<div class="rest" style="width:${Math.min(100, total)}%"></div>` : ''}<div style="width:${Math.min(100, own)}%;background:${color}"></div></div>`;
    return section('Claude Code load', `<div class="card rows cc-load">
      <div title="CPU used by ${r.count} claude process${r.count === 1 ? '' : 'es'}, as a share of all cores${sysCpu != null ? `; the system as a whole is at ${pct(sysCpu)}%` : ''}">
        <div class="row-head"><span class="label">CPU</span><span class="muted num"><b class="own">${r.cpu.toFixed(1)}%</b>${sysCpu != null ? ` of ${pct(sysCpu)}% system` : ''}</span></div>
        ${stack(r.cpu, sysCpu, 'var(--orange)')}
      </div>
      <div title="Resident memory of the claude processes${sysMem != null ? `; ${pct(sysMem)}% of RAM is in use overall` : ''}">
        <div class="row-head"><span class="label">Memory</span><span class="muted num"><b class="own">${bytes(r.memRss)}</b>${sysMem != null ? ` · ${memShare.toFixed(1)}% of ${pct(sysMem)}% used` : ''}</span></div>
        ${stack(memShare, sysMem, 'var(--purple)')}
      </div>
      <div class="kv"><span class="k">Throughput</span><span class="num" title="Tokens per minute: this minute, and the average over active minutes in the last 10">${count(now)}/min · avg ${count(avg)}/min</span></div>
      <div class="kv"><span class="k">Processes</span><span class="num">${r.count}</span></div>
    </div>`, 'vs system');
  }

  /** Tokens per minute over the last hour: new tokens over cache reads, with the running cost on top. */
  function tokenGraph(split) {
    if (!split || !state.showGraph) { return ''; }
    const n = split.fresh.length;
    const totals = split.fresh.map((f, i) => f + split.cached[i]);
    if (!totals.some(Boolean)) { return ''; }
    const W = 300, H = 56, bw = W / n;
    const top = Math.max(...totals) * 1.08;
    let run = 0;
    const cum = split.cost.map((v) => (run += v));
    const costTop = Math.max(0.0001, run);
    const bars = totals.map((t, i) => {
      if (!t) { return ''; }
      const x = (i * bw + 0.4).toFixed(1), w = Math.max(0.6, bw - 0.8).toFixed(1);
      const hc = (split.cached[i] / top) * H, hf = Math.max(split.fresh[i] ? 1.5 : 0, (split.fresh[i] / top) * H);
      return `<rect x="${x}" y="${(H - hc).toFixed(1)}" width="${w}" height="${hc.toFixed(1)}" class="tk-cached"></rect>` +
        `<rect x="${x}" y="${(H - hc - hf).toFixed(1)}" width="${w}" height="${hf.toFixed(1)}" class="tk-fresh"></rect>`;
    }).join('');
    const costLine = cum.map((v, i) => `${i ? 'L' : 'M'}${((i + 0.5) * bw).toFixed(1)},${(H - (v / costTop) * (H - 3) - 1.5).toFixed(1)}`).join('');
    const fmt = (v) => (v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? '<$0.01' : '$0');
    const tips = totals.map((t, i) => {
      const ago = n - i - 1 ? `${n - i - 1}m ago` : 'This minute';
      return `${ago} · ${count(t)} tokens\n${count(split.fresh[i])} new · ${count(split.cached[i])} cache reads\n${fmt(split.cost[i])} this minute · ${fmt(cum[i])} so far`;
    });
    const fresh = split.fresh.reduce((a, b) => a + b, 0), cached = split.cached.reduce((a, b) => a + b, 0);
    const svg = `<svg class="tk-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true">${bars}<path d="${costLine}" class="tk-cost"></path></svg>`;
    return `<div class="cc-label cc-week-label"><span>Tokens · last hour</span><span class="num">${esc(count(fresh + cached))} · ${fmt(run)}</span></div>
      <div class="cc-rate">${hoverable(svg, tips)}</div>
      <div class="axis"><span>60m</span><span>30m</span><span>now</span></div>
      <div class="cc-mixes"><span class="cc-mix"><span class="legend tk-fresh-k"></span>New <b class="num">${count(fresh)}</b></span><span class="cc-mix"><span class="legend tk-cached-k"></span>Cache reads <b class="num">${count(cached)}</b></span><span class="cc-mix"><span class="legend tk-cost-k"></span>Cost <b class="num">${fmt(run)}</b></span></div>`;
  }

  /** Earlier sessions in this workspace, each one resumable in a terminal. */
  function historyView() {
    const h = (state.claude && state.claude.history) || [];
    if (!h.length) { return ''; }
    const rows = h.map((p) => {
      const ctx = p.context
        ? `<div class="cc-ctx" title="Context of the latest request: ${esc(p.context.text)}"><span class="bar"><span style="width:${Math.max(1, p.context.percent)}%;background:${loadColor(p.context.percent, 'var(--blue)')}"></span></span><span class="muted num">${Math.round(p.context.percent)}% · ${esc(p.context.text)}</span></div>`
        : '';
      return `<div class="cc-past">
        <div class="proc-main"><div class="pname" title="${esc(p.title)}">${esc(p.title)}</div>
          <div class="proc-cmd">${ago(p.updated)} · ${esc(p.tokens)} tokens · ${p.toolCalls} calls · ${esc(p.cost)}</div>${ctx}</div>
        <button class="chip script" data-action="resume" data-id="${esc(p.id)}" title="Run claude --resume in a new terminal">Resume</button>
      </div>`;
    }).join('');
    return section('Chats', `<div class="card cc-history">${rows}</div>`, 'context · last 7 days');
  }

  /** Small Claude Code summary on the Project tab; clicking it opens the Claude tab. */
  function claudeLink() {
    const c = state.claude;
    const t = claudeTotals(c);
    const p = c && c.project;
    if (!t.sessions.length && !(p && p.sessions)) { return ''; }
    const s = t.sessions[0];
    const st = s ? statusOf(s) : { cls: '', label: '' };
    const what = s
      ? (s.state === 'working' && s.current ? `${esc(s.current.tool)} · ${esc(s.current.detail)}` : esc(s.title))
      : `${p.sessions} chat${p.sessions === 1 ? '' : 's'}`;
    // Plain-language numbers for people new to Claude Code; the Claude tab has the detail.
    const tile = (value, label, tip, extra = '') => `<span class="cc-tile" data-tip="${esc(tip)}"><b class="num">${value}</b><span>${label}</span>${extra}</span>`;
    const spentToday = c && c.today
      ? tile(`<span class="${overBudget() ? 'cc-over' : ''}">${esc(c.today.cost)}</span>`, 'Spent today',
        `What today's Claude Code use in this project would cost at API prices.${state.budget ? `\nYour daily budget: $${state.budget.toFixed(2)}` : ''}\nOn a Pro or Max plan you pay the plan price, not this.`)
      : '';
    const ctxPct = s && s.context ? Math.round(s.context.percent) : null;
    const memory = ctxPct != null
      ? tile(`${ctxPct}%`, 'Chat memory used',
        `How much of Claude's memory this chat fills (${s.context.text} tokens).\nWhen it gets full, Claude summarises older messages and may forget details.`,
        `<span class="bar"><span style="width:${Math.max(2, ctxPct)}%;background:${loadColor(ctxPct, 'var(--blue)')}"></span></span>`)
      : '';
    const tiles = s
      ? [
          spentToday,
          tile(String(s.filesTouched), `File${s.filesTouched === 1 ? '' : 's'} changed`, 'Files Claude created or edited in this chat. Open the Claude tab to see which, or undo them.'),
          tile(count(s.toolCalls), 'Steps taken', 'Actions Claude ran in this chat: reading files, editing, running commands, searching the web.'),
          memory || tile(esc(s.tokens), 'Tokens used', 'Tokens are the chunks of text Claude reads and writes; usage and cost are counted in them.')
        ]
      : [
          spentToday,
          tile(esc(p.cost), 'Spent all time', 'What every Claude Code chat in this project would cost at API prices.'),
          tile(String(p.sessions), `Chat${p.sessions === 1 ? '' : 's'}`, 'Claude Code conversations in this project.'),
          tile(count(p.toolCalls), 'Steps taken', 'Actions Claude ran across all chats: reading files, editing, running commands, searching the web.')
        ];
    // One friendly hint when something needs attention.
    const hint = !s ? 'Run <span class="mono">claude</span> in a terminal here to start a chat.'
      : s.loop ? `⟳ Claude looks stuck (${esc(s.loop.text)}). Give it a hint or press Esc to stop it.`
      : ctxPct >= 80 ? 'Chat memory is nearly full. Type <span class="mono">/compact</span> to free it up, or start a new chat.'
      : s.state === 'waiting' && s.waitingOn === 'you' ? 'Claude is done and waiting for your reply.'
      : s.state === 'waiting' ? `Claude is waiting for you to approve <b>${esc(s.waitingOn)}</b>.`
      : '';
    return `<button class="card cc-link cc-mini ${st.cls}" data-action="tab" data-tab="claude" title="Open the Claude tab">
      <span class="cc-mini-top">
        <span class="cc-pulse ${st.cls === 'working' ? 'on' : st.cls}"></span>
        <span class="cc-link-main"><b>Claude Code</b>${st.label ? ` <span class="cc-state ${st.cls}">${esc(st.label)}</span>` : ''}<span class="detail">${what}</span></span>
        ${chevron}
      </span>
      <span class="cc-tiles">${tiles.filter(Boolean).join('')}</span>
      ${hint ? `<span class="cc-hint">${hint}</span>` : ''}
    </button>`;
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
      ${spark([{ values: h.projectCpu, color: 'var(--blue)' }], { tips: sampleTips(h.projectCpu.length, (i) => `CPU ${(h.projectCpu[i] || 0).toFixed(1)}% · ${bytes(h.projectMem[i])}`) })}
    </div>`;

    out += claudeLink();

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
  function mrow({ label, value, color, percent, text, history, max, tips, tab = 'system', title = '' }) {
    const middle = percent != null
      ? `<div class="bar">${percent > 0 ? `<div style="width:${Math.max(0, Math.min(100, percent))}%;background:${color}"></div>` : ''}</div>`
      : `<span class="mtext">${text || ''}</span>`;
    return `<div class="mrow" data-action="open" data-tab="${tab}" title="${esc(title)}">
      <span class="mlabel"><span class="mdot" style="background:${color}"></span>${label}</span>
      ${middle}
      <span class="mval num">${value}</span>
      <span class="mspark">${history ? spark(history, { max, height: 14, tips }) : ''}</span>
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
        tips: sampleTips(h.cpu.length, (i) => `CPU ${pct(h.cpu[i])}%`),
        title: `CPU ${pct(s.cpu.load)}% · user ${pct(s.cpu.user)}% · system ${pct(s.cpu.system)}%\n${s.cpu.cores.length} cores · ${s.cpu.brand}` }),
      mrow({ label: 'MEM', value: `${pct(s.memory.percent)}%`, color: memColor, percent: s.memory.percent, history: [{ values: h.memory, color: memColor }], max: 100,
        tips: sampleTips(h.memory.length, (i) => `Memory ${pct(h.memory[i])}%`),
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
    const lim = state.claude && state.claude.limits && state.claude.limits.limits;
    if (lim && lim.length && limitsUseful(state.claude.limits)) {
      const first = lim[0];
      const lc = limitColor(first.percent);
      rows.push(mrow({ label: 'LIM', value: `${Math.round(first.percent)}%`, color: lc, percent: first.percent, tab: 'claude',
        history: [{ values: h.limit || [], color: lc }], max: 100,
        title: lim.map((x) => `${x.label}: ${Math.round(x.percent)}% · ${resetText(x.resetsAt)}`).join('\n') }));
    }
    const t = claudeTotals(state.claude);
    if (state.hasWorkspace && t.sessions.length) {
      const c = t.sessions[0];
      const st = statusOf(c);
      const color = st.cls === 'working' ? 'var(--green)' : st.cls === 'waiting' ? 'var(--yellow)' : 'var(--muted)';
      const text = c.state === 'working' && c.current
        ? `<b style="color:${catColor[c.current.cat] || 'inherit'}">${esc(c.current.tool)}</b> ${esc(c.current.detail)}`
        : `<b style="color:${color}">${esc(st.label)}</b> ${esc(c.title)}`;
      const rate = state.claude.tokenRate || [];
      const over = overBudget();
      rows.push(mrow({ label: 'CC', value: over ? `<span style="color:var(--red)">${esc(state.claude.today.cost)}</span>` : t.cost !== '—' ? t.cost : c.tokens, color, tab: 'claude', text,
        history: rate.some(Boolean) ? [{ values: rate.slice(-30), color: 'var(--blue)' }] : null,
        title: `Claude Code · ${st.label}${over ? `\nOver today's budget: ${state.claude.today.cost} of $${state.budget.toFixed(2)}` : ''}\n${c.title}\n${c.toolCalls} tool calls · ${c.filesTouched} files · ${c.tokens} tokens · ${c.cost} (API billing)${c.context ? `\nContext ${c.context.text}` : ''}\nClick to open Claude activity` }));
    }
    return rows.join('');
  }

  // ---------- footer links ----------
  const GITHUB_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  const HEART_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.25 2.5c-1.336 0-2.75 1.164-2.75 3 0 2.15 1.58 4.144 3.365 5.682A20.565 20.565 0 008 13.393a20.561 20.561 0 003.135-2.211C12.92 9.644 14.5 7.65 14.5 5.5c0-1.836-1.414-3-2.75-3-1.373 0-2.609.986-3.029 2.456a.75.75 0 01-1.442 0C6.859 3.486 5.623 2.5 4.25 2.5zM8 14.25l-.345.666-.002-.001-.006-.003-.018-.01a7.643 7.643 0 01-.31-.17 22.075 22.075 0 01-3.434-2.414C2.045 10.731 0 8.35 0 5.5 0 2.836 2.086 1 4.25 1 5.797 1 7.153 1.802 8 3.02 8.847 1.802 10.203 1 11.75 1 13.914 1 16 2.836 16 5.5c0 2.85-2.045 5.231-3.885 6.818a22.08 22.08 0 01-3.744 2.584l-.018.01-.006.003h-.002L8 14.25zm0 0l.345.666a.752.752 0 01-.69 0L8 14.25z"/></svg>';
  const linksFooter = () => `<div class="links">
      <button data-action="external" data-link="github" title="Nano Metrics on GitHub" aria-label="Nano Metrics on GitHub">${GITHUB_ICON}</button>
      <button data-action="external" data-link="sponsor" title="Sponsor on GitHub" aria-label="Sponsor on GitHub">${HEART_ICON}</button>
    </div>`;

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

  // Live dot on the tab, so a session waiting on you is noticed from the other tabs.
  function claudeBadge() {
    const t = claudeTotals(state.claude);
    return t.waiting ? '<span class="tab-dot waiting"></span>' : t.working ? '<span class="tab-dot"></span>' : '';
  }

  // ---------- hover tooltip ----------
  // One floating tooltip for every chart. It lives outside the re-rendered regions and is re-applied after each
  // render, so it follows live data while the pointer rests on a chart.
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  let pointer = null;

  function updateTip() {
    document.querySelectorAll('.chart-guide').forEach((g) => g.remove());
    const target = pointer && document.elementFromPoint(pointer.x, pointer.y);
    const el = target && /** @type {HTMLElement} */ (target).closest('[data-tips],[data-tip]');
    if (!el) { tip.hidden = true; return; }
    const node = /** @type {HTMLElement} */ (el);
    let text = node.dataset.tip || '';
    if (node.dataset.tips) {
      let tips = [];
      try { tips = JSON.parse(node.dataset.tips); } catch { /* malformed */ }
      const r = node.getBoundingClientRect();
      const i = Math.max(0, Math.min(tips.length - 1, Math.floor(((pointer.x - r.left) / r.width) * tips.length)));
      text = tips[i] || '';
      const guide = document.createElement('div');
      guide.className = 'chart-guide';
      guide.style.left = `${((i + 0.5) / tips.length) * 100}%`;
      node.appendChild(guide);
    }
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const x = Math.min(window.innerWidth - w - 4, Math.max(4, pointer.x - w / 2));
    const y = pointer.y - h - 12 < 4 ? pointer.y + 16 : pointer.y - h - 12;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  document.addEventListener('mousemove', (e) => { pointer = { x: e.clientX, y: e.clientY }; updateTip(); });
  document.addEventListener('mouseleave', () => { pointer = null; updateTip(); });
  window.addEventListener('scroll', () => { pointer = null; updateTip(); }, true);

  function render() {
    renderRegions();
    if (pointer) { updateTip(); }
  }

  function renderRegions() {
    if (compact) {
      region('compact', compactView());
      return;
    }
    region('top', `<div class="topbar">
      <div class="tabs" role="tablist">
        <button class="tab ${state.tab === 'system' ? 'active' : ''}" role="tab" aria-selected="${state.tab === 'system'}" data-action="tab" data-tab="system">System</button>
        <button class="tab ${state.tab === 'project' ? 'active' : ''}" role="tab" aria-selected="${state.tab === 'project'}" data-action="tab" data-tab="project">Project</button>
        <button class="tab ${state.tab === 'claude' ? 'active' : ''}" role="tab" aria-selected="${state.tab === 'claude'}" data-action="tab" data-tab="claude">Claude${claudeBadge()}</button>
      </div>
      <button class="live ${state.paused ? 'paused' : ''}" data-action="pause" title="${state.paused ? 'Resume' : 'Pause'} monitoring"><span class="dot"></span>${state.paused ? 'Paused' : 'Live'}</button>
    </div>${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}`);
    region('system', systemView()).hidden = state.tab !== 'system';
    region('project', state.tab === 'project' ? projectView() : '').hidden = state.tab !== 'project';
    region('claude', state.tab === 'claude' ? claudeView() : '').hidden = state.tab !== 'claude';
    region('links', linksFooter());
  }

  function persist() {
    vscode.setState({ tab: state.tab, expanded: [...state.expanded], showIdle: [...state.showIdle], procSort: state.procSort });
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
      case 'procSort':
        state.procSort = d.sort === 'mem' ? 'mem' : 'cpu';
        break;
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
      case 'checkUsage':
        vscode.postMessage({ type: 'checkUsage' });
        return;
      case 'openLink':
        vscode.postMessage({ type: 'openLink', url: d.url });
        return;
      case 'external':
        vscode.postMessage({ type: 'external', link: d.link });
        return;
      case 'resume':
        vscode.postMessage({ type: 'resume', id: d.id });
        return;
      case 'openFile':
        vscode.postMessage({ type: 'openFile', path: d.path });
        return;
      case 'undoTurn':
        e.stopPropagation();
        vscode.postMessage({ type: 'undoTurn', session: d.session, turn: d.turn });
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
        state.interval = m.interval || 2000;
        state.warning = m.warning;
        state.budget = m.budget || 0;
        state.info = m.info;
        state.hasWorkspace = m.hasWorkspace;
        if (!compact && m.force) {
          state.tab = m.tab;
          persist();
        } else if (!compact && m.tab !== state.tab) {
          vscode.postMessage({ type: 'tab', tab: state.tab });
        }
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
        if (m.history) { state.history = m.history; }
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
