---
name: lot-authoring
description: Write, review, lint, and deploy LoT (Language of Things) for the Coreflux broker — actions, models, routes, rules, panels, themes, Python scripts and .lotnb notebooks. Use whenever the user asks to define/fix an action, model, route, rule, panel or theme, edits a .lot or .lotnb file, or a broker rejects LoT with a parse error.
---

# LoT Authoring — Coreflux Language of Things

LoT is the **only** configuration language for Coreflux: **Actions** (event-driven logic),
**Models** (typed JSON schemas), **Routes** (integrations: databases, PLCs, AI, bridges),
**Rules** (MQTT access control) and, for dashboards, **Panels** and **Themes**.
Never propose JSON or YAML to configure these.

## Workflow (always)

1. Pick the entity from the decision guide below.
2. Write the LoT following the universal rules — every example must compile as-is.
3. Run the `lot_lint` tool (from the `coreflux-broker` MCP server) on the code.
4. Deploy with `lot_deploy` (inline) or `lotnb_deploy` (file). Read every returned envelope.
5. Verify: `broker_action_trace` for actions, `mqtt_subscribe` on the output topic,
   `mqtt_read_retained` on `$SYS/Coreflux/Routes/<Name>/status` for routes.
6. If the parser rejects something, the broker's message is authoritative — fix the LoT,
   do not argue with it. Use `broker_command -lotDiagnostic action <Name>` for runtime issues.

When a broker is not configured, still lint, and hand the user the LoT plus the exact
`-addX` command to run.

## Task Decision Guide

| User goal | Approach |
|-----------|----------|
| React to a topic / sensor data | `DEFINE ACTION` + `ON TOPIC` — [lot-actions.md](lot-actions.md) |
| Skip duplicate telemetry (same payload) | `ON CHANGE "topic/pattern"` instead of `ON TOPIC` |
| Aggregate topics into one JSON document | `DEFINE MODEL` (often `COLLAPSED`) — [lot-models.md](lot-models.md) |
| Connect to database / REST / AI / bridge | `DEFINE ROUTE` with the matching config block — [lot-routes.md](lot-routes.md) |
| Add a PLC tag / register / OPC node | `ADD TAG` under `ADD MAPPING` on the OT route, redeploy the **full** route — never a model |
| Schedule recurring work | `ON EVERY N SECONDS` / `ON EVERY WEEKDAY AT "HH:mm:ss"` |
| Share state between actions | `KEEP TOPIC "state/x" WITH {v}` (no MQTT delivery) + `GET TOPIC` |
| Send data to subscribers / routes | `PUBLISH TOPIC "out/t" WITH {v}` |
| Restrict MQTT access | `DEFINE RULE` with scope + priority (see `broker-security` skill) |
| Complex math / ML / parsing | Python script (`# Script Name:` header) + `CALL PYTHON` |
| Build a dashboard | `DEFINE PANEL`, then `DEFINE THEME` |
| Start a new route from scratch | `broker_route_template TYPE` → fill the `skeleton` |

**Routes vs models:** many MQTT topics → one typed JSON → model. New device point on a PLC → `ADD TAG` on the route.

## Universal Syntax Rules (parse errors if violated)

| Rule | Detail |
|------|--------|
| Indentation | **4 spaces** per level. Never tabs. |
| Keywords | **UPPERCASE**: `DEFINE`, `ADD`, `WITH`, `ON`, `DO`, `SET`, `IF`, `THEN` … |
| Variables | Always `{braces}`: `{temp}`, `{deviceId}` |
| Strings | Always **double quotes** |
| Topic positions | **1-based**: `TOPIC POSITION 1` is the first segment |
| `SET` separator | `SET "x" WITH 5` (`WITH`/`TO`/`AS` interchangeable); `SET x 5` fails |
| `PUBLISH` / `KEEP` | `… WITH <value>` — **never** `MESSAGE`, never an empty `WITH` |
| `IF` | needs `THEN`; blocks close by indentation, there is no `END IF` |
| Triggers | end with `DO`: `ON EVERY 10 SECONDS DO` |
| **Trigger indentation** | `ON …` sits at the **same column as `DEFINE ACTION`** (or on the DEFINE line). Body indents 4 spaces under it. |
| Action, model, route and rule names | Bare identifiers, never quoted: `DEFINE ACTION Heartbeat`, `DEFINE MODEL SensorReading`, `DEFINE ROUTE PlantDb WITH TYPE …`, `DEFINE RULE SensorAccess …`. The parser rejects `DEFINE MODEL "X"` with *STRING where IDENTIFIER was expected*. |
| Panel and theme names | Quoted string: `DEFINE PANEL "Line 3 Overview"`, `DEFINE THEME "Dark"` (bare identifiers also parse). |
| Model parents | Bare as well: `DEFINE MODEL Child FROM Parent WITH TOPIC "…"` |
| Credentials | `GET ENV "NAME"` / `GET SECRET "NAME"` — never literal passwords |
| `ADD METADATA` | Template-only; the parser rejects it in deployed routes |
| `RETURN` | On its own line, then one indented `OUTPUT var` per line |
| `PAYLOAD` | Only exists for `ON TOPIC` / `ON CHANGE`. Timers read state with `GET TOPIC`. |

## Naming Conventions

| Entity | Convention | Example |
|--------|------------|---------|
| Actions | PascalCase, verb-first | `ProcessTemperature`, `AlertOnOverheat` |
| Models | PascalCase, noun | `SensorReading` |
| Rules | PascalCase, descriptive | `ProtectSysTopics` |
| Routes | PascalCase, destination-based | `FactoryDB`, `CloudBridge` |
| Fields | snake_case in quotes | `"device_id"` |
| Topics | lowercase, slash-separated | `sensors/+/temperature` |

Write **LoT** in prose; use `lot` as the code-block language tag.

## Actions — quick reference

```lot
DEFINE ACTION Heartbeat
ON EVERY 10 SECONDS DO
    PUBLISH TOPIC "system/heartbeat" WITH TIMESTAMP "ISO"
```

```lot
DEFINE ACTION AlertOnOverheat
ON TOPIC "sensors/+/data" DO
    SET "deviceId" WITH TOPIC POSITION 2
    SET "temp" WITH PAYLOAD AS DOUBLE
    IF {temp} > 85 THEN
        PUBLISH TOPIC "alerts/" + {deviceId} WITH "CRITICAL: " + {temp}
```

Callable action (no `ON`; invoked with `CALL ACTION`):

```lot
DEFINE ACTION CalcAverage
INPUT a AS DOUBLE
INPUT b AS DOUBLE
DO
    SET "result" WITH ({a} + {b}) / 2
RETURN
    OUTPUT result
```

Triggers: `ON TOPIC "p/+"` · `ON CHANGE "p/+"` · `ON EVERY N SECONDS|MINUTES|HOURS|DAYS` ·
`ON EVERY WEEKDAY|WEEKEND|MONDAY… AT "06:00:00"` · `ON START` · `ON CONNECT` · `ON DISCONNECT` ·
`ON SUBSCRIBE ["pattern"]`.

Key statements: `SET "v" WITH PAYLOAD AS DOUBLE` · `SET "z" WITH TOPIC POSITION 3` ·
`SET "x" WITH GET TOPIC "state/last" AS DOUBLE` · `SET "k" WITH GET JSON "a.b" IN PAYLOAD AS STRING` ·
`KEEP TOPIC "state/mode" WITH "active"` · `PUBLISH MODEL "M" TO "out" WITH field = {v}` ·
`CALL PYTHON "Script.fn" WITH ({json}) RETURN AS {r}` · `CALL MCP "Route.tool" WITH (q = {x}) RETURN AS {r}` ·
`TRIGGER "Event" TO RouteName WITH {payload}`.

Full reference: [lot-actions.md](lot-actions.md)

## Models — quick reference

```lot
DEFINE MODEL SensorReading WITH TOPIC "factory/sensors/data"
    ADD STRING "deviceId" WITH TOPIC "factory/sensors/id" AS TRIGGER
    ADD DOUBLE "temperature" WITH TOPIC "factory/sensors/temp"
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
    ADD STRING "status" WITH "ok"
```

`COLLAPSED` publishes one JSON object on the base topic; otherwise each field goes to
`<base>/<field>`. Types: `STRING INT DOUBLE BOOL ARRAY OBJECT TIMESTAMP COLLECTION`.
Mark data fields `AS TRIGGER` (not timestamps). Static defaults use `WITH` directly, never `WITH VALUE`.

Full reference: [lot-models.md](lot-models.md)

## Routes — quick reference

```lot
DEFINE ROUTE SensorDB WITH TYPE POSTGRESQL
    ADD SQL_CONFIG
        WITH SERVER GET ENV "PG_HOST"
        WITH PORT 5432
        WITH DATABASE "factory"
        WITH USERNAME GET ENV "PG_USER"
        WITH PASSWORD GET SECRET "PG_PASSWORD"
    ADD EVENT ReadSensors
        WITH SOURCE_TOPIC "sensors/+/query"
        WITH DESTINATION_TOPIC "sensors/{topic.2}/result"
        WITH QUERY "SELECT * FROM sensors WHERE id = '{payload}'"
```

```lot
DEFINE ROUTE PLC1 WITH TYPE MODBUS_TCP
    ADD MODBUS_CONFIG
        WITH IP "192.168.1.100"
        WITH PORT 502
        WITH SLAVE_ID 1
    ADD MAPPING "ReadRegisters"
        WITH SOURCE_TOPIC "plc1/read"
        WITH EVERY 1 SECONDS
        ADD TAG "Temperature"
            WITH ADDRESS "40001"
            WITH DATA_TYPE "INT16"
```

Config block must match the type: `SQL_CONFIG` (POSTGRESQL/MYSQL/MARIADB/SQLSERVER) ·
`MONGODB_CONFIG` · `OPENSEARCH_CONFIG` · `CRATEDB_CONFIG` · `FILE_STORAGE_CONFIG` ·
`MODBUS_CONFIG` (MODBUS_TCP/MODBUS_SERIAL) · `MODBUS_SERVER_CONFIG` · `S7_CONFIG` · `OPCUA_CONFIG` ·
`OPCUA_SERVER_CONFIG` · `ETHERNETIP_CONFIG` · `ALLEN_BRADLEY_CONFIG` · `ADS_CONFIG` · `FINS_CONFIG` ·
`BACNET_CONFIG` · `KAFKA_CONFIG` · `REST_API_CONFIG` · `SMTP_CONFIG` (EMAIL) ·
`SOURCE_CONFIG`+`DESTINATION_CONFIG` (MQTT_BRIDGE) · `CLUSTER_CONFIG` · `LLM_CONFIG` · `AGENT_CONFIG` ·
`MCP_CONFIG` · `MCP_SERVER_CONFIG` · `BARCODE_CONFIG` · `VIDEO_INPUT_CONFIG` · `AUDIO_INPUT_CONFIG` ·
`VIDEO_OUTPUT_CONFIG`. `ROUTE_CONFIG` (overload policy) can be added to any route.

The authoritative template for any type is `broker_route_template TYPE`
(`-routeCode TYPE`). Placeholders in event queries are 1-based: `{payload}`, `{topic.N}`,
`{timestamp}`, `{env.NAME}`, `{secret.NAME}`. **OT tags publish to `<SOURCE_TOPIC>/<tagName>`.**

Full reference: [lot-routes.md](lot-routes.md)

## Rules — quick reference

```lot
DEFINE RULE SensorAccess WITH PRIORITY 100 FOR Subscribe TO TOPIC "sensors/#"
    IF USER HAS "AllowedSubscribe" THEN
        ALLOW
    ELSE
        DENY
```

Lowest priority number wins; among ties DENY wins; no matching rule ⇒ deny. Priorities
`0–99` are reserved. Scopes: `Connect` · `Subscribe` · `Publish` · `SubscribeSys` ·
`PublishSys` · `SystemConfiguration` · `*ManagementCreation` · `CommandCall`.
Details and the RBAC model: `broker-security` skill.

## Panels & Themes — quick reference

```lot
DEFINE PANEL "Zone1Dashboard"
    WITH TITLE "Zone 1 — Operations"
    WITH LAYOUT "grid" COLUMNS 3
    WITH VISIBILITY SHARED
    WITH SHARE TO GROUP "zone1-staff"
    WITH STATE PUBLISHED

    ADD COMPONENT "TempGauge" WITH TYPE "gauge"
        SET LABEL "Temperature"  SET UNIT "°C"
        SET RANGE FROM 0 TO 150
        BIND VALUE TO TOPIC "zone1/temp"

    ADD COMPONENT "StopBtn" WITH TYPE "button"
        SET LABEL "STOP"  SET STYLE "danger"
        WITH INTERACT FOR GROUP "supervisors"
        ON CLICK DO
            PUBLISH TOPIC "zone1/emergency/stop" WITH 1
```

```lot
DEFINE THEME "IndustrialDark"
    SET "PRIMARY" WITH "#f97316"
    SET "BACKGROUND" WITH "#0a0a0f"
    SET "FOREGROUND" WITH "#fafafa"
```

`WITH STATE PUBLISHED` is required (DRAFT panels are never distributed). `PRIVATE` never
combines with `WITH SHARE TO`. Silent failures: `TYPE` without `WITH` is dropped, `"form"` is
not a type, `BIND` needs `<TARGET> TO TOPIC`, and the statement after `ON CLICK DO` must be
on its own indented line.

## Python scripts

```python
# Script Name: SensorUtils

import json, statistics

def analyze(readings_json):
    readings = json.loads(readings_json) if isinstance(readings_json, str) else readings_json
    return {"mean": statistics.mean(readings), "count": len(readings)}
```

Deploy with `-addPython` (a `python` cell in a notebook, or `lot_deploy` `python`). Call with
`CALL PYTHON "SensorUtils.analyze" WITH ({readings}) RETURN AS {stats}`; `RETURN AS` is a JSON
string, read fields with `GET JSON "mean" IN {stats} AS DOUBLE`. Allowed modules: `math`,
`statistics`, `json`, `datetime`, `collections`, `re`, `csv`, `hashlib`, `base64`.
Blocked: `os`, `subprocess`, `socket`, `http`, `importlib`.

## Anti-patterns the linter catches

```
ON EVERY 10 SECONDS              <- missing DO
SET x "value"                    <- missing WITH
PUBLISH TOPIC "t" MESSAGE "hi"   <- MESSAGE is not a keyword
DEFINE ACTION X
    ON TOPIC "t" DO              <- trigger indented under DEFINE
TOPIC POSITION 0                 <- 1-based
"Temp: " + temp                  <- variable without braces
WITH PASSWORD "mypass"           <- hardcode; use GET SECRET
ADD METADATA                     <- template-only
RETURN OUTPUT a, b               <- one OUTPUT per line
KEEP TOPIC "db/insert" WITH {p}  <- KEEP does not drive route events; PUBLISH does
ON EVERY 5 SECONDS DO
    PUBLISH TOPIC "t" WITH PAYLOAD   <- no payload on timers
```

## Deployment order

Broker load order (and what `lot_deploy` / `lotnb_deploy` use): models → actions → routes →
rules → python → themes → panels. Parent models before children; callable actions before
their callers; Python scripts before the actions that `CALL PYTHON` them (deploy the script in
its own step if needed).

## Where the truth lives

The parser in the connected broker is the ground truth. When the docs and the broker disagree,
trust the broker's error message, then search the `coreflux-docs` MCP server
(`https://docs.coreflux.org`) for the current syntax.
