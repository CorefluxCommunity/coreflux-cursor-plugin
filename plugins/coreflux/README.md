# coreflux

Author, deploy and operate Coreflux MQTT brokers from Cursor.

## Components

### MCP servers (`mcp.json`)

| Server | Transport | Tools |
|--------|-----------|-------|
| `coreflux-broker` | stdio, `scripts/mcp/coreflux-mqtt-mcp.mjs` | see below |
| `coreflux-docs` | HTTPS `https://docs.coreflux.org/mcp` | documentation search |

`coreflux-broker` tools:

| Tool | Purpose |
|------|---------|
| `broker_connection` | Resolve + test the active profile's MQTT connection, report the user and permissions |
| `broker_list` | Every configured broker profile and which one is active |
| `broker_use` | Switch profile for the session, or persist the choice in the workspace/user file |
| `broker_save` / `broker_remove` | Add, edit or delete a profile in `~/.coreflux/brokers.json` or `.coreflux/brokers.json` |
| `broker_command` | Run any `-command` on `$SYS/Coreflux/Command`, return the correlated JSON envelope |
| `broker_overview` | Routes, projects, active project, pending entities, retained action errors |
| `mqtt_publish` | Publish to any topic (QoS 0/1, retain) |
| `mqtt_subscribe` | Bounded live capture of a topic filter |
| `mqtt_read_retained` | Snapshot of retained state under a filter |
| `lot_lint` | Static LoT checks (code or `.lot`/`.lotnb` path) |
| `lot_deploy` | Split, lint and deploy LoT text (+ optional Python) in broker order |
| `lotnb_deploy` | Same for a notebook/file on disk, with `dryRun` and `only` |
| `lot_remove` | `-remove<Kind> <name>` |
| `broker_route_template` | `-routeCode TYPE` parsed into fields + deployable skeleton |
| `broker_action_trace` | Arm `-actionTrace`, `-runAction`, collect `…/Trace` + `…/Error` |
| `project_upload` | Zip a folder → `-addProject zip64:… [name] [load]` |
| `project_export` | `-getProject` → write the zip locally |

#### Broker profiles

The tools always talk to the **active profile**. Profiles are merged from (later wins):

| Source | Format |
|--------|--------|
| built in | `localhost` → anonymous `mqtt://localhost:1883` |
| plugin variable `COREFLUX_BROKERS` | `local=mqtt://root:pass@localhost:1883; edge=mqtts://ops:pass@10.0.0.5:8883?tlsInsecure=true; prod=mqtts://mqtt.example.com:8883?passwordEnv=PROD_MQTT_PASSWORD` or a JSON object |
| `~/.coreflux/brokers.json` | `{ "active": "local", "brokers": { "local": { "url", "username", "password" \| "passwordEnv", "clientId", "tlsInsecure", "description" } } }` |
| `<workspace>/.coreflux/brokers.json` | same shape; use `passwordEnv` there, never `password` |
| `<workspace>/.broker` | legacy single broker → profile `workspace` |
| plugin variables `COREFLUX_MQTT_URL` / `_USERNAME` / `_PASSWORD` / `_CLIENT_ID` / `_TLS_INSECURE` | single broker → profile `default` |

Active profile, first match: `broker_use` in this session → `COREFLUX_BROKER` variable →
workspace file `active` → user file `active` → `default` → `workspace` → `localhost`.
`/coreflux-connect` walks the user through listing, switching and adding profiles.

### Skills (`skills/`)

| Skill | Use |
|-------|-----|
| `lot-authoring` | LoT syntax, decision guide, anti-patterns; references for actions, models, routes |
| `broker-commands` | Every broker command, payload rules, envelope shape, sequences |
| `broker-observability` | `$SYS/Coreflux` topic map, status/trace JSON, triage playbook |
| `lot-projects` | `.lotnb` format, project layout, load order, `-addProject` / git commands |
| `broker-security` | RBAC rules, flags, groups, which flag each command needs, anti-lockout |

### Rules (`rules/`)

- `coreflux-conventions.mdc` (always on): LoT-only config, tool-first workflow, verify after
  deploy, destructive-command policy, secrets hygiene.
- `lot-files.mdc` (`**/*.lotnb`, `**/*.lot`): notebook JSON shape and mandatory lint.

### Agents (`agents/`)

- `lot-reviewer` — pre-deploy review of LoT/notebooks.
- `broker-operator` — evidence-based operation of a live broker.

### Commands (`commands/`)

`/coreflux-setup` · `/coreflux-connect` · `/coreflux-status` · `/coreflux-deploy` ·
`/coreflux-new-route` · `/coreflux-new-project` · `/coreflux-debug-action` · `/coreflux-secure`

### Hooks (`hooks/hooks.json`)

| Hook | Script | Effect |
|------|--------|--------|
| `sessionStart` | `scripts/hooks/session-context.mjs` | Injects the active broker profile, the other profiles and the notebook count into the session |
| `sessionStart` | `scripts/hooks/ensure-lot-extension.mjs` | Installs the [LOT Notebooks](https://github.com/CorefluxCommunity/VSCodeLotNotebook) editor extension (`coreflux.vscode-lot-notebooks`) through the Cursor CLI when it is missing (checked once a day; opt out with `COREFLUX_INSTALL_LOT_EXTENSION=false` or `{"installLotExtension": false}` in `~/.coreflux/plugin-state.json`) |
| `beforeMCPExecution` (failClosed) | `scripts/hooks/guard-broker-tools.mjs` | Asks for approval before `-removeAll*`, `-removeProject`, `-unloadProject`, `-removeUser`, `-restoreRules`, user/password changes, licence loads, retained `$SYS` publishes, and `project_upload … load` |
| `beforeShellExecution` | `scripts/hooks/guard-shell-commands.mjs` | Same guard for `mosquitto_pub`-style shell commands targeting `$SYS/Coreflux/Command` |

## Permissions the broker user needs

| To… | Needs |
|-----|-------|
| run any command / read `Command/Output` | `CommandCall` + `SubscribeSys` carve-out: root, admin, `AllowedUserManagement`, `AllowedSystemConfiguration` |
| deploy routes/models/actions/rules, env, secrets | `AllowedSystemConfiguration` |
| manage users/groups | `AllowedUserManagement` |
| read other `$SYS/#` topics | `AllowedSystemConfiguration` |

## Tests

```bash
npm test                                   # from the repository root: unit + offline e2e (fake broker)
COREFLUX_MQTT_URL=mqtt://localhost:1883 COREFLUX_MQTT_USERNAME=root COREFLUX_MQTT_PASSWORD=… \
  node scripts/smoke-test.mjs              # read-only checks against a real broker
COREFLUX_MQTT_URL=… COREFLUX_MQTT_USERNAME=… COREFLUX_MQTT_PASSWORD=… \
  node scripts/e2e-test.mjs                # deploys, drives and removes throw-away entities
```

`test/` holds `node:test` suites: the MQTT client against an in-process MQTT 3.1.1 fake broker
(`test/helpers/fake-broker.mjs`), the LoT splitter/linter, the ZIP writer, the hook scripts, and
the MCP server spawned over stdio with every tool exercised.
