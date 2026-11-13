import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { collectSystem, SystemOptions, SystemSnapshot } from './sysinfoMetrics';
import { collectClaude, ClaudeSnapshot, claudeResources, transcriptFiles, projectDir } from './claudeActivity';
import { insideRoots, planUndo } from './claudeCheckpoints';
import { sanitizePricing } from './claudeUsage';
import { collectOtherAgents } from './otherAgents';
import { readLimits, USAGE_URL } from './claudeLimits';
import {
    collectProject, containsPid, isSafeScriptName, killProcessTree, ProjectSnapshot, readProjectInfo, ProjectInfo
} from './projectMetrics';

type Tab = 'system' | 'project' | 'claude';
const TABS: Tab[] = ['system', 'project', 'claude'];
const asTab = (t: unknown): Tab => (TABS.includes(t as Tab) ? t as Tab : 'system');

const HISTORY = 60;

// The only outside pages the footer may open.
const LINKS: Record<string, string> = {
    github: 'https://github.com/nuhmanpk/nanometrics',
    sponsor: 'https://github.com/sponsors/nuhmanpk'
};

const SERVICES: { setting: string; label: string; query: string }[] = [
    { setting: 'enableMysql', label: 'MySQL', query: 'mysqld' },
    { setting: 'enablePostgres', label: 'Postgres', query: 'postgres' },
    { setting: 'enableMongoDB', label: 'MongoDB', query: 'mongod' },
    { setting: 'enableRedis', label: 'Redis', query: 'redis-server' },
    { setting: 'enableDocker', label: 'Docker', query: process.platform === 'darwin' ? 'com.docker.backend' : 'dockerd' },
    { setting: 'enableNginx', label: 'Nginx', query: 'nginx' },
    { setting: 'enableApache', label: 'Apache', query: process.platform === 'linux' ? 'apache2' : 'httpd' },
    { setting: 'enableElasticsearch', label: 'Elasticsearch', query: 'elasticsearch' },
    { setting: 'enableRabbitMQ', label: 'RabbitMQ', query: 'rabbitmq' },
    { setting: 'enableKafka', label: 'Kafka', query: 'kafka' },
    { setting: 'enableOracleDB', label: 'OracleDB', query: 'oracle' },
    { setting: 'enableSqlServer', label: 'SQL Server', query: 'sqlservr' },
    { setting: 'enableNeo4j', label: 'Neo4j', query: 'neo4j' },
    { setting: 'enableCassandra', label: 'Cassandra', query: 'cassandra' },
    { setting: 'enableMariaDB', label: 'MariaDB', query: 'mariadbd' },
    { setting: 'enableCouchDB', label: 'CouchDB', query: 'couchdb' },
    { setting: 'enableInfluxDB', label: 'InfluxDB', query: 'influxd' },
    { setting: 'enableClickHouse', label: 'ClickHouse', query: 'clickhouse' },
    { setting: 'enableMemcached', label: 'Memcached', query: 'memcached' },
    { setting: 'enableEtcd', label: 'etcd', query: 'etcd' },
    { setting: 'enableConsul', label: 'Consul', query: 'consul' },
    { setting: 'enableZookeeper', label: 'ZooKeeper', query: 'zookeeper' },
    { setting: 'enablePrometheus', label: 'Prometheus', query: 'prometheus' },
    { setting: 'enableGrafana', label: 'Grafana', query: 'grafana' },
    { setting: 'enableMinIO', label: 'MinIO', query: 'minio' },
    { setting: 'enableHAProxy', label: 'HAProxy', query: 'haproxy' },
    { setting: 'enableTraefik', label: 'Traefik', query: 'traefik' },
    { setting: 'enableOllama', label: 'Ollama', query: 'ollama' }
];

class Ring {
    private values: number[] = [];
    push(v: number) {
        this.values.push(v);
        if (this.values.length > HISTORY) {
            this.values.shift();
        }
    }
    get list() {
        return this.values;
    }
}

export class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    // Distinct from 0.0.x's tree view id 'nanometrics', which VS Code may still have cached.
    public static readonly viewId = 'nanometrics.dashboard';
    // Compact summary that lives in the Explorer sidebar.
    public static readonly compactViewId = 'nanometrics.explorer';

    private readonly views = new Set<vscode.WebviewView>();
    private tab: Tab = 'system';
    private timer?: NodeJS.Timeout;
    private busy = false;
    private paused = false;
    // Set when the extension picks the tab (sidebar opened, or a show command), so the webview drops its saved one.
    private forceTab = false;
    private lastShowTab = 0;
    private projectInfo: ProjectInfo[] = [];
    private readonly disposables: vscode.Disposable[] = [];

    private readonly history = {
        cpu: new Ring(),
        memory: new Ring(),
        rx: new Ring(),
        tx: new Ring(),
        temp: new Ring(),
        limit: new Ring(),
        projectCpu: new Ring(),
        projectMem: new Ring()
    };

    private lastSystem?: SystemSnapshot;
    private lastProject?: ProjectSnapshot;
    private lastClaude?: ClaudeSnapshot;

    private readonly _onSystem = new vscode.EventEmitter<SystemSnapshot>();
    readonly onSystem = this._onSystem.event;
    private readonly _onClaude = new vscode.EventEmitter<ClaudeSnapshot>();
    readonly onClaude = this._onClaude.event;
    private lastClaudeAt = 0;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('nanometrics')) {
                    this.restart();
                    this.sendAll();
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.loadProjectInfo()),
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (path.basename(doc.fileName) === 'package.json') {
                    this.loadProjectInfo();
                }
            })
        );
        this.loadProjectInfo();
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.views.add(view);
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        const mode = view.viewType === DashboardViewProvider.compactViewId ? 'compact' : 'full';
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        view.webview.html = this.html(view.webview, media, mode);
        if (mode === 'full') {
            this.openOnProject();
        }

        view.webview.onDidReceiveMessage(msg => this.onMessage(msg), undefined, this.disposables);
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                if (view.viewType === DashboardViewProvider.viewId) {
                    this.openOnProject();
                }
                this.sendAll();
                this.tick();
            }
        }, undefined, this.disposables);
        view.onDidDispose(() => {
            this.views.delete(view);
        }, undefined, this.disposables);
    }

    private visible(mode?: 'full' | 'compact') {
        return [...this.views].some(v => v.visible && (!mode || (v.viewType === DashboardViewProvider.compactViewId) === (mode === 'compact')));
    }

    /** True while someone is already looking at the Claude tab. */
    claudeTabVisible() {
        return this.visible('full') && this.tab === 'claude';
    }

    start() {
        this.restart();
    }

    private restart() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        const interval = Math.max(1000, vscode.workspace.getConfiguration('nanometrics').get<number>('refreshInterval', 2000));
        this.timer = setInterval(() => this.tick(), interval);
        this.tick();
    }

    togglePause() {
        this.paused = !this.paused;
        this.post({ type: 'paused', paused: this.paused });
    }

    /** Opening the sidebar from the activity bar lands on the Project tab, unless a show command just picked one. */
    private openOnProject() {
        if (Date.now() - this.lastShowTab < 1000) {
            return;
        }
        this.tab = 'project';
        this.forceTab = true;
        this.post({ type: 'tab', tab: this.tab });
    }

    showTab(tab: Tab) {
        this.lastShowTab = Date.now();
        this.forceTab = true;
        this.tab = tab;
        this.post({ type: 'tab', tab });
        this.tick();
    }

    private async loadProjectInfo() {
        const folders = vscode.workspace.workspaceFolders ?? [];
        this.projectInfo = await Promise.all(
            folders.filter(f => f.uri.scheme === 'file').map(f => readProjectInfo(f.uri.fsPath))
        );
        this.post({ type: 'projectInfo', info: this.projectInfo, hasWorkspace: folders.length > 0 });
    }

    private systemOptions(): SystemOptions {
        const config = vscode.workspace.getConfiguration('nanometrics');
        return {
            network: config.get('enableNetwork', true),
            battery: config.get('enableBattery', false),
            gpu: config.get('enableGpu', false),
            disk: config.get('enableDisk', true),
            temperature: true,
            services: SERVICES.filter(s => config.get(s.setting, false)).map(s => ({ label: s.label, query: s.query }))
        };
    }

    private async terminalPids() {
        const result: { pid: number; name: string }[] = [];
        await Promise.all(vscode.window.terminals.map(async t => {
            const pid = await t.processId;
            if (pid) {
                result.push({ pid, name: t.name });
            }
        }));
        return result;
    }

    private async tick() {
        // Claude runs on its own track: slow system sampling or process scans must not hold its numbers back.
        void this.refreshClaude(false);
        if (this.busy || this.paused) {
            return;
        }
        this.busy = true;
        try {
            const visible = this.visible();
            if (!visible && !vscode.workspace.getConfiguration('nanometrics').get('showStatusBar', true) && !claudeAlertsOn()) {
                return;
            }
            const opts: SystemOptions = visible ? this.systemOptions() : { network: false, battery: false, gpu: false, disk: false, temperature: false, services: [] };
            opts.processes = this.visible('full') && this.tab === 'system';
            if (this.visible('compact')) {
                // The compact view always shows network, plus GPU (temperature instead on macOS).
                opts.gpu = opts.gpu || process.platform !== 'darwin';
                opts.network = true;
            }
            const system = await collectSystem(opts);
            this.history.cpu.push(system.cpu.load);
            this.history.memory.push(system.memory.percent);
            if (system.cpu.temperature !== null) {
                this.history.temp.push(system.cpu.temperature);
            }
            if (system.network) {
                this.history.rx.push(system.network.rxSec);
                this.history.tx.push(system.network.txSec);
            }
            this.lastSystem = system;
            this._onSystem.fire(system);

            if (visible) {
                this.post({ type: 'system', data: system, history: this.historyPayload() });
            }

            // Project scans are heavier (process table + lsof), so only run them when someone is looking.
            const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
            if ((this.visible('full') && this.tab === 'project') || this.visible('compact')) {
                const project = await collectProject({
                    folders,
                    terminals: await this.terminalPids(),
                    extensionHostPid: process.pid,
                    appBase: appBase()
                });
                this.history.projectCpu.push(project.cpu);
                this.history.projectMem.push(project.memRss);
                this.lastProject = project;
                this.post({ type: 'project', data: project, history: this.historyPayload() });
            }
        } catch (err) {
            this.post({ type: 'error', message: String(err instanceof Error ? err.message : err) });
        } finally {
            this.busy = false;
        }
    }


    private claudeBusy = false;
    private claudeAgain = false;
    private watchers: fs.FSWatcher[] = [];
    private watchTimer?: NodeJS.Timeout;
    private watched = '';

    /** Refreshes Claude data. `force` skips the idle-alert throttle, used when a transcript just changed. */
    private async refreshClaude(force: boolean) {
        if (this.paused) {
            return;
        }
        if (this.claudeBusy) {
            // A change arrived mid-scan: go once more right after, so the last write is never missed.
            this.claudeAgain = this.claudeAgain || force;
            return;
        }
        const busy = this.lastClaude?.sessions.some(s => s.state === 'working');
        const alerts = claudeAlertsOn() && Date.now() - this.lastClaudeAt > (busy ? ALERT_BUSY_MS : ALERT_POLL_MS);
        const watching = (this.visible('full') && this.tab !== 'system') || this.visible('compact');
        if (!watching && !alerts) {
            return;
        }
        // While someone watches a working chat, don't wait for the next tick.
        if (!force && !alerts && watching && Date.now() - this.lastClaudeAt < 900) {
            return;
        }
        this.claudeBusy = true;
        try {
            const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
            this.watchTranscripts(folders);
            const pricing = sanitizePricing(vscode.workspace.getConfiguration('nanometrics').get('claudePricing'));
            const [claude, limits, resources, otherAgents] = await Promise.all([
                collectClaude(folders, pricing),
                readLimits(),
                claudeResources(),
                collectOtherAgents(folders, pricing).catch(() => [])
            ]);
            this.lastClaude = { ...claude, limits, resources, otherAgents };
            this.lastClaudeAt = Date.now();
            this._onClaude.fire(this.lastClaude);
            if (limits.limits.length) {
                this.history.limit.push(limits.limits[0].percent);
            }
            this.post({ type: 'claude', data: this.lastClaude, history: this.historyPayload() });
        } catch (err) {
            this.post({ type: 'error', message: String(err instanceof Error ? err.message : err) });
        } finally {
            this.claudeBusy = false;
            if (this.claudeAgain) {
                this.claudeAgain = false;
                void this.refreshClaude(true);
            }
        }
    }

    /** Watches Claude Code's transcript folders, so a new tool call shows within a fraction of a second, not on the next poll. */
    private watchTranscripts(folders: string[]) {
        const key = folders.join('|');
        if (key === this.watched) {
            return;
        }
        this.watched = key;
        this.watchers.forEach(w => w.close());
        this.watchers = [];
        for (const folder of folders) {
            try {
                const w = fs.watch(projectDir(folder), { persistent: false }, () => {
                    clearTimeout(this.watchTimer);
                    this.watchTimer = setTimeout(() => void this.refreshClaude(true), 250);
                });
                w.on('error', () => { /* folder vanished; the poll still covers it */ });
                this.watchers.push(w);
            } catch {
                // No transcripts yet; the next scan tries again once Claude Code creates the folder.
                this.watched = '';
            }
        }
    }

    private historyPayload() {
        return {
            cpu: this.history.cpu.list,
            memory: this.history.memory.list,
            rx: this.history.rx.list,
            tx: this.history.tx.list,
            temp: this.history.temp.list,
            limit: this.history.limit.list,
            projectCpu: this.history.projectCpu.list,
            projectMem: this.history.projectMem.list
        };
    }

    private sendAll() {
        const config = vscode.workspace.getConfiguration('nanometrics');
        this.post({
            type: 'init',
            tab: this.tab,
            force: this.forceTab,
            paused: this.paused,
            showGraph: config.get('showGraph', true),
            interval: Math.max(1000, config.get<number>('refreshInterval', 2000)),
            warning: config.get('warningThreshold', 85),
            budget: config.get('claudeDailyBudget', 0),
            tokenLimit: config.get('claudeDailyTokenLimit', 0),
            planPrice: config.get('claudePlanPrice', 0),
            pricing: Object.entries(sanitizePricing(config.get('claudePricing')))
                .map(([model, p]) => ({ model, input: p[0], output: p[1], cached: p[2] ?? Math.round(p[0] * 0.1 * 1000) / 1000 })),
            info: this.projectInfo,
            hasWorkspace: (vscode.workspace.workspaceFolders ?? []).length > 0
        });
        this.forceTab = false;
        if (this.lastSystem) {
            this.post({ type: 'system', data: this.lastSystem, history: this.historyPayload() });
        }
        if (this.lastProject) {
            this.post({ type: 'project', data: this.lastProject, history: this.historyPayload() });
        }
        if (this.lastClaude) {
            this.post({ type: 'claude', data: this.lastClaude, history: this.historyPayload() });
        }
    }

    private async onMessage(msg: any) {
        switch (msg?.type) {
            case 'ready':
                this.sendAll();
                this.tick();
                break;
            case 'tab':
                this.tab = asTab(msg.tab);
                this.tick();
                break;
            case 'pause':
                this.togglePause();
                break;
            case 'open':
                await vscode.commands.executeCommand(`${DashboardViewProvider.viewId}.focus`);
                this.showTab(asTab(msg.tab));
                break;
            case 'settings':
                vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nuhmanpk.nanometrics');
                break;
            case 'openPort': {
                const port = Number(msg.port);
                if (Number.isInteger(port) && port > 0 && port < 65536) {
                    vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
                }
                break;
            }
            case 'kill': {
                const pid = Number(msg.pid);
                if (!containsPid(this.lastProject, pid)) {
                    return;
                }
                const choice = await vscode.window.showWarningMessage(
                    `Stop "${msg.name}" (PID ${pid}) and its child processes?`,
                    { modal: true },
                    'Stop'
                );
                if (choice === 'Stop') {
                    await killProcessTree(pid);
                    setTimeout(() => this.tick(), 500);
                }
                break;
            }
            case 'runScript': {
                const info = this.projectInfo.find(i => i.folder === msg.folder);
                if (!info || !info.scripts.includes(msg.script) || !isSafeScriptName(msg.script)) {
                    return;
                }
                const pm = info.packageManager ?? 'npm';
                const terminal = vscode.window.createTerminal({ name: `${info.name}: ${msg.script}`, cwd: info.folder });
                terminal.show();
                terminal.sendText(`${pm} run ${msg.script}`);
                break;
            }
            case 'checkUsage':
                // Claude Code's deep link opens a session with the prompt filled in; without the extension, use claude.ai.
                if (vscode.extensions.getExtension('anthropic.claude-code')) {
                    vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://anthropic.claude-code/open?prompt=${encodeURIComponent('/usage')}`));
                } else {
                    vscode.env.openExternal(vscode.Uri.parse(USAGE_URL));
                }
                break;
            case 'openLink': {
                // Only pages Claude fetched in a listed session.
                const known = this.lastClaude?.sessions.some(s => s.research.some(r => r.url && r.url === msg.url));
                if (known) {
                    vscode.env.openExternal(vscode.Uri.parse(msg.url));
                }
                break;
            }
            case 'external':
                if (Object.prototype.hasOwnProperty.call(LINKS, msg.link)) {
                    vscode.env.openExternal(vscode.Uri.parse(LINKS[msg.link]));
                }
                break;
            case 'resume': {
                const past = this.lastClaude?.history.find(h => h.id === msg.id);
                if (!past || !/^[\w-]+$/.test(past.id)) {
                    return;
                }
                const terminal = vscode.window.createTerminal({ name: `Claude: ${past.title}`, cwd: past.cwd });
                terminal.show();
                terminal.sendText(`claude --resume ${past.id}`);
                break;
            }
            case 'openFile': {
                // Only files the dashboard listed, so the webview can't open arbitrary paths.
                const known = this.lastClaude?.sessions.some(s => s.hotFiles.some(f => f.path === msg.path));
                if (known) {
                    vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: true });
                }
                break;
            }
            case 'undoTurn':
                await this.undoTurn(String(msg.session ?? ''), String(msg.turn ?? ''));
                break;
            case 'showTerminal': {
                const t = vscode.window.terminals.find(t => t.name === msg.name);
                t?.show();
                break;
            }
        }
    }

    /** Puts back every file Claude changed from the given prompt onwards, after the user confirms. */
    private async undoTurn(sessionId: string, turnId: string) {
        const session = this.lastClaude?.sessions.find(s => s.id === sessionId);
        const turn = session?.turns.find(t => t.id === turnId);
        if (!session || !turn || !/^[\w-]+$/.test(session.id)) {
            return;
        }
        const plan = await planUndo(await transcriptFiles(session.cwd, session.id), turn.id);
        // Never touch anything outside the open workspace folders.
        const roots = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
        const restores: NonNullable<typeof plan>['restores'] = [];
        for (const r of plan?.restores ?? []) {
            if (await insideRoots(r.path, roots)) {
                restores.push(r);
            }
        }
        if (!restores.length) {
            vscode.window.showInformationMessage('Nothing to undo: no file changes Claude Code recorded for that prompt are in this workspace.');
            return;
        }
        const rel = (p: string) => vscode.workspace.asRelativePath(p);
        const created = restores.filter(r => r.original === null);
        const changed = restores.filter(r => r.original !== null);
        const detail = [
            changed.length ? `Restore ${changed.length} file${changed.length === 1 ? '' : 's'}:\n${changed.map(r => `  ${rel(r.path)}`).join('\n')}` : '',
            created.length ? `Move ${created.length} new file${created.length === 1 ? '' : 's'} to the trash:\n${created.map(r => `  ${rel(r.path)}`).join('\n')}` : '',
            plan?.unknown.length ? `Can't restore (earlier content not recorded):\n${plan.unknown.map(p => `  ${rel(p)}`).join('\n')}` : '',
            'Later edits to these files, yours included, are replaced. Changes made through shell commands are not undone.'
        ].filter(Boolean).join('\n\n');
        const choice = await vscode.window.showWarningMessage(`Undo Claude's changes since "${turn.prompt}"?`, { modal: true, detail }, 'Undo changes');
        if (choice !== 'Undo changes') {
            return;
        }
        const failed: string[] = [];
        for (const r of restores) {
            const uri = vscode.Uri.file(r.path);
            try {
                if (r.original === null) {
                    await vscode.workspace.fs.delete(uri, { useTrash: true });
                    continue;
                }
                const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
                if (!exists) {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(r.original, 'utf8'));
                    continue;
                }
                // Through the editor, so an open file updates in place and Ctrl+Z brings Claude's version back.
                const doc = await vscode.workspace.openTextDocument(uri);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), r.original);
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            } catch {
                failed.push(rel(r.path));
            }
        }
        const done = restores.length - failed.length;
        vscode.window.showInformationMessage(
            `Undid Claude's changes in ${done} file${done === 1 ? '' : 's'}${failed.length ? `; couldn't restore ${failed.join(', ')}` : ''}. ` +
            'Tell Claude you reverted them, or it may assume its edits are still there.'
        );
    }

    private post(message: unknown) {
        for (const v of this.views) {
            v.webview.postMessage(message);
        }
    }

    private html(webview: vscode.Webview, media: vscode.Uri, mode: 'full' | 'compact'): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css'));
        const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.js'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Nano Metrics</title>
</head>
<body data-mode="${mode}" data-platform="${process.platform}">
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }

    dispose() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.watchers.forEach(w => w.close());
        clearTimeout(this.watchTimer);
        this._onSystem.dispose();
        this._onClaude.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

const ALERT_POLL_MS = 10_000;
const ALERT_BUSY_MS = 4_000;

function claudeAlertsOn(): boolean {
    const config = vscode.workspace.getConfiguration('nanometrics');
    return config.get('claudeContextWarning', 80) > 0 || config.get('claudeDailyBudget', 0) > 0 ||
        config.get('claudeLoopWarning', true) || config.get('claudeDailyTokenLimit', 0) > 0 ||
        config.get('claudeSessionCostLimit', 0) > 0 || config.get('claudeSessionTokenLimit', 0) > 0;
}

function appBase(): string {
    // appRoot is <install>/resources/app (or Contents/Resources/app on macOS).
    return path.resolve(vscode.env.appRoot, '..', '..');
}
