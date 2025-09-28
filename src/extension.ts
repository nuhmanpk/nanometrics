import * as vscode from 'vscode';
// import { NanoMetricsView } from './nanoMetricsView';
import { NanoMetricsView } from './nanoMetricsDataProvider';



export function activate(context: vscode.ExtensionContext) {
    // Show a thank you message on install/activation
    vscode.window.showInformationMessage(
        'Thanks for installing Nano Metrics! Visit my GitHub: https://github.com/nuhmanpk',
        'Open GitHub'
    ).then(selection => {
        if (selection === 'Open GitHub') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/nuhmanpk/nanometrics'));
        }
    });

    // Register the command to create or show the webview panel
    NanoMetricsView.createOrShow(context.extensionUri);
}

export function deactivate() {}