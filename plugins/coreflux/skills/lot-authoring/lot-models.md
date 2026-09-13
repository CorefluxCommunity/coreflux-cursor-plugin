# LOT Models — Full Reference

## What Models Do

Models define **data schemas** that map MQTT topics to structured fields. When a trigger topic receives a message, the broker re-evaluates all fields and publishes the assembled output.

Two publishing modes:
- **Default**: each field published individually to `<baseTopic>/<fieldName>`
- **COLLAPSED**: all fields published as a single JSON object to `<baseTopic>`

---

## Basic Structure

```
DEFINE MODEL Name [COLLAPSED] [FROM ParentModel] [WITH TOPIC "base/topic"]
    ADD <TYPE> "fieldName" WITH TOPIC "field/topic" [AS TRIGGER]
    ADD <TYPE> "fieldName" WITH <expression>
    [STORE IN "RouteName" WITH TABLE "table_name"]
    [FETCH FROM "RouteName" WITH TABLE "table_name" WHEN ...]
```

Indentation: **4 spaces** per level.

---

## Field Types

| Type | Description | Example value |
|------|-------------|---------------|
| `STRING` | Text | `"hello"`, `"sensor1"` |
| `INT` | Integer | `0`, `42` |
| `DOUBLE` | Float | `3.14`, `98.6` |
| `BOOL` | Boolean | `true`, `false` |
| `OBJECT` | Raw JSON object/array — embedded directly, not as string | `{"a": 1}` |
| `ARRAY` | JSON array | `[1, 2, 3]` |
| `TIMESTAMP` | Date/time value | ISO, UNIX string |
| `COLLECTION` | Array of another model type | see Collections below |

---

## Field Bindings

### WITH TOPIC — subscribe to an MQTT topic
```
ADD DOUBLE "temperature" WITH TOPIC "sensors/temp"
ADD STRING "deviceId" WITH TOPIC "factory/sensors/id"
```
The field value is updated whenever that topic receives a message.

### AS TRIGGER — re-fire the model when this topic updates
```
ADD DOUBLE "temperature" WITH TOPIC "sensors/temp" AS TRIGGER
ADD STRING "deviceId" WITH TOPIC "factory/sensors/id" AS TRIGGER
```
At least one field should have `AS TRIGGER` for the model to auto-publish.
Multiple triggers are allowed; any one of them firing will publish the model.

### Static defaults — WITH directly, NEVER WITH VALUE
The parser rejects `WITH VALUE` for expressions. Always use `WITH` alone.
```
ADD STRING "id"        WITH RANDOM UUID
ADD STRING "timestamp" WITH TIMESTAMP "UTC"
ADD STRING "status"    WITH "ok"
ADD INT    "count"     WITH 0
ADD DOUBLE "offset"    WITH 0.0
ADD BOOL   "active"    WITH FALSE
```

Supported expressions after `WITH`:
- String literals: `"text"`
- Numbers: `42`, `3.14`
- `RANDOM UUID` — generates a UUID
- `TIMESTAMP "ISO"` — ISO 8601 timestamp
- `TIMESTAMP "UNIX"` — Unix epoch seconds
- `TIMESTAMP "UTC"` — UTC formatted timestamp

---

## Model Options (header clauses)

### COLLAPSED — publish as single JSON object
```
DEFINE MODEL Event COLLAPSED WITH TOPIC "events/output"
    ADD STRING "id" WITH RANDOM UUID
    ADD STRING "type" WITH "alert"
    ADD DOUBLE "value" WITH TOPIC "sensors/temp" AS TRIGGER
```
Output: `{"id":"...","type":"alert","value":23.5}` published to `events/output`

Without COLLAPSED, each field is published to `events/output/id`, `events/output/type`, etc.

### KEEP — model retains its last output on MQTT (retained flag)
```
DEFINE MODEL Config KEEP WITH TOPIC "device/config"
```

### WITH RETAIN — same as KEEP (alias)
```
DEFINE MODEL Config WITH TOPIC "device/config" RETAIN
```

### QoS
```
DEFINE MODEL Critical WITH TOPIC "alerts/data" QOS1
DEFINE MODEL Best WITH TOPIC "sensors/data" QOS0
```
Options: `QOS0` (default), `QOS1`, `QOS2`

---

## Model Inheritance (FROM)

```
DEFINE MODEL AdvancedSensor FROM SensorReading WITH TOPIC "sensors/advanced"
    ADD STRING "firmware" WITH "v2.0"
    ADD DOUBLE "batteryLevel" WITH TOPIC "sensors/battery"
```
Child inherits all parent fields. **Parent must be defined first.**

---

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

---

## Database Fetch (FETCH FROM)

```
    FETCH FROM "MyDB" WITH TABLE "sensors" WHEN id EQUALS "sensor1" LIMIT 10
```

---

## Collections (arrays of another model)

```
DEFINE MODEL Reading
    ADD DOUBLE "value"
    ADD STRING "unit"

DEFINE MODEL SensorBatch COLLAPSED WITH TOPIC "sensors/batch"
    ADD STRING "deviceId" WITH TOPIC "sensors/id" AS TRIGGER
    ADD COLLECTION "readings" OF "Reading"
```

---

## Complete Examples

### Simple topic-mapped model (Default behavior)
```
DEFINE MODEL SensorReading WITH TOPIC "factory/sensors/data"
    ADD STRING "deviceId" WITH TOPIC "factory/sensors/id" AS TRIGGER
    ADD DOUBLE "temperature" WITH TOPIC "factory/sensors/temp"
    ADD DOUBLE "humidity" WITH TOPIC "factory/sensors/humidity"
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
    ADD STRING "status" WITH "ok"
```
Publishes to:
- `factory/sensors/data/deviceId`
- `factory/sensors/data/temperature`
- `factory/sensors/data/humidity`
- etc.

### COLLAPSED JSON model
```
DEFINE MODEL Alert COLLAPSED WITH TOPIC "alerts/active"
    ADD STRING "id" WITH RANDOM UUID
    ADD STRING "zone" WITH TOPIC "factory/zone" AS TRIGGER
    ADD DOUBLE "value" WITH TOPIC "factory/sensors/temp" AS TRIGGER
    ADD STRING "severity" WITH "critical"
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"
```
Publishes one JSON payload: `{"id":"...","zone":"A1","value":92.3,"severity":"critical","timestamp":"..."}`

### Model with database storage
```
DEFINE MODEL SensorHistory COLLAPSED WITH TOPIC "sensors/history"
    ADD STRING "deviceId" WITH TOPIC "sensors/id" AS TRIGGER
    ADD DOUBLE "temperature" WITH TOPIC "sensors/temp"
    ADD DOUBLE "humidity" WITH TOPIC "sensors/humidity"
    ADD STRING "recordedAt" WITH TIMESTAMP "ISO"
    STORE IN "FactoryDB" WITH TABLE "sensor_history"
```

### Inherited model
```
DEFINE MODEL BaseSensor WITH TOPIC "sensors/base"
    ADD STRING "deviceId" WITH TOPIC "sensors/id" AS TRIGGER
    ADD STRING "timestamp" WITH TIMESTAMP "ISO"

DEFINE MODEL TemperatureSensor FROM BaseSensor WITH TOPIC "sensors/temperature"
    ADD DOUBLE "celsius" WITH TOPIC "sensors/temp"
    ADD DOUBLE "fahrenheit" WITH TOPIC "sensors/temp_f"
    ADD STRING "location" WITH "Zone-A"
```

---

## When to Use PUBLISH MODEL vs Topic Bindings

### Pattern 1 — Topic-binding model (simple pass-through, no logic)
Fields bind directly to MQTT topics. Model fires automatically on TRIGGER. No action needed.
```
DEFINE MODEL BoilerStatus COLLAPSED WITH TOPIC "factory/boiler/data"
    ADD STRING "boilerId"    WITH TOPIC "factory/boiler/id"   AS TRIGGER
    ADD DOUBLE "temperature" WITH TOPIC "factory/boiler/temp"
    ADD DOUBLE "pressure"    WITH TOPIC "factory/boiler/pressure"
    ADD STRING "timestamp"   WITH TIMESTAMP "UTC"
```
Good for: simple dashboards, pass-through aggregation, static display.

### Pattern 2 — PUBLISH MODEL from action (recommended for streaming data)
Use when data needs processing, multi-source aggregation, or logic before publishing.

**Key rule:** Put static/repeating fields in DEFINE MODEL — timestamps, unit labels, constants,
firmware version, location. The action only passes what actually changes per event.

```
-- Schema: static fields auto-fill, action only sends the 3 dynamic ones
DEFINE MODEL SensorReading COLLAPSED
    ADD STRING "timestamp"   WITH TIMESTAMP "UTC"   -- always auto-generated
    ADD STRING "unit"        WITH "celsius"          -- always the same
    ADD STRING "plant"       WITH "Factory-A"        -- always the same
    ADD STRING "deviceId"                            -- action fills this
    ADD DOUBLE "temperature"                         -- action fills this
    ADD STRING "status"                              -- action fills this

DEFINE ACTION StreamSensor
ON TOPIC "sensors/+/raw" DO
    SET "id" WITH TOPIC POSITION 2
    SET "temp" WITH PAYLOAD AS DOUBLE
    SET "st" WITH "ok"
    IF {temp} > 85 THEN
        SET "st" WITH "critical"
    PUBLISH MODEL SensorReading TO "sensors/" + {id} + "/data" WITH
        deviceId    = {id}
        temperature = {temp}
        status      = {st}
```

### Decision guide
| Scenario | Use |
|----------|-----|
| Simple topic→JSON pass-through, no logic | Topic-binding model (no action) |
| Data needs computation or filtering | PUBLISH MODEL from action |
| Same structure for many assets/machines | PUBLISH MODEL from action |
| Need to call Python, MCP, or LLM first | PUBLISH MODEL from action |
| Static config/metadata display | Topic-binding with RETAIN |

## PUBLISH MODEL in Actions

Use inside a `DEFINE ACTION` body to send a model instance:
```
DEFINE ACTION PublishSensorData
ON TOPIC "sensors/+/raw" DO
    SET "id" WITH TOPIC POSITION 2
    SET "temp" WITH PAYLOAD AS DOUBLE
    PUBLISH MODEL "SensorReading" TO "sensors/" + {id} + "/processed" WITH
        deviceId = {id}
        temperature = {temp}
        timestamp = TIMESTAMP "ISO"
        status = "active"
```

For `OBJECT` type fields, the value is embedded as raw JSON (not as a string):
```
DEFINE MODEL KafkaMessage COLLAPSED
    ADD STRING "componentId"
    ADD STRING "topic"
    ADD OBJECT "payload"

-- In an action:
PUBLISH MODEL "KafkaMessage" TO {targetTopic} WITH
    componentId = "sensor1"
    topic = {targetTopic}
    payload = (GET JSON "data" IN PAYLOAD AS STRING)
```

---

## Anti-Patterns

```
-- WRONG: No field type
ADD "temperature" WITH TOPIC "sensors/temp"

-- RIGHT:
ADD DOUBLE "temperature" WITH TOPIC "sensors/temp"
```

```
-- WRONG: No base topic
DEFINE MODEL Sensor
    ADD DOUBLE "temp" WITH TOPIC "sensors/t" AS TRIGGER

-- RIGHT:
DEFINE MODEL Sensor WITH TOPIC "sensors/data"
    ADD DOUBLE "temp" WITH TOPIC "sensors/t" AS TRIGGER
```

```
-- WRONG: Child model before parent
DEFINE MODEL Child FROM Parent WITH TOPIC "c/data"
    ...
DEFINE MODEL Parent WITH TOPIC "p/data"    -- too late
    ...

-- RIGHT: define Parent first
```

```
-- WRONG: COLLAPSED with individual subtopic expectations
-- COLLAPSED publishes ONE JSON to the base topic, not per-field subtopics.
-- If downstream consumers read "data/temperature", "data/humidity", etc.,
-- don't use COLLAPSED.
```
