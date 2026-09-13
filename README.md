# Coreflux plugins for Cursor

[![CI](https://github.com/CorefluxCommunity/coreflux-cursor-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/CorefluxCommunity/coreflux-cursor-plugin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/CorefluxCommunity/coreflux-cursor-plugin?include_prereleases&sort=semver)](https://github.com/CorefluxCommunity/coreflux-cursor-plugin/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Cursor Marketplace plugins for the [Coreflux MQTT broker](https://coreflux.org) and
**LoT (Language of Things)** — the DSL that defines actions, models, routes, rules, panels and
themes on a Coreflux broker.

| Plugin | What it gives the agent |
|--------|-------------------------|
| [`plugins/coreflux`](plugins/coreflux) | The full broker command surface over MQTT (`$SYS/Coreflux/Command`), live topic publish/subscribe, LoT lint + ordered deployment of `.lot`/`.lotnb` files, project upload/export, route templates, action tracing, docs search, five LoT/broker skills, two agents, six slash-commands and safety hooks for destructive operations. |

Built from the [cursor/plugin-template](https://github.com/cursor/plugin-template).

## Install

From the Cursor Marketplace, or add this repository as a plugin source. Then set the plugin
variables (Cursor → Plugins → Coreflux):

| Variable | Purpose |
|----------|---------|
| `COREFLUX_MQTT_URL` | `mqtt://host:1883` or `mqtts://host:8883` (default `mqtt://localhost:1883`) |
| `COREFLUX_MQTT_USERNAME` / `COREFLUX_MQTT_PASSWORD` | A user with `CommandCall` (root, admin, or `AllowedSystemConfiguration`) |
| `COREFLUX_MQTT_CLIENT_ID` | Optional fixed client id |
| `COREFLUX_MQTT_TLS_INSECURE` | `"true"` to accept self-signed certs (dev only) |

Alternatively drop a `.broker` file in the workspace root:

```text
mqtt://192.168.1.10:1883
username=root
password=coreflux
```

The MCP server needs Node.js ≥ 20 on the machine running Cursor. It has **no npm
dependencies** — the MQTT client is bundled.

## What you can ask

- "Is the broker healthy?" → `/coreflux-status`
- "Deploy this notebook and prove it works" → `/coreflux-deploy`
- "Add a Modbus route for the PLC at 10.0.0.5, poll every second" → `/coreflux-new-route`
- "Why does `AlertOnOverheat` never publish?" → `/coreflux-debug-action`
- "Lock down `devices/#` so each gateway only publishes its own topics" → `/coreflux-secure`
- "Scaffold a project for the packaging line" → `/coreflux-new-project`
- Anything else: "list projects", "show me `$SYS/Coreflux/Routes/+/status`", "set secret
  PG_PASSWORD", "publish `{"v":1}` to `test/a`", "what does `-lotDiagnostic` return"…

## Repository layout

```
.cursor-plugin/marketplace.json   marketplace manifest
plugins/coreflux/                 the plugin (see its README); tests in plugins/coreflux/test
scripts/                          validate, check, package and release tooling
.github/workflows/                CI (validate → unit matrix → broker e2e → package), release
docs/add-a-plugin.md              how to add another plugin to this repo
```

## Development

```bash
npm run validate   # manifest + frontmatter checks
npm run check      # version sync, hook/MCP wiring, docs ↔ tool names, line endings
npm test           # unit + offline end-to-end tests (in-process fake broker)
npm run smoke      # read-only checks against COREFLUX_MQTT_URL
npm run e2e        # full round-trip against a real broker (creates and removes test entities)
```

The MCP server is `plugins/coreflux/scripts/mcp/coreflux-mqtt-mcp.mjs` (stdio JSON-RPC). Run it
directly and paste JSON-RPC lines to experiment.

Every push and pull request runs the validators, the unit suite on Linux/macOS/Windows with
Node 20 and 22, and the end-to-end suite against `coreflux/coreflux-mqtt-broker:latest`. Tags
`vX.Y.Z` publish a GitHub release with the packaged plugin and its checksum.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run, how to
write skills that stay true to the broker parser, and the release process.
[SECURITY.md](SECURITY.md) covers vulnerability reports. Changes are tracked in
[CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
