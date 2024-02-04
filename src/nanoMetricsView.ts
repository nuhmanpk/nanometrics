import * as vscode from 'vscode';
import { calculateCurrentCpuLoad, calculateCurrentMemoryLoad, calculateTotalCoreLoad, getMysqlServices } from 'sys-metrics-tracker';

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

    const [cpuData, memoryData, coreLoadData,mysql] = await Promise.all([
        calculateCurrentCpuLoad(),
        calculateCurrentMemoryLoad(),
        calculateTotalCoreLoad(),
        getMysqlServices()
    ]);

    // Convert data to JSON strings
    const cpuDataString = JSON.stringify(cpuData);
    const memoryDataString = JSON.stringify(memoryData);
    const coreLoadDataString = JSON.stringify(coreLoadData);
    const mysqlDataString = JSON.stringify(mysql);

    // Dynamically build HTML content
    const chartHtml = `
        <div id="cpuChart" width="400" height="50"></div>
        <div id="memoryChart" width="400" height="50"></div>
        <div id="coreLoadChart" width="400" height="50"></div>
        <div id="mysqlData" width="400" height="50"></div>
    `;

    const chartJsScript = `
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    `;

    const script = `
        <script>
            async function createCharts() {
                const cpuData = ${cpuDataString};
                const memoryData = ${memoryDataString};
                const coreLoadData = ${coreLoadDataString};
                const mysqlData = ${mysqlDataString};

                // Create charts (you can update this part based on your actual chart creation logic)
                // For example, updateChartFunction(cpuData, memoryData, coreLoadData);

                // Use the data to update the HTML content as needed
                document.getElementById('cpuChart').innerText = 'CPU Load: ' + JSON.stringify(cpuData);
                document.getElementById('memoryChart').innerText = 'Memory Load: ' + JSON.stringify(memoryData);
                document.getElementById('coreLoadChart').innerText = 'Core Load: ' + JSON.stringify(coreLoadData);
                document.getElementById('mysqlData').innerText = 'Mysql: ' + JSON.stringify(mysqlData);
            }

            createCharts();
        </script>
    `;

    return `
        ${chartHtml}
        ${chartJsScript}
        ${script}
    `;
}

