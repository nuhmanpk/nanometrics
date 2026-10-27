# Change Log

All notable changes to the "nanometrics" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.4.0]

- **Claude Code** now tracks subagents: transcripts under `<session>/subagents/` (including workflow agents) are read alongside the main session
  - New **Agents** list per session: name, running / done, tool calls, tokens and cost for each agent
  - Session tokens, cost, tool calls, edited files and recent activity include subagent work (previously only the parent session was counted)
  - A session stays **working** while any of its agents is running, even when the parent is quietly waiting

## [0.3.1]

- Fixed Claude Code cost estimates: prices now follow the current Anthropic list prices per model (Claude Opus 5.5 $4/$20, Claude Sonnet 5.5 $2/$10, Claude Haiku 5.5 $0.10/$0.50, Claude Fable 5.1 $10/$50, plus older models) instead of one price per family
  - Model specific cache read prices (e.g. $0.20 per MTok on Claude Opus 5.5) and the Claude Haiku 5.5 rate for prompts over 100k tokens
  - Claude Fable and Mythos sessions now show a cost instead of `—`
  - `nanometrics.claudePricing` accepts an optional third value for the cache read price, and overrides take priority over the built-in prices

## [0.3.0]

- **Claude Code** sessions now show total **tokens** and an **estimated cost**, read from the local session transcript (hover Tokens for the input / output / cache breakdown)
  - Prices are estimates per model family; override them with `nanometrics.claudePricing`
- New `nanometrics.statusBarStyle` setting: `compact` shortens the status bar readout to e.g. `12·45%`
- Charts adapt to light and high-contrast themes
- 16 more services: Neo4j, Cassandra, MariaDB, CouchDB, InfluxDB, ClickHouse, Memcached, etcd, Consul, ZooKeeper, Prometheus, Grafana, MinIO, HAProxy, Traefik, Ollama
- Unit tests for usage parsing, cost, transcript reading and the status bar (`npm run test:unit`)
- Fixed the ESLint config error, updated dependencies and cleared all `npm audit` findings

## [0.2.0]

- New **Claude Code** window in the Project tab: live view of what Claude Code is doing in your workspace
  - Working / idle status, current tool call and a timeline of recent actions
  - Task progress from Claude's plan (done / total, with the active step highlighted)
  - Tool call and edited-file counts per session
  - Reads local session transcripts only; nothing leaves your machine
- README: new screenshots, Explorer panel image replaces the demo GIF

## [0.1.1]

- Fixed "There is no data provider registered that can provide view data" after upgrading from 0.0.x: the dashboard now uses its own view id instead of reusing the old tree view's

## [0.1.0]

- New sidebar dashboard with CPU/memory gauges, history graphs, per-core heatmap, network, storage, battery, GPU and services
- New project monitor: workspace processes, process trees, listening ports, stop process, git branch and package.json scripts
- Compact NanoMetrics panel in the Explorer, replacing the plain tree view
- Status bar CPU/memory indicator with warning threshold
- Settings for refresh interval, status bar, warning threshold and disk; service settings now work
- Fixed GPU and network always showing N/A
- Welcome message now shows once instead of on every window

- Initial release