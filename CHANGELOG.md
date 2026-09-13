# Changelog

All notable changes to the Coreflux plugin for Cursor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-13

### Added

- `coreflux-broker` MCP server (stdio, dependency-free): `broker_command`, `broker_overview`,
  `broker_connection`, `mqtt_publish`, `mqtt_subscribe`, `mqtt_read_retained`, `lot_lint`,
  `lot_deploy`, `lotnb_deploy`, `lot_remove`, `project_upload`, `project_export`,
  `broker_route_template`, `broker_action_trace`.
- `coreflux-docs` MCP server pointing at docs.coreflux.org.
- Skills: `lot-authoring` (actions, models, routes references), `broker-commands`,
  `broker-observability`, `lot-projects`, `broker-security`.
- Rules: `coreflux-conventions` (always on) and `lot-files` (for `.lot` / `.lotnb`).
- Agents: `lot-reviewer`, `broker-operator`.
- Commands: `/coreflux-status`, `/coreflux-deploy`, `/coreflux-new-route`,
  `/coreflux-new-project`, `/coreflux-debug-action`, `/coreflux-secure`.
- Hooks: session context injection, approval gate for destructive broker commands via MCP or
  shell.
- Static LoT linter covering the parser errors seen most often (indentation, triggers, `MESSAGE`,
  0-based `TOPIC POSITION`, quoted entity names, `ADD METADATA`, hardcoded credentials, `PAYLOAD`
  on timers).

[Unreleased]: https://github.com/CorefluxCommunity/coreflux-cursor-plugin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CorefluxCommunity/coreflux-cursor-plugin/releases/tag/v0.1.0
