import * as vscode from 'vscode';
import {
    calculateCurrentCpuLoad, calculateCurrentMemoryLoad,
    calculateTotalCoreLoad, getMysqlServices
} from './sysinfoMetrics';

class MetricNode extends vscode.TreeItem {
    constructor (
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        description?: string
    ) {
        super(label, collapsibleState);
        if (description) {
            this.description = description;
        }
    }
}

class MetricTreeDataProvider implements vscode.TreeDataProvider<MetricNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<MetricNode | undefined> = new vscode.EventEmitter<MetricNode | undefined>();
    readonly onDidChangeTreeData: vscode.Event<MetricNode | undefined> = this._onDidChangeTreeData.event;

    constructor () {

    }

    getTreeItem(element: MetricNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: MetricNode): Promise<MetricNode[]> {
        if (element) {
            return [];
        } else {
            const [
                cpuData,
                memoryData,
                coreLoadData,
                mysqlData
            ] = await Promise.all([
                calculateCurrentCpuLoad(),
                calculateCurrentMemoryLoad(),
                calculateTotalCoreLoad(),
                getMysqlServices()
            ]);

            // Helper to colorize values
            const colorize = (value: number) => {
                if (value >= 80) { return '$(errorForeground)'; } // red
                if (value >= 50) { return '$(warningForeground)'; } // yellow
                return '';
            };

            // CPU
            const cpuColor = colorize(cpuData);
            const cpuLabel = `💻 CPU : ${Math.round(cpuData)}%`;
            const cpuNode = new MetricNode(cpuLabel, vscode.TreeItemCollapsibleState.None, cpuColor ? `$(primitive-square) ${cpuColor}` : '');

            // Memory
            const memColor = colorize(memoryData);
            const memLabel = `🧠 Memory : ${Math.round(memoryData)}%`;
            const memNode = new MetricNode(memLabel, vscode.TreeItemCollapsibleState.None, memColor ? `$(primitive-square) ${memColor}` : '');

            // Core Loads
            const coreLoadsRounded = coreLoadData.map((load: number) => Math.round(load));
            const coreLoadLabel = `🔥 Core Loads : ${coreLoadsRounded.join(', ')}`;
            const coreLoadNode = new MetricNode(coreLoadLabel, vscode.TreeItemCollapsibleState.None);

            const serviceNodes: MetricNode[] = [cpuNode, memNode, coreLoadNode];

            // Function to create MetricNode for running instances of a service
            const createRunningNodes = (serviceName: string, instances: any[]) => {
                const runningInstances = instances.filter((instance: any) => instance.running);
                return runningInstances.map((instance: any, index: number) => {
                    const cpu = Math.round(instance?.cpu ?? 0);
                    const mem = Math.round(instance?.mem ?? 0);
                    let color = '';
                    if (cpu >= 80 || mem >= 80) { color = '$(errorForeground)'; }
                    else if (cpu >= 50 || mem >= 50) { color = '$(warningForeground)'; }
                    const emoji = color === '$(errorForeground)' ? '🚨' : color === '$(warningForeground)' ? '⚠️' : '';
                    const label = `${serviceName} - ${index + 1}: ${emoji} 💻 : ${cpu}%, 🧠: ${mem}%`;
                    return new MetricNode(label, vscode.TreeItemCollapsibleState.None, color ? `$(primitive-square) ${color}` : '');
                });
            };

            // Add nodes for running instances of each service
            if (mysqlData.length > 0) {
                serviceNodes.push(...createRunningNodes('🐬 MySQL', mysqlData));
            }

            return serviceNodes;
        }
    }



    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }
}

export class NanoMetricsView {
    private static _treeDataProvider: MetricTreeDataProvider;

    public static createOrShow(extensionUri: vscode.Uri) {
        // If not already initialized, create a new TreeDataProvider
        if (!NanoMetricsView._treeDataProvider) {
            NanoMetricsView._treeDataProvider = new MetricTreeDataProvider();
        }

        // Create TreeView with a unique id and set the treeDataProvider option
        const treeView = vscode.window.createTreeView('nanometrics', { treeDataProvider: NanoMetricsView._treeDataProvider });

        // Update metrics in the TreeView
        setInterval(async () => {
            // Update tree items with new data
            NanoMetricsView._treeDataProvider.refresh();
        }, 3000);
    }
}
