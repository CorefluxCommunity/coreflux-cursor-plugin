---
name: broker-tools
description: "Complete reference for the tools you can call on a Coreflux broker: the MCP tool surface the Hub assistant and MCP clients use (validate_lot, deploy_lot, explore_topics, diagnose, provision_data_source and one tool per registry command), the broker__ tools a DEFINE AGENT is granted (read_mqtt, write_mqtt, read_lot, create_lot, execute_routes, execute_actions), Insight vs Agent mode, and the mandatory workflow for deploying LoT safely."
---

# Broker Tools — Complete Reference

## Which tool surface you are on

There are two, with different tool names. Look at the tools you were given and use this table.

| You are | Your tools are named | Skills come from |
|---------|----------------------|------------------|
| The Hub assistant, or any MCP client of the broker | `deploy_lot`, `validate_lot`, `add_action`, … — no prefix (see "MCP tools" below) | `load_skill` (Hub) or the MCP resource `coreflux://skills/<name>` |
| A `DEFINE AGENT` running inside the broker | `broker__read_mqtt`, `broker__create_lot`, … — only the tools its `ADD TOOL` lines grant, plus `agent__<peer>__ask` for each peer in `WITH AGENTS` | `broker__load_skill` (always present) |

There are **no** UI tools on either surface: no `show_approval`, `show_code`, `show_progress`,
`show_option_list` or `create_artifact`. There is also no `run_python`, `list_topics`,
`get_topic_payload`, `publish_topic`, `action_errors`, `trace`, `capture_image`, and no
auto-generated `{RouteName}.trigger_*` / `.query` / `.store` / `{McpRouteName}.*` tools. Those
belonged to the retired `TYPE AGENT` route and do not exist — never call them, and never tell
the user they exist.

**Insight vs Agent mode (Hub).** In Insight mode the Hub gives you only the tools the broker
marks read-only (the "Read-only" column below). In Agent mode you get every tool, and the Hub
asks the user to approve each call to a write tool before it runs — you do not request
approval yourself. Over a plain MCP client there is no approval step: the call runs.

The MCP surface can also be narrowed by the operator (`EnableAllTools` false plus an
`EnabledTools` allowlist), so a tool listed here may be absent. Work with what you were given.

---

## MANDATORY WORKFLOW — MCP / Hub assistant

```
1. load_skill("lot-actions")          ← the skill for the kind you are writing (see list below)
2. explore_topics() / list_routes() / list_entities()
                                       ← know what data flows and what already exists
3. validate_lot(argument=<the LoT>)    ← every syntax, resolve, compile and lint error at once;
                                         deploys nothing. Fix and re-validate until "valid": true
4. deploy_lot(source=<the LoT>)        ← atomic: rolls back on the first failure
5. diagnose()                          ← connection status, action errors, pending work
```

Prefer **deploy_lot** over the per-entity `add_action` / `add_model` / `add_route` /
`add_rule` tools. For a new OT or database connector, prefer **provision_data_source** (omit
`definition` to fetch the template; pass it to deploy and check the connection) after
loading `lot-routes`. Panels and themes are not handled by deploy_lot: deploy them with
`add_panel` / `add_theme`. Things are deployed with `add_thing` (load `lot-things` first).

**One logical change, one deploy.** If a deploy fails and only a syntax fix is needed (same
names, same intent, same topics, same trigger, same permission scope), fix the source,
re-validate and deploy again. In Hub Agent mode each write call is approved by the user; do
not ask again in chat for a pure syntax fix.

## MANDATORY WORKFLOW — DEFINE AGENT

```
1. broker__load_skill("lot-actions")         ← read the syntax FIRST
2. broker__read_lot() / broker__read_mqtt(topic="…/#")
                                              ← read before you write; never replace an
                                                entity you have not just read
3. broker__create_lot(target="action", lot=<one DEFINE block>)
                                              ← one entity per call
4. broker__read_lot(target=<name>)            ← confirm it is loaded
```

A DEFINE AGENT has no validate tool and no error-reading tool: `create_lot` returns the add
command's result (`success`, `message`, `errors`, `warnings`) — read it, fix, and call again.

Which skill to load before each kind:
- Action → `lot-actions` · Model → `lot-models` · Route / connector → `lot-routes`
  (and `get_route_template("TYPE")` over MCP) · Rule → `lot-rules` · Panel → `lot-panels`
  · Theme → `lot-themes` · Agent → `lot-agents` · Python script → `python-scripts`
- Before explaining or changing a DEFINE THING, or an entity it owns → `lot-things`
- A vendor REST API (Airtable, ServiceNow, SAP, …) → `rest-api-connectors` on the Hub and in
  a DEFINE AGENT. Elsewhere that skill is not available; get the same information from
  `list_route_templates` (REST API apps carry `connector: true`) and
  `get_route_template("<APP_CODE>")` (`-routeCode <APP_CODE>` over MQTT)
- Raw MQTT commands on `$SYS/Coreflux/Command`, the `$SYS` topic map, users and permission
  flags, env vs secrets, projects and `.lotnb` notebooks → `broker-operations`

---

## MCP tools — the consolidated four

### explore_topics
Paginated topic discovery with inferred payload schema. Read-only; does not wait for live
publishes. Topics you may not subscribe to are filtered out.
Parameters: `filter` (optional topic prefix, e.g. `"sensors/"`), `limit` (default 50, max 200),
`cursor` (from the previous page's `next_cursor`), `response_format` (`concise` omits payloads;
`detailed` includes payload and field-level schema).

### diagnose
Aggregate broker health in one call: connection status, action errors and pending status.
Takes no arguments. Partial results come back when one source fails, with the reason in
`errors[]`. Use it after every deploy.

### provision_data_source
Provision an OT or database connector from a LoT `DEFINE ROUTE` (or `DEFINE CONNECTOR`).
Parameters: `route_type` (required, e.g. `POSTGRESQL`, `MODBUS_TCP`), `name` (required),
`definition` (optional — omit to fetch the connector-type template without deploying),
`filter` (optional topic prefix explored after a successful connection check; defaults to the
connector name). Write tool — not available in Insight mode.

### deploy_lot
Atomically deploy `DEFINE ACTION`, `MODEL`, `ROUTE` (or `CONNECTOR`), `AGENT`, `RULE` and
`THING` blocks from one source string. Parameter: `source` (required). Blocks are added in
source order, one add command per DEFINE (consecutive DEFINE THING blocks are one `-addThing`);
place an agent after the LLM connector it uses. After each action, compile errors are
checked. On the first failure everything this call added is removed in reverse order and an
entity it overwrote is restored, and the result has `rolled_back: true`. Returns `success`,
`rolled_back`, `deployed`, `failed_entity`, `error`, `action_errors`. Panels and themes are not
accepted. Write tool — not available in Insight mode.

---

## MCP tools — registry commands

Every broker command that declares the MCP surface is a tool named after its CLI token in
snake_case (`-addAction` → `add_action`). These tools take **one** parameter:

- `argument` (string) — passed to the command verbatim, exactly what follows the token on the
  CLI. For `add_*` it is the full LoT block; for `remove_*`, `disable_*`, `enable_*` and
  `check_route_connection` it is the entity name.
- Tools named `list_*`, plus `audit_query` and `get_pending_status`, also take `limit`,
  `cursor` and `response_format` (`concise` | `detailed`) and return a page.

Notes on the ones you will use most:

- **validate_lot** — `argument` is one or more DEFINE blocks. Prefix with `--isolated` to check
  the snippet against itself only (ignore live entities). Returns `valid`, `errors`,
  `warnings` and every diagnostic with line and column. Deploys nothing. Read-only.
- **validate_lotnb** — the same for a `.lotnb` notebook JSON, or `--project <name>`.
- **add_action / add_model / add_route / add_rule / add_panel / add_theme / add_agent** —
  exactly ONE DEFINE block per call. Re-adding a name replaces it. For several entities use
  deploy_lot.
- **add_thing / remove_thing / list_things** — Things deploy as one unit with their children.
  Lead `add_thing`'s argument with `--dryRun` to get the plan without changing anything. Never
  change a Thing's child entity directly: change the Thing and redeploy it.
- **disable_action / enable_action / disable_route / enable_route** — turn an entity off without
  removing it. It is redeployed with a `DISABLE true` line, stays defined and listed, and
  stays off across restarts. A disabled action's triggers do not fire and `run_action` refuses
  it; a disabled connector opens no connection. `disable_agent` / `enable_agent` do the same
  for agents. Prefer these over remove when the user wants something "stopped" or "paused".
- **list_entities** — every deployed entity (kind and name) with its project. Use before you
  replace or remove anything.
- **list_routes** — connectors with health (Green/Yellow/Red), events and mappings. Agents are
  not listed here.
- **list_agents** — agents with `name`, `llmRoute`, `status` (`online` / `offline` / `error`) and
  `description`.
- **check_route_connection** — test one connector's connection by name.
- **run_action** — `argument` is `<actionName>` or `<actionName> <json>`. Each action is also
  its own tool, `action_<name>`, with a `payload` parameter; `list_action_tools` lists them.
- **action_trace** — `argument` is `<actionName>`, `all`, `off`, `status` or
  `remove <actionName>`. Trace records are published (not retained) to
  `$SYS/Coreflux/Actions/<name>/Trace`; tracing auto-expires after 5 minutes. Runtime errors
  are retained on `$SYS/Coreflux/Actions/<name>/Error` and summarised by `diagnose`.
- **set_secret / set_env** — never put a credential value you were given in chat into a
  tool call or into LoT. Tell the user which secret names to set; connectors read them with
  `GET SECRET "…"` / `GET ENV "…"`.

Hand-written MCP tools (named differently from their command):

| Tool | Parameters | Purpose |
|------|-----------|---------|
| get_route_template | `routeType` (required) | Template for a connector type (POSTGRESQL, MODBUS_TCP, OPCUA, MCP, LLM, REST_API, …) or a REST API app code (AIRTABLE, SERVICENOW, SAP_S4HANA_CLOUD, …) |
| list_route_templates | `limit`, `cursor`, `response_format` | Every connector template and REST API app; apps carry `connector: true` |
| get_panel_code | `panelName` (required) | LoTV source of a deployed panel |
| add_trace_log | `traceConfig` (required) | `level=<Level>,expires=<seconds>,messageContains=<substring>` |
| get_broker_info | — | Version, status and capabilities |
| get_available_commands | `limit`, `cursor`, `response_format` | Every command this MCP server can run |
| list_action_tools | `limit`, `cursor`, `response_format` | The `action_<name>` tools |

**Templates.** `get_route_template` returns placeholders in the form
`#Name,type,Description,regex,required#` — replace each with a real value. A REST API app is a
pre-built `TYPE REST_API` connector for one vendor; the generated LoT must keep
`WITH TYPE REST_API` (an app code is not a connector type). Templates end with an
`ADD METADATA` block (WITH IMAGE / WITH DESCRIPTION / WITH DOCLINK) — documentation only.
**NEVER include ADD METADATA in the connector LoT you deploy**; the parser rejects it.
Never hardcode credentials — use `GET ENV` / `GET SECRET`.

There is no MCP tool that publishes an arbitrary MQTT message. To make something happen on a
topic, run an action (`run_action` / `action_<name>`) that publishes it.

---

## DEFINE AGENT tools (`broker__…`)

A DEFINE AGENT sees `broker__load_skill` plus only what `ADD TOOL` grants (see `lot-agents`).
Every call is checked against the grant's topics or targets and against the broker ACL /
command permissions, as both whoever started the task and the agent's `DEFAULT_USER`.

| Tool | Parameters | What it does |
|------|-----------|--------------|
| broker__load_skill | `name` | Load a skill body (no grant needed) |
| broker__read_mqtt | `topic` (filter, inside the granted TOPICS), `limit`, `cursor` | Latest payload of every known topic matching the filter. With a wildcard, payloads over 1024 chars are cut to a preview (`payload_truncated`); read the exact topic for the whole payload |
| broker__write_mqtt | `topic` (concrete, inside the granted TOPICS), `payload`, `retain` (default false) | Publish one message, checked against the Publish ACL (`PublishSys` for `$SYS/…`) |
| broker__read_lot | `target` (optional: a kind — action, model, route, rule, panel, agent, python, thing — or an exact entity name) | The loaded entity manifest, narrowed to the target |
| broker__create_lot | `target` (action, model, route, rule or panel — as granted), `lot` (one DEFINE block) | Create or replace one entity through its add command |
| broker__execute_routes | `target` (`<route>.<event>`), `parameters` (optional JSON object) | Trigger one connector event |
| broker__execute_actions | `target` (action name), `arguments` (optional JSON) | Run one granted action (`-runAction`) |
| agent__<peer>__ask | `question` | Delegate a task to a peer agent |

Things to know:
- Write grants must be `WITH LEVEL "write"`; confirmed writes (`write_confirm`) are not
  available yet, so `create_lot` cannot author agents or skills, and nothing can author a Thing.
- `write_mqtt` refuses wildcards and every agent-bus topic; reach other agents only through
  `agent__<peer>__ask`. Publishing to `$SYS/…` needs a `PublishSys` rule — it is default-deny,
  even for `root`, apart from a short built-in list (`$SYS/Coreflux/Command`, `Config/New`,
  `Actions/+/Invoke`, `Actions/+/Run`, `Hub/#`).
- `execute_routes` is authorized as a `PublishSys` on
  `$SYS/Coreflux/Routes/<route>/Events/<event>/Trigger`, so the principal needs a rule allowing
  that topic. Events whose name starts with `_`, and events of an agent, are always refused.
- A connector event's result arrives on its `DESTINATION_TOPIC`; read it with `read_mqtt` if
  that topic is granted.

---

## MCP registry tools — full list

Generated from the broker command registry. "Read-only" tools are the ones available in Hub
Insight mode. A DEFINE AGENT does not get these tools — only the `broker__` tools above.

| Tool | Command | Read-only |
|------|---------|-----------|
| action_trace | `-actionTrace` | |
| add_action | `-addAction` | |
| add_agent | `-addAgent` | |
| add_model | `-addModel` | |
| add_panel | `-addPanel` | |
| add_project | `-addProject` | |
| add_python | `-addPython` | |
| add_route | `-addRoute` | |
| add_rule | `-addRule` | |
| add_theme | `-addTheme` | |
| add_thing | `-addThing` | |
| add_trace_log | `-addTraceLog` | |
| add_user | `-addUser` | |
| add_user_to_group | `-addUserToGroup` | |
| add_visu_file | `-addVisuFile` | |
| audit_export | `-auditExport` | |
| audit_query | `-auditQuery` | yes |
| audit_status | `-auditStatus` | yes |
| change_user_settings | `-changeUserSettings` | |
| check_action_usage | `-checkActionUsage` | yes |
| check_route_connection | `-checkRouteConnection` | yes |
| connection_status | `-connectionStatus` | yes |
| decrypt_audit | `-decryptAudit` | yes |
| disable_action | `-disableAction` | |
| disable_agent | `-disableAgent` | |
| disable_route | `-disableRoute` | |
| discover_ai_providers | `-discoverAIProviders` | yes |
| duplicate_project | `-duplicateProject` | |
| enable_action | `-enableAction` | |
| enable_agent | `-enableAgent` | |
| enable_route | `-enableRoute` | |
| get_panel_code | `-panelCode` | yes |
| get_pending_status | `-getPendingStatus` | yes |
| get_project | `-getProject` | yes |
| get_route_template | `-routeCode` | yes |
| install_python_package | `-installPythonPackage` | |
| list_agents | `-listAgents` | yes |
| list_entities | `-listEntities` | yes |
| list_env | `-listEnv` | yes |
| list_panels | `-listPanels` | yes |
| list_projects | `-listProjects` | yes |
| list_python_packages | `-listPythonPackages` | yes |
| list_route_templates | `-listTemplates` | yes |
| list_routes | `-listRoutes` | yes |
| list_secrets | `-listSecrets` | yes |
| list_themes | `-listThemes` | yes |
| list_things | `-listThings` | yes |
| list_trace_logs | `-listTraceLogs` | yes |
| list_user_groups | `-listUserGroups` | yes |
| load_folder | `-loadFolder` | |
| load_project | `-loadProject` | |
| lot_diagnostic | `-lotDiagnostic` | yes |
| mqtt_packet_trace | `-mqttPacketTrace` | |
| project_checkout | `-projectCheckout` | |
| project_manifest | `-projectManifest` | yes |
| project_pull | `-projectPull` | |
| project_push | `-projectPush` | |
| project_status | `-projectStatus` | yes |
| refresh_visu | `-refreshVisu` | |
| remove_action | `-removeAction` | |
| remove_agent | `-removeAgent` | |
| remove_all_actions | `-removeAllActions` | |
| remove_all_models | `-removeAllModels` | |
| remove_all_project_rules | `-removeAllProjectRules` | |
| remove_all_python_scripts | `-removeAllPythonScripts` | |
| remove_all_routes | `-removeAllRoutes` | |
| remove_all_themes | `-removeAllThemes` | |
| remove_all_trace_logs | `-removeAllTraceLogs` | |
| remove_env | `-removeEnv` | |
| remove_model | `-removeModel` | |
| remove_panel | `-removePanel` | |
| remove_project | `-removeProject` | |
| remove_python | `-removePython` | |
| remove_route | `-removeRoute` | |
| remove_rule | `-removeRule` | |
| remove_secret | `-removeSecret` | |
| remove_theme | `-removeTheme` | |
| remove_thing | `-removeThing` | |
| remove_trace_log | `-removeTraceLog` | |
| remove_user | `-removeUser` | |
| remove_user_from_group | `-removeUserFromGroup` | |
| restore_rules | `-restoreRules` | |
| route_certificates | `-routeCertificates` | yes |
| run_action | `-runAction` | |
| set_env | `-setEnv` | |
| set_secret | `-setSecret` | |
| unload_project | `-unloadProject` | |
| update_data | `-updateData` | |
| update_visu_state | `-updateVisuState` | |
| validate_lot | `-validateLot` | yes |
| validate_lotnb | `-validateLotnb` | yes |

Plus `explore_topics` and `diagnose` (read-only), `provision_data_source` and `deploy_lot`,
`get_broker_info`, `get_available_commands`, `list_action_tools` (read-only) and one
`action_<name>` tool per user action.

Deliberately not exposed to any agent: licensing and enrollment (`-activateLicense`,
`-loadLicense`, `-refreshLicense`, `-enroll`), credentials (`-changeUserPassword`,
`-createMcpToken`, `-listMcpTokens`, `-revokeMcpToken`, `-brokerCertificates`), and the
`-auditFilter` modifier. If the user needs one of these, tell them to run it themselves.
