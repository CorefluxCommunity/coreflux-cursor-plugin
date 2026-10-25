---
name: lot-models
description: "How to write LOT models: data schemas, field types, MQTT topic bindings, triggers, behaviors (Default, Keep, Collapsed), storage, and inheritance."
---

# LOT Models — Complete Reference

## CRITICAL SYNTAX

Model names are NEVER quoted in DEFINE. Field names and topic strings ARE quoted.
```
WRONG:  DEFINE MODEL "SensorReading" WITH TOPIC "sensors/data"
RIGHT:  DEFINE MODEL SensorReading WITH TOPIC "sensors/data"
```

Static field defaults use WITH directly — NEVER use WITH VALUE (parser rejects it for anything but a plain literal).
```
WRONG:  ADD STRING "timestamp" WITH VALUE TIMESTAMP "ISO"
RIGHT:  ADD STRING "timestamp" WITH TIMESTAMP "ISO"

WRONG:  ADD STRING "id" WITH VALUE RANDOM UUID
RIGHT:  ADD STRING "id" WITH RANDOM UUID

AVOID:  ADD STRING "status" WITH VALUE "ok"    (accepted for literals only)
RIGHT:  ADD STRING "status" WITH "ok"
```

Model names that are a LoT keyword in any case are rejected with LOT1001 — e.g. `Device`,
`Event`, `Unit`, `Tag`, `Table`, `Type`, `Alarm`, `Metric`, `Store`, `Fetch`. Use a compound
name such as `DeviceInfo` or `EventRecord`.

## Basic Structure

```
DEFINE MODEL <name> WITH TOPIC "<base_topic>"
    ADD <TYPE> "<fieldName>" WITH TOPIC "<field_topic>" [AS TRIGGER]
    ADD <TYPE> "<fieldName>" WITH <expression>
```

Models define data schemas that map MQTT topics to typed fields.

## Field Types
- STRING — text values (timestamps too: `ADD STRING "ts" WITH TIMESTAMP "ISO"`)
- INT — integer numbers
- DOUBLE — floating-point numbers (FLOAT / SINGLE are accepted; protobuf wire alias)
- BOOL — true/false
- ARRAY (or LIST) — JSON arrays; `ARRAY <ModelName>` is an array of another model
- OBJECT (or MAP / DICTIONARY) — nested JSON objects (embedded as-is, not as string)
- `<ModelName>` — a nested model: `ADD Reading "last"` (or `ADD MODEL Reading "last"`)

`ADD JSON "x"` and `ADD TIMESTAMP "x"` are parse errors — use OBJECT and STRING.
The type may be omitted (`ADD "x" WITH TOPIC "t"`); it is then inferred from the value.

To embed JSON you received (not a string of it), assign the JSON text to an OBJECT or ARRAY field in
PUBLISH MODEL. The text is parsed into the document; text that is not valid JSON becomes `{}` / `[]`.
```
DEFINE MODEL GatewayEnvelope COLLAPSED
    ADD STRING "gateway"
    ADD OBJECT "data"
    ADD STRING "received" WITH TIMESTAMP "ISO"

DEFINE ACTION WrapGatewayData
ON TOPIC "gateways/+/raw" DO
    SET "gw" WITH TOPIC POSITION 2
    PUBLISH MODEL GatewayEnvelope TO "gateways/" + {gw} + "/envelope" WITH
        gateway = {gw}
        data = (GET JSON "data" IN PAYLOAD AS STRING)
```
`GET JSON … AS STRING` on a nested object returns its JSON text, so `data` is published as an object.

## Field Bindings

### WITH TOPIC — bind field to an MQTT topic
```
ADD DOUBLE "temperature" WITH TOPIC "sensors/temp"
```

### AS TRIGGER — field topic triggers model update
```
ADD DOUBLE "temperature" WITH TOPIC "sensors/temp" AS TRIGGER
```
When a message arrives on the trigger topic, the model re-evaluates and publishes.
At least one field must be AS TRIGGER for the model to auto-publish.

Several fields may be AS TRIGGER; a message on any one of them publishes the model, with the other
fields at their last known values:
```
DEFINE MODEL MachineSnapshot COLLAPSED WITH TOPIC "machines/press1/snapshot"
    ADD DOUBLE "temperature" WITH TOPIC "machines/press1/temp" AS TRIGGER
    ADD DOUBLE "pressure" WITH TOPIC "machines/press1/pressure" AS TRIGGER
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
```

### WITH COLLECTION TO TOPIC — build an array from numbered subtopics
```
DEFINE MODEL LineOrders COLLAPSED WITH TOPIC "line1/orders/summary"
    ADD STRING "line" WITH TOPIC "line1/orders/updated" AS TRIGGER
    ADD ARRAY "orders" WITH COLLECTION TO TOPIC "line1/orders/item"
```
The array is read from `line1/orders/item/0`, `line1/orders/item/1`, … and stops at the first missing
index. Declare the field ARRAY, and publish one JSON object per index.

### WITH (static or computed default) — NO VALUE keyword
Static defaults use WITH directly. Never use WITH VALUE — the parser rejects it for anything but a plain literal.
```
ADD STRING "id" WITH RANDOM UUID
ADD STRING "timestamp" WITH TIMESTAMP "ISO"
ADD STRING "timestamp" WITH TIMESTAMP "UTC"
ADD STRING "status" WITH "ok"
ADD INT "count" WITH 0
ADD BOOL "active" WITH FALSE
ADD DOUBLE "offset" WITH 0.0
```

## Complete Example

```
DEFINE MODEL SensorReading WITH TOPIC "factory/sensors/data"
    ADD STRING "deviceId" WITH TOPIC "factory/sensors/id" AS TRIGGER
    ADD DOUBLE "temperature" WITH TOPIC "factory/sensors/temp"
    ADD DOUBLE "humidity" WITH TOPIC "factory/sensors/humidity"
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
    ADD STRING "status" WITH "ok"
```

## Model Options

### RETAIN — retain model output on MQTT
```
DEFINE MODEL Config WITH TOPIC "device/config" RETAIN
```
RETAIN and QOS are applied when an action runs `PUBLISH MODEL`. A topic-bound model
(published by its AS TRIGGER fields) currently publishes non-retained at QoS 0 whatever the
header says.

### QoS levels
```
DEFINE MODEL Critical WITH TOPIC "alerts/data" QOS1
```
Options: QOS0 (default), QOS1, QOS2

### FORMAT — wire format
`WITH FORMAT PROTOBUF` (or `JSON`, the default, or `BOTH`: JSON on the topic, protobuf on
`<topic>/protobuf`). Header clauses (FROM, COLLAPSED, KEEP, WITH TOPIC, RETAIN, QOS, FORMAT)
may appear in any order.

## Model Behaviors

### Default — whole JSON plus one subtopic per field
The full JSON object is published on `<baseTopic>`, and each field is also published to
`<baseTopic>/<fieldName>`.

### COLLAPSED — all fields as single JSON object
```
DEFINE MODEL EventRecord COLLAPSED WITH TOPIC "events/data"
    ADD STRING "id" WITH RANDOM UUID
    ADD STRING "type" WITH "alert"
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
    ADD DOUBLE "value" WITH TOPIC "sensors/temp" AS TRIGGER
```
Output: a single JSON payload `{"id":"...","type":"alert","timestamp":"...","value":23.5}` on `events/data`.

### KEEP — field subtopics stay inside the broker
```
DEFINE MODEL LineState KEEP WITH TOPIC "line/state"
    ADD DOUBLE "speed" WITH TOPIC "line/speed" AS TRIGGER
```
The JSON on `<baseTopic>` is published as usual, but the per-field `<baseTopic>/<fieldName>`
values are only stored in the broker's topic cache (readable with GET TOPIC), not sent to
MQTT subscribers. With `PUBLISH MODEL`, a KEEP model stores the JSON too and publishes nothing.

## Model Inheritance (FROM)

Child models inherit ALL fields from their parent and can add new ones.
Use inheritance when multiple models share common structure but differ in specialization.

**Rules:**
- Parent model MUST be defined BEFORE the child (order matters)
- Child CANNOT remove inherited fields
- Child CAN add new fields with ADD
- Child CAN override inherited field topics by re-declaring them
- Inheritance can be multi-level (grandparent → parent → child)

### Step 1 — Define the base model first
```
DEFINE MODEL BaseSensor WITH TOPIC "sensors/base"
    ADD STRING "deviceId" WITH TOPIC "sensors/id" AS TRIGGER
    ADD STRING "location" WITH TOPIC "sensors/location"
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
    ADD STRING "status" WITH "ok"
```

### Step 2 — Specialize it with child models
```
DEFINE MODEL TemperatureSensor FROM BaseSensor WITH TOPIC "sensors/temperature"
    ADD DOUBLE "celsius" WITH TOPIC "sensors/temp/celsius" AS TRIGGER
    ADD DOUBLE "fahrenheit" WITH TOPIC "sensors/temp/fahrenheit"
    ADD STRING "unit" WITH "°C"

DEFINE MODEL HumiditySensor FROM BaseSensor WITH TOPIC "sensors/humidity"
    ADD DOUBLE "humidity" WITH TOPIC "sensors/humidity/value" AS TRIGGER
    ADD DOUBLE "dewPoint" WITH TOPIC "sensors/humidity/dewpoint"
```

Each child publishes all base fields (deviceId, location, timestamp, status) PLUS its own.

### Multi-level inheritance
```
-- Level 1: base with identity fields
DEFINE MODEL DeviceBase WITH TOPIC "devices/base"
    ADD STRING "deviceId" WITH TOPIC "devices/id" AS TRIGGER
    ADD STRING "firmware" WITH TOPIC "devices/firmware"
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"

-- Level 2: sensor adds measurement fields
DEFINE MODEL Sensor FROM DeviceBase WITH TOPIC "sensors/base"
    ADD STRING "unit" WITH TOPIC "sensors/unit"
    ADD DOUBLE "value" WITH TOPIC "sensors/value"

-- Level 3: specialized sensor for a specific measurement
DEFINE MODEL PressureSensor FROM Sensor WITH TOPIC "sensors/pressure"
    ADD DOUBLE "bar" WITH TOPIC "sensors/pressure/bar" AS TRIGGER
    ADD STRING "grade" WITH "industrial"
```

### Inheritance + COLLAPSED
```
-- Parent: shared fields
DEFINE MODEL EventBase WITH TOPIC "events/base"
    ADD STRING "id" WITH RANDOM UUID
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
    ADD STRING "source" WITH TOPIC "system/name" AS TRIGGER

-- Child: specialized event type, collapsed to one JSON
DEFINE MODEL AlertEvent COLLAPSED FROM EventBase WITH TOPIC "events/alerts"
    ADD STRING "severity" WITH TOPIC "alerts/severity"
    ADD STRING "message" WITH TOPIC "alerts/message"
    ADD STRING "zone" WITH TOPIC "alerts/zone"
```

### When to use inheritance
Use inheritance when: same base fields appear in many models (device ID, timestamp, location).
Define the base once, extend everywhere. If a field changes (e.g. timestamp format), update in one place.

## Database Storage (STORE IN)

```
DEFINE MODEL SensorLog WITH TOPIC "sensors/log"
    ADD DOUBLE "temperature" WITH TOPIC "sensors/temp" AS TRIGGER
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
    STORE IN "MyDB" WITH TABLE "sensor_readings"
```

### Conditional storage
```
    STORE IN "MyDB" WITH TABLE "alerts" WHEN {temperature} > 50
```

## Database Fetch (FETCH FROM)

Accepted but not run yet (warning LOT4005, ENG-417): the model publishes without querying the route.

```
    FETCH FROM "MyDB" WITH TABLE "sensors" WHEN id EQUALS "sensor1" LIMIT 10
```

## When to Use PUBLISH MODEL vs Topic Bindings

### Pattern 1 — Topic-binding model (simple streaming, no logic)
Use when data flows directly from MQTT topics into a structured output with no computation.
The model fires automatically when a TRIGGER topic receives a message.
```
DEFINE MODEL BoilerStatus COLLAPSED WITH TOPIC "factory/boiler/data"
    ADD STRING "boilerId" WITH TOPIC "factory/boiler/id" AS TRIGGER
    ADD DOUBLE "temperature" WITH TOPIC "factory/boiler/temp"
    ADD DOUBLE "pressure" WITH TOPIC "factory/boiler/pressure"
    ADD STRING "timestamp" WITH TIMESTAMP "UTC"
```
Good for: pass-through aggregation, display dashboards, simple monitoring.

### Pattern 2 — PUBLISH MODEL from an action (streaming with logic/aggregation)
Use when data needs processing, conditional logic, external calls, or multiple source aggregation.
RECOMMENDED for most data streaming scenarios — it gives full control and clean schema.

**Key design rule:** Put static and repeating fields in DEFINE MODEL — IDs, timestamps,
unit labels, firmware version, location constants. These fill automatically.
The action only passes the fields that actually change per event.

```
-- Step 1: Define the schema. Static/repeating fields go HERE.
DEFINE MODEL SensorReading COLLAPSED
    ADD STRING "timestamp" WITH TIMESTAMP "UTC"    -- auto-generated every time
    ADD STRING "unit" WITH "celsius"              -- always the same
    ADD STRING "firmware" WITH "v2.1"             -- constant
    ADD STRING "deviceId"                          -- dynamic — action fills this
    ADD DOUBLE "temperature"                       -- dynamic — action fills this
    ADD STRING "status"                            -- dynamic — action fills this

-- Step 2: The action handles logic and only passes the 3 dynamic fields.
DEFINE ACTION StreamSensorData
ON TOPIC "sensors/+/raw" DO
    SET "id" WITH TOPIC POSITION 2
    SET "temp" WITH PAYLOAD AS DOUBLE
    SET "status" WITH "ok"
    IF {temp} > 85 THEN
        SET "status" WITH "critical"
    PUBLISH MODEL SensorReading TO "sensors/" + {id} + "/processed" WITH
        deviceId = {id}
        temperature = {temp}
        status = {status}
```

Result: the agent produces `{timestamp, unit, firmware, deviceId, temperature, status}` — the
schema is fully defined, the action is clean, and static fields never need repeating.

### Pattern 3 — PUBLISH MODEL for repeated multi-asset streaming
When the same model structure is published for many assets (machines, sensors, zones),
define the schema once with all static fields, and let the action loop or react per-asset.

```
DEFINE MODEL MachineStatus COLLAPSED
    ADD STRING "timestamp" WITH TIMESTAMP "UTC"
    ADD STRING "plant" WITH "Factory-A"
    ADD STRING "machineId"
    ADD STRING "state"
    ADD DOUBLE "cycleTime"
    ADD INT "partCount"

DEFINE ACTION TrackMachines
ON TOPIC "machines/+/cycle" DO
    SET "machine" WITH TOPIC POSITION 2
    SET "cycles" WITH GET JSON "count" IN PAYLOAD AS INT
    SET "time" WITH GET JSON "cycleMs" IN PAYLOAD AS DOUBLE
    PUBLISH MODEL MachineStatus TO "machines/" + {machine} + "/status" WITH
        machineId = {machine}
        state = "running"
        cycleTime = {time}
        partCount = {cycles}
```

### Decision guide

| Scenario | Use |
|----------|-----|
| Simple topic→JSON pass-through, no logic | Topic-binding model (no action needed) |
| Data needs computation, filtering, or logic | PUBLISH MODEL from action |
| Same structure published for many assets | PUBLISH MODEL from action |
| Need to call Python, MCP, or LLM first | PUBLISH MODEL from action |
| Fields come from different systems/routes | PUBLISH MODEL from action |
| Static display model (config, metadata) | PUBLISH MODEL from action with a RETAIN model (topic-bound models ignore RETAIN) |

## Common Mistakes

| WRONG | RIGHT |
|-------|-------|
| DEFINE MODEL "SensorReading" | DEFINE MODEL SensorReading |
| ADD STRING "ts" WITH VALUE TIMESTAMP "ISO" | ADD STRING "ts" WITH TIMESTAMP "ISO" — no VALUE keyword |
| ADD STRING "id" WITH VALUE RANDOM UUID | ADD STRING "id" WITH RANDOM UUID — no VALUE keyword |
| ADD STRING "ok" WITH VALUE "ok" | ADD STRING "ok" WITH "ok" — VALUE only takes a literal; drop it |
| No AS TRIGGER on any field (topic-bound model) | At least one field must have AS TRIGGER |
| ADD JSON "cfg" / ADD TIMESTAMP "ts" | ADD OBJECT "cfg" / ADD STRING "ts" WITH TIMESTAMP "ISO" |
| ADD STRING "data" for received JSON (published as an escaped string) | ADD OBJECT "data" — JSON text assigned to it is parsed |
| DEFINE MODEL Device / DEFINE MODEL Event | Keyword names are rejected — DeviceInfo, EventRecord |
| DEFINE child before parent | Define parent model first |
| COLLAPSED when subtopics are needed | Only use COLLAPSED when you want one JSON blob |
