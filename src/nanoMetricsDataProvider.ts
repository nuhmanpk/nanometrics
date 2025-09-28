import * as vscode from 'vscode';
import {
    calculateCurrentCpuLoad, calculateCurrentMemoryLoad,
    calculateTotalCoreLoad, getMysqlServices
} from './sysinfoMetrics';

class MetricNode extends vscode.TreeItem {
    constructor (
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly description?: string
    ) {
        super(label, collapsibleState);
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

            const serviceNodes: MetricNode[] = [
                new MetricNode(`💻 CPU : ${cpuData}`, vscode.TreeItemCollapsibleState.None),
                new MetricNode(`🧠 Memory : ${memoryData.toFixed(2)}%`, vscode.TreeItemCollapsibleState.None),
                new MetricNode(`🔥 Core Loads : ${coreLoadData.map((load: number) => load.toFixed(2)).join(', ')}`, vscode.TreeItemCollapsibleState.None)
            ];

            // Function to create MetricNode for running instances of a service
            const createRunningNodes = (serviceName: string, instances: any[]) => {
                const runningInstances = instances.filter((instance: any) => instance.running);
                return runningInstances.map((instance: any, index: number) => {
                    const emoji = instance.cpu > 50 || instance.mem > 50 ? '🚨' : '';
                    return new MetricNode(`${serviceName} - ${index + 1}: ${emoji} 💻 : ${(instance?.cpu)}%, 🧠: ${(instance?.mem)}%`, vscode.TreeItemCollapsibleState.None);
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
