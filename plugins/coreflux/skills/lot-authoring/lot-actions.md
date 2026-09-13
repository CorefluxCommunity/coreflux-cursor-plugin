# LOT Actions — Full Reference

## Structure

```
DEFINE ACTION Name
<trigger> DO
    <body statements>
```

**The trigger line sits at column 0 — same indent as `DEFINE`.** The body is
indented **4 spaces** under the trigger. Do NOT indent the trigger line under
`DEFINE ACTION`: the LOT lexer is Python-style indentation-sensitive, so an
indented trigger emits a stray `INDENT` token before `ON ...` and the parser
rejects the action.

---

## Triggers

### ON EVERY — interval timer
```
DEFINE ACTION Heartbeat
ON EVERY 10 SECONDS DO
    PUBLISH TOPIC "system/heartbeat" WITH TIMESTAMP "ISO"
```
Units: `MILLISECONDS`, `SECONDS`, `MINUTES`, `HOURS`, `DAYS`, `WEEKS`

### ON EVERY \<DAY> AT — day-of-week scheduled
Runs once at a specific time on the given day(s). Time is `"HH:mm:ss"` (24-hour).
```
DEFINE ACTION DailyShiftStart
ON EVERY WEEKDAY AT "06:00:00" DO
    PUBLISH TOPIC "shift/status" WITH "active"

DEFINE ACTION WeekendMode
ON EVERY WEEKEND AT "08:00:00" DO
    KEEP TOPIC "state/mode" WITH "weekend"

DEFINE ACTION SaturdayBackup
ON EVERY SATURDAY AT "02:00:00" DO
    PUBLISH TOPIC "backup/trigger" WITH "start"
```
Day keywords: `MONDAY` `TUESDAY` `WEDNESDAY` `THURSDAY` `FRIDAY` `SATURDAY` `SUNDAY` `WEEKDAY` `WEEKEND`

### ON TOPIC — MQTT-triggered
```
DEFINE ACTION ProcessSensor
ON TOPIC "sensors/+/data" DO
    SET "deviceId" WITH TOPIC POSITION 2
    SET "temp" WITH PAYLOAD AS DOUBLE
    IF {temp} > 30 THEN
        PUBLISH TOPIC "alerts/" + {deviceId} WITH "High temp: " + {temp}
```
- `+` matches one level in the topic pattern
- `PAYLOAD` — the incoming message body
- `TOPIC POSITION N` — segment N of the incoming topic (1-based)

### ON CHANGE — MQTT-triggered only when payload changes
```
DEFINE ACTION ProcessSensorOnChange
ON CHANGE "sensors/+/data" DO
    SET "temp" WITH PAYLOAD AS DOUBLE
    PUBLISH TOPIC "sensors/processed" WITH {temp}
```
- Same topic patterns and wildcards as `ON TOPIC`
- Runs on the **first** message for a topic, then only when the incoming **payload bytes** differ from the last value on that concrete topic (not JSON-aware)
- Use `ON TOPIC` when every publish must be handled; use `ON CHANGE` to avoid duplicate work on unchanged telemetry

### ON START — once at broker startup
```
DEFINE ACTION Init
ON START DO
    PUBLISH TOPIC "system/status" WITH "online"
    KEEP TOPIC "device/config" WITH "ready"
```

### ON CONNECT / ON DISCONNECT / ON SUBSCRIBE — MQTT session lifecycle
```
DEFINE ACTION AuditConnect
ON CONNECT DO
    PUBLISH TOPIC "audit/connect" WITH CLIENTID + "@" + ENDPOINT

DEFINE ACTION AuditDisconnect
ON DISCONNECT DO
    PUBLISH TOPIC "audit/disconnect" WITH DISCONNECTREASON

DEFINE ACTION TrackSubscriptions
ON SUBSCRIBE "sensors/#" DO
    PUBLISH TOPIC "audit/sub" WITH SUBSCRIBETOPIC + " qos=" + SUBSCRIBEQOS
```

Session context keywords: `CLIENTID`, `USER`, `ENDPOINT`, `CLEANSESSION`, `DISCONNECTREASON`, `SUBSCRIBETOPIC`, `SUBSCRIBEQOS`. Omit the topic pattern on `ON SUBSCRIBE` to run on every allowed subscription. The broker only evaluates these hooks when at least one action defines them.

### Callable actions (INPUT / RETURN / OUTPUT)

Callable actions have no MQTT trigger. Declare `INPUT` parameters, a `DO` body, then `RETURN` with **one `OUTPUT` per line** (one variable each). Comma-separated `RETURN OUTPUT a, b` and single-line `RETURN OUTPUT result` are **rejected**.

```
DEFINE ACTION CalcAverage
INPUT value1 AS DOUBLE
INPUT value2 AS DOUBLE
DO
    SET "avg" WITH ({value1} + {value2}) / 2
RETURN
    OUTPUT avg
```

Multiple outputs:

```
DEFINE ACTION AnalyzeReading
INPUT value AS DOUBLE
INPUT threshold AS DOUBLE
DO
    SET "is_above" WITH ({value} > {threshold})
    SET "difference" WITH ({value} - {threshold})
    SET "percentage" WITH ({value} / {threshold} * 100)
RETURN
    OUTPUT is_above
    OUTPUT difference
    OUTPUT percentage
```

Input types: `STRING`, `INT`, `DOUBLE`, `BOOL`, `JSON`

The number of `RETURN` variables at a `CALL ACTION` site must match the callee's `OUTPUT` count (validated at upload).

---

## Variable Operations

### SET — assign a value
```
SET "myVar" WITH "hello"
SET "count" WITH 0
SET "temp" WITH GET TOPIC "sensor/temp" AS DOUBLE
SET "raw" WITH PAYLOAD
SET "data" WITH GET JSON "readings.temperature" IN PAYLOAD AS DOUBLE
SET "host" WITH GET ENV "DB_HOST"
SET "pass" WITH GET SECRET "DB_PASSWORD"
SET "seg" WITH TOPIC POSITION 2
```

### Type casting with AS
`AS INT` · `AS DOUBLE` · `AS BOOL` · `AS STRING` · `AS TIMESTAMP` · `AS ARRAY` · `AS OBJECT`

### GET TOPIC — read a retained/current topic value
```
SET "value" WITH GET TOPIC "sensors/temperature" AS DOUBLE
SET "config" WITH GET TOPIC "device/config" AS STRING
```

Lookup order (same in actions and permission rules):

1. **In-flight** — a `KEEP` / `PUBLISH` this action queued but has not flushed yet.
2. **Trigger payload** — when reading the topic that fired this action.
3. **Live cache** — latest stored value. `KEEP TOPIC` writes it without broadcasting; `PUBLISH TOPIC` overwrites it and broadcasts. Last write wins.
4. **MQTT retain** — fallback after restart, before the cache is warm again.

Use `KEEP TOPIC` for state another action (or a rule) will `GET TOPIC` without notifying subscribers. Use `TOPIC EXISTS` in rules when the grant must be an MQTT retained message. Permission checks never dynamically subscribe to a missing topic.

### GET JSON — extract from JSON
```
SET "temp" WITH GET JSON "data.temperature" IN PAYLOAD AS DOUBLE
SET "name" WITH GET JSON "device.name" IN {myJson}
SET "nested" WITH GET JSON "a.b.c" IN PAYLOAD AS STRING
SET "ok" WITH (GET JSON "success" IN {result} AS BOOL)
```
Source is a JSON **string** (`PAYLOAD`, a variable, or `CALL PYTHON` `RETURN AS`). Missing keys
and JSON `null` become `"null"`; `AS BOOL` / `AS INT` / `AS DOUBLE` safe-parse that to
false / 0 / 0.0 instead of throwing. `AS STRING` yields the text `null`.

### GET MODEL — fetch model data from a DB route
```
SET "record" WITH GET MODEL "SensorData" FROM "MyDB" WHERE id EQUALS "sensor1"
```

---

## Publishing

### PUBLISH vs KEEP — When to Use Which

**KEEP** — stored in the broker cache with no MQTT delivery, readable by `GET TOPIC`.
**PUBLISH** — overwrites that same cache slot and delivers to current subscribers.

A later `PUBLISH` of the same topic **replaces** the KEEP'd value for `GET TOPIC`.

Use KEEP for shared inter-action state (counters, mode flags, last-known values).
Use PUBLISH to send data to routes, dashboards, or external systems.

```
-- Share state between actions:
KEEP TOPIC "state/mode" WITH "running"
KEEP TOPIC "state/lastTemp" WITH {temp}
SET "mode" WITH GET TOPIC "state/mode" AS STRING    -- read it from any action

-- Drive routes/UIs/external systems:
PUBLISH TOPIC "sensors/data" WITH { "temp": {temp} }
PUBLISH TOPIC "alerts/zone1" WITH "CRITICAL"
```

### PUBLISH TOPIC — non-retained message
```
PUBLISH TOPIC "output/data" WITH "value: " + {temp}
PUBLISH TOPIC "output/json" WITH { "temp": {temp}, "status": "ok" }
PUBLISH TOPIC "events/" + {deviceId} WITH TIMESTAMP "ISO"
```

### Binary passthrough — `PAYLOAD AS BYTES`

Use `AS BYTES` when the incoming MQTT payload must be forwarded or retained
bit-for-bit (protobuf, Modbus frames, image chunks). Untyped `WITH PAYLOAD`
still uses the string publish path and may corrupt non-UTF-8 data.

```
DEFINE ACTION ForwardBinary
ON TOPIC "binary/in" DO
    PUBLISH TOPIC "binary/out" WITH PAYLOAD AS BYTES

DEFINE ACTION KeepBinaryState
ON TOPIC "binary/in" DO
    KEEP TOPIC "state/raw" WITH PAYLOAD AS BYTES
    SET "frame" WITH PAYLOAD AS BYTES
```

- Do **not** chain string transforms (`TRIM`, `FILTER`, `REPLACE`, `SPLIT`) after
  `PAYLOAD AS BYTES` on publish/keep — the parser rejects that combination.
- Empty payloads are not published or stored on the binary path.

### KEEP TOPIC — stored without broadcast, readable by GET TOPIC
```
KEEP TOPIC "state/mode" WITH "running"
KEEP TOPIC "device/" + {id} + "/config" WITH {config}
```

### PUBLISH MODEL — use a defined model schema
```
PUBLISH MODEL "SensorReading" TO "output/sensors" WITH
    deviceId = "sensor1"
    temperature = {temp}
    timestamp = TIMESTAMP "ISO"
    status = "active"
```

---

## Persistent State

### KEEP ENV / KEEP SECRET — store environment variables
```
KEEP ENV "COUNTER" WITH {counter} + 1
KEEP SECRET "API_KEY" WITH "sk-abc123"
```

### DELETE ENV / DELETE SECRET
```
DELETE ENV "OLD_CONFIG"
DELETE SECRET "EXPIRED_KEY"
```

---

## Control Flow

### IF / THEN / ELSE
```
IF {temp} > 30 THEN
    PUBLISH TOPIC "alert" WITH "Hot!"
ELSE
    PUBLISH TOPIC "status" WITH "Normal"
```
Operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `AND`, `OR`, `NOT`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`

### IF without ELSE
```
IF {status} == "error" THEN
    PUBLISH TOPIC "alerts/system" WITH "Error detected"
```

### SWITCH / CASE
```
SWITCH {status}
    CASE "on" THEN
        PUBLISH TOPIC "led" WITH "1"
    CASE "off" THEN
        PUBLISH TOPIC "led" WITH "0"
    DEFAULT THEN
        PUBLISH TOPIC "led" WITH "unknown"
```

### LOOP / UNTIL
```
SET "i" WITH 0
LOOP
    SET "i" WITH {i} + 1
    PUBLISH TOPIC "counter" WITH {i}
UNTIL {i} == 10
```

---

## Expressions

### Arithmetic
```
SET "result" WITH {a} + {b} * 2
SET "avg" WITH ({x} + {y}) / 2
SET "remainder" WITH {total} % {batch}
```

### String concatenation with +
```
SET "msg" WITH "Temperature: " + {temp} + "°C"
PUBLISH TOPIC "sensors/" + {deviceId} + "/alert" WITH {msg}
```

### RANDOM
```
SET "id" WITH RANDOM UUID
SET "roll" WITH RANDOM INT BETWEEN 1 AND 6
SET "val" WITH RANDOM DOUBLE BETWEEN 0.0 AND 1.0
```

### TIMESTAMP
```
SET "now" WITH TIMESTAMP "ISO"       -- ISO 8601: 2026-01-15T10:30:00Z
SET "unix" WITH TIMESTAMP "UNIX"     -- Unix epoch seconds
SET "custom" WITH TIMESTAMP "UTC"
```

---

## String Transforms

### FILTER (regex extraction)
```
SET "digits" WITH FILTER PAYLOAD USING REGEX "[0-9]+"
```

### REPLACE
```
SET "clean" WITH REPLACE "\n" WITH " " IN RESULT
```

### TRIM
```
SET "text" WITH PAYLOAD AND_THEN TRIM
```

### AND_THEN (chaining transforms)
```
SET "result" WITH PAYLOAD AND_THEN FILTER USING REGEX "[0-9]+" AND_THEN TRIM
```

---

## Integration Calls

### CALL ACTION — invoke another callable action
```
DEFINE ACTION ProcessPair
ON TOPIC "sensors/pair/data" DO
    SET "temp1" WITH (GET JSON "sensor1" IN PAYLOAD AS DOUBLE)
    SET "temp2" WITH (GET JSON "sensor2" IN PAYLOAD AS DOUBLE)
    CALL ACTION CalcAverage
        WITH value1 = {temp1}, value2 = {temp2}
        RETURN result
    PUBLISH TOPIC "sensors/average" WITH {result}
```

Multi-line `CALL` (same rules as multi-line `RETURN` / `OUTPUT`):

```
    CALL ACTION AnalyzeReading
        WITH value = {current_value}, threshold = {threshold}
        RETURN above, diff, pct
```

The called action must declare `INPUT` parameters and a multi-line `RETURN` / `OUTPUT` block.

### CALL PYTHON — invoke a Python function

**Full workflow:**

**Step 1 — Write and deploy the script** (a `python` cell in a `.lotnb`, or the `lot_deploy` tool's `python` argument). Must include the `# Script Name:` header.
```python
# Script Name: SensorUtils

import json, statistics

def analyze(readings_json):
    readings = json.loads(readings_json) if isinstance(readings_json, str) else readings_json
    if not readings:
        return {"success": False, "error": "empty"}
    return {
        "success": True,
        "mean":  round(statistics.mean(readings), 2),
        "min":   min(readings),
        "max":   max(readings),
        "count": len(readings)
    }

def classify(value, low, high):
    v = float(value)
    if v < float(low):  return "low"
    if v > float(high): return "high"
    return "normal"
```

**Step 2 — Call from LOT action:**
```
DEFINE ACTION AnalyzeBatch
ON TOPIC "sensors/batch" DO
    SET "readings" WITH PAYLOAD
    CALL PYTHON "SensorUtils.analyze" WITH ({readings}) RETURN AS {stats}
    SET "ok" WITH (GET JSON "success" IN {stats} AS BOOL)
    IF {ok} EQUALS TRUE THEN
        SET "avg" WITH GET JSON "mean" IN {stats} AS DOUBLE
        SET "hi" WITH GET JSON "max"  IN {stats} AS DOUBLE
        PUBLISH TOPIC "sensors/stats" WITH {stats}
        IF {hi} > 85 THEN
            PUBLISH TOPIC "alerts/overtemp" WITH "Max: " + {hi}
```

**Rules:**
- Format: `CALL PYTHON "ScriptName.function_name" WITH (arg1, arg2, ...) RETURN AS {result}`
- Arguments are **positional** — order must match the Python function signature
- `RETURN AS` is always a **JSON string**. A Python `dict` / `list` / number / bool is
  serialized automatically — you do **not** need `json.dumps()`. A Python `str` (including
  `json.dumps(...)`) is kept as-is. `None` becomes `null`.
- Parse fields with `GET JSON "key" IN {result} AS BOOL|INT|DOUBLE|STRING`. Missing keys
  do not crash: typed extracts become false/0; `AS STRING` is the text `null`.
- `PUBLISH … WITH {result}` sends that same JSON string.
- Script must be deployed (`-addPython`, via `lot_deploy` / `lotnb_deploy`) before the action that calls it
- Available modules: `math`, `statistics`, `json`, `datetime`, `collections`, `re`, `csv`, `hashlib`, `base64`
- Blocked: `os`, `subprocess`, `socket`, `http`, `importlib`

### CALL MCP — invoke a tool exposed by an MCP route
```
CALL MCP "MyMcpRoute.search" WITH (query = "test") RETURN AS {result}
```
Tool names are `"<RouteName>.<tool>"`; discover them on the retained topic `$SYS/Coreflux/Routes/<RouteName>/Tools`. The legacy `CALL MCP "Route" TOOL "name"` form is rejected.

### CALL LLM — invoke an LLM route
```
CALL LLM "MyLlm" METHOD "generate" WITH prompt = "Summarize: " + {data} RETURN AS {answer}
```

### CALL AGENT — invoke an Agent route
```
CALL AGENT "MyAgent" METHOD "execute" WITH task = "Analyze data" RETURN AS {result}
```

### TRIGGER — fire a route event programmatically
```
TRIGGER "ReadSensors" TO MyDB WITH "sensor1"
```

---

## Complete Examples

### Sensor monitor with alerting
```
DEFINE ACTION SensorMonitor
ON TOPIC "factory/sensors/+/temperature" DO
    SET "zone" WITH TOPIC POSITION 3
    SET "temp" WITH PAYLOAD AS DOUBLE
    SET "ts" WITH TIMESTAMP "ISO"
    IF {temp} > 85 THEN
        PUBLISH TOPIC "factory/alerts/" + {zone} WITH "CRITICAL: " + {temp} + "°C at " + {ts}
        KEEP TOPIC "state/alerts/" + {zone} + "/last" WITH {temp}
    ELSE
        IF {temp} > 70 THEN
            PUBLISH TOPIC "factory/warnings/" + {zone} WITH "WARNING: " + {temp} + "°C"
```

### Periodic data aggregation with Python
```
DEFINE ACTION DailyReport
ON EVERY WEEKDAY AT "18:00:00" DO
    SET "readings" WITH GET TOPIC "sensors/day/buffer"
    CALL PYTHON "ReportGen.summarize" WITH ({readings}) RETURN AS {summary}
    PUBLISH TOPIC "reports/daily" WITH {summary}
    KEEP TOPIC "state/reports/daily/latest" WITH {summary}
```

### Callable conversion utility
```
DEFINE ACTION CelsiusToFahrenheit
INPUT celsius AS DOUBLE
DO
    SET "fahrenheit" WITH {celsius} * 1.8 + 32
RETURN
    OUTPUT fahrenheit
```

---

## Anti-Patterns

```
-- WRONG: Trigger indented under DEFINE (parser rejects with an unexpected INDENT)
DEFINE ACTION ToggleInput
    ON EVERY 1 SECONDS DO
        SET "current" WITH GET TOPIC "plc/input" AS BOOL
        IF {current} == true THEN
            PUBLISH TOPIC "plc/input" WITH false
        ELSE
            PUBLISH TOPIC "plc/input" WITH true
-- RIGHT: trigger at column 0, body indented 4 spaces
DEFINE ACTION ToggleInput
ON EVERY 1 SECONDS DO
    SET "current" WITH GET TOPIC "plc/input" AS BOOL
    IF {current} == true THEN
        PUBLISH TOPIC "plc/input" WITH false
    ELSE
        PUBLISH TOPIC "plc/input" WITH true
```

The same rule applies to every trigger: `ON TOPIC`, `ON EVERY N <UNIT>`,
`ON EVERY <DAY> AT`, `ON START`. The trigger line MUST sit at the same column as
`DEFINE ACTION` — never indented under it. Callable actions use `INPUT` lines
instead of an `ON` trigger.

```
-- WRONG: comma-separated or single-line RETURN OUTPUT
RETURN OUTPUT result
RETURN OUTPUT is_above, difference, percentage
-- RIGHT: RETURN on its own line, one OUTPUT per line
RETURN
    OUTPUT result
RETURN
    OUTPUT is_above
    OUTPUT difference
    OUTPUT percentage
```

```
-- WRONG: Quoted action name
DEFINE ACTION "Heartbeat"
-- RIGHT:
DEFINE ACTION Heartbeat
```

```
-- WRONG: MESSAGE keyword (invalid — parser rejects it)
PUBLISH TOPIC "t" MESSAGE "hello"
KEEP TOPIC "t" MESSAGE "value"
-- RIGHT:
PUBLISH TOPIC "t" WITH "hello"
KEEP TOPIC "t" WITH "value"
```

```
-- WRONG: Missing DO
ON EVERY 10 SECONDS
    PUBLISH TOPIC "t" WITH "x"
-- RIGHT:
ON EVERY 10 SECONDS DO
    PUBLISH TOPIC "t" WITH "x"
```

```
-- WRONG: Missing WITH in SET
SET count 0
-- RIGHT:
SET "count" WITH 0
```

```
-- WRONG: 0-based topic position
SET "seg" WITH TOPIC POSITION 0
-- RIGHT (1-based):
SET "seg" WITH TOPIC POSITION 1
```

```
-- WRONG: Variable without braces
SET "msg" WITH "Temp: " + temp
-- RIGHT:
SET "msg" WITH "Temp: " + {temp}
```

```
-- WRONG: No THEN after IF
IF {x} > 5
    PUBLISH TOPIC "t" WITH "yes"
-- RIGHT:
IF {x} > 5 THEN
    PUBLISH TOPIC "t" WITH "yes"
```

```
-- WRONG: KEEP to drive a route (unreliable — use PUBLISH)
KEEP TOPIC "db/insert/data" WITH {payload}
-- RIGHT for route events:
PUBLISH TOPIC "db/insert/data" WITH {payload}
-- KEEP is for state between actions:
KEEP TOPIC "state/lastValue" WITH {payload}
```
