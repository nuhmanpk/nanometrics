# Change Log

All notable changes to the "nanometrics" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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