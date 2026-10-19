---
name: coreflux-cursor-tools
description: How the Coreflux skills map onto this Cursor plugin — which coreflux-broker MCP tool to call where a skill names a broker MCP tool (deploy_lot, validate_lot, diagnose, get_route_template, run_action, …), how to send any broker command over MQTT and read its envelope, and how to deploy .lot/.lotnb files and projects. Read it together with broker-tools before calling a tool.
---

# Coreflux skills in Cursor

The other skills in this plugin (`broker-tools`, `lot-actions`, `lot-models`, `lot-routes`,
`lot-rules`, `lot-agents`, `lot-things`, `lot-panels`, `lot-themes`, `python-scripts`) are
generated from the broker and shared with every Coreflux client. Their LoT syntax is the
broker's. Their **tool names are not this plugin's**: `broker-tools` describes the broker's own
MCP server and the tools a `DEFINE AGENT` is granted inside the broker. In Cursor you talk to
the broker through the `coreflux-broker` MCP server of this plugin, which sends commands over
MQTT.

## Tool map

| A skill says | Call in Cursor |
|--------------|----------------|
| `load_skill("x")` (either surface) | Read the skill `x` from this plugin |
| `validate_lot` | `lot_lint` (offline), then `broker_command { command: "-validateLot <LoT>" }` for the broker's own check |
| `validate_lotnb` | `lot_lint { path }`, then `lotnb_deploy { path, dryRun: true }` |
| `deploy_lot` | `lot_deploy` — not atomic: read every envelope, it does not roll back |
| `add_action` / `add_model` / `add_route` / `add_rule` / `add_agent` / `add_thing` / `add_panel` / `add_theme` / `add_python` | `lot_deploy` (orders and lints for you; all `DEFINE THING` blocks, templates included, go as one `-addThing`) |
| `add_thing --dryRun` | `broker_command { command: "-addThing --dryRun <DEFINE THING …>" }` |
| `remove_*` | `lot_remove { kind, name }`, or `broker_command -removeX <name>` |
| `diagnose` | `broker_overview` |
| `explore_topics` | `mqtt_read_retained` (state) or a bounded `mqtt_subscribe` (live) |
| `get_route_template` / `provision_data_source` | `broker_route_template { type }`, then `lot_deploy` and `broker_command -checkRouteConnection <name>` |
| `run_action` / `action_trace` | `broker_action_trace { action, payload }` |
| any other registry tool (`list_routes`, `set_env`, `load_project`, …) | `broker_command` with the CLI token: `list_routes` → `-listRoutes`, `set_env` → `-setEnv NAME=value` |
| "no tool publishes an arbitrary MQTT message" | Here one does: `mqtt_publish`. Say what you publish on a non-local broker. |

`broker_connection` tells you which broker profile and user you are on; `broker_list` /
`broker_use` / `broker_save` manage profiles. Name the profile whenever you deploy.

## Commands and envelopes

`broker_command` publishes a plain string to `$SYS/Coreflux/Command` (`-commandName args…`,
LoT bodies unquoted) and returns the JSON envelope from `$SYS/Coreflux/Command/Output`:
`success`, `message`, `data`, and on failure `errors[]` — parse errors carry `line` and
`column`. Fix the LoT to satisfy the broker's message; never retry the same text.
`Permission denied` is a reply. No reply at all means the publish was dropped (the user holds
none of `AllowedSystemConfiguration`, `AllowedUserManagement`, `AllowedLogManagement`), the user
cannot read `Command/Output`, or the command has no MQTT reply (`-updateData`, and today
`-checkActionUsage`, `-loadFolder`, `-mqttPacketTrace`). `broker_action_trace` runs the action for
real: every PUBLISH goes out.

Destructive commands (`-removeAll*`, `-removeProject`, `-unloadProject`, `-removeUser`,
`-restoreRules`, …) are blocked by this plugin's hook unless the user asked for them in this
conversation. State the command and its consequence, get a yes, then run it.

## Files and projects

- `.lot` / `.lotnb` in the workspace: `lot_lint { path }` after every edit,
  `lotnb_deploy { path, dryRun: true }` to see the plan, then `lotnb_deploy { path }`.
- A whole project folder: `project_upload { path, name, load: true }`; fetch one back with
  `project_export { name, outputPath }`.
- Entities deployed with `lot_deploy` / `lotnb_deploy` are ad-hoc; entities loaded from a
  project belong to it and leave with `-unloadProject`.
