import * as vscode from 'vscode';
import { DashboardViewProvider } from './dashboardView';

const WELCOME_KEY = 'nanometrics.welcomeShown';

export function activate(context: vscode.ExtensionContext) {
    const dashboard = new DashboardViewProvider(context.extensionUri);
    context.subscriptions.push(
        dashboard,
        vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewId, dashboard, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.window.registerWebviewViewProvider(DashboardViewProvider.compactViewId, dashboard)
    );

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'nanometrics.focus';
    statusBar.name = 'Nano Metrics';
    context.subscriptions.push(statusBar);

    const updateStatusBar = () => {
        const enabled = vscode.workspace.getConfiguration('nanometrics').get('showStatusBar', true);
        enabled ? statusBar.show() : statusBar.hide();
    };
    updateStatusBar();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('nanometrics.showStatusBar')) {
                updateStatusBar();
            }
        }),
        dashboard.onSystem(s => {
            const warning = vscode.workspace.getConfiguration('nanometrics').get('warningThreshold', 85);
            const cpu = Math.round(s.cpu.load);
            const mem = Math.round(s.memory.percent);
            statusBar.text = `$(pulse) ${cpu}%  $(server) ${mem}%`;
            statusBar.tooltip = `Nano Metrics\nCPU ${cpu}% · Memory ${mem}%\nClick to open dashboard`;
            statusBar.backgroundColor = cpu >= warning || mem >= warning
                ? new vscode.ThemeColor('statusBarItem.warningBackground')
                : undefined;
        }),
        vscode.commands.registerCommand('nanometrics.focus', () =>
            vscode.commands.executeCommand(`${DashboardViewProvider.viewId}.focus`)),
        vscode.commands.registerCommand('nanometrics.showProject', async () => {
            await vscode.commands.executeCommand(`${DashboardViewProvider.viewId}.focus`);
            dashboard.showTab('project');
        }),
        vscode.commands.registerCommand('nanometrics.showSystem', async () => {
            await vscode.commands.executeCommand(`${DashboardViewProvider.viewId}.focus`);
            dashboard.showTab('system');
        }),
        vscode.commands.registerCommand('nanometrics.togglePause', () => dashboard.togglePause()),
        vscode.commands.registerCommand('nanometrics.openSettings', () =>
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nuhmanpk.nanometrics'))
    );

    dashboard.start();

    // Thank-you note once per install, not on every window.
    if (!context.globalState.get(WELCOME_KEY)) {
        context.globalState.update(WELCOME_KEY, true);
        vscode.window.showInformationMessage(
            'Thanks for installing Nano Metrics! Visit my GitHub: https://github.com/nuhmanpk',
            'Open GitHub'
        ).then(selection => {
            if (selection === 'Open GitHub') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/nuhmanpk/nanometrics'));
            }
        });
    }
}

export function deactivate() {}
