---
name: lot-routes
description: "How to write LOT connectors: database, OT (Modbus, S7, OPC UA, EtherNet/IP, ADS, Allen-Bradley, Fins), REST API, AI (LLM, MCP), MQTT bridge/cluster, Kafka/REST integrations, email, barcode, video, events, mappings, and OT TAG blocks."
---

# LOT Connectors — Complete Reference

Connectors are written `DEFINE ROUTE`; `DEFINE CONNECTOR` is a synonym (and `ADD CONNECTOR_CONFIG` of
`ADD ROUTE_CONFIG`). Both spellings deploy the same connector and are stored exactly as typed. The
examples below use `DEFINE ROUTE`, which every broker version accepts.

## CRITICAL SYNTAX

Connector, event, and mapping names are NEVER quoted (bare identifiers). String values ARE quoted.
```
WRONG:  DEFINE ROUTE "ProductionDB" WITH TYPE POSTGRESQL
RIGHT:  DEFINE ROUTE ProductionDB WITH TYPE POSTGRESQL

WRONG:  DEFINE ROUTE "MyLLM" WITH TYPE LLM
RIGHT:  DEFINE ROUTE MyLLM WITH TYPE LLM
```

## Shapes by connector family

Not every connector uses the same blocks. Match **WITH TYPE** to the config block and pattern below. Call **`broker.get_route_template("TYPE")`** for the authoritative template with all available settings for any connector type.

**Vendor REST APIs:** when the user names a SaaS or vendor API (Airtable, ServiceNow, SAP, Salesforce, AWS, Azure, Slack, …), load **`rest-api-connectors`** first. It lists REST API apps — ready-made `TYPE REST_API` connectors — by app code; `load_skill("rest-api-connectors/<APP_CODE>")` returns one with auth, events and topics already written. An app code is never a `WITH TYPE`.

| Family | Typical pattern |
|--------|-----------------|
| SQL / document DB / search / warehouse / file storage | **ADD *_CONFIG** + **ADD EVENT** (QUERY) |
| OT (Modbus, S7, OPC UA, EtherNet/IP, ADS, Allen-Bradley, Fins) | **ADD *_CONFIG** + optional **ADD EVENT** + **ADD MAPPING** with nested **ADD TAG** |
| OT servers (MODBUS_SERVER, OPCUA_SERVER) | **ADD MODBUS_SERVER_CONFIG** / **OPCUA_SERVER_CONFIG** + **ADD MAPPING** with nested **ADD TAG**; no **ADD EVENT** (see **OT server connectors** below) |
| REST_API | **ADD REST_API_CONFIG** + **ADD EVENT** |
| LLM / MCP | **ADD LLM_CONFIG** / **MCP_CONFIG** (agents are `DEFINE AGENT`, not a connector) |
| EMAIL / BARCODE / VIDEO_* / AUDIO_INPUT | **ADD SMTP_CONFIG** / **BARCODE_CONFIG** / **VIDEO_*_CONFIG** / **AUDIO_INPUT_CONFIG** + **ADD EVENT** |
| KAFKA (STREAMING) | **ADD KAFKA_CONFIG** + **ADD EVENT** with **DIRECTION** "in"/"out" (same SOURCE_TOPIC/DESTINATION_TOPIC keywords as MQTT_BRIDGE; "out" = MQTT to Kafka, "in" = Kafka to MQTT) |
| GRPC (STREAMING) | **ADD GRPC_CONFIG** + **ADD EVENT** with **SOURCE_TOPIC**/**DESTINATION_TOPIC**; **RPC_TYPE** UNARY / SERVER_STREAM / CLIENT_STREAM / BIDI; empty payload = CloseSend on streams; **SESSION_SCOPE** TOPIC (default) or EVENT (one BIDI Call shared across SOURCE `+` topics until **IDLE_TIMEOUT** / CloseSend) |
| MQTT_BRIDGE (SYSTEM) | **ADD SOURCE_CONFIG** + **ADD DESTINATION_CONFIG** + **ADD MAPPING** |
| MQTT_CLUSTER (SYSTEM) | **ADD CLUSTER_CONFIG** |
| FEDERATION (SYSTEM) | **ADD FEDERATION_CONFIG** (REMOTE_CLUSTER_ID, REMOTE_ADDRESS/REMOTE_PORT or REMOTE_ENDPOINTS, CONTROL_LANE/CONTROL_PUSH/CONTROL_SCOPE, DATA_LANE/DATA_OUTBOUND/DATA_INBOUND); no template, so `get_route_template` has nothing for it |
| SPARKPLUG_B (SYSTEM) | **ADD SPARKPLUG_CONFIG** + optional **ADD METRIC** / **ADD DEVICE**; no **ADD EVENT** |
| SPARKPLUG_HOST (SYSTEM) | **ADD SPARKPLUG_HOST_CONFIG** + optional command-overlay **ADD METRIC**; no **ADD EVENT** |

A broker runs at most one Sparkplug connector that decodes the `spBv1.0` namespace: one SPARKPLUG_HOST, or one SPARKPLUG_B with MODE DECODE/BOTH. ENCODE-only SPARKPLUG_B connectors may coexist.
| MQTT_TO_REST | **ADD MQTT_CONFIG** + **ADD REST_API_CONFIG** + **ADD MAPPING** |

**OT device points** (registers, nodes, PLC addresses) belong in **ADD TAG** under **ADD MAPPING** on the OT connector, not in **DEFINE MODEL**.

## OT mappings — MQTT topics for TAG polling

For **ADD MAPPING** with nested **ADD TAG** (Modbus, S7, OPC UA, EtherNet/IP, etc.):
- Set **SOURCE_TOPIC** on the mapping to the **prefix** where each tag's value is published: **`<SOURCE_TOPIC>/<tagName>`** (tag names are case-sensitive as defined in **ADD TAG**).
- When telling users what topic to **subscribe** to or what **explore_topics** / **broker__read_mqtt** should use for live values, use that **SOURCE_TOPIC** path — **not** **DESTINATION_TOPIC**.
- Omit **DESTINATION_TOPIC** on these OT TAG read/poll mappings unless you have a specific legacy/query pattern that requires it; it is **not** the "display" topic for per-tag data.
- A tag may override with its own **WITH SOURCE_TOPIC** on **ADD TAG**; otherwise it inherits **`<mapping SOURCE_TOPIC>/<tag name>`**.

## OT TAG WRITABLE — DESTINATION_TOPIC is the write topic

When an OT TAG is bidirectional (read + write to the PLC), set on **ADD TAG**:
- **WITH WRITABLE "true"**
- **WITH SOURCE_TOPIC "<read_topic>"** — Device → MQTT (current/polled value is published here).
- **WITH DESTINATION_TOPIC "<write_topic>"** — MQTT → Device (the broker subscribes to this topic and forwards the payload to the PLC).

**DESTINATION_TOPIC on a writable TAG is REQUIRED.** Without it, the broker logs `TAG '<name>' is WRITABLE but has no DESTINATION_TOPIC - skipping` and the write path is never registered.

Do **NOT** put the "write to PLC" topic in **SOURCE_TOPIC** — **SOURCE_TOPIC** is only the topic where the polled (read) value is published. The write topic always goes in **DESTINATION_TOPIC**.

## Basic Structure

OT **ADD MAPPING** with **ADD TAG**: mapping **SOURCE_TOPIC** is the per-tag publish prefix (see **OT mappings - MQTT topics for TAG polling** above).

```
DEFINE ROUTE <name> WITH TYPE <ROUTE_TYPE>
    ADD <CONFIG_TYPE>
        WITH <SETTING> <value>
    ADD EVENT <eventName>
        WITH SOURCE_TOPIC "<mqtt_topic>"
        WITH DESTINATION_TOPIC "<mqtt_topic>"
        WITH QUERY "<query_string>"
    ADD MAPPING <mappingName>
        WITH SOURCE_TOPIC "<topic_prefix_for_each_tag>"
        WITH EVERY <number> <unit>
        ADD TAG "TagName"
            ...
```

Non-OT **ADD MAPPING** blocks (e.g. some bridge templates) may still use **WITH DESTINATION_TOPIC** per their connector template.

## Connector Types

### Database Connectors
| Type | Config Block | Default Port |
|------|-------------|--------------|
| POSTGRESQL | SQL_CONFIG | 5432 |
| MYSQL / MARIADB | SQL_CONFIG | 3306 |
| SQLSERVER / MSSQL | SQL_CONFIG | 1433 |
| MONGODB | MONGODB_CONFIG | 27017 |
| OPENSEARCH | OPENSEARCH_CONFIG | 9200 |
| CRATEDB | CRATEDB_CONFIG | 5432 |
| FILE_STORAGE | FILE_STORAGE_CONFIG | — |
| SNOWFLAKE | SNOWFLAKE_CONFIG | — |

### OT (Operational Technology) Connectors
| Type | Config Block |
|------|-------------|
| MODBUS_TCP | MODBUS_CONFIG |
| MODBUS_SERIAL | MODBUS_CONFIG |
| MODBUS_SERVER / MODBUS_TCP_SERVER | MODBUS_SERVER_CONFIG |
| SIEMENS_S7 / S7 | S7_CONFIG |
| ETHERNETIP / EIP | ETHERNETIP_CONFIG |
| OPCUA / OPC_UA | OPCUA_CONFIG |
| OPCUA_SERVER / OPC_UA_SERVER | OPCUA_SERVER_CONFIG |
| ADS / BECKHOFF / TWINCAT | ADS_CONFIG |
| FINS / OMRON / OMRONFINS | FINS_CONFIG |
| BACNET / BACNET_IP / BACNET_MSTP | BACNET_CONFIG |
| ALLEN_BRADLEY / AB / ALLENBRADLEY | ALLEN_BRADLEY_CONFIG |

### AI Connectors
| Type | Config Block |
|------|-------------|
| LLM | LLM_CONFIG |
| MCP | MCP_CONFIG |

### Other Connectors
| Type | Config Block |
|------|-------------|
| REST_API | REST_API_CONFIG |
| MQTT_BRIDGE | SOURCE_CONFIG + DESTINATION_CONFIG (see template) |
| MQTT_CLUSTER | CLUSTER_CONFIG |
| FEDERATION | FEDERATION_CONFIG |
| KAFKA (STREAMING) | KAFKA_CONFIG |
| GRPC (STREAMING) | GRPC_CONFIG |
| SPARKPLUG_B / SPARKPLUG | SPARKPLUG_CONFIG |
| SPARKPLUG_HOST | SPARKPLUG_HOST_CONFIG |
| MQTT_TO_REST (REST API) | MQTT_CONFIG + REST_API_CONFIG |
| EMAIL | SMTP_CONFIG |
| BARCODE | BARCODE_CONFIG |
| VIDEO_INPUT | VIDEO_INPUT_CONFIG |
| AUDIO_INPUT | AUDIO_INPUT_CONFIG |
| VIDEO_OUTPUT | VIDEO_OUTPUT_CONFIG |

VIDEO_INPUT always publishes JPEG frames. Do not use WITH FORMAT on the connector — FORMAT is reserved for models and the parser will reject it. Use SOURCE webcam:N (or Windows video=Device Name), FRAME_RATE, WIDTH, HEIGHT. WIDTH/HEIGHT is a request: if the camera rejects that size, the broker retries without it and streams at the camera's native resolution, with no error. FFmpeg must be on PATH; local ./run.sh --install-ffmpeg installs it for the detected OS.

AUDIO_INPUT always publishes raw 16-bit little-endian PCM chunks. Do not use WITH FORMAT. Use SOURCE mic:N (macOS/Linux), audio=Device Name (Windows), anullsrc, or tone:440. SAMPLE_RATE defaults to 16000, CHANNELS to 1, CHUNK_MS to 100.

## Overload / Backpressure Configuration (ADD ROUTE_CONFIG — cross-type)

Unlike every other config block above, **ADD ROUTE_CONFIG** is not tied to a connector type — it may be
added to **any** connector, alongside its type-specific config block, to control what happens when the
shared connector channel is saturated (and, on a cluster, where the connector runs). Every setting is optional; an absent block inherits the
broker-wide default.

```
DEFINE ROUTE HistorianDB WITH TYPE POSTGRESQL
    ADD ROUTE_CONFIG
        WITH OVERLOAD_POLICY "balanced"
        WITH OVERLOAD_TIMEOUT 200
        WITH OVERLOAD_CAPACITY 20000
    ADD SQL_CONFIG
        WITH SERVER GET ENV "PG_HOST"
        WITH PORT 5432
        WITH DATABASE "historian"
        WITH USERNAME GET ENV "PG_USER"
        WITH PASSWORD GET SECRET "PG_PASSWORD"
    ADD EVENT StoreReading
        WITH SOURCE_TOPIC "sensors/store"
        WITH QUERY "INSERT INTO readings (device, value) VALUES ('{payload.json.device}', CAST('{payload.json.value}' AS DOUBLE PRECISION))"
```

| Setting | Values | Description |
|---------|--------|--------------|
| OVERLOAD_POLICY | `lossless` / `balanced` / `realtime` | `lossless` waits indefinitely and never sheds; `balanced` (default) waits up to OVERLOAD_TIMEOUT then sheds the arriving message; `realtime` never waits and sheds immediately |
| OVERLOAD_TIMEOUT | milliseconds, default 50 | Wait budget for `balanced` only — ignored for `lossless`/`realtime` |
| OVERLOAD_CAPACITY | integer, default unbounded | Max messages from THIS connector in flight at once, for cross-connector isolation |
| CLUSTER_NODE | node name, default none | Cluster only. Pins the connector to the named node: an exclusive connector (a device client, a serial server) runs there or, while that node is down, nowhere. Without it the cluster picks an owner and moves it on failure. Ignored on a standalone broker |

**`OVERLOAD_CAPACITY` is incompatible with `lossless`** — a capacity is an admission budget that
sheds once exhausted, which would silently break the "lossless never sheds" guarantee. Declaring
both logs an error and the connector runs with capacity forced back to unbounded; lossless always wins.

The broker-wide default (what a connector without ADD ROUTE_CONFIG inherits) comes from two environment
variables read at broker start: `COREFLUX_ROUTE_OVERLOAD_POLICY` (`lossless` / `balanced` / `realtime`,
default `balanced`) and `COREFLUX_ROUTE_CHANNEL_FULL_TIMEOUT_MS` (the `balanced` wait, default 50).
`COREFLUX_ROUTE_CHANNEL_CAPACITY` sizes the shared connector channel (default 100000, minimum 1024).

## Environment Variables and Secrets

Use GET ENV and GET SECRET for sensitive configuration:
```
DEFINE ROUTE MyDB WITH TYPE POSTGRESQL
    ADD SQL_CONFIG
        WITH SERVER GET ENV "PG_HOST"
        WITH PORT 5432
        WITH DATABASE GET ENV "PG_DATABASE"
        WITH USERNAME GET ENV "PG_USER"
        WITH PASSWORD GET SECRET "PG_PASSWORD"
```

## Events (triggered by MQTT messages)

```
ADD EVENT ReadSensor
    WITH SOURCE_TOPIC "sensors/+/read"
    WITH DESTINATION_TOPIC "sensors/{topic.2}/result"
    WITH QUERY "SELECT * FROM sensors WHERE id = '{payload.json.id}'"
```
`{payload.json.id}` (with a payload like `{"id": "s1"}`) is used rather than `'{payload}'`, which is inserted
unescaped; see the SQL injection note under PostgreSQL.

### Query Placeholders
| Placeholder | Value |
|-------------|-------|
| {payload} | Raw MQTT message payload |
| {payload.json} / {value.json} | The whole payload (same text as {payload}) |
| {payload.json.key} | Nested JSON extraction |
| {topic} | Full MQTT topic |
| {topic.N} | Topic segment by position (1-based) |
| {timestamp} / {timestamp.iso} | ISO 8601 timestamp |
| {timestamp.unix} | Unix seconds |
| {timestamp.unix_ms} / {timestamp.utc} | Unix milliseconds / `yyyy-MM-dd HH:mm:ss` UTC |
| {payload.csv.N} | Nth CSV field of the payload (0-based) |
| {fieldName} | Top-level field of a JSON payload (e.g. `{sensor_id}`) |
| {env.NAME} | Environment variable |
| {secret.NAME} | Encrypted secret |

In SQL queries, `{payload.json.*}` values have single quotes doubled; REST_API passes values unchanged.

An event runs when a message arrives on its **SOURCE_TOPIC**, or on a timer when it has **WITH EVERY <n> <unit>**
instead. A scheduled (EVERY) event must have a **DESTINATION_TOPIC** or the connector fails to load. An event with
neither SOURCE_TOPIC nor EVERY is accepted but never runs. **DESTINATION_TOPIC** is only where results are published,
so a write-only event (an INSERT) can omit it. KAFKA rejects EVERY on events; KAFKA and GRPC events need both topics.
Every event that registers (SOURCE_TOPIC or EVERY) uses one action slot of the license's action limit.

## Mappings (scheduled / periodic polling)

OT **ADD TAG** mappings: polled values publish to **SOURCE_TOPIC/tagName** (no **DESTINATION_TOPIC** for that).

```
ADD MAPPING PollSensors
    WITH SOURCE_TOPIC "factory/plc1/read"
    WITH EVERY 5 SECONDS
    ADD TAG "Temperature"
        WITH ADDRESS "0"
        WITH ADDRESS_TYPE "HOLDING_REGISTER"
        WITH DATA_TYPE "INT16"
```

Subscribes / **explore_topics** / **broker__read_mqtt**: e.g. **factory/plc1/read/Temperature**.

Writable TAG (read + write the PLC). The read value publishes on **SOURCE_TOPIC**; publishing to **DESTINATION_TOPIC** writes to the PLC:

```
ADD MAPPING ControlSetpoint
    WITH SOURCE_TOPIC "factory/plc1/control"
    WITH EVERY 1 SECONDS
    ADD TAG "Setpoint"
        WITH ADDRESS "200"
        WITH ADDRESS_TYPE "HOLDING_REGISTER"
        WITH DATA_TYPE "FLOAT"
        WITH SOURCE_TOPIC "factory/plc1/control/setpoint"
        WITH DESTINATION_TOPIC "factory/plc1/control/setpoint/write"
        WITH WRITABLE "true"
```

Read value publishes on **factory/plc1/control/setpoint**; publishing to **factory/plc1/control/setpoint/write** writes the value to the PLC.

Value options on an OT **ADD TAG** (all optional): **SCALING** and **OFFSET** give `raw × SCALING + OFFSET`;
**MIN_VALUE** / **MAX_VALUE** clamp it; **DECIMAL_PLACES** rounds it (default 2); **DEADBAND** is the minimum
change before a new value is published (default 0 = every poll); **UNIT** is a label. These take a plain number;
OFFSET, MIN_VALUE and MAX_VALUE may be negative (`WITH OFFSET -40`).

## Database Connector Examples

### PostgreSQL
```
DEFINE ROUTE ProductionDB WITH TYPE POSTGRESQL
    ADD SQL_CONFIG
        WITH SERVER GET ENV "PG_HOST"
        WITH PORT 5432
        WITH DATABASE "factory"
        WITH USERNAME GET ENV "PG_USER"
        WITH PASSWORD GET SECRET "PG_PASSWORD"
        WITH USE_SSL true
    ADD EVENT GetOrders
        WITH SOURCE_TOPIC "orders/query"
        WITH DESTINATION_TOPIC "orders/result"
        WITH QUERY "SELECT * FROM orders WHERE status = '{payload.json.status}'"
    ADD EVENT InsertReading
        WITH SOURCE_TOPIC "sensors/store"
        WITH QUERY "INSERT INTO readings (device, value, ts) VALUES ('{payload.json.device}', CAST('{payload.json.value}' AS DOUBLE PRECISION), NOW())"
```
**SQL injection:** QUERY is built by text substitution; there are no bound parameters. Only `{payload.json.key}` and
`{payload.csv.N}` values have their single quotes doubled, so put those inside `'…'` and CAST numbers in SQL.
Raw `{payload}`, `{value.json}` and `{topic.N}` are inserted unescaped: a `'` in a payload or topic segment
(both are client-controlled) breaks or rewrites the statement. Never use them inside a query, and limit who may
publish to SOURCE_TOPIC with a rule (`lot-rules`). Give the connector's database user only the rights it needs.

### MongoDB
```
DEFINE ROUTE LogsDB WITH TYPE MONGODB
    ADD MONGODB_CONFIG
        WITH CONNECTION_STRING GET ENV "MONGO_URI"
        WITH DATABASE "logs"
    ADD EVENT StoreLogs
        WITH SOURCE_TOPIC "system/logs/+"
        WITH QUERY "CLEAN:{collection: logs, document: {source_topic: {source_topic}, data: {value.json}}}"
```

A MongoDB insert QUERY must name both `collection:` and `document:`; any other QUERY is treated as a find.

## OT Connector Examples

### Modbus TCP
```
DEFINE ROUTE PLC1 WITH TYPE MODBUS_TCP
    ADD MODBUS_CONFIG
        WITH IP "192.168.1.100"
        WITH PORT 502
        WITH SLAVE_ID 1
    ADD MAPPING ReadRegisters
        WITH SOURCE_TOPIC "plc1/read"
        WITH EVERY 1 SECONDS
        ADD TAG "Temperature"
            WITH ADDRESS "0"
            WITH ADDRESS_TYPE "HOLDING_REGISTER"
            WITH DATA_TYPE "INT16"
            WITH SCALING 0.1
        ADD TAG "Pressure"
            WITH ADDRESS "1"
            WITH ADDRESS_TYPE "HOLDING_REGISTER"
            WITH DATA_TYPE "FLOAT32"
```

Modbus TAGs need **ADDRESS_TYPE** (`HOLDING_REGISTER`, `INPUT_REGISTER`, `COIL`, `DISCRETE_INPUT`): without it the
connector deploys but every poll fails with `Unsupported address type`. A plain **ADDRESS** is the zero-based register
offset (`WITH ONE_BASED_ADDRESSES true` on MODBUS_CONFIG makes `1` the first register). Only six-digit Modicon
addresses (`400001`, `300001`, `100001`) are converted; `"40001"` is register offset 40001, not the first holding register.

### Modbus RTU (MODBUS_SERIAL)
```
DEFINE ROUTE BoilerRtu WITH TYPE MODBUS_SERIAL
    ADD MODBUS_CONFIG
        WITH COM_PORT "/dev/ttyUSB0"
        WITH BAUD_RATE 19200
        WITH PARITY "EVEN"
        WITH DATA_BITS 8
        WITH STOP_BITS "ONE"
        WITH SLAVE_ID 3
    ADD MAPPING Boiler
        WITH SOURCE_TOPIC "boiler/rtu"
        WITH EVERY 2 SECONDS
        ADD TAG "WaterTemp"
            WITH ADDRESS "0"
            WITH ADDRESS_TYPE "INPUT_REGISTER"
            WITH DATA_TYPE "INT16"
            WITH SCALING 0.1
            WITH DEADBAND 0.5
```
The serial port is **COM_PORT** (`COM3` on Windows, `/dev/ttyUSB0` on Linux), not PORT. MODBUS_SERIAL is serial
by its type, so CONNECTION_TYPE is not needed. BAUD_RATE must be at least 300; PARITY is NONE/ODD/EVEN/MARK/SPACE; DATA_BITS 7 or 8;
STOP_BITS ONE/TWO/ONEPOINTFIVE; SLAVE_ID 1–247 on a serial line.

### BACnet/IP
```
DEFINE ROUTE BMS WITH TYPE BACNET
    ADD BACNET_CONFIG
        WITH IP "127.0.0.1"
        WITH PORT 47808
        WITH DEVICE_ID 1234
        WITH DIRECT_IP true
    ADD MAPPING RoomSensors
        WITH SOURCE_TOPIC "bacnet/bms"
        WITH EVERY 1 SECONDS
        ADD TAG "RoomTemp"
            WITH ADDRESS "AI:0"
            WITH DATA_TYPE "FLOAT"
            WITH UNIT "degC"
        ADD TAG "Setpoint"
            WITH ADDRESS "AV:0"
            WITH DATA_TYPE "FLOAT"
            WITH WRITABLE true
            WITH DESTINATION_TOPIC "bacnet/bms/setpoint/write"
```

### Siemens S7
```
DEFINE ROUTE S7PLC WITH TYPE SIEMENS_S7
    ADD S7_CONFIG
        WITH IP "192.168.1.50"
        WITH CPU_TYPE "S71500"
        WITH RACK 0
        WITH SLOT 1
    ADD MAPPING ReadDB
        WITH SOURCE_TOPIC "s7/read"
        WITH EVERY 500 MILLISECONDS
        ADD TAG "Speed"
            WITH ADDRESS "DB1.DBD0"
            WITH DATA_TYPE "REAL"
```
CPU_TYPE is one of `S7200`, `S7300`, `S7400`, `S71200` (default) or `S71500` (`S7-1200` / `S7-1500` also
accepted). Anything else, such as `LOGO`, fails validation. SLOT is usually 1 for S7-1200/1500 and 2 for S7-300.

### OPC UA
```
DEFINE ROUTE OpcServer WITH TYPE OPCUA
    ADD OPCUA_CONFIG
        WITH ENDPOINT_URL "opc.tcp://192.168.1.200:4840"
        WITH USE_SECURITY false
    ADD MAPPING ReadNodes
        WITH SOURCE_TOPIC "opc/read"
        WITH EVERY 1 SECONDS
        ADD TAG "Temperature"
            WITH ADDRESS "ns=2;s=Channel1.Device1.Tag1"
            WITH DATA_TYPE "DOUBLE"
```

### EtherNet/IP (CIP explicit messaging)
```
DEFINE ROUTE PackagingLine WITH TYPE ETHERNETIP
    ADD ETHERNETIP_CONFIG
        WITH IP "192.168.10.20"
        WITH PORT 44818
    ADD MAPPING LineStatus
        WITH SOURCE_TOPIC "packaging/eip"
        WITH EVERY 1 SECONDS
        ADD TAG "CycleCount"
            WITH ADDRESS "4.100.3.0"
            WITH DATA_TYPE "DINT"
```
ADDRESS is `ClassID.InstanceID.AttributeID.AttributeIndex` (an optional fifth part selects a bit), not a
Logix tag name. IP is required; PORT defaults to 44818.

### Beckhoff ADS / TwinCAT
```
DEFINE ROUTE Press1 WITH TYPE ADS
    ADD ADS_CONFIG
        WITH TARGET_NET_ID "192.168.1.50.1.1"
        WITH TARGET_IP "192.168.1.50"
        WITH TARGET_PORT 851
    ADD MAPPING PressState
        WITH SOURCE_TOPIC "press1/ads"
        WITH EVERY 500 MILLISECONDS
        ADD TAG "Force"
            WITH ADDRESS "GVL_Press.rForce"
            WITH ADDRESS_TYPE "SYMBOL"
            WITH DATA_TYPE "REAL"
```
The target is addressed by its AMS Net ID (**TARGET_NET_ID**) and **TARGET_PORT** (851 for TwinCAT 3, 801 for
TwinCAT 2); there is no AMS_NET_ID key. The connector goes through the local AMS router and does not create AMS
routes, so set up the route between this host and the PLC yourself. LOCAL_NET_ID, LOCAL_ROUTE_TO_TARGET,
TARGET_ROUTE_TO_LOCAL, TARGET_USER and TARGET_PASSWORD are accepted but not used. A SYMBOL tag's ADDRESS is the PLC symbol path; ADDRESS_TYPE "INDEX"
takes `"indexGroup,indexOffset"`.

### Omron FINS
```
DEFINE ROUTE Oven1 WITH TYPE FINS
    ADD FINS_CONFIG
        WITH IP "192.168.1.60"
        WITH PORT 9600
        WITH PROTOCOL "TCP"
        WITH LOCAL_NODE 10
        WITH REMOTE_NODE 60
    ADD MAPPING OvenData
        WITH SOURCE_TOPIC "oven1/fins"
        WITH EVERY 1 SECONDS
        ADD TAG "ZoneTemp"
            WITH ADDRESS "100"
            WITH MEMORY_TYPE "DM"
            WITH DATA_TYPE "INT"
            WITH SCALING 0.1
```
Nodes are **LOCAL_NODE** / **REMOTE_NODE** (not PC_NODE / PLC_NODE); PROTOCOL is TCP (default) or UDP. A tag's
ADDRESS is the word address and **MEMORY_TYPE** the area (DM default; CIO, WR, HR, AR, CNT, TIM, EM).

### OT server connectors (MODBUS_SERVER, OPCUA_SERVER)
The broker is the device: it serves registers (Modbus) or nodes (OPC UA) to external masters/clients, and the values
come from MQTT. The direction is the reverse of an OT client: publishing to a tag's **SOURCE_TOPIC**
(`<mapping SOURCE_TOPIC>/<tag name>` by default) sets the served value.
```
DEFINE ROUTE PlantModbus WITH TYPE MODBUS_SERVER
    ADD MODBUS_SERVER_CONFIG
        WITH PORT 502
        WITH UNIT_ID 1
    ADD MAPPING Registers
        WITH SOURCE_TOPIC "plant/modbus"
        ADD TAG "Setpoint"
            WITH ADDRESS "0"
            WITH ADDRESS_TYPE "HOLDING_REGISTER"
            WITH DATA_TYPE "FLOAT"
            WITH WRITABLE "true"
            WITH DESTINATION_TOPIC "plant/modbus/setpoint/written"
```
On MODBUS_SERVER every TAG needs ADDRESS and ADDRESS_TYPE, and a master's write to a WRITABLE HOLDING_REGISTER/COIL is
published to **DESTINATION_TOPIC**. On OPCUA_SERVER (OPCUA_SERVER_CONFIG: SERVER_PORT default 4840, ALLOW_ANONYMOUS
default true) a client's write to a WRITABLE node is published back to the tag's **SOURCE_TOPIC**. Call
`get_route_template` for the full setting list of either.

## REST API Connector

```
DEFINE ROUTE WeatherAPI WITH TYPE REST_API
    ADD REST_API_CONFIG
        WITH BASE_ADDRESS "https://api.weather.com"
    ADD EVENT GetForecast
        WITH SOURCE_TOPIC "weather/request"
        WITH DESTINATION_TOPIC "weather/forecast"
        WITH METHOD "GET"
        WITH ENDPOINT "/v1/forecast?city={payload}"
```

## REST API Server Connector

```
DEFINE ROUTE MyAPI WITH TYPE REST_API
    ADD REST_API_CONFIG
        WITH ENABLE_SERVER true
        WITH SERVER_PORT 8080
    ADD EVENT GetStatus
        WITH METHOD "GET"
        WITH ENDPOINT "/api/status"
        WITH DESTINATION_TOPIC "api/status/request/{session}"
        WITH REPLY_TOPIC "api/status/reply/{session}"
        WITH REPLY_TIMEOUT 10
```

Server mode needs **WITH ENABLE_SERVER true**; without it the connector is an HTTP client and requires BASE_ADDRESS.
Each event with METHOD + ENDPOINT is an HTTP endpoint: the request body is published to **DESTINATION_TOPIC**. With
**REPLY_TOPIC** the server waits for a message there and returns it (504 after REPLY_TIMEOUT seconds); without it the
request is answered `200 accepted` at once. `{session}` is a per-request id.

## MQTT Bridge Connector

```
DEFINE ROUTE CloudBridge WITH TYPE MQTT_BRIDGE
    ADD SOURCE_CONFIG
        WITH BROKER SELF
    ADD DESTINATION_CONFIG
        WITH BROKER_ADDRESS "mqtt.example.com"
        WITH BROKER_PORT 8883
        WITH CLIENT_ID "plant1-bridge"
        WITH USE_TLS true
        WITH USERNAME GET ENV "CLOUD_MQTT_USER"
        WITH PASSWORD GET SECRET "CLOUD_MQTT_PASSWORD"
    ADD MAPPING TelemetryUp
        WITH SOURCE_TOPIC "plant1/telemetry/#"
        WITH DESTINATION_TOPIC "sites/plant1/telemetry/#"
        WITH DIRECTION "out"
    ADD MAPPING CommandsDown
        WITH SOURCE_TOPIC "plant1/commands/#"
        WITH DESTINATION_TOPIC "sites/plant1/commands/#"
        WITH DIRECTION "in"
```
`WITH BROKER SELF` makes a side this broker; otherwise each side takes BROKER_ADDRESS, BROKER_PORT (default 1883),
CLIENT_ID, USERNAME, PASSWORD, USE_TLS (plus ALLOW_UNTRUSTED_CERTS and certificate paths). Each mapping's
DIRECTION is `out` (SOURCE_TOPIC on the source side → DESTINATION_TOPIC on the destination), `in` (DESTINATION_TOPIC
on the destination → SOURCE_TOPIC on the source) or `both` (default); `+` and `#` carry over by position. At least
one ADD MAPPING is required, and MQTT_CONFIG is not accepted in place of SOURCE_CONFIG.

## Email Connector

```
DEFINE ROUTE AlertMail WITH TYPE EMAIL
    ADD SMTP_CONFIG
        WITH HOST "smtp.example.com"
        WITH PORT 587
        WITH USERNAME GET ENV "SMTP_USER"
        WITH PASSWORD GET SECRET "SMTP_PASSWORD"
        WITH USE_TLS true
    ADD EVENT SendAlarm
        WITH SOURCE_TOPIC "alarms/email"
        WITH DESTINATION_TOPIC "alarms/email/status"
        WITH SUBJECT "Alarm on {payload.json.machine}"
        WITH RECIPIENT "maintenance@example.com"
```
SMTP_CONFIG needs HOST, USERNAME and PASSWORD (PORT defaults to 587, USE_TLS to true); USERNAME is also the From
address. Each message on SOURCE_TOPIC sends one email to RECIPIENT. The payload is the HTML body unless the event
sets TEMPLATE_PATH to an HTML file. SUBJECT and RECIPIENT accept placeholders; DESTINATION_TOPIC receives the send
status. There are no SERVER, FROM or TO keys.

## AI Connectors

### LLM Connector
```
DEFINE ROUTE LocalLLM WITH TYPE LLM
    ADD LLM_CONFIG
        WITH BASE_URL "http://localhost:11434"
        WITH MODEL "llama3.2"
        WITH TEMPERATURE 0.7
```

Cloud provider (PROVIDER `openai`, `anthropic`, or `compatible` for an OpenAI-compatible BASE_URL; default `ollama`):
```
DEFINE ROUTE Claude WITH TYPE LLM
    ADD LLM_CONFIG
        WITH PROVIDER "anthropic"
        WITH MODEL "claude-sonnet-4-5"
        WITH API_KEY GET SECRET "ANTHROPIC_API_KEY"
        WITH MAX_TOKENS 1024
```
MODEL is required. Cloud providers use their own endpoint when BASE_URL is omitted. MAX_TOKENS caps each
completion (default 2048); SYSTEM_PROMPT applies to CALL LLM; PRICE_INPUT / PRICE_OUTPUT (per million tokens)
turn on cost reporting.

### MCP Client Connector — stdio transport

IMPORTANT: SERVER_ARGUMENTS is COMMA-SEPARATED — each argument is a separate comma-delimited token.

```
DEFINE ROUTE ToolServer WITH TYPE MCP
    ADD MCP_CONFIG
        WITH SERVER_COMMAND "npx"
        WITH SERVER_ARGUMENTS "-y, @modelcontextprotocol/server-filesystem, /data"
        WITH CLIENT_NAME "CorefluxBroker"
```

To pass environment variables to the server process, add one `WITH SERVER_ENV "NAME" <value>` line per variable
(the value may be `GET SECRET "..."` or `GET ENV "..."`).

### MCP Client Connector — Docker Desktop gateway (manages all servers in a profile)
```
DEFINE ROUTE DockerGateway WITH TYPE MCP
    ADD MCP_CONFIG
        WITH SERVER_COMMAND "docker"
        WITH SERVER_ARGUMENTS "mcp, gateway, run, --profile, default"
        WITH CLIENT_NAME "CorefluxBroker"
```

### MCP Client Connector — DesktopCommander (terminal access: docker ps, shell commands, file ops)
Runs on the host via npx. The agent can execute any shell command including docker ps,
docker run, docker stop, etc. Requires Node.js. Auto-updates on first use each session.
```
DEFINE ROUTE DesktopCommander WITH TYPE MCP
    ADD MCP_CONFIG
        WITH SERVER_COMMAND "npx"
        WITH SERVER_ARGUMENTS "-y, @wonderwhy-er/desktop-commander@latest"
        WITH CLIENT_NAME "CorefluxBroker"
```

### MCP Client Connector — Docker container/image control via Docker MCP gateway
Uses Docker Desktop's built-in `docker` catalog server. No Node.js required.
```
DEFINE ROUTE DockerControl WITH TYPE MCP
    ADD MCP_CONFIG
        WITH SERVER_COMMAND "docker"
        WITH SERVER_ARGUMENTS "mcp, gateway, run, --servers, docker"
        WITH CLIENT_NAME "CorefluxBroker"
```

### MCP Client Connector — HTTP/SSE (remote server, no SERVER_ARGUMENTS needed)
```
DEFINE ROUTE RemoteMCP WITH TYPE MCP
    ADD MCP_CONFIG
        WITH SERVER_URL "https://mcp.example.com/mcp"
        WITH CLIENT_NAME "CorefluxBroker"
```

### Agents (DEFINE AGENT, not a connector type)
An agent is its own entity, deployed with `-addAgent`, and runs on a `TYPE LLM` connector. There is no
`WITH TYPE AGENT` / `AGENT_CONFIG` (removed). Load `lot-agents` before writing one.

## STORE IN targets

`STORE IN "<connector>"` in a model or action reaches only these connector types: POSTGRESQL, MYSQL, MARIADB,
SQLSERVER/MSSQL, MONGODB, CRATEDB, SNOWFLAKE, OPENSEARCH, FILE_STORAGE and REST_API. Any other type logs
`Unsupported route type for storage` and drops the row.

## Managing and monitoring connectors

- Deploying a connector that already exists (`broker.add_route`) updates it in place; `broker.remove_route` stops it and removes its events and mappings.
- A `DISABLE true` line inside the `DEFINE ROUTE` block keeps the connector defined and listed but never starts it (`-disableConnector` / `-enableConnector` add and remove the line).
- `$SYS/Coreflux/Routes/<name>` holds the connector's retained LoT definition; `$SYS/Coreflux/Routes/<name>/status` is published periodically (not retained) with its health and connection JSON.
- MQTT_BRIDGE, FEDERATION, LLM, MCP, VIDEO_INPUT, AUDIO_INPUT and VIDEO_OUTPUT need a Growth or Enterprise license. On a Community broker they are refused, and a saved one is skipped at startup with a warning in the log.
- BARCODE runs only on Windows; on other platforms the connector is skipped with a warning.

## Common Mistakes
- **WRONG:** DEFINE MODEL (or broker.add_model) for a new Modbus/OPC/S7/device point **RIGHT:** **ADD TAG** inside **ADD MAPPING** on the OT connector; deploy full connector with **broker.add_route**
- **WRONG:** Using **DESTINATION_TOPIC** on an OT **ADD MAPPING** as the topic where polled tag data appears **RIGHT:** Data is on **SOURCE_TOPIC** / **`<SOURCE_TOPIC>/<tagName>`** (subscribe or read those topics)
- **WRONG:** **ADD TAG** directly under **DEFINE ROUTE** **RIGHT:** every **ADD TAG** sits inside an **ADD MAPPING** (otherwise: "Unexpected token TAG in route components")
- **WRONG:** MODBUS_SERIAL with **WITH PORT "COM3"** **RIGHT:** **WITH COM_PORT "COM3"**
- **NEVER use ADD METADATA in connector definitions.** `ADD METADATA` blocks (WITH IMAGE, WITH DESCRIPTION, WITH DOCLINK) appear in connector *templates* returned by `broker.get_route_template` for documentation purposes only. The LOT parser does **not** support `ADD METADATA` in deployed connectors. Including it in a `DEFINE ROUTE` block will cause a parse error. Always strip `ADD METADATA` and everything under it when generating connector LoT from a template.
- Missing WITH TYPE after the connector name
- Config block type must match the connector type (e.g., SQL_CONFIG for POSTGRESQL)
- An event with no SOURCE_TOPIC and no EVERY never runs; a scheduled (EVERY) event without DESTINATION_TOPIC fails to load
- Forgetting quotes around topic patterns and query strings
- Events use {payload} and {topic.N} for dynamic values — N is 1-based
- GET ENV / GET SECRET must have quotes around the variable name
- An unknown TAG DATA_TYPE is not an error: it silently becomes INT16. Use a listed type (BOOL, INT16, UINT16, INT32, UINT32, INT64, FLOAT/REAL, DOUBLE/LREAL, STRING, ...)
- OPC UA client: there is no SECURITY_MODE setting (it is ignored). Use USE_SECURITY, SECURITY_POLICY and MESSAGE_SECURITY
- MCP connector: use SERVER_COMMAND and SERVER_ARGUMENTS (NOT "COMMAND" and "ARGS" — those are invalid)
- MCP connector: SERVER_ARGUMENTS is COMMA-SEPARATED — each CLI argument is a separate comma-delimited token
  WRONG: WITH SERVER_ARGUMENTS "mcp gateway run --profile default"
  RIGHT: WITH SERVER_ARGUMENTS "mcp, gateway, run, --profile, default"
- MCP connector: use SERVER_URL (NOT "URL") for HTTP/SSE transport; no SERVER_ARGUMENTS needed
- MCP connector via Docker gateway: SERVER_COMMAND is "docker", SERVER_ARGUMENTS is "mcp, gateway, run, --profile, <name>"
- MCP connector via Docker container control: SERVER_COMMAND is "docker", SERVER_ARGUMENTS is "mcp, gateway, run, --servers, docker" (uses Docker Desktop gateway — no socket mount needed, works on Windows)
