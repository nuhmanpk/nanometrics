# Nano Metrics - VSCode Extension

![Nano Metrics Logo](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/logo-full.png)


<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=nuhmanpk.nanometrics">
    <img src="https://badgen.net/vs-marketplace/v/nuhmanpk.nanometrics?label=VS%20Code" alt="Version">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=nuhmanpk.nanometrics">
    <img src="https://badgen.net/vs-marketplace/i/nuhmanpk.nanometrics?label=Installs" alt="Installs">
  </a>
  <a href="https://github.com/nuhmanpk/nanometrics">
    <img src="https://img.shields.io/github/stars/nuhmanpk/nanometrics?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/nuhmanpk/nanometrics/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/nuhmanpk/nanometrics?style=flat-square&label=License" alt="License">
  </a>
  <a href="https://github.com/nuhmanpk/nanometrics/commits/main">
    <img src="https://img.shields.io/github/last-commit/nuhmanpk/nanometrics?style=flat-square&label=Last%20Commit" alt="Last Commit">
  </a>
  <a href="https://github.com/nuhmanpk/nanometrics">
    <img src="https://img.shields.io/github/repo-size/nuhmanpk/nanometrics?style=flat-square&label=Repo%20Size" alt="Repository Size">
  </a>
  <a href="https://github.com/nuhmanpk/nanometrics/issues">
    <img src="https://img.shields.io/github/issues/nuhmanpk/nanometrics?style=flat-square&label=Issues" alt="GitHub Issues">
  </a>
  <a href="https://github.com/nuhmanpk/nanometrics/pulls">
    <img src="https://img.shields.io/github/issues-pr/nuhmanpk/nanometrics?style=flat-square&label=Pull%20Requests" alt="Pull Requests">
  </a>
  <img src="https://img.shields.io/badge/Platform-VS%20Code-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white" alt="VS Code">
  <img src="https://img.shields.io/badge/Made%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <a href="https://www.producthunt.com/products/nano-metrics">
    <img src="https://img.shields.io/badge/Product%20Hunt-Follow-DA552F?style=flat-square&logo=producthunt&logoColor=white" alt="Product Hunt">
  </a>
</p>


----

![Claude Code session tracked live in Nano Metrics](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/claude_working.png)

Explore and monitor system metrics effortlessly with this quick and convenient VSCode extension. Access real-time information on CPU load, memory usage, core load, and running instances of various services right from the side panel. Stay informed about your system's health and performance with ease.

![NanoMetrics panel in the Explorer](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/explorer.png)

<p align="center">
  <a href="https://www.producthunt.com/products/nano-metrics?utm_source=badge-follow&utm_medium=badge&utm_source=badge-nano&#0045;metrics" target="_blank">
    <img src="https://api.producthunt.com/widgets/embed-image/v1/follow.svg?product_id=1357538&theme=light" alt="Nano Metrics on Product Hunt" width="250" height="54">
  </a>
</p>


## Features

### Claude Code activity tracking

![Claude Code activity card](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/claude_activity.png)


Watch your AI pair programmer work, without leaving the sidebar. The Project tab has a dedicated **Claude Code** window for every recent session in your workspace:
- **Live status** - working or idle, with a pulse while Claude is actively writing
- **What it's doing right now** - the current tool call (editing a file, running a command, searching...)
- **Tokens and cost** - total tokens per session and an estimated cost from the transcript's usage data (prices are estimates, override with `nanometrics.claudePricing`)
- **Progress tracking** - Claude's task plan with done/total, a progress bar and the active step highlighted
- **Recent activity timeline** - the last actions, with timestamps
- **Session stats** - tool calls made and files edited
- Pairs with the process list, so you see what Claude's `claude`, dev servers and test runs cost in CPU and memory

![Claude Code pricing card](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/claude_pricing.png)

It reads Claude Code's local session transcripts (`~/.claude/projects`). Nothing is uploaded.

![Project dashboard with Claude Code tracking](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/image_project_dashboard.png)

### System dashboard
- Live CPU and memory gauges with history graphs
- Per-core load heatmap and CPU temperature (where available)
- Network throughput (download / upload) for the default interface
- Disk and swap usage, battery and GPU info
- Optional service monitoring: MySQL, Postgres, MongoDB, Redis, Docker, Nginx, Apache, Elasticsearch, RabbitMQ, Kafka, OracleDB, SQL Server, Neo4j, Cassandra, MariaDB, CouchDB, InfluxDB, ClickHouse, Memcached, etcd, Consul, ZooKeeper, Prometheus, Grafana, MinIO, HAProxy, Traefik, Ollama

![System dashboard](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/image_dashboard.png)

### Project monitor
See what your open project is costing you, right next to your code:
- Every process tied to the workspace — anything running in VS Code terminals, processes whose working directory is inside the project, and the language servers / linters extensions run for this window
- Process trees with combined CPU and memory, so `npm run dev` shows the real cost of everything it spawned
- Listening ports for each process — click to open `localhost:<port>` in the browser
- Stop a process tree with one click
- Git branch and one-click `package.json` scripts (npm, yarn, pnpm or bun)

### Everywhere else
- Compact **NanoMetrics** panel in the Explorer — CPU, memory, temperature (macOS), network and project at a glance

- CPU and memory in the status bar, highlighted when usage crosses your warning threshold
- Uses your VS Code theme colors, light or dark

## Installation

1. Open Visual Studio Code
2. Go to Extensions (or press `Ctrl+Shift+X`)
3. Search for "Nano Metrics"
4. Install the extension

## Usage

1. Click the Nano Metrics icon in the Activity Bar for the full dashboard, or use the **NanoMetrics** panel in the Explorer
2. Switch between the **System** and **Project** tabs
3. Click the status bar item to jump to the dashboard
4. Search for "Nano Metrics" in VS Code settings to tune it

| Setting | Default | Description |
| --- | --- | --- |
| `nanometrics.refreshInterval` | `2000` | Refresh interval in milliseconds |
| `nanometrics.showStatusBar` | `true` | Show CPU and memory in the status bar |
| `nanometrics.warningThreshold` | `85` | Usage % highlighted as a warning |
| `nanometrics.showGraph` | `true` | Show history graphs |
| `nanometrics.enableNetwork` / `enableDisk` | `true` | Network and disk sections |
| `nanometrics.enableGpu` / `enableBattery` | `false` | GPU and battery sections |
| `nanometrics.statusBarStyle` | `full` | `compact` shortens the status bar to e.g. `12·45%` |
| `nanometrics.claudePricing` | `{}` | Override model prices (USD per 1M tokens) for the cost estimate |
| `nanometrics.enable<Service>` | `false` | Monitor a background service |

Process working directories and ports are read with `lsof` on macOS and `/proc` on Linux. On Windows the project monitor relies on terminals and command lines.


## Contribution

Feel free to contribute to this project by reporting issues or submitting pull requests. Visit our [GitHub repository](https://github.com/nuhmanpk/nanometrics) to get involved. Your feedback and contributions mean a lot as we continue to enhance and improve Nano Metrics. This project is under active development, and your input is invaluable.

## Sponsor

If Nano Metrics helps you, consider supporting its development:

- [GitHub Sponsors](https://github.com/sponsors/nuhmanpk)
- [Buy Me a Coffee](https://buymeacoffee.com/nuhmanpk)

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/nuhmanpk/nanometrics) file for details.

🚀 Happy coding !!!

