import * as vscode from 'vscode';
import { calculateCurrentCpuLoad, calculateCurrentMemoryLoad, calculateTotalCoreLoad, getMysqlServices } from './sysinfoMetrics';

export class NanoMetricsView {
    private static _panel: vscode.WebviewPanel | undefined;

    public static createOrShow(extensionUri: vscode.Uri) {
        // If we already have a panel, show it
        if (NanoMetricsView._panel) {
            NanoMetricsView._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        // Otherwise, create a new panel
        NanoMetricsView._panel = vscode.window.createWebviewPanel(
            'nanoMetrics',
            'Nano Metrics',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
            }
        );

        // Listen for when the panel is disposed
        NanoMetricsView._panel.onDidDispose(() => {
            NanoMetricsView._panel = undefined;
        });

        // Update charts at regular intervals
        // setInterval(() => {
        //     updateCharts(NanoMetricsView._panel!);
        // }, 3000);

        // Get the webview content and set it
        setInterval(() => {            
            getWebviewContent(extensionUri).then((webviewContent) => {
                NanoMetricsView._panel!.webview.html = webviewContent;
            });
        }, 1000);
    }
}

async function getWebviewContent(extensionUri: vscode.Uri): Promise<string> {

    // Always show CPU, memory, core load
    const cpuData = await calculateCurrentCpuLoad();
    const memoryData = await calculateCurrentMemoryLoad();
    const coreLoadData = await calculateTotalCoreLoad();

    // Read settings from VS Code configuration
    const config = vscode.workspace.getConfiguration('nanometrics');
    const showGraph = config.get('showGraph', false);
    const enabledServices = [
        config.get('enableMysql', false) ? { name: 'MySQL', fn: 'getMysqlServices' } : null,
        config.get('enableMongoDB', false) ? { name: 'MongoDB', fn: 'getMongoDBServices' } : null,
        config.get('enableRedis', false) ? { name: 'Redis', fn: 'getRedisServices' } : null,
        config.get('enableDocker', false) ? { name: 'Docker', fn: 'getDockerServices' } : null,
        config.get('enableNginx', false) ? { name: 'Nginx', fn: 'getNginxServices' } : null,
        config.get('enableApache', false) ? { name: 'Apache', fn: 'getApacheServices' } : null,
        config.get('enableElasticsearch', false) ? { name: 'Elasticsearch', fn: 'getElasticsearchServices' } : null,
        config.get('enableRabbitMQ', false) ? { name: 'RabbitMQ', fn: 'getRabbitMQServices' } : null,
        config.get('enableKafka', false) ? { name: 'Kafka', fn: 'getKafkaServices' } : null,
        config.get('enablePostgres', false) ? { name: 'Postgres', fn: 'getPostgresServices' } : null,
        config.get('enableOracleDB', false) ? { name: 'OracleDB', fn: 'getOracleDBServices' } : null,
        config.get('enableSqlServer', false) ? { name: 'SqlServer', fn: 'getSqlServerServices' } : null,
        config.get('enableGpu', false) ? { name: 'GPU', fn: 'getGpuInfo' } : null,
        config.get('enableBattery', false) ? { name: 'Battery', fn: 'getBatteryInfo' } : null,
        config.get('enableNetwork', false) ? { name: 'Network', fn: 'getNetworkInfo' } : null
    ].filter(Boolean);

    // Main HTML and script as a single string
    // Build HTML based on settings
    let html = [
        '<div id="loadingSpinner" style="display:flex;align-items:center;justify-content:center;height:100px;"><span>Loading metrics...</span><span style="margin-left:10px;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#36a2eb" stroke-width="4" stroke-linecap="round" stroke-dasharray="60" stroke-dashoffset="0"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg></span></div>',
        '<div id="cpuChart" width="400" height="50" style="display:none;"></div>',
        '<div id="memoryChart" width="400" height="50" style="display:none;"></div>',
        '<div id="coreLoadChart" width="400" height="50" style="display:none;"></div>',
        '<div id="graphContainer" style="display:none; margin-top:20px;"><canvas id="usageGraph" width="400" height="200"></canvas></div>',
        '<hr>',
        '<div id="servicesData"></div>',
        '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>'
    ];

    html.push(`<script>
        window.addEventListener('DOMContentLoaded', function() {
            setTimeout(function() {
                document.getElementById('loadingSpinner').style.display = 'none';
                document.getElementById('cpuChart').style.display = 'block';
                document.getElementById('memoryChart').style.display = 'block';
                document.getElementById('coreLoadChart').style.display = 'block';
            }, 800);
        });
        const cpuData = ${JSON.stringify(cpuData)};
        const memoryData = ${JSON.stringify(memoryData)};
        const coreLoadData = ${JSON.stringify(coreLoadData)};
        document.getElementById('cpuChart').innerText = 'CPU Load: ' + cpuData;
        document.getElementById('memoryChart').innerText = 'Memory Load: ' + memoryData.toFixed(2) + '%';
        document.getElementById('coreLoadChart').innerText = 'Core Loads: ' + coreLoadData.map(x => x.toFixed(2)).join(', ');

        // Show graph if enabled
        const graphContainer = document.getElementById('graphContainer');
        let usageChart = null;
        if (${showGraph}) {
            graphContainer.style.display = 'block';
            if (!usageChart) {
                const ctx = document.getElementById('usageGraph').getContext('2d');
                usageChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: ['CPU Usage', 'Memory Usage'],
                        datasets: [{
                            label: 'Usage (%)',
                            data: [cpuData, memoryData],
                            backgroundColor: ['#36a2eb', '#ff6384']
                        }]
                    },
                    options: {
                        scales: {
                            y: { beginAtZero: true, max: 100 }
                        }
                    }
                });
            }
        }

        // Fetch and show enabled services
        const enabledServices = ${JSON.stringify(enabledServices)};
        const vscode = acquireVsCodeApi();
        enabledServices.forEach(s => {
            vscode.postMessage({ command: 'fetchService', service: s.fn });
        });
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'serviceData') {
                document.getElementById('servicesData').innerHTML += '<pre>' + JSON.stringify(message.data, null, 2) + '</pre>';
            }
        });
    </script>`);

    return html.join('\n');
}

