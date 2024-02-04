import * as vscode from 'vscode';
// import { NanoMetricsView } from './nanoMetricsView';
import { NanoMetricsView } from './nanoMetricsDataProvider';



export function activate(context: vscode.ExtensionContext) {
    // Register the command to create or show the webview panel
    // context.subscriptions.push(vscode.commands.registerCommand('nanometrics.activate', () => {
        // NanoMetricsView.createOrShow(context.extensionUri);
		NanoMetricsView.createOrShow(context.extensionUri);
    // }));
}

export function deactivate() {}