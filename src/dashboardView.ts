import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { collectSystem, SystemOptions, SystemSnapshot } from './sysinfoMetrics';
import { collectClaude, ClaudeSnapshot } from './claudeActivity';
import { sanitizePricing } from './claudeUsage';
import { readLimits, USAGE_URL } from './claudeLimits';
import {
    collectProject, containsPid, isSafeScriptName, killProcessTree, ProjectSnapshot, readProjectInfo, ProjectInfo
} from './projectMetrics';

type Tab = 'system' | 'project' | 'claude';
const TABS: Tab[] = ['system', 'project', 'claude'];
const asTab = (t: unknown): Tab => (TABS.includes(t as Tab) ? t as Tab : 'system');

const HISTORY = 60;

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
    private projectInfo: ProjectInfo[] = [];
    private readonly disposables: vscode.Disposable[] = [];

    private readonly history = {
        cpu: new Ring(),
        memory: new Ring(),
        rx: new Ring(),
        tx: new Ring(),
        temp: new Ring(),
        projectCpu: new Ring(),
        projectMem: new Ring()
    };

    private lastSystem?: SystemSnapshot;
    private lastProject?: ProjectSnapshot;
    private lastClaude?: ClaudeSnapshot;

    private readonly _onSystem = new vscode.EventEmitter<SystemSnapshot>();
    readonly onSystem = this._onSystem.event;

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

        view.webview.onDidReceiveMessage(msg => this.onMessage(msg), undefined, this.disposables);
        view.onDidChangeVisibility(() => {
            if (view.visible) {
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

    showTab(tab: Tab) {
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
        if (this.busy || this.paused) {
            return;
        }
        this.busy = true;
        try {
            const visible = this.visible();
            if (!visible && !vscode.workspace.getConfiguration('nanometrics').get('showStatusBar', true)) {
                return;
            }
            const opts: SystemOptions = visible ? this.systemOptions() : { network: false, battery: false, gpu: false, disk: false, temperature: false, services: [] };
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
            if ((this.visible('full') && this.tab !== 'system') || this.visible('compact')) {
                const [claude, limits] = await Promise.all([
                    collectClaude(folders, sanitizePricing(vscode.workspace.getConfiguration('nanometrics').get('claudePricing'))),
                    readLimits()
                ]);
                this.lastClaude = { ...claude, limits };
                this.post({ type: 'claude', data: this.lastClaude });
            }
        } catch (err) {
            this.post({ type: 'error', message: String(err instanceof Error ? err.message : err) });
        } finally {
            this.busy = false;
        }
    }

    private historyPayload() {
        return {
            cpu: this.history.cpu.list,
            memory: this.history.memory.list,
            rx: this.history.rx.list,
            tx: this.history.tx.list,
            temp: this.history.temp.list,
            projectCpu: this.history.projectCpu.list,
            projectMem: this.history.projectMem.list
        };
    }

    private sendAll() {
        const config = vscode.workspace.getConfiguration('nanometrics');
        this.post({
            type: 'init',
            tab: this.tab,
            paused: this.paused,
            showGraph: config.get('showGraph', true),
            warning: config.get('warningThreshold', 85),
            info: this.projectInfo,
            hasWorkspace: (vscode.workspace.workspaceFolders ?? []).length > 0
        });
        if (this.lastSystem) {
            this.post({ type: 'system', data: this.lastSystem, history: this.historyPayload() });
        }
        if (this.lastProject) {
            this.post({ type: 'project', data: this.lastProject, history: this.historyPayload() });
        }
        if (this.lastClaude) {
            this.post({ type: 'claude', data: this.lastClaude });
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
            case 'openPort':
                vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${Number(msg.port)}`));
                break;
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
            case 'showTerminal': {
                const t = vscode.window.terminals.find(t => t.name === msg.name);
                t?.show();
                break;
            }
        }
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
        this._onSystem.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

function appBase(): string {
    // appRoot is <install>/resources/app (or Contents/Resources/app on macOS).
    return path.resolve(vscode.env.appRoot, '..', '..');
}
