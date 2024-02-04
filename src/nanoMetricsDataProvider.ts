import * as vscode from 'vscode';
import {
    calculateCurrentCpuLoad, calculateCurrentMemoryLoad,
    calculateTotalCoreLoad, getApacheServices, getDockerServices,
    getElasticsearchServices, getMongoDBServices, getMysqlServices,
    getNginxServices, getOracleDBServices, getKafkaServices, getPostgresServices,
    getRabbitMQServices, getRedisServices, getSqlServerServices, getCpuTemperature
} from 'sys-metrics-tracker';

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
                mysqlData,
                apacheData,
                elasticsearchData,
                dockerData,
                mongodbData,
                nginxData,
                oracleData,
                kafkaData,
                postGresData,
                rabbitMqData,
                redisData,
                sqlServerData,
                cpuTemperatureData
            ] = await Promise.all([
                calculateCurrentCpuLoad(),
                calculateCurrentMemoryLoad(),
                calculateTotalCoreLoad(),
                getMysqlServices(),
                getApacheServices(),
                getElasticsearchServices(),
                getDockerServices(),
                getMongoDBServices(),
                getNginxServices(),
                getOracleDBServices(),
                getKafkaServices(),
                getPostgresServices(),
                getRabbitMQServices(),
                getRedisServices(),
                getSqlServerServices(),
                getCpuTemperature()

            ]);

            const serviceNodes: MetricNode[] = [
                new MetricNode(`💻 CPU : ${cpuData.load}`, vscode.TreeItemCollapsibleState.None),
                new MetricNode(`🧠 Memory : ${memoryData}%`, vscode.TreeItemCollapsibleState.None),
                new MetricNode(`🔥 Core : ${coreLoadData.total}`, vscode.TreeItemCollapsibleState.None)
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
            if (apacheData.length > 0) {
                serviceNodes.push(...createRunningNodes('🚀 Apache', apacheData));
            }
            if (elasticsearchData.length > 0) {
                serviceNodes.push(...createRunningNodes('🔍 Elasticsearch', elasticsearchData));
            }
            if (dockerData.length > 0) {
                serviceNodes.push(...createRunningNodes('🐳 Docker', dockerData));
            }
            if (mongodbData.length > 0) {
                serviceNodes.push(...createRunningNodes('🍃 MongoDB', mongodbData));
            }
            if (nginxData.length > 0) {
                serviceNodes.push(...createRunningNodes('🚀 Nginx', nginxData));
            }
            if (nginxData.length > 0) {
                serviceNodes.push(...createRunningNodes('🚀 Kafka', kafkaData));
            }
            if (nginxData.length > 0) {
                serviceNodes.push(...createRunningNodes('🚀 PostGres', postGresData));
            }
            if (nginxData.length > 0) {
                serviceNodes.push(...createRunningNodes('🚀 RabbitMQ', rabbitMqData));
            }
            if (nginxData.length > 0) {
                serviceNodes.push(...createRunningNodes('🚀 Redis', redisData));
            }
            if (nginxData.length > 0) {
                serviceNodes.push(...createRunningNodes('🚀 Nginx', nginxData));
            }
            if (nginxData.length > 0) {
                serviceNodes.push(...createRunningNodes('🚀 SQLServer', sqlServerData));
            }

            if (cpuTemperatureData) {
                if (cpuTemperatureData.chipset !== null || undefined) {
                    serviceNodes.push(new MetricNode(`🌡️ Temperature (Chipset): ${cpuTemperatureData.chipset}`, vscode.TreeItemCollapsibleState.None));
                }
                if (cpuTemperatureData.main !== null || undefined) {
                    serviceNodes.push(new MetricNode(`🌡️ Temperature (Main): ${cpuTemperatureData.main}`, vscode.TreeItemCollapsibleState.None));
                }
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
