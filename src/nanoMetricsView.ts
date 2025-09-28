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

    // List of optional services
    const services = [
        { id: 'mysql', name: 'MySQL', fn: 'getMysqlServices' },
        { id: 'mongodb', name: 'MongoDB', fn: 'getMongoDBServices' },
        { id: 'redis', name: 'Redis', fn: 'getRedisServices' },
        { id: 'docker', name: 'Docker', fn: 'getDockerServices' },
        { id: 'nginx', name: 'Nginx', fn: 'getNginxServices' },
        { id: 'apache', name: 'Apache', fn: 'getApacheServices' },
        { id: 'elasticsearch', name: 'Elasticsearch', fn: 'getElasticsearchServices' },
        { id: 'rabbitmq', name: 'RabbitMQ', fn: 'getRabbitMQServices' },
        { id: 'kafka', name: 'Kafka', fn: 'getKafkaServices' },
        { id: 'postgres', name: 'Postgres', fn: 'getPostgresServices' },
        { id: 'oracle', name: 'OracleDB', fn: 'getOracleDBServices' },
        { id: 'sqlserver', name: 'SqlServer', fn: 'getSqlServerServices' },
        { id: 'gpu', name: 'GPU', fn: 'getGpuInfo' },
        { id: 'battery', name: 'Battery', fn: 'getBatteryInfo' },
        { id: 'network', name: 'Network', fn: 'getNetworkInfo' }
    ];

    // HTML for checkboxes
    const graphCheckboxHtml = `<label><input type="checkbox" id="showGraph" /> Show Graph</label>`;
    const checkboxesHtml = graphCheckboxHtml + '<br>' + services.map(s => `<label><input type="checkbox" id="${s.id}" /> ${s.name}</label>`).join('<br>');

    // Main HTML and script as a single string
    return [
        '<div id="cpuChart" width="400" height="50"></div>',
        '<div id="memoryChart" width="400" height="50"></div>',
        '<div id="coreLoadChart" width="400" height="50"></div>',
        '<div id="graphContainer" style="display:none; margin-top:20px;"><canvas id="usageGraph" width="400" height="200"></canvas></div>',
        '<hr>',
        '<div><strong>Optional Services:</strong></div>',
        `<div>${checkboxesHtml}</div>`,
        '<div id="servicesData"></div>',
        '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
        `<script>
            const cpuData = ${JSON.stringify(cpuData)};
            const memoryData = ${JSON.stringify(memoryData)};
            const coreLoadData = ${JSON.stringify(coreLoadData)};
            document.getElementById('cpuChart').innerText = 'CPU Load: ' + cpuData;
            document.getElementById('memoryChart').innerText = 'Memory Load: ' + memoryData.toFixed(2) + '%';
            document.getElementById('coreLoadChart').innerText = 'Core Loads: ' + coreLoadData.map(x => x.toFixed(2)).join(', ');
            const services = ${JSON.stringify(services)};
            async function fetchServiceData(service) {
                const vscode = acquireVsCodeApi();
                vscode.postMessage({ command: 'fetchService', service });
            }
            services.forEach(s => {
                document.getElementById(s.id).addEventListener('change', function(e) {
                    if (e.target.checked) {
                        fetchServiceData(s.fn);
                    } else {
                        document.getElementById('servicesData').innerHTML = '';
                    }
                });
            });
            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'serviceData') {
                    document.getElementById('servicesData').innerHTML = '<pre>' + JSON.stringify(message.data, null, 2) + '</pre>';
                }
            });
            // Graph logic
            const showGraphCheckbox = document.getElementById('showGraph');
            const graphContainer = document.getElementById('graphContainer');
            let usageChart = null;
            showGraphCheckbox.addEventListener('change', function(e) {
                if (e.target.checked) {
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
                } else {
                    graphContainer.style.display = 'none';
                }
            });
        </script>`
    ].join('\n');
}

