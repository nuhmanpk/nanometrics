import si from 'systeminformation';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export type ProcessOrigin = 'terminal' | 'tooling' | 'workspace' | 'command';

export interface ProjectProcess {
  pid: number;
  parentPid: number;
  name: string;
  command: string;
  cpu: number;
  memRss: number;
  started: string;
  origin: ProcessOrigin;
  originLabel: string;
  ports: number[];
  children: ProjectProcess[];
  // Subtree totals, including this process.
  totalCpu: number;
  totalMem: number;
}

export interface ProjectSnapshot {
  timestamp: number;
  folders: string[];
  roots: ProjectProcess[];
  processCount: number;
  cpu: number;
  memRss: number;
  ports: { port: number; pid: number; name: string }[];
}

export interface ProjectContext {
  folders: string[];
  terminals: { pid: number; name: string }[];
  // The extension host process; its descendants are language servers and other tooling for this window.
  extensionHostPid: number;
  // Install directory of the editor; processes running from it are the editor itself.
  appBase: string;
}

function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Map of pid → current working directory for processes owned by the current user. */
async function readCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (process.platform === 'linux') {
    await Promise.all(pids.map(async pid => {
      try {
        out.set(pid, await fs.readlink(`/proc/${pid}/cwd`));
      } catch {
        // Not ours or already gone.
      }
    }));
  } else if (process.platform === 'darwin') {
    const user = process.env.USER || '';
    const stdout = await run('lsof', ['-a', '-d', 'cwd', '-u', user, '-Fpn']);
    let pid = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1));
      } else if (line.startsWith('n') && pid) {
        out.set(pid, line.slice(1));
      }
    }
  }
  return out;
}

/** Map of pid → listening TCP ports. */
async function readListeningPorts(pids: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (pids.length === 0) {
    return out;
  }
  const add = (pid: number, port: number) => {
    const list = out.get(pid) ?? [];
    if (!list.includes(port)) {
      list.push(port);
    }
    out.set(pid, list);
  };

  if (process.platform === 'win32') {
    const conns = await si.networkConnections().catch(() => []);
    const wanted = new Set(pids);
    for (const c of conns) {
      if (c.state === 'LISTEN' && c.pid && wanted.has(c.pid)) {
        add(c.pid, Number(c.localPort));
      }
    }
    return out;
  }

  const stdout = await run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fpn']);
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1));
      if (port) {
        add(pid, port);
      }
    }
  }
  return out;
}

export async function collectProject(ctx: ProjectContext): Promise<ProjectSnapshot> {
  const { list } = await si.processes();
  const byPid = new Map(list.map(p => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const p of list) {
    const c = children.get(p.parentPid) ?? [];
    c.push(p.pid);
    children.set(p.parentPid, c);
  }

  const descendants = (pid: number): number[] => {
    const result: number[] = [];
    const stack = [...(children.get(pid) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      result.push(next);
      stack.push(...(children.get(next) ?? []));
    }
    return result;
  };

  // Never report the editor itself: the extension host and everything above it.
  const excluded = new Set<number>([process.pid]);
  for (let p = byPid.get(process.pid); p && p.parentPid > 1 && !excluded.has(p.parentPid); p = byPid.get(p.parentPid)) {
    excluded.add(p.parentPid);
  }

  // Find the editor's main process so its helpers (renderers, file watchers) are not matched by cwd.
  const fromEditor = (pid: number) => {
    const p = byPid.get(pid);
    return !!p && !!ctx.appBase && `${p.path}${p.command}`.startsWith(ctx.appBase);
  };
  let editorMain = process.pid;
  while (fromEditor(byPid.get(editorMain)?.parentPid ?? 0)) {
    editorMain = byPid.get(editorMain)!.parentPid;
  }
  const editorTree = new Set<number>([editorMain, ...descendants(editorMain)]);

  const origin = new Map<number, { origin: ProcessOrigin; label: string }>();
  const claim = (pid: number, o: ProcessOrigin, label: string) => {
    if (!origin.has(pid) && !excluded.has(pid) && byPid.has(pid)) {
      origin.set(pid, { origin: o, label });
    }
  };

  for (const t of ctx.terminals) {
    // The shell itself is idle noise; what runs inside it is what matters.
    excluded.add(t.pid);
    for (const pid of descendants(t.pid)) {
      claim(pid, 'terminal', t.name);
    }
  }

  for (const pid of descendants(ctx.extensionHostPid)) {
    claim(pid, 'tooling', 'Editor tooling');
  }

  if (ctx.folders.length) {
    const candidates = list.filter(p => !origin.has(p.pid) && !excluded.has(p.pid) && !editorTree.has(p.pid)).map(p => p.pid);
    const cwds = await readCwds(candidates);
    for (const pid of candidates) {
      const cwd = cwds.get(pid);
      const folder = cwd && ctx.folders.find(f => isInside(cwd, f));
      if (folder) {
        claim(pid, 'workspace', path.basename(folder));
        continue;
      }
      const p = byPid.get(pid)!;
      const cmdline = `${p.path} ${p.command} ${p.params}`;
      const byCommand = ctx.folders.find(f => cmdline.includes(f));
      if (byCommand) {
        claim(pid, 'command', path.basename(byCommand));
      }
    }
  }

  const pids = [...origin.keys()];
  const ports = await readListeningPorts(pids).catch(() => new Map<number, number[]>());

  const nodes = new Map<number, ProjectProcess>();
  for (const pid of pids) {
    const p = byPid.get(pid)!;
    const o = origin.get(pid)!;
    nodes.set(pid, {
      pid,
      parentPid: p.parentPid,
      name: p.name,
      command: `${p.command} ${p.params}`.trim(),
      cpu: p.cpu,
      memRss: p.memRss * 1024,
      started: p.started,
      origin: o.origin,
      originLabel: o.label,
      ports: (ports.get(pid) ?? []).sort((a, b) => a - b),
      children: [],
      totalCpu: 0,
      totalMem: 0
    });
  }

  const roots: ProjectProcess[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentPid);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const total = (n: ProjectProcess): void => {
    n.children.forEach(total);
    n.children.sort((a, b) => b.totalCpu - a.totalCpu);
    n.totalCpu = n.cpu + n.children.reduce((s, c) => s + c.totalCpu, 0);
    n.totalMem = n.memRss + n.children.reduce((s, c) => s + c.totalMem, 0);
  };
  roots.forEach(total);
  roots.sort((a, b) => b.totalCpu - a.totalCpu || b.totalMem - a.totalMem);

  const allPorts: ProjectSnapshot['ports'] = [];
  for (const node of nodes.values()) {
    for (const port of node.ports) {
      allPorts.push({ port, pid: node.pid, name: node.name });
    }
  }
  allPorts.sort((a, b) => a.port - b.port);

  return {
    timestamp: Date.now(),
    folders: ctx.folders,
    roots,
    processCount: nodes.size,
    cpu: roots.reduce((s, r) => s + r.totalCpu, 0),
    memRss: roots.reduce((s, r) => s + r.totalMem, 0),
    ports: allPorts
  };
}

/** Terminates a process and everything it spawned, children first. */
export function isSafeScriptName(name: string): boolean {
  return /^[\w:.@/+-]+$/.test(name) && !name.startsWith('-');
}

/** True when `pid` is one of the processes in the snapshot, so the dashboard can't be asked to stop anything else. */
export function containsPid(snapshot: ProjectSnapshot | undefined, pid: number): boolean {
  const walk = (nodes: ProjectProcess[]): boolean => nodes.some(n => n.pid === pid || walk(n.children));
  return Number.isInteger(pid) && pid > 1 && !!snapshot && walk(snapshot.roots);
}

export async function killProcessTree(pid: number): Promise<void> {
  // 0 and negative pids address process groups (or every process) in kill(2).
  if (!Number.isInteger(pid) || pid <= 1) {
    return;
  }
  if (process.platform === 'win32') {
    await run('taskkill', ['/pid', String(pid), '/T', '/F']);
    return;
  }
  const { list } = await si.processes();
  const children = new Map<number, number[]>();
  for (const p of list) {
    const c = children.get(p.parentPid) ?? [];
    c.push(p.pid);
    children.set(p.parentPid, c);
  }
  const order: number[] = [];
  const visit = (p: number) => {
    (children.get(p) ?? []).forEach(visit);
    order.push(p);
  };
  visit(pid);
  for (const p of order) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {
      // Already exited.
    }
  }
}

export interface ProjectInfo {
  name: string;
  folder: string;
  branch: string | null;
  scripts: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | null;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

export async function readProjectInfo(folder: string): Promise<ProjectInfo> {
  let branch: string | null = null;
  try {
    const head = (await fs.readFile(path.join(folder, '.git', 'HEAD'), 'utf8')).trim();
    branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch {
    // Not a git repo, or a worktree with a .git file.
  }

  let scripts: string[] = [];
  let packageManager: ProjectInfo['packageManager'] = null;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
    // Script names go into a terminal command line, so only plain names are offered.
    scripts = Object.keys(pkg.scripts ?? {}).filter(isSafeScriptName);
    const pm = String(pkg.packageManager ?? '').split('@')[0];
    if (pm === 'yarn' || pm === 'pnpm' || pm === 'bun' || pm === 'npm') {
      packageManager = pm;
    } else if (await exists(path.join(folder, 'pnpm-lock.yaml'))) {
      packageManager = 'pnpm';
    } else if (await exists(path.join(folder, 'yarn.lock'))) {
      packageManager = 'yarn';
    } else if (await exists(path.join(folder, 'bun.lockb')) || await exists(path.join(folder, 'bun.lock'))) {
      packageManager = 'bun';
    } else {
      packageManager = 'npm';
    }
  } catch {
    // No package.json.
  }

  return { name: path.basename(folder), folder, branch, scripts, packageManager };
}
