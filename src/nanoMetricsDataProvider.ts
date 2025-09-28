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

            // CPU
            const cpuLabel = `💻 CPU : ${Math.round(cpuData)}%`;
            const cpuNode = new MetricNode(cpuLabel, vscode.TreeItemCollapsibleState.None);

            // Memory
            const memLabel = `🧠 Memory : ${Math.round(memoryData)}%`;
            const memNode = new MetricNode(memLabel, vscode.TreeItemCollapsibleState.None);

            // GPU
            let gpuLabel = '🖥️ GPU : N/A';
            try {
                const sysinfoMetrics = require('./sysinfoMetrics');
                const gpuInfo = await sysinfoMetrics.getGpuInfo();
                if (gpuInfo && gpuInfo.controllers && gpuInfo.controllers.length > 0) {
                    gpuLabel = `🖥️ GPU : ${gpuInfo.controllers[0].model} (${gpuInfo.controllers[0].memoryTotal || 'N/A'} MB)`;
                }
            } catch {}
            const gpuNode = new MetricNode(gpuLabel, vscode.TreeItemCollapsibleState.None);

            // Network
            let netLabel = '🌐 Network : N/A';
            try {
                const sysinfoMetrics = require('./sysinfoMetrics');
                const netInfo = await sysinfoMetrics.getNetworkInfo();
                if (netInfo && netInfo.length > 0) {
                    netLabel = `🌐 Network : ${netInfo[0].iface} (${netInfo[0].ip4 || 'N/A'})`;
                }
            } catch {}
            const netNode = new MetricNode(netLabel, vscode.TreeItemCollapsibleState.None);

            const serviceNodes: MetricNode[] = [cpuNode, memNode, gpuNode, netNode];

            // Function to create MetricNode for running instances of a service (not used for default)
            const createRunningNodes = (serviceName: string, instances: any[]) => {
                const runningInstances = instances.filter((instance: any) => instance.running);
                return runningInstances.map((instance: any, index: number) => {
                    const cpu = Math.round(instance?.cpu ?? 0);
                    const mem = Math.round(instance?.mem ?? 0);
                    const label = `${serviceName} - ${index + 1}: 💻 : ${cpu}%, 🧠: ${mem}%`;
                    return new MetricNode(label, vscode.TreeItemCollapsibleState.None);
                });
            };

            // ...existing code...

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
