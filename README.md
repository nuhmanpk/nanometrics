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

Explore and monitor system metrics effortlessly with this quick and convenient VSCode extension. Access real-time information on CPU load, memory usage, core load, and running instances of various services right from the side panel. Stay informed about your system's health and performance with ease.

![NanoMetrics panel in the Explorer](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/explorer.png)

<p align="center">
  <a href="https://www.producthunt.com/products/nano-metrics?utm_source=badge-follow&utm_medium=badge&utm_source=badge-nano&#0045;metrics" target="_blank">
    <img src="https://img.shields.io/badge/Product%20Hunt-Follow%20Nano%20Metrics-DA552F?style=for-the-badge&logo=producthunt&logoColor=white" alt="Nano Metrics on Product Hunt">
  </a>
</p>


## Features

### Claude Code activity tracking

![Claude Code session in the Claude tab](https://raw.githubusercontent.com/nuhmanpk/nanometrics/main/images/claude_session.png)

Watch your AI pair programmer work, without leaving the sidebar. The **Claude** tab follows every recent Claude Code session in your workspace:
- **Live status** - Working, **Your turn** (Claude finished and waits for your prompt), **Waiting on a tool** (a permission prompt or a long run) or Idle. The tab shows a dot when a session needs you, so you notice from any tab
- **What it's doing right now** - the current tool call, and the last prompt you sent
- **Context meter** - how full the context window was on the latest request
- **Tokens, cost and burn rate** - total tokens, the estimated cost (what the usage would be billed through the Anthropic API) and $/hr. Override prices with `nanometrics.claudePricing`
- **Code stats** - tool calls, files edited, lines added / removed and failed tool calls
- **Activity chart** - tool calls per minute over the last 30 minutes, coloured by kind (explore, edit, run, web, agents)
- **Hot files** - the most edited files, click to open
- **Subagents and workflows** - every agent the session spawns, with running/done status, tool calls, tokens and cost; their usage is included in the session totals
- **Plan progress and recent activity** - Claude's task list with done/total, and the last actions with timestamps
- **Research trail** - every web search Claude ran and page it fetched (click to open the page)
- **Models and cache** - tokens and cost per model when you switch models, plus the cache hit rate and how much caching saved
- **Errors** - failed tool calls with their error message
- **Token graph** - tokens per minute over the last hour, across every session in the workspace
- **Last 7 days** - estimated spend per day in this workspace, and today's total
- **Past sessions** - the last week's sessions with their cost; **Resume** opens a terminal with `claude --resume`
- **Plan usage** - your Claude plan's 5-hour and weekly limits as bars, with the time each one resets: the same numbers as `/usage` in Claude Code, read from Claude Code's local cache. No setup. The **/usage** button opens Claude Code with `/usage` filled in to refresh them
- A **CC** row in the Explorer panel and a summary line on the Project tab show what Claude is doing at a glance

It reads Claude Code's local session transcripts (`~/.claude/projects`). Nothing is uploaded.

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
- Compact **NanoMetrics** panel in the Explorer — CPU, memory, temperature (macOS), network, project and Claude Code at a glance

- CPU and memory in the status bar, highlighted when usage crosses your warning threshold
- Uses your VS Code theme colors, light or dark

## Installation

1. Open Visual Studio Code
2. Go to Extensions (or press `Ctrl+Shift+X`)
3. Search for "Nano Metrics"
4. Install the extension

## Usage

1. Click the Nano Metrics icon in the Activity Bar for the full dashboard, or use the **NanoMetrics** panel in the Explorer
2. Switch between the **System**, **Project** and **Claude** tabs
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


## Privacy and open source

Nano Metrics runs entirely on your machine. **Nothing is sent anywhere**: no telemetry, no analytics, no account, no server. The extension makes no network requests at all.

What it reads, locally:
- System stats (CPU, memory, disks, network, battery, GPU) from your operating system
- Processes, working directories and listening ports (`ps`, `lsof` on macOS, `/proc` on Linux)
- Your workspace's `package.json` scripts and current git branch
- Claude Code's session transcripts in `~/.claude/projects`, read only, to show what Claude is doing, tokens and estimated cost
- The plan limits Claude Code last saved for `/usage` in `~/.claude.json`, read only. Nano Metrics never reads your login token and never asks Anthropic for anything

What it writes: nothing. It doesn't change your Claude Code settings or any of your files.

Links open in your browser only when you click them: `localhost` ports, the claude.ai usage page (only if the Claude Code extension isn't installed) and GitHub. The **/usage** button hands `/usage` to Claude Code, which then checks your limits itself.

The code is open source under the MIT License. Don't take our word for it: read every line on [GitHub](https://github.com/nuhmanpk/nanometrics), and build the extension from source if you prefer.

## Contribution

Feel free to contribute to this project by reporting issues or submitting pull requests. Visit our [GitHub repository](https://github.com/nuhmanpk/nanometrics) to get involved. Your feedback and contributions mean a lot as we continue to enhance and improve Nano Metrics. This project is under active development, and your input is invaluable.

## Sponsor

If Nano Metrics helps you, consider supporting its development:

- [GitHub Sponsors](https://github.com/sponsors/nuhmanpk)
- [Buy Me a Coffee](https://buymeacoffee.com/nuhmanpk)

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/nuhmanpk/nanometrics) file for details.

🚀 Happy coding !!!

