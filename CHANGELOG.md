# Change Log

All notable changes to the "nanometrics" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.5.0]

- New **Claude** tab: everything Claude Code is doing in this workspace, separate from the Project tab
  - **Plan usage**: your 5-hour and weekly Claude plan limits as bars with their reset times, plus a **/usage** button that opens Claude Code with `/usage` filled in to refresh them. The numbers are the ones Claude Code caches for `/usage` in `~/.claude.json`, so there is nothing to set up and no network request. Hidden when Claude Code hasn't cached any limits
  - Overview of working sessions, sessions **waiting on you**, today's estimated cost, a **Tokens · last hour** graph and a **Last 7 days** spend chart
  - Session status: **Working**, **Your turn** (Claude finished and waits for a prompt), **Waiting on &lt;tool&gt;** (a permission prompt or a long run) or Idle; the tab shows a dot while a session is working or waiting
  - **Context** meter for the latest request, sized to that request's model (1M for Claude Fable, Mythos, Opus 4.6+, Sonnet 4.6+ and Haiku 5.5; 200k for older models), session length, **burn rate** ($/hr), lines added / removed and failed tool calls
  - **Activity** chart of tool calls per minute over the last 30 minutes, coloured by kind (explore, edit, run, web, agents)
  - **Models** (tokens and cost per model, cache hit rate and what caching saved), **Research** (web searches and fetched pages, click to open), **Hot files** (click to open) and **Errors** (failed tool calls with their message)
  - **Past sessions** from the last week with tokens and cost; **Resume** runs `claude --resume <id>` in a new terminal
  - The last prompt you sent, and tool names coloured by kind in recent activity
- The Project tab shows a one-line Claude summary that opens the Claude tab
- The Explorer view gets a **CC** row with what Claude is doing right now and the session cost, and a **LIM** row for the 5-hour limit
- Token counts show billions (e.g. `1.3B`); the cost tooltip explains it is what the usage would be billed through the Anthropic API
- README: new **Privacy and open source** section
- Security hardening:
  - `package.json` scripts whose names contain shell characters are no longer offered as one-click buttons, so a cloned repo can't smuggle a command into the terminal
  - Stopping a process only works for processes the dashboard lists (and never pid 0, 1 or negative pids)
  - Tool names such as `constructor` and a `__proto__` key in `nanometrics.claudePricing` can no longer reach object prototypes
  - The webview script nonce now comes from a cryptographic random source

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