---
name: broker-commands
description: Operate a Coreflux MQTT broker through its command surface — every -command on $SYS/Coreflux/Command (routes, models, actions, rules, python, panels, themes, projects, users, groups, env, secrets, audit, trace logs) and the JSON envelope on $SYS/Coreflux/Command/Output. Use when the user wants to list, add, remove, run, diagnose or configure anything on a broker, or asks "what command does X".
---

# Coreflux Broker Commands

Everything the broker can do is a command published to **`$SYS/Coreflux/Command`**; the reply
is a JSON envelope on **`$SYS/Coreflux/Command/Output`**. The `broker_command` tool (MCP
server `coreflux-broker`) does the publish, adds `-requestId`, and returns the matching
envelope. Prefer the specialised tools where they exist:

| Goal | Tool |
|------|------|
| Any command | `broker_command { command: "-listRoutes" }` |
| Health snapshot | `broker_overview` |
| Deploy LoT text / a file | `lot_deploy` / `lotnb_deploy` (lint + ordered `-addX`) |
| Remove one entity | `lot_remove { kind, name }` |
| Route skeleton for a type | `broker_route_template { type }` |
| Debug an action | `broker_action_trace { action, payload }` |
| Ship / fetch a project folder | `project_upload` / `project_export` |
| Raw MQTT | `mqtt_publish` / `mqtt_subscribe` / `mqtt_read_retained` |
| Which broker am I on? | `broker_connection` |
| Several brokers (dev/edge/prod) | `broker_list` → `broker_use { name }`; add one with `broker_save` |

Without a configured broker, give the user the exact payload to publish:
`mosquitto_pub -h HOST -u USER -P PASS -t '$SYS/Coreflux/Command' -m '-listRoutes'` and
`mosquitto_sub … -t '$SYS/Coreflux/Command/Output' -v`.

## Payload rules

- Plain UTF-8 string: `-commandName <args…> [-requestId <id>]`. Not JSON-wrapped.
- Arguments are quote-aware tokens; quotes are stripped. **Do not wrap LoT bodies in quotes.**
  `-addAction DEFINE ACTION X\nON TOPIC "a" DO\n    PUBLISH TOPIC "b" WITH PAYLOAD` is correct.
- Multi-word project names: `-loadProject "Traceability System"` or hyphenate.
- Aliases: `--kebab-case` works for every command (`--list-routes`), and `-addVisu` = `-addPanel`.
- RBAC uses the MQTT session username; there is no `-requestUser`.
- `-updateData` produces no Output message; everything else does.

## Response envelope

```json
{ "success": true, "command": "AddRoute", "requestId": "…", "message": "Route 'X' added successfully!",
  "entityType": "Route", "entityName": "X", "data": {} }
```

- `data` is always present (`{}`/`[]` when empty). Lists put arrays in `data`.
- Failures: `success: false`, `errors[]` with `message`, and for parse errors `line`,
  `column`, `sourceLines`, `suggestions`. Quote the `line` back to the user and fix the LoT.
- `Permission denied: You are not allowed to execute -x` → RBAC (see `broker-security`).
- `Unknown command: -x` → typo or command not wired for MQTT (`-mqttPacketTrace`,
  `-checkActionUsage`, `-loadFolder` are dispatcher-only).
- If the publish itself is rejected (no Output at all), the user lacks `CommandCall`.

## Command index

### Routes
| Command | Args | Notes |
|---|---|---|
| `-addRoute` | `DEFINE ROUTE … WITH TYPE …` | Redeploy the **full** route to change one tag |
| `-removeRoute` | `<name>` | |
| `-removeAllRoutes` | | **destructive** |
| `-listRoutes` | | `data[]`: `name`, `type`, `connection`, `health` |
| `-routeCode` | `<TYPE>` | Template LoT in `data` (contains template-only `ADD METADATA`) |
| `-listTemplates` | | Route types available on this build |
| `-checkRouteConnection` | `<name>` | Connection probe details in `data` |
| `-connectionStatus` | | Text report of every route connection |
| `-routeCertificates` | `cert64:<base64-json>` | TLS cert management for routes |
| `-discoverAIProviders` | `[json]` | Detect local/cloud LLM providers |

### Models
| Command | Args |
|---|---|
| `-addModel` | `DEFINE MODEL Name …` |
| `-removeModel` | `<name>` |
| `-removeAllModels` | **destructive** |

### Actions
| Command | Args | Notes |
|---|---|---|
| `-addAction` | `DEFINE ACTION Name …` | |
| `-removeAction` | `<name>` | |
| `-removeAllActions` | | **destructive** |
| `-runAction` | `<name> [json]` | JSON = INPUT bindings, or `{"topic":"…","payload":…}` to simulate an inbound message; returns `data.traceId`, `status`, `published[]` |
| `-actionTrace` | `<name>\|all\|off\|status\|remove <name>` | Streams to `$SYS/Coreflux/Actions/<name>/Trace` for 5 min |
| `-lotDiagnostic` | `model\|action\|route\|rule <name>` | Static + runtime diagnosis of a deployed entity |
| `-getPendingStatus` | | Models/actions waiting on missing dependencies |

### Rules (RBAC)
| Command | Args | Notes |
|---|---|---|
| `-addRule` | `DEFINE RULE Name WITH PRIORITY N FOR <Scope> [TO TOPIC "…"] …` | Priorities `0–99` are reserved |
| `-removeRule` | `<name>` | Built-in rules cannot be removed |
| `-restoreRules` | | Restores `AllowPublishTopic`, `AllowSubscribeTopic`, `AllowConnect` — **confirm first** |

### Python
| Command | Args | Notes |
|---|---|---|
| `-addPython` | `<code>` starting with `# Script Name: Name` | Whole script as the payload |
| `-removePython` | `<name>` | |
| `-installPythonPackage` | `<package>` | pip install into the embedded runtime |
| `-listPythonPackages` | | |
| `-removeAllPythonScripts` | | **destructive** |

### Panels & themes (LoTV dashboards)
| Command | Args |
|---|---|
| `-addPanel` / `-addVisu` | `DEFINE PANEL "Name" …` |
| `-removePanel` | `<name>` |
| `-listPanels` | publishes to `$SYS/Coreflux/VoT/Panels/<name>` |
| `-panelCode` | `<name>` → LoT source |
| `-updateVisuState` | `<name> DRAFT\|PUBLISHED\|ARCHIVED` |
| `-addVisuFile` | `lot64:<base64>` |
| `-refreshVisu` | |
| `-addTheme` / `-removeTheme` / `-listThemes` / `-removeAllThemes` | |

### Projects (see `lot-projects` skill)
| Command | Args |
|---|---|
| `-addProject` | `<git-url\|path\|file.zip\|zip64:<b64>> [branch\|name] [load]` |
| `-removeProject` | `<name>` — **destructive** |
| `-loadProject` / `-unloadProject` | `<name>` / — |
| `-listProjects` | `data[]` projects with status |
| `-listEntities` | loaded entity manifest with `origin` (`adhoc` or project/file/cell) |
| `-getProject` | `<name>` → base64 zip on `$SYS/Coreflux/Projects/<name>/download` |
| `-duplicateProject` | `<source> <newName>` |
| `-projectCheckout` / `-projectPull` / `-projectPush` / `-projectStatus` / `-projectManifest` | `<name> [ref]` |

### Users & groups
| Command | Args | Permission |
|---|---|---|
| `-addUser` | `<user> <password>` | `UserManagementCreation` |
| `-removeUser` | `<user>` | `UserManagementRemove` — **destructive** |
| `-changeUserPassword` | `<user> <newPassword>` | `UserManagementPasswordChange` |
| `-changeUserSettings` | `<user> <Setting> <value>` e.g. `AllowedSystemConfiguration true` | `UserManagementUpdate` |
| `-addUserToGroup` / `-removeUserFromGroup` | `<user> <group>` | `UserManagementUpdate` |
| `-listUserGroups` | `<user>` → `data.groups` | |

### Environment & secrets
| Command | Args | Notes |
|---|---|---|
| `-setEnv` | `NAME=value` | Read in LoT with `GET ENV "NAME"` / `{env.NAME}` |
| `-removeEnv` / `-listEnv` | | |
| `-setSecret` | `NAME=value` | Encrypted at rest; `GET SECRET "NAME"` / `{secret.NAME}`; never echoed |
| `-removeSecret` / `-listSecrets` | | `-listSecrets` returns names only |

### Audit, logs, licence, misc
| Command | Args |
|---|---|
| `-auditStatus` / `-auditQuery YYYY-MM-DD[\|filter]` / `-decryptAudit [\|exportPath]` | |
| `-addTraceLog` / `-listTraceLogs` / `-removeTraceLog` / `-removeAllTraceLogs` | trace-log sinks under `$SYS/Coreflux/Log/Traces/` |
| `-loadLicense` | `<path-to-signed-license>` |
| `-updateData` | refresh `$SYS` statistics (no reply) |

## Destructive commands — confirm before running

`-removeAllRoutes`, `-removeAllModels`, `-removeAllActions`, `-removeAllPythonScripts`,
`-removeAllThemes`, `-removeAllTraceLogs`, `-removeProject`, `-removeUser`, `-restoreRules`,
`-unloadProject` (when a project is active). The plugin's `beforeMCPExecution` hook blocks
them unless the user has explicitly asked in this conversation; state the exact command
and its consequence, get a yes, then run it.

## Typical sequences

**Deploy and verify an action**
1. `lot_lint` → `lot_deploy` (or `broker_command -addAction …`)
2. `broker_action_trace { action, payload: {"topic":"…","payload":…} }`
3. `mqtt_subscribe` on the output topic

**Bring up a route**
1. `broker_route_template MODBUS_TCP` → fill `skeleton`, credentials via `GET SECRET`
2. `broker_command -setSecret PLC_PASS=…` if needed
3. `lot_deploy` → `broker_command -checkRouteConnection Name` → `mqtt_read_retained $SYS/Coreflux/Routes/Name/status`
4. `mqtt_subscribe plc1/read/#` to see polled tags

**Investigate "nothing happens"**
1. `broker_overview` (routes health, pending status, action errors)
2. `broker_command -lotDiagnostic action Name`
3. `broker_command -getPendingStatus` — a model/action can wait on a missing dependency
4. `mqtt_read_retained $SYS/Coreflux/Actions/Name/Error`
