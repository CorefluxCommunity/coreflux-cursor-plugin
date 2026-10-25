---
name: broker-operations
description: "Operating a Coreflux broker over MQTT: the $SYS/Coreflux/Command payload and the Command/Output reply envelope, the $SYS/Coreflux topic map, route status and action trace JSON, a triage playbook, users, groups and permission flags, env vs secrets, and projects and .lotnb notebooks."
---

# Broker Operations — Commands, $SYS Topics, Users, Projects

Every broker command (`-addAction`, `-listRoutes`, `-loadProject`, …) is reachable two ways:

- **Over MCP** it is a registry tool of the same name in snake_case (`-listRoutes` →
  `list_routes`); see `broker-tools`. The tool's `argument` is what follows the token.
- **Over raw MQTT** an external client (a script, `mosquitto_pub`, an IDE plugin, another
  broker) publishes the command to `$SYS/Coreflux/Command` and reads the reply on
  `$SYS/Coreflux/Command/Output`. The rest of this skill is about that path.

## 1. Command payload

The payload is a **plain UTF-8 string**, never a JSON wrapper:

```
-commandName <arguments…> [-requestId <id>]
```

| Rule | Detail |
|------|--------|
| Spellings | Every command also has a `--kebab-case` form (`-listRoutes` = `--list-routes`). Aliases: `-addConnector` = `-addRoute`, `-addVisu` = `-addPanel`, `-listConnectors` = `-listRoutes`, `-connectorCode` = `-routeCode`, … |
| Plain arguments | Split into quote-aware tokens; the quotes are stripped. Quote a name with spaces: `-loadProject "Traceability System"` |
| LoT bodies | `-addAction` / `-addModel` / `-addRoute` / `-addRule` / `-addAgent` / `-addPanel` / `-addTheme` / `-addThing` take the `DEFINE …` block **unquoted**, newlines and indentation preserved. Send one block per add command |
| `--dryRun` | After `-addAction`/`-addModel`/`-addRoute`/`-addRule`/`-addThing`: validate only (the first four reply as `ValidateLot`) |
| `-runAction` JSON | The JSON after the action name is kept verbatim (quotes intact) |
| Comments | `//`, `/* */` and `-- ` comments outside string literals are stripped from the payload before parsing |
| `-requestId` | Must be the **last** token. Echoed back as `requestId`; use it to match replies, because every allowed subscriber sees the same Output topic |
| Identity | The caller is the MQTT session's username. The broker appends `-requestUser` itself — never send it |

Example payloads:

```
-listRoutes -requestId r1
-addAction DEFINE ACTION Heartbeat
ON EVERY 10 SECONDS DO
    PUBLISH TOPIC "system/heartbeat" WITH TIMESTAMP "ISO" -requestId a1
-setSecret PG_PASSWORD=<value> -requestId s1
```

## 2. Reply envelope (`$SYS/Coreflux/Command/Output`)

Not retained, JSON, camelCase. Null fields are omitted.

| Field | When | Meaning |
|-------|------|---------|
| `success` | always | `true` / `false` |
| `command` | always | PascalCase command name (`AddRoute`, `ListRoutes`) |
| `requestId` | if you sent one | Your correlation id |
| `message` | always | Human-readable summary |
| `entityType` / `entityName` | single-entity commands | e.g. `Action` / `Heartbeat` |
| `data` | **always** | Structured result (`{}` when none). List/status commands put their JSON here |
| `errors[]` | failures only | `{ code?, message, line?, column?, sourceLines?, suggestions? }`. Parse context (line, column, `sourceLines` map of line → text, `suggestions`) is on the first error |
| `warnings[]` | when any | Non-fatal problems — e.g. a project load that skipped entities still has `success: true` |

A failure with a stable code (`ROUTE_INIT_FAILED`, `ROUTE_ACTION_LIMIT_EXCEEDED`) carries it in
`errors[0].code` and `data.error.code`. Branch on the code, not the message.

**Reading silence and odd replies:**

| You see | Cause |
|---------|-------|
| `Unknown command: -x` | Not a registered token — a typo |
| `Permission denied: You are not allowed to execute …` | Your user fails `CommandCall` or the command's own scope (section 6) |
| `Command blocked: …` | The payload matched the broker's command-injection filter |
| **No reply at all** | (a) the publish to `$SYS/Coreflux/Command` was dropped — `PublishSys` is default-deny and your user holds none of the three flags; (b) you may not subscribe to `Command/Output`, so the reply exists but you never see it; (c) the command has no MQTT reply: `-updateData` |

## 3. `-runAction`

| Form | For | Returns in `data` |
|------|-----|-------------------|
| `-runAction <name>` | Any action — runs it once, no trigger context | `action`, `traceId` |
| `-runAction <name> {"a":1,"b":2}` | A callable action: the object binds its `INPUT` parameters | the run result |
| `-runAction <name> {"topic":"sensors/line1/temp","payload":72.5}` | An `ON TOPIC` / `ON CHANGE` action, as if that message arrived. `topic` must match the trigger pattern; a non-string `payload` is passed as raw JSON text | `action`, `traceId`, `status` (`success`/`error`/`no_trace_captured`), `published[]` (`{topic, payload}`), `durationMs`, `error` |

The topic form runs synchronously with tracing forced on, so `published[]` is the fastest way
to see what an action does with a given input. **It is not a dry run**: every PUBLISH really
goes out. A disabled action is refused. Needs `ActionManagementRun`.

## 4. `$SYS/Coreflux` topic map

All topics below are prefixed `$SYS/Coreflux/`. Periodic ones are republished about every 7 s;
`-updateData` forces a republish now.

| Topic | Retained | Content |
|-------|:-------:|---------|
| `Command` | — | Inbound commands (section 1) |
| `Command/Output` | no | Replies (section 2) |
| `Actions/<n>` | yes | Action LoT source (appears on the next periodic cycle after `-addAction`) |
| `Actions/<n>/Description` | yes | Action description |
| `Actions/<n>/Error` | yes | Last runtime error: `timestamp`, `action`, `error`, `trigger.{topic,clientId}` |
| `Actions/<n>/Trace` | no | Trace records, only while tracing is on (`-actionTrace`, 5 min auto-expiry) |
| `Models/<n>` | yes | Model LoT source |
| `Rules/<n>` | no | Rule LoT source (periodic) |
| `Routes/<n>` | yes | Connector LoT source |
| `Routes/<n>/status` | no | Connector status JSON (section 5), periodic |
| `Routes/<n>/Tools` | yes | MCP connector: discovered tools |
| `Routes/<n>/Certificates` | yes | Certificate stores, `pendingCount`, `pending[]` (rejected peer certs awaiting trust), `activeThumbprints` |
| `Routes/<n>/Events/<e>/Trigger` | — | Inbound: publish here to fire a connector event (needs a `PublishSys` rule) |
| `VoT/Panels/<n>` | no | Panel source |
| `VoT/Themes/<n>` | yes | Compiled theme |
| `Projects/list`, `Projects/active` | yes | Project names; the active project |
| `Projects/<n>/status`, `Projects/<n>/manifest` | yes | Git status; content manifest |
| `Projects/<n>/download` | **no** | `zip64:<base64>` from `-getProject` — subscribe **before** sending it |
| `Entities/ownership` | yes | Which project/file/cell owns each entity |
| `Comms/Logins` | no | One JSON per connect attempt: `ClientId`, `Endpoint`, `Username`, `CleanSession`, `ReasonCode` |
| `Comms/Sessions` | no | Connected sessions, periodic |
| `Comms/PacketTrace/<clientId>/In` · `/Out` | no | Raw packets while `mqtt_packet_trace` is on |
| `Log/Traces/<…>` | no | Log lines matching an `-addTraceLog` trace point |
| `Version` | yes | Broker version |
| `License` | yes | Licence and enrollment status (not `License/Status`) |
| `Cluster/Role`, `IsLeader`, `Leader`, `Term`, `Members` | yes | Only when clustering is on. `Members` is a count |

## 5. Route status and action trace JSON

**`Routes/<n>/status`**: `name`, `type`, `connection` (`Disconnected` | `Connecting` |
`Connected` | `Reconnecting`), `health` (`Green` | `Yellow` | `Red`),
`errors.{total, consecutive, rate}`, `messages.{total, succeeded, failed}`, `lastActivity`,
`lastSuccess`, `lastError`, `uptime`, `connectedSince`, `timestamp`, and `warning` when degraded.

| Health | When |
|--------|------|
| Red | Disconnected, **or** ≥ 3 consecutive failures, **or** > 30 % failures in the last 20 operations |
| Yellow | Connecting/Reconnecting, an operational warning (`warning` field), or 0–30 % failures in the last 20 operations |
| Green | Connected, no failures in the window |

`errors.consecutive > 0` while `connection` is `Connected` means the endpoint answers but rejects
the operations: a bad query, wrong register or node, or missing write rights.

**`Actions/<n>/Trace`**: `action`, `traceId`, `timestamp`,
`trigger.{topic, payload (first 512 chars), clientId}`, `timing.{startUtc, endUtc, durationMs}`,
`published[]` (`{topic, payload}`), `result` (`success` | `error`), `error`.

## 6. Users, groups and permissions

| Command | Arguments |
|---------|-----------|
| `-addUser` | `<user> <password>` — a new user has no flags and no groups |
| `-removeUser` | `<user>` |
| `-changeUserPassword` | `<user> <newPassword>` |
| `-changeUserSettings` | `<user> <Setting> <value>`, e.g. `operator1 AllowedUserManagement true` |
| `-addUserToGroup` / `-removeUserFromGroup` | `<user> <group>` |
| `-listUserGroups` | `<user>` |

A group exists once a user is in it; there is no create step. Use groups plus rules for data
access (`lot-rules`), and the three flags — `AllowedSystemConfiguration`,
`AllowedUserManagement`, `AllowedLogManagement` — only for administration. A fresh broker has
one user, `root`, with a default password and `AllowedSystemConfiguration`: change it with
`-changeUserPassword` before the broker is reachable from a network.

**Who passes the locked built-in gates** (user rules cannot change these; see `lot-rules`):

| Gate | Passes |
|------|--------|
| Publish to `$SYS/Coreflux/Command` | any of the three flags; `root` |
| Subscribe `Command/Output`, `Projects/#` | `AllowedSystemConfiguration`, `AllowedUserManagement`, `root`, `admin` |
| Subscribe any other `$SYS/#` | `AllowedSystemConfiguration`, `root`, `admin` |
| `CommandCall` — **every** MQTT command checks this first | `AllowedSystemConfiguration`, `AllowedUserManagement`, `root`, `admin` |

Then the command's own scope:

| Commands | Scope | Passes |
|----------|-------|--------|
| Projects (`-addProject`, `-loadProject`, `-unloadProject`, `-removeProject`, `-duplicateProject`, `-projectCheckout/Pull/Push`), `-setEnv`/`-removeEnv`, `-setSecret`/`-removeSecret`, `-restoreRules`, `-auditQuery`, `-decryptAudit` | SystemConfiguration | `AllowedSystemConfiguration`, `root` |
| `-addRule`, `-removeRule`, `-removeAllProjectRules` | Rule… | `AllowedSystemConfiguration`, `root` |
| User commands, MCP tokens | UserManagement… | `AllowedUserManagement`, `AllowedSystemConfiguration`, `root` |
| `-addTraceLog`, `-listTraceLogs`, `-removeTraceLog` | LogManagement… | `AllowedLogManagement`, `AllowedSystemConfiguration`, `root` |
| Add/remove/enable/disable actions, connectors, agents, things; remove models; python, panels, themes | …Creation / …Remove | `AllowedSystemConfiguration`, `root`, `admin` |
| `-addModel`, `-runAction` | ModelManagementCreation, ActionManagementRun | same, but their built-in rule sits at 1000000, so a user rule overrides it |
| Everything else (`-list*`, `-get*`, `-validate*`, `-routeCode`, `-actionTrace`, `-auditStatus`, …) | CommandCall | the CommandCall gate only |

`AllowedLogManagement` alone can publish a command but fails `CommandCall` and cannot read
`Command/Output`; pair it with another flag. **Anti-lockout:** `root` always passes Connect,
CommandCall, rule add/remove and the Command/Output topics, whatever rules exist. Before
deploying a Connect or deny rule, keep root's credentials safe and test the rule with a second
account; `-restoreRules` resets the three shipped seed rules.

Audit: `-auditStatus`, `-auditQuery <YYYY-MM-DD>`, `-decryptAudit <YYYY-MM-DD>`. Transport
defaults: MQTT 1883, MQTT over TLS 8883. Connector PKI: `-routeCertificates cert64:<base64 JSON>`
(op `stores` / `list` / `inspect` / `trust` / `delete` / `export` / `import`).

## 7. Env vs secrets

| | `-setEnv NAME=value` | `-setSecret NAME=value` |
|-|-|-|
| Stored | plain `.env` file | encrypted (AES-256-GCM) |
| Listed by | `-listEnv` — **names and values**, to anyone passing CommandCall | `-listSecrets` — names only |
| In LoT | `GET ENV "NAME"`, `{env.NAME}` | `GET SECRET "NAME"`, `{secret.NAME}` |
| Use for | hosts, ports, database names, flags | passwords, API keys, tokens |

Never put a credential value from chat into a command you compose. Tell the operator which
names to set and let them run `-setSecret` themselves.

## 8. Projects and `.lotnb` notebooks

A project is a folder of `.lotnb` notebooks (subfolders included) under the broker's projects
directory.

**Notebook format** — a JSON **array** of cells, no wrapper object:

```json
[
  { "kind": 1, "language": "markdown", "value": "# Line 1 telemetry" },
  { "kind": 2, "language": "lot", "value": "DEFINE MODEL …\n\nDEFINE ACTION …" },
  { "kind": 2, "language": "python", "value": "# Script Name: LineMath\ndef oee(a, p, q):\n    return a * p * q" }
]
```

- Only `kind: 2` (code) cells load; every other kind is skipped.
- `lot` cells may hold several DEFINE blocks. `python` cells need a `# Script Name: <Name>`
  comment (or a `scriptName` field). Any other language, e.g. `shellscript`, is documentation.
- A duplicate entity name keeps the first occurrence and reports a warning.

**Load order is by kind, not by file:** models → actions → connectors → agents → rules →
python → themes → panels → Things. Pending dependencies (an action whose `CALL PYTHON` script
loads later) are resolved once loading ends; anything still stuck shows in `-getPendingStatus`.

| Command | Notes |
|---------|-------|
| `-addProject <git-url> [branch]` | Clones; the name comes from the URL |
| `-addProject <folder-path>` | Copies a folder on the broker host; the name is the folder name |
| `-addProject <file.zip \| zip64:<base64>> [name] [load]` | Extracts; `load` loads it at once |
| `-loadProject <name>` | Replaces the previous project's entities and is remembered across restarts. Reply `data`: `project`, `entities[]` (`type`, `name`, `origin`), `counts`, `load`. Entities that failed are in `warnings[]` |
| `-unloadProject` | Removes the project's entities and clears the remembered project |
| `-listEntities` | Every entity with `origin`: `{kind:"adhoc"}` or `{kind:"project", project, file, cell}` |
| `-getProject <name>` | Publishes `zip64:<base64>` on `Projects/<name>/download` |
| `-listProjects`, `-removeProject`, `-duplicateProject <src> <new>`, `-projectCheckout <name> <ref>`, `-projectPull`, `-projectPush`, `-projectStatus`, `-projectManifest` | Git-backed project management |
| `-validateLotnb <json>` / `-validateLotnb --project <name>` | Validate without deploying |

Entities added ad hoc with `-addX` survive `-unloadProject` and a later `-loadProject`. The
broker CLI flag `--project <url|path>` (with `--branch`) loads a project at startup.

Suggested layout: numbered notebooks by concern (`01-models.lotnb`, `02-actions.lotnb`,
`03-connectors.lotnb`, …) for readers — the numbers do not change load order — and a README
listing every `GET ENV` / `GET SECRET` name the operator must set.

## 9. Triage playbook

**Action deployed, nothing published**
1. `-runAction <name> {"topic":"<a real topic>","payload":…}`: a topic mismatch is reported;
   `published: []` means an IF or a cast never reached PUBLISH.
2. Read the retained `Actions/<name>/Error`.
3. `-getPendingStatus`: the action may be waiting for a model, script or connector.
4. Check the trigger's `+` / `#` shape against the topics that really arrive.

**Connector connected, data missing**
1. `Routes/<n>/status`: `errors.consecutive` and `lastError`.
2. `-checkRouteConnection <n>`.
3. OT tag values arrive on `<SOURCE_TOPIC>/<tag>`, not on `DESTINATION_TOPIC`.
4. Events fire on PUBLISH; KEEP TOPIC never triggers a connector.

**Connector disconnected**
1. Every `GET ENV` / `GET SECRET` name exists (`-listEnv`, `-listSecrets`).
2. `Routes/<n>/Certificates`: `pendingCount > 0` means a peer certificate awaits trust.

## Do not

- Wrap the command in JSON, or quote a LoT body.
- Send `-requestUser`, or put `-requestId` anywhere but last.
- Expect a reply from `-updateData`.
- Send `-loadFolder` over MQTT: it is refused there, because it would read any folder on the broker
  host. Use `-addProject` / `-loadProject`, or `--project` at startup.
- Read `License/Status` or `Stats` — use `License`; there is no live `Stats` topic.
- Wait for `Projects/<n>/download` after sending `-getProject` — it is not retained.
- Treat `-runAction` with a topic envelope as a dry run.
- Use `USER HAS` with a flag other than the three that exist (it is silently false).
- Try to widen `SubscribeSys` or `CommandCall` with a user rule; the locked built-ins decide.
- Put secrets in `-setEnv`; anyone who can run commands can list env values.
- Run without confirming: `-removeAll*`, `-removeProject`, `-removeUser`, `-unloadProject`
  while a project is active, `-restoreRules` (resets edits to the three seed rules).
