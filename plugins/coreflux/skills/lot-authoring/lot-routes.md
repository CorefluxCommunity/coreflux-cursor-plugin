# LOT Routes — Full Reference

## What Routes Do

Routes connect the broker to external systems: databases, OT devices (PLCs, sensors), REST APIs, AI models, and message bridges. Each route defines:
- A **CONFIG** block — connection settings
- **EVENT** blocks — MQTT-triggered queries/actions
- **MAPPING** blocks — scheduled/periodic polling (OT routes)

---

## Basic Structure

```
DEFINE ROUTE Name WITH TYPE <ROUTE_TYPE>
    ADD <CONFIG_BLOCK>
        WITH <SETTING> <value>
        ...
    ADD EVENT EventName
        WITH SOURCE_TOPIC "mqtt/topic/+"
        WITH DESTINATION_TOPIC "mqtt/result/{topic.2}"
        WITH QUERY "SELECT * FROM table WHERE id = '{payload}'"
    ADD MAPPING "MappingName"
        WITH SOURCE_TOPIC "plc/read"
        WITH EVERY 5 SECONDS
        ADD TAG "TagName"
            WITH ADDRESS "40001"
            WITH DATA_TYPE "INT16"
```

**OT `ADD MAPPING` + `ADD TAG`:** mapping `SOURCE_TOPIC` is the MQTT prefix; each tag publishes to `SOURCE_TOPIC` + `/` + tag name (e.g. `plc/read/TagName`). Do not use `DESTINATION_TOPIC` as the topic where polled tag values appear. Non-OT mappings (bridges, etc.) may still use `DESTINATION_TOPIC` per their template.

Indentation: **4 spaces** per level. `ADD TAG` inside a `MAPPING` is indented 8 spaces.

---

## ENV & Secrets in Config

**Always use `GET ENV` / `GET SECRET` for credentials and host names.** Never hardcode passwords.

```
WITH SERVER GET ENV "PG_HOST"
WITH PASSWORD GET SECRET "DB_PASSWORD"
WITH USERNAME GET ENV "PG_USER"
```

Inside event `WITH QUERY` strings, use placeholder syntax instead:
```
WITH QUERY "SELECT * FROM sensors WHERE zone = '{env.ZONE}' AND key = '{secret.API_KEY}'"
```

---

## Event Query Placeholders (1-based)

| Placeholder | Value |
|-------------|-------|
| `{payload}` | Raw MQTT message payload |
| `{payload.json}` | Full JSON payload object |
| `{payload.json.key}` | Nested JSON extraction (dot path) |
| `{payload.csv.N}` | CSV column by index |
| `{topic}` | Full MQTT topic string |
| `{topic.N}` | Topic segment by position (**1-based**) |
| `{timestamp}` | ISO 8601 timestamp |
| `{timestamp.unix}` | Unix epoch seconds |
| `{timestamp.unix_ms}` | Unix milliseconds |
| `{env.NAME}` | Environment variable |
| `{secret.NAME}` | Encrypted secret |

---

## Overload / Backpressure Configuration (`ADD ROUTE_CONFIG`)

Unlike every other config block, `ADD ROUTE_CONFIG` is **cross-type** — it may be added to any
route, alongside the route's own type-specific config block, to control what happens when the
shared route channel is saturated. All three settings are optional and independently defaulted;
an absent block inherits the broker-wide default (`COREFLUX_ROUTE_OVERLOAD_POLICY` /
`COREFLUX_ROUTE_CHANNEL_FULL_TIMEOUT_MS`). Search the `coreflux-docs` MCP server for
"route overload configuration" for the full operator-facing reference.

```
DEFINE ROUTE CloudBridge WITH TYPE MQTT_BRIDGE
    ADD ROUTE_CONFIG
        WITH OVERLOAD_POLICY "lossless"
        WITH OVERLOAD_TIMEOUT 200
        WITH OVERLOAD_CAPACITY 20000
    ADD SOURCE_CONFIG
        WITH BROKER SELF
    ADD DESTINATION_CONFIG
        WITH BROKER_ADDRESS "broker.example.com"
        WITH BROKER_PORT 8883
```

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `OVERLOAD_POLICY` | `lossless` \| `balanced` \| `realtime` | `balanced` | `lossless` waits indefinitely and never sheds; `balanced` waits up to `OVERLOAD_TIMEOUT` then sheds the arriving message; `realtime` never waits and sheds immediately |
| `OVERLOAD_TIMEOUT` | milliseconds | `50` | Wait budget for `balanced` only — ignored for `lossless`/`realtime` |
| `OVERLOAD_CAPACITY` | integer | unbounded | Max messages from THIS route in flight at once — per-route admission budget, for cross-route isolation |

`OVERLOAD_CAPACITY` is **rejected with `lossless`**: a capacity is an admission budget that sheds
once exhausted, which would silently break the "lossless never sheds" guarantee. Declaring both
logs an error and the route runs with capacity forced back to unbounded — lossless always wins.

---

## Database Routes

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
        WITH QUERY "SELECT * FROM orders WHERE status = '{payload}'"
    ADD EVENT InsertReading
        WITH SOURCE_TOPIC "sensors/+/store"
        WITH QUERY "INSERT INTO readings (device, value, ts) VALUES ('{topic.2}', {payload}, NOW())"
```

Config keys for SQL routes: `SERVER`, `PORT`, `DATABASE`, `USERNAME`, `PASSWORD`, `USE_SSL`, `SCHEMA`

### MySQL / MariaDB
Same as PostgreSQL but `WITH TYPE MYSQL` or `WITH TYPE MARIADB`. Default port: 3306.

### SQL Server / MSSQL
```
DEFINE ROUTE ERPSQL WITH TYPE SQLSERVER
    ADD SQL_CONFIG
        WITH SERVER GET ENV "SQL_HOST"
        WITH PORT 1433
        WITH DATABASE "ERP"
        WITH USERNAME GET ENV "SQL_USER"
        WITH PASSWORD GET SECRET "SQL_PASSWORD"
```

### MongoDB
```
DEFINE ROUTE LogsDB WITH TYPE MONGODB
    ADD MONGODB_CONFIG
        WITH CONNECTION_STRING GET ENV "MONGO_URI"
        WITH DATABASE "logs"
    ADD EVENT StoreLogs
        WITH SOURCE_TOPIC "system/logs/+"
        WITH QUERY "INSERT logs {payload.json}"
    ADD EVENT QueryLogs
        WITH SOURCE_TOPIC "logs/query"
        WITH DESTINATION_TOPIC "logs/result"
        WITH QUERY "FIND logs WHERE level = '{payload}' LIMIT 100"
```

### OpenSearch / Elasticsearch
```
DEFINE ROUTE SearchIndex WITH TYPE OPENSEARCH
    ADD OPENSEARCH_CONFIG
        WITH SERVER GET ENV "OS_HOST"
        WITH PORT 9200
        WITH USERNAME GET ENV "OS_USER"
        WITH PASSWORD GET SECRET "OS_PASSWORD"
    ADD EVENT IndexDocument
        WITH SOURCE_TOPIC "documents/+"
        WITH QUERY "INDEX documents/{topic.2} {payload.json}"
```

### File Storage
```
DEFINE ROUTE DataFiles WITH TYPE FILE_STORAGE
    ADD FILE_STORAGE_CONFIG
        WITH PATH "/data/exports"
        WITH FORMAT "CSV"
    ADD EVENT SaveReading
        WITH SOURCE_TOPIC "sensors/+/log"
        WITH QUERY "APPEND {topic.2}.csv {timestamp},{payload}"
```

---

## OT (Operational Technology) Routes

Polled tag values are published on MQTT as **`SOURCE_TOPIC/<tagName>`** per mapping (unless a tag sets its own `WITH SOURCE_TOPIC`). Subscribe or read those topics — not `DESTINATION_TOPIC`.

### Modbus TCP
```
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
            WITH SCALING 0.1
        ADD TAG "Pressure"
            WITH ADDRESS "40002"
            WITH DATA_TYPE "FLOAT32"
        ADD TAG "Running"
            WITH ADDRESS "00001"
            WITH DATA_TYPE "BOOL"
```

Data types: `INT16`, `INT32`, `UINT16`, `UINT32`, `FLOAT32`, `FLOAT64`, `BOOL`, `STRING`
Tag options: `ADDRESS`, `DATA_TYPE`, `SCALING`, `OFFSET`, `DEADBAND`, `PUBLISH_MODE`

### Modbus Serial (RTU)
```
DEFINE ROUTE SerialPLC WITH TYPE MODBUS_SERIAL
    ADD MODBUS_CONFIG
        WITH PORT "COM3"
        WITH BAUD_RATE 9600
        WITH PARITY "None"
        WITH STOP_BITS 1
        WITH SLAVE_ID 1
```

### Siemens S7
```
DEFINE ROUTE S7PLC WITH TYPE SIEMENS_S7
    ADD S7_CONFIG
        WITH IP "192.168.1.50"
        WITH CPU_TYPE "S71500"
        WITH RACK 0
        WITH SLOT 1
    ADD MAPPING "ReadDB"
        WITH SOURCE_TOPIC "s7/read"
        WITH EVERY 500 MILLISECONDS
        ADD TAG "Speed"
            WITH ADDRESS "DB1.DBD0"
            WITH DATA_TYPE "REAL"
        ADD TAG "Count"
            WITH ADDRESS "DB1.DBW4"
            WITH DATA_TYPE "INT"
        ADD TAG "Enable"
            WITH ADDRESS "DB1.DBX8.0"
            WITH DATA_TYPE "BOOL"
```

CPU types: `S7300`, `S7400`, `S71200`, `S71500`, `LOGO`

### OPC UA
```
DEFINE ROUTE OpcServer WITH TYPE OPCUA
    ADD OPCUA_CONFIG
        WITH ENDPOINT_URL "opc.tcp://192.168.1.200:4840"
        WITH SECURITY_MODE "None"
        WITH USERNAME GET ENV "OPC_USER"
        WITH PASSWORD GET SECRET "OPC_PASSWORD"
    ADD MAPPING "ReadNodes"
        WITH SOURCE_TOPIC "opc/read"
        WITH EVERY 1 SECONDS
        ADD TAG "Temperature"
            WITH ADDRESS "ns=2;s=Channel1.Device1.Tag1"
            WITH DATA_TYPE "DOUBLE"
```

Security modes: `None`, `Sign`, `SignAndEncrypt`

### EtherNet/IP (Allen-Bradley / Rockwell)
```
DEFINE ROUTE ABController WITH TYPE ETHERNETIP
    ADD ETHERNETIP_CONFIG
        WITH IP "192.168.1.75"
        WITH SLOT 0
    ADD MAPPING "ReadTags"
        WITH SOURCE_TOPIC "ab/read"
        WITH EVERY 250 MILLISECONDS
        ADD TAG "MotorSpeed"
            WITH ADDRESS "Motor_Speed"
            WITH DATA_TYPE "REAL"
        ADD TAG "LineRunning"
            WITH ADDRESS "Line_Running"
            WITH DATA_TYPE "BOOL"
```

### Beckhoff TwinCAT (ADS)
```
DEFINE ROUTE TwinCatPLC WITH TYPE ADS
    ADD ADS_CONFIG
        WITH AMS_NET_ID "192.168.1.100.1.1"
        WITH PORT 851
    ADD MAPPING "ReadVariables"
        WITH SOURCE_TOPIC "tc/read"
        WITH EVERY 100 MILLISECONDS
        ADD TAG "Velocity"
            WITH ADDRESS "MAIN.Velocity"
            WITH DATA_TYPE "LREAL"
```

### Omron FINS
```
DEFINE ROUTE OmronPLC WITH TYPE FINS
    ADD FINS_CONFIG
        WITH IP "192.168.1.80"
        WITH PORT 9600
        WITH PC_NODE 0
        WITH PLC_NODE 1
```

### BACnet/IP
```
DEFINE ROUTE BMS WITH TYPE BACNET
    ADD BACNET_CONFIG
        WITH IP "192.168.1.50"
        WITH PORT 47808
        WITH DEVICE_ID 1234
    ADD MAPPING "RoomSensors"
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

---

## AI Routes

### LLM Route (local or remote)
```
DEFINE ROUTE LocalLLM WITH TYPE LLM
    ADD LLM_CONFIG
        WITH BASE_URL "http://localhost:11434"
        WITH MODEL "llama3.2"
        WITH TEMPERATURE 0.7
        WITH MAX_TOKENS 2048
```

For OpenAI / cloud providers:
```
DEFINE ROUTE OpenAI WITH TYPE LLM
    ADD LLM_CONFIG
        WITH BASE_URL "https://api.openai.com"
        WITH MODEL "gpt-4o"
        WITH API_KEY GET SECRET "OPENAI_API_KEY"
```

### MCP Client Route
```
DEFINE ROUTE FilesystemMCP WITH TYPE MCP
    ADD MCP_CONFIG
        WITH TRANSPORT "stdio"
        WITH COMMAND "npx"
        WITH ARGS "-y @modelcontextprotocol/server-filesystem /data"
```

```
DEFINE ROUTE DatabaseMCP WITH TYPE MCP
    ADD MCP_CONFIG
        WITH TRANSPORT "sse"
        WITH URL "http://localhost:3000/sse"
```

### Agent Route
```
DEFINE ROUTE Assistant WITH TYPE AGENT
    ADD AGENT_CONFIG
        WITH MODEL "llama3.2"
        WITH BASE_URL "http://localhost:11434"
        WITH MAX_ITERATIONS 10
        WITH BROKER_TOOLS true
        WITH MCP_ROUTES "FilesystemMCP"
        WITH SYSTEM_PROMPT "You are a factory assistant. Help operators monitor and control the production line."
```

Key agent config options:
| Setting | Default | Description |
|---------|---------|-------------|
| `MODEL` | — | LLM model name (required) |
| `BASE_URL` | — | LLM provider base URL |
| `BROKER_TOOLS` | false | Give agent access to broker tools |
| `MCP_ROUTES` | — | Comma-separated list of MCP route names |
| `MAX_ITERATIONS` | 10 | Max tool call loops per response |
| `SYSTEM_PROMPT` | — | Agent persona and instructions |
| `TEMPERATURE` | 0.7 | LLM creativity |
| `MAX_TOKENS` | 4096 | Max tokens per response |

---

## REST API Routes

### REST API Client (outbound)
```
DEFINE ROUTE WeatherAPI WITH TYPE REST_API
    ADD REST_API_CONFIG
        WITH BASE_ADDRESS "https://api.weather.com"
        WITH AUTHORIZATION GET SECRET "WEATHER_API_KEY"
    ADD EVENT GetForecast
        WITH SOURCE_TOPIC "weather/request"
        WITH DESTINATION_TOPIC "weather/forecast"
        WITH METHOD "GET"
        WITH ENDPOINT "/v1/forecast?city={payload}"
    ADD EVENT PostReading
        WITH SOURCE_TOPIC "sensors/upload"
        WITH METHOD "POST"
        WITH ENDPOINT "/v1/readings"
        WITH BODY "{payload.json}"
```

### REST API Server (inbound — expose broker data over HTTP)
```
DEFINE ROUTE BrokerAPI WITH TYPE REST_API
    ADD REST_API_CONFIG
        WITH SERVER_PORT 8080
    ADD EVENT GetStatus
        WITH METHOD "GET"
        WITH ENDPOINT "/api/status"
        WITH SOURCE_TOPIC "system/status"
    ADD EVENT SendCommand
        WITH METHOD "POST"
        WITH ENDPOINT "/api/command"
        WITH DESTINATION_TOPIC "system/commands"
```

---

## MQTT Bridge
```
DEFINE ROUTE CloudBridge WITH TYPE MQTT_BRIDGE
    ADD SOURCE_CONFIG
        WITH BROKER SELF
    ADD DESTINATION_CONFIG
        WITH BROKER_ADDRESS "broker.example.com"
        WITH BROKER_PORT 8883
        WITH CLIENT_ID "bridge-client"
        WITH USERNAME GET ENV "BRIDGE_USER"
        WITH PASSWORD GET SECRET "BRIDGE_PASSWORD"
        WITH USE_TLS true
    ADD MAPPING "ForwardSensors"
        WITH SOURCE_TOPIC "sensors/#"
        WITH DESTINATION_TOPIC "cloud/factory/sensors/#"
        WITH DIRECTION "out"
```

---

## Email Route
```
DEFINE ROUTE AlertEmail WITH TYPE EMAIL
    ADD SMTP_CONFIG
        WITH SERVER "smtp.example.com"
        WITH PORT 587
        WITH USERNAME GET ENV "SMTP_USER"
        WITH PASSWORD GET SECRET "SMTP_PASSWORD"
        WITH FROM "alerts@factory.com"
        WITH USE_TLS true
    ADD EVENT SendAlert
        WITH SOURCE_TOPIC "alerts/critical"
        WITH TO "ops@factory.com"
        WITH SUBJECT "Critical Alert: {topic.2}"
        WITH BODY "Alert received: {payload} at {timestamp}"
```

---

## TRIGGER from LOT Actions

Invoke a route event programmatically from an action:
```
TRIGGER "ReadSensors" TO ProductionDB WITH "sensor1"
```

---

## Common Mistakes

```
-- WRONG: Missing WITH TYPE
DEFINE ROUTE MyDB
    ADD SQL_CONFIG ...

-- RIGHT:
DEFINE ROUTE MyDB WITH TYPE POSTGRESQL
    ADD SQL_CONFIG ...
```

```
-- WRONG: Wrong config block for route type
DEFINE ROUTE MyDB WITH TYPE POSTGRESQL
    ADD MODBUS_CONFIG ...    -- wrong!

-- RIGHT:
DEFINE ROUTE MyDB WITH TYPE POSTGRESQL
    ADD SQL_CONFIG ...
```

```
-- WRONG: Hardcoded password
WITH PASSWORD "mysecretpassword"

-- RIGHT:
WITH PASSWORD GET SECRET "DB_PASSWORD"
```

```
-- WRONG: 0-based topic position
WITH QUERY "SELECT * FROM t WHERE zone = '{topic.0}'"

-- RIGHT (1-based):
WITH QUERY "SELECT * FROM t WHERE zone = '{topic.1}'"
```

```
-- WRONG: Missing DESTINATION_TOPIC when result is expected
ADD EVENT GetData
    WITH SOURCE_TOPIC "data/query"
    WITH QUERY "SELECT * FROM data"
-- Result goes nowhere!

-- RIGHT:
ADD EVENT GetData
    WITH SOURCE_TOPIC "data/query"
    WITH DESTINATION_TOPIC "data/result"
    WITH QUERY "SELECT * FROM data"
```

```
-- WRONG: Using DESTINATION_TOPIC on OT TAG mapping as the topic for live values
ADD MAPPING "Poll"
    WITH SOURCE_TOPIC "plc/read"
    WITH DESTINATION_TOPIC "plc/data"
-- Values are on plc/read/<TagName>, not plc/data

-- RIGHT:
ADD MAPPING "Poll"
    WITH SOURCE_TOPIC "plc/read"
    WITH EVERY 1 SECONDS
    ADD TAG "Temperature" ...
```

```
-- WRONG: ADD METADATA in route definitions (parser rejects it)
DEFINE ROUTE PLC1 WITH TYPE MODBUS_TCP
    ADD MODBUS_CONFIG
        WITH IP "192.168.1.1"
    ADD MAPPING "Poll"
        ...
    ADD METADATA                 -- wrong! Parser does not support ADD METADATA
        WITH DESCRIPTION "..."   -- strip this from templates

-- ADD METADATA blocks appear in route templates (-routeCode TYPE / the
-- broker_route_template tool) for documentation only. broker_route_template
-- returns a `skeleton` with the block already removed — deploy that.
```

```
-- WRONG: ADD TAG outside MAPPING block
DEFINE ROUTE PLC1 WITH TYPE MODBUS_TCP
    ADD MODBUS_CONFIG
        WITH IP "192.168.1.1"
    ADD TAG "Temp"       -- wrong! TAG must be inside MAPPING
        WITH ADDRESS "40001"

-- RIGHT:
    ADD MAPPING "Poll"
        WITH SOURCE_TOPIC "plc/read"
        WITH EVERY 1 SECONDS
        ADD TAG "Temp"
            WITH ADDRESS "40001"
            WITH DATA_TYPE "INT16"
```
