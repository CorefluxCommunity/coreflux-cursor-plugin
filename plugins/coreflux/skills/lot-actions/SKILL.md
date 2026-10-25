---
name: lot-actions
description: "How to write LOT actions: triggers, variables, topic operations, control flow, callable actions, and integrations (Python, MCP, LLM)."
---

# LOT Actions — Complete Reference

## CRITICAL SYNTAX — Read Before Writing Anything

### Action names are NEVER quoted in DEFINE
```
WRONG:  DEFINE ACTION "Heartbeat"
RIGHT:  DEFINE ACTION Heartbeat
```

### PUBLISH TOPIC uses WITH, never MESSAGE
```
WRONG:  PUBLISH TOPIC "t" MESSAGE "hello"
RIGHT:  PUBLISH TOPIC "t" WITH "hello"

WRONG:  KEEP TOPIC "t" MESSAGE "value"
RIGHT:  KEEP TOPIC "t" WITH "value"
```

The separator between topic and payload is always WITH (or TO or AS — all equivalent).
MESSAGE is a different keyword used elsewhere. Never use it with PUBLISH/KEEP TOPIC.

### SET uses quoted variable names and WITH
```
AVOID:  SET performance TO ({a} / {b}) * 100
RIGHT:  SET "performance" WITH ({a} / {b}) * 100

AVOID:  SET machineId TO TOPIC POSITION 3
RIGHT:  SET "machineId" WITH TOPIC POSITION 3
```

Always write variable names in SET double-quoted, with WITH between the name and value.
The parser also accepts an unquoted name and TO (WITH, TO, AS and IN are the same token),
but the quoted WITH form is the canonical one — use it everywhere.

### One DEFINE ACTION per broker.add_action call

broker.add_action accepts exactly ONE DEFINE ACTION block per call. To deploy
multiple actions, make multiple calls - one per action - and check each call's
result before the next (a parse or compile failure comes back as success=false
with the errors) so a syntax failure in action 2 does not hide a problem in
action 1. Errors raised while an action runs are reported by broker.diagnose
(its action_errors field). To deploy several actions atomically, use
broker.deploy_lot instead.

WRONG - three DEFINE ACTION blocks bundled into a single call:
```
broker.add_action(argument="
DEFINE ACTION PublishTopicAEvery5Seconds
ON EVERY 5 SECONDS DO
    PUBLISH TOPIC \"topica\" WITH \"tick\"

DEFINE ACTION ForwardTopicAToTopicB
ON TOPIC \"topica\" DO
    PUBLISH TOPIC \"topicb\" WITH PAYLOAD

DEFINE ACTION CountTopicBEvents
ON TOPIC \"topicb\" DO
    SET \"currentCount\" WITH GET TOPIC \"state/topicb/count\" AS INT
    KEEP TOPIC \"state/topicb/count\" WITH {currentCount} + 1
    PUBLISH TOPIC \"state/topicb/count/updated\" WITH {currentCount} + 1
")
```

RIGHT - one broker.add_action call per action, each result checked before the next:
```
broker.add_action(argument="DEFINE ACTION PublishTopicAEvery5Seconds\nON EVERY 5 SECONDS DO\n    PUBLISH TOPIC \"topica\" WITH \"tick\"")
# check the result: success=false carries the parse/compile errors

broker.add_action(argument="DEFINE ACTION ForwardTopicAToTopicB\nON TOPIC \"topica\" DO\n    PUBLISH TOPIC \"topicb\" WITH PAYLOAD")
# check the result: success=false carries the parse/compile errors

broker.add_action(argument="DEFINE ACTION CountTopicBEvents\nON TOPIC \"topicb\" DO\n    SET \"currentCount\" WITH GET TOPIC \"state/topicb/count\" AS INT\n    KEEP TOPIC \"state/topicb/count\" WITH {currentCount} + 1\n    PUBLISH TOPIC \"state/topicb/count/updated\" WITH {currentCount} + 1")
# check the result: success=false carries the parse/compile errors
```

If the user asks for N related actions, that is N separate broker.add_action
calls - never one combined call, regardless of how tightly coupled the actions
are.

---

## Basic Structure

```
DEFINE ACTION <name>
<trigger> DO
    <statements>
```

Action names are plain identifiers — no quotes, no spaces.
**The trigger line sits at column 0 (same as `DEFINE`). The body is indented 4 spaces under the trigger.**
Do NOT indent the trigger line under `DEFINE ACTION` — that produces an unexpected INDENT token before the trigger and the parser rejects it.

## Trigger Types

### ON EVERY — Interval Timer

Runs the action body repeatedly at a fixed interval.

```
DEFINE ACTION Heartbeat
ON EVERY 10 SECONDS DO
    PUBLISH TOPIC "system/heartbeat" WITH TIMESTAMP "ISO"
```

All valid time units:
```
ON EVERY 500 MILLISECONDS DO    -- sub-second polling
ON EVERY 5 SECONDS DO           -- fast cyclic (sensors, watchdog)
ON EVERY 1 MINUTES DO           -- moderate polling
ON EVERY 2 HOURS DO             -- periodic aggregation
ON EVERY 1 DAYS DO              -- daily tasks
ON EVERY 1 WEEKS DO             -- weekly tasks
ON EVERY 1 MONTHS DO            -- also YEARS; singular forms (SECOND, MINUTE…) and MS work too
```
The unit is not checked when the action is deployed: a misspelled unit (`5 SECS`) deploys
cleanly and fails only when scheduled ("Unsupported time unit" in the broker log).

### ON EVERY \<DAY> AT — Scheduled (Day-of-Week + Time)

Runs once at a specific time on the specified day(s). Time is in 24-hour format "HH:mm:ss".

```
-- Specific weekdays:
DEFINE ACTION MondayMeeting
ON EVERY MONDAY AT "09:00:00" DO
    PUBLISH TOPIC "calendar/reminder" WITH "Weekly meeting in 30 minutes"

-- All weekdays (Monday–Friday):
DEFINE ACTION DailyShiftStart
ON EVERY WEEKDAY AT "06:00:00" DO
    PUBLISH TOPIC "shift/status" WITH "active"
    KEEP TOPIC "state/shift" WITH "day"

-- Weekend only (Saturday + Sunday):
DEFINE ACTION WeekendMode
ON EVERY WEEKEND AT "08:00:00" DO
    KEEP TOPIC "state/mode" WITH "weekend"

-- Every day of the week independently:
DEFINE ACTION SaturdayBackup
ON EVERY SATURDAY AT "02:00:00" DO
    PUBLISH TOPIC "backup/trigger" WITH "start"
```

Valid day keywords: MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY, WEEKDAY, WEEKEND

Full day-of-week example set:
```
ON EVERY MONDAY AT "07:00:00" DO
ON EVERY TUESDAY AT "07:00:00" DO
ON EVERY WEDNESDAY AT "07:00:00" DO
ON EVERY THURSDAY AT "07:00:00" DO
ON EVERY FRIDAY AT "07:00:00" DO
ON EVERY SATURDAY AT "10:00:00" DO
ON EVERY SUNDAY AT "10:00:00" DO
ON EVERY WEEKDAY AT "07:00:00" DO   -- Mon-Fri only
ON EVERY WEEKEND AT "10:00:00" DO   -- Sat-Sun only
```

### ON TOPIC (MQTT-triggered)
```
DEFINE ACTION ProcessSensor
ON TOPIC "sensors/+/data" DO
    SET "deviceId" WITH TOPIC POSITION 2
    SET "temp" WITH PAYLOAD AS DOUBLE
    IF {temp} > 30 THEN
        PUBLISH TOPIC "alerts/" + {deviceId} WITH "High temperature: " + {temp}
```
Use `+` for single-level wildcard in topic patterns.
PAYLOAD gives the message content. TOPIC POSITION N extracts segment N (1-based).
PAYLOAD exists only in ON TOPIC and ON CHANGE actions. In ON EVERY, ON START, session triggers and
callable actions there is no message: a bare PAYLOAD fails to compile, and a typed `PAYLOAD AS DOUBLE`
compiles but never holds data. Read the last value with `GET TOPIC "…"` instead.

### ON CHANGE (MQTT-triggered only when payload bytes change)
```
DEFINE ACTION ProcessSensorOnChange
ON CHANGE "sensors/+/data" DO
    SET "temp" WITH PAYLOAD AS DOUBLE
    PUBLISH TOPIC "sensors/processed" WITH {temp}
```
Same topic patterns as ON TOPIC. Fires on first publish per topic, then only when the payload differs from the last cached value. Use ON TOPIC for every message; use ON CHANGE to skip unchanged repeats. (Not the same as Visu slider ON CHANGE DO PUBLISH — that is client UI only.)

### ON START (runs once at broker startup)
```
DEFINE ACTION Init
ON START DO
    PUBLISH TOPIC "system/status" WITH "online"
```
In a cluster, ON START runs once per cluster start, on one node, at most once. A node that restarts, or a definition deployed later, does not run it again.

### ON CONNECT / ON DISCONNECT / ON SUBSCRIBE (client session events)
```
DEFINE ACTION AuditConnect
ON CONNECT DO
    PUBLISH TOPIC "audit/connect/" + CLIENTID WITH USER + "@" + ENDPOINT
    KEEP TOPIC "sessions/" + CLIENTID + "/clean" WITH CLEANSESSION

DEFINE ACTION AuditDisconnect
ON DISCONNECT DO
    PUBLISH TOPIC "audit/disconnect/" + CLIENTID WITH DISCONNECTREASON

DEFINE ACTION AuditSensorSubscriptions
ON SUBSCRIBE "sensors/#" DO
    PUBLISH TOPIC "audit/subscriptions" WITH CLIENTID + " -> " + SUBSCRIBETOPIC + " qos=" + SUBSCRIBEQOS
```
ON CONNECT runs after the broker accepts a client's CONNECT; ON DISCONNECT when the client goes away
(clean, unclean or session takeover); ON SUBSCRIBE after the subscribe permission check allows a
subscription. `ON SUBSCRIBE "pattern"` fires when the subscribed topic filter matches the pattern
(`+`/`#` allowed); bare `ON SUBSCRIBE DO` fires for every allowed subscription.

Session keywords (no braces — they are keywords, not variables):

| Keyword | Value |
|---------|-------|
| CLIENTID | The client that connected, disconnected or subscribed |
| USER | That client's username (`USER IN GROUP "g"` / `USER IS "name"` work too) |
| ENDPOINT | Client address (`ip:port`) |
| CLEANSESSION | `"true"` / `"false"` from the CONNECT packet |
| DISCONNECTREASON | ON DISCONNECT only, e.g. `Clean (NormalDisconnection)`, `NotClean`, `Takeover` |
| SUBSCRIBETOPIC | ON SUBSCRIBE only: the topic filter the client subscribed to |
| SUBSCRIBEQOS | ON SUBSCRIBE only: the granted QoS (0, 1, 2); -1 elsewhere |

These actions have no triggering message: PAYLOAD fails to compile in them and TOPIC POSITION is
empty. The broker
only runs the session hooks while at least one action uses them, so there is no cost when unused.

### Callable actions (INPUT / RETURN / OUTPUT)

Callable actions have no MQTT trigger. Use INPUT lines, DO body, then RETURN with one OUTPUT per line (one variable each). Comma-separated RETURN OUTPUT and single-line RETURN OUTPUT result are rejected.

```
DEFINE ACTION CalcAverage
INPUT value1 AS DOUBLE
INPUT value2 AS DOUBLE
DO
    SET "avg" WITH ({value1} + {value2}) / 2
RETURN
    OUTPUT avg
```

Multiple outputs (one OUTPUT per line):
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

The number of RETURN variables at the CALL site must match the number of OUTPUTs declared
by the called action — otherwise the upload fails with a clear validation error.

## Variable Operations

### SET — assign a value
```
SET "myVar" WITH "hello"
SET "temp" WITH GET TOPIC "sensor/temp" AS DOUBLE
SET "data" WITH GET JSON "readings.temperature" IN PAYLOAD AS DOUBLE
SET "host" WITH GET ENV "DB_HOST"
SET "pass" WITH GET SECRET "DB_PASSWORD"
```

### GET TOPIC — read an MQTT topic's current value
```
SET "value" WITH GET TOPIC "sensors/temperature" AS DOUBLE
```
Type casting with AS: INT, DOUBLE (or FLOAT), BOOL, STRING, TIMESTAMP, OBJECT, ARRAY.
`GET TOPIC … AS ARRAY` in a SET currently fails to compile; read it AS STRING and parse it.

Lookup order (same in actions and rules):
1. In-flight KEEP/PUBLISH this action has not flushed yet
2. The payload that triggered this action (when reading that topic)
3. Live cache — latest KEEP or PUBLISH. PUBLISH replaces KEEP
4. MQTT retain — fallback after restart, before the cache is warm again

Use KEEP for state another action (or a rule) will GET TOPIC without notifying subscribers. Use TOPIC EXISTS in rules when the grant must be an MQTT retained message.

In a cluster, a KEEP is copied to every node and saved to disk, so GET TOPIC on any node returns it. The last write by timestamp wins, so a counter updated from two nodes can lose an update: keep one writer per topic.

### GET JSON — extract from JSON payload
```
SET "temp" WITH GET JSON "data.temperature" IN PAYLOAD AS DOUBLE
SET "name" WITH GET JSON "device.name" IN {myJson}
SET "ok" WITH (GET JSON "success" IN {result} AS BOOL)
```
Source must be a JSON string (PAYLOAD, a variable, or CALL PYTHON RETURN AS). Missing keys
and JSON null become "null"; AS BOOL / AS INT / AS DOUBLE safe-parse to false / 0 / 0.0
instead of throwing. AS STRING yields the text null.

### GET MODEL — fetch model data from a database route
```
SET "data" WITH GET MODEL "SensorData" FROM "MyDB" WHERE id EQUALS "sensor1"
PUBLISH TOPIC "sensors/result" WITH GET MODEL "SensorData" FROM "MyDB"
```
The query runs synchronously inside the action; with no matching row the result is an empty object.

## Topic Operations

### PUBLISH vs KEEP — When to Use Which

Use **PUBLISH** when the message should flow to external consumers:
- Sending data to database routes (route events listen on MQTT and fire on arrival)
- Sending alerts, events, or updates to dashboards and UIs
- Triggering other systems or services
- One-time notifications

Use **KEEP** when the value is shared internal state between actions:
- Storing a counter, mode flag, or last-known value that another action needs to read
- Values that actions read back with GET TOPIC without broadcasting to subscribers

KEEP stores the value in the broker cache without MQTT delivery. A later PUBLISH of the same topic replaces it and notifies subscribers.
PUBLISH delivers to current subscribers. It is not MQTT retain (TOPIC EXISTS does not see KEEP).

```
-- Use KEEP for state between actions:
DEFINE ACTION IncrementCounter
ON TOPIC "counter/increment" DO
    SET "current" WITH GET TOPIC "state/counter" AS INT
    KEEP TOPIC "state/counter" WITH {current} + 1

-- Use PUBLISH to drive routes, UIs, other systems:
DEFINE ACTION ForwardToDatabase
ON TOPIC "sensors/+/data" DO
    SET "zone" WITH TOPIC POSITION 2
    SET "val" WITH PAYLOAD AS DOUBLE
    PUBLISH TOPIC "db/insert/readings/" + {zone} WITH {val}
```

### PUBLISH TOPIC — non-retained, fires to current subscribers
```
PUBLISH TOPIC "output/data" WITH "value: " + {temp}
PUBLISH TOPIC "events/alert" WITH TIMESTAMP "ISO"
PUBLISH TOPIC "sensors/" + {zone} + "/processed" WITH {result}
PUBLISH TOPIC "output/state" WITH {state} RETAIN       -- optional MQTT retain flag
PUBLISH TOPIC "output/cmd" WITH {cmd} WITH RETAIN QOS1 -- optional RETAIN and QOS0/QOS1/QOS2
```
LoT has no JSON object literal (`WITH { "temp": {temp} }` is rejected). Build a structured
payload with PUBLISH MODEL (below) or return a dict from CALL PYTHON. Do not hand-build
JSON with escaped quotes (`"{\"a\": 1}"`) — a `\"` in a string literal fails to compile.
RETAIN / QOS apply to PUBLISH TOPIC only, never to KEEP TOPIC.

### PAYLOAD AS BYTES — forward binary payloads unchanged
```
DEFINE ACTION ForwardCameraFrame
ON TOPIC "cameras/+/frame" DO
    SET "cam" WITH TOPIC POSITION 2
    PUBLISH TOPIC "archive/cameras/" + {cam} + "/frame" WITH PAYLOAD AS BYTES
    KEEP TOPIC "state/cameras/" + {cam} + "/last" WITH PAYLOAD AS BYTES
```
Plain PAYLOAD goes through a UTF-8 string, which corrupts images, protobuf and other binary data.
`WITH PAYLOAD AS BYTES` on PUBLISH TOPIC or KEEP TOPIC passes the bytes through bit for bit. A string
transformation after it (`PAYLOAD AS BYTES TRIM`, FILTER, REPLACE) is a parse error, and an empty
payload is not published or kept.

### KEEP TOPIC — stored without broadcast, readable by GET TOPIC from any action
```
KEEP TOPIC "state/mode" WITH "running"
KEEP TOPIC "state/lastTemp" WITH {temp}
KEEP TOPIC "device/" + {id} + "/config" WITH {config}
```

Reading a KÉEPed value from another action:
```
SET "mode" WITH GET TOPIC "state/mode" AS STRING
SET "lastTemp" WITH GET TOPIC "state/lastTemp" AS DOUBLE
```

### KEEP ENV / KEEP SECRET — persist environment variables
```
KEEP ENV "COUNTER" WITH {counter} + 1
KEEP SECRET "API_KEY" WITH "sk-abc123"
```

### DELETE ENV / DELETE SECRET
```
DELETE ENV "OLD_CONFIG"
DELETE SECRET "OLD_KEY"
```

## Control Flow

### IF / THEN / ELSE
```
IF {temp} > 30 THEN
    PUBLISH TOPIC "alert" WITH "Hot!"
ELSE
    PUBLISH TOPIC "status" WITH "Normal"
```
Operators: ==, !=, >, <, >=, <=, AND, OR, CONTAINS, MATCHES REGEX "pattern", NOT MATCHES REGEX "pattern".
Word forms also work: EQUALS / IS (==), NOT EQUALS (!=), GREATER THAN / ABOVE (>), LESS THAN / BELOW (<).
There is no prefix NOT (`IF NOT {x} ...` is rejected) and no STARTS_WITH / ENDS_WITH — use
`MATCHES REGEX "^abc"` / `MATCHES REGEX "abc$"`. Do not compare a number with TRUE/FALSE
(type mismatch at deploy).

### ELSE IF — multi-way branch (there is no SWITCH statement in actions)
```
IF {status} == "on" THEN
    PUBLISH TOPIC "led" WITH "1"
ELSE IF {status} == "off" THEN
    PUBLISH TOPIC "led" WITH "0"
ELSE
    PUBLISH TOPIC "led" WITH "unknown"
```
`ELIF` is accepted as a synonym for `ELSE IF`.

### REPEAT … UNTIL — loop (also LOOP / ITERATE)
```
SET "i" WITH 0
REPEAT
    SET "i" WITH {i} + 1
UNTIL {i} >= 3
```



## String Transformations

### FILTER (regex extraction)
```
SET "digits" WITH FILTER PAYLOAD USING REGEX "[0-9]+"
```

### REPLACE
```
SET "clean" WITH REPLACE "\n" WITH " " IN PAYLOAD
```
The source after IN is PAYLOAD, a variable, or a string. `IN RESULT` is only valid inside a chain.

### TRIM
```
SET "text" WITH PAYLOAD TRIM
```
TRIM takes no argument and trims the value before it — `TRIM PAYLOAD` is rejected.

### AND THEN (chaining)
```
SET "result" WITH FILTER PAYLOAD USING REGEX "[0-9]+" AND THEN TRIM
SET "tidy" WITH FILTER PAYLOAD USING REGEX "[a-z ]+" AND THEN REPLACE " " WITH "_" IN RESULT
```
The chain keyword is two words, `AND THEN` (`AND_THEN` is rejected). Start the chain with
FILTER or REPLACE; RESULT refers to the output of the previous step.

## Expressions

### Arithmetic: +, -, *, /, %
```
SET "result" WITH {a} + {b} * 2
```

### String concatenation
```
SET "msg" WITH "Temperature: " + {temp} + "°C"
```

### RANDOM
```
SET "id" WITH RANDOM UUID
SET "roll" WITH RANDOM INT BETWEEN 1 AND 6
SET "val" WITH RANDOM DOUBLE BETWEEN 0.0 AND 1.0
```

### TIMESTAMP
```
SET "now" WITH TIMESTAMP "ISO"        -- 2026-01-31T14:05:09.123Z
SET "utc" WITH TIMESTAMP "UTC"        -- 2026-01-31 14:05:09
SET "unix" WITH TIMESTAMP "UNIX"      -- seconds since epoch
SET "ms" WITH TIMESTAMP "UNIX-MS"     -- milliseconds since epoch
SET "day" WITH TIMESTAMP "yyyy-MM-dd" -- any other string is a .NET date format
```
All timestamps are UTC; there is no local-time format. An unrecognised string is used as a
.NET custom format, so a typo yields odd text rather than an error.

## Integration Calls

### CALL ACTION — invoke another action
```
CALL ACTION "CalcAvg" WITH value1 = {a}, value2 = {b} RETURN avg
```
Unlike CALL PYTHON, the one-line form is valid here. For long argument lists, WITH and RETURN may also go
on indented lines; several outputs are comma-separated after RETURN:
```
DEFINE ACTION CheckBoilerTemp
ON TOPIC "boiler/+/temp" DO
    SET "temp" WITH PAYLOAD AS DOUBLE
    CALL ACTION AnalyzeReading
        WITH value = {temp}, threshold = 85
        RETURN is_above, difference, percentage
    IF {is_above} == TRUE THEN
        PUBLISH TOPIC "boiler/" + TOPIC POSITION 2 + "/alarm" WITH "over by " + {difference}
```
(`AnalyzeReading` is the callable from "Callable actions" above.) The callable must be deployed first (deploy fails with "Callable action … not found").
Calling the same callable twice in one action currently fails to compile — split it.

### CALL PYTHON — invoke a Python function
```
CALL PYTHON "utils.calculate"
    WITH ({value})
    RETURN AS {result}
```
Format: "scriptName.functionName". Script must be deployed with broker.add_python first.
WITH and RETURN AS go on their own indented lines under CALL PYTHON. The one-line form
`CALL PYTHON "utils.calculate" WITH (...) RETURN AS {result}` is rejected by the parser.
The same indented layout applies to CALL MCP, CALL LLM and CALL AGENT.

### CALL MCP — invoke an MCP tool
```
CALL MCP "MyMcpRoute.search"
    WITH (query = "test")
    RETURN AS {result}
```
"RouteName.ToolName" in one string; named arguments inside parentheses. There is no TOOL keyword:
`CALL MCP "MyMcpRoute" TOOL "search"` is rejected (the string must contain exactly one dot).

To find the tool names and their parameters, read the retained topics the MCP connector publishes once
it connects: `$SYS/Coreflux/Routes/<Route>/Tools` (summary with the `tools` list) and
`$SYS/Coreflux/Routes/<Route>/Tools/<tool>` (description and `parameters`). Its `usage_example` and
`trigger_example` fields are ready to paste.

### CALL LLM — invoke an LLM route
```
CALL LLM "MyLlm.generate"
    WITH (prompt = "Summarize: " + {data})
    RETURN AS {answer}
```

### CALL AGENT — invoke an agent
```
CALL AGENT "MyAgent.execute"
    WITH (task = "Analyze data")
    RETURN AS {result}
```

### TRIGGER — trigger a route event
```
TRIGGER "MyDB" TO "sensor1" FOR "ReadSensors"
```
Order: connector name, TO the data to send, FOR the route event/mapping name. `WITH` is accepted in place of `TO`, but the data still comes before `FOR`. Writing the event name first and the data after `FOR` still parses, but sends the event name as the data to an event named after the data.

## PUBLISH MODEL — publish a model instance
```
PUBLISH MODEL SensorData TO "output/data" WITH
    temperature = {temp}
    status = "active"
```

## Python Integration

Use Python when LOT expressions aren't enough: statistics, complex string manipulation,
JSON reshaping, external library math, or multi-step data processing.

### Step 1 — Write and deploy the script (once)
Every script MUST have `# Script Name: <Name>` in the first 10 lines.
Deploy with `broker.add_python(argument=...)` — the argument is the whole script, header included;
the name is read from the header (letters, digits, `_`; must not start with a digit).
In a project (`.lotnb`), Python cells load after the actions; project loading is covered by `broker-operations`.

```python
# Script Name: SensorUtils

import json, statistics

def analyze(readings_json):
    """Return mean/min/max for a JSON array of numbers."""
    readings = json.loads(readings_json) if isinstance(readings_json, str) else readings_json
    if not readings:
        return {"success": False, "error": "empty"}
    return {
        "success": True,
        "mean":   round(statistics.mean(readings), 2),
        "min":    min(readings),
        "max":    max(readings),
        "count":  len(readings)
    }

def classify(value, low, high):
    """Return 'low', 'normal', or 'high' based on thresholds."""
    v = float(value)
    if v < float(low):   return "low"
    if v > float(high):  return "high"
    return "normal"
```

### Step 2 — Call from a LOT action
```
DEFINE ACTION AnalyzeSensorBatch
ON TOPIC "sensors/batch" DO
    SET "readings" WITH PAYLOAD
    CALL PYTHON "SensorUtils.analyze"
        WITH ({readings})
        RETURN AS {stats}
    PUBLISH TOPIC "sensors/stats" WITH {stats}

DEFINE ACTION ClassifyReading
ON TOPIC "sensors/+/temp" DO
    SET "temp" WITH PAYLOAD AS DOUBLE
    CALL PYTHON "SensorUtils.classify"
        WITH ({temp}, 15, 75)
        RETURN AS {level}
    IF {level} == "high" THEN
        PUBLISH TOPIC "alerts/temp" WITH "HIGH: " + {temp}
```

### Rules for CALL PYTHON
- Format: `CALL PYTHON "ScriptName.function_name"`, then `WITH (arg1, arg2)` and
  `RETURN AS {result}` each on its own line indented under it
- Arguments are positional — order must match the function signature
- Pass scalars or variables. An array literal argument (`WITH ([1, 2, 3])`) fails to compile;
  pass a JSON string variable and `json.loads` it in Python. PAYLOAD and untyped values
  arrive as Python `str`; use `AS DOUBLE` / `AS INT` in LoT or `float()` in Python
- RETURN AS is always a JSON string. A Python dict / list / number / bool is serialized
  automatically — do not require json.dumps(). A Python str (including json.dumps output)
  is kept as-is. None becomes null.
- Parse fields with GET JSON "key" IN {result} AS BOOL|INT|DOUBLE|STRING. Missing keys
  do not crash: typed extracts become false/0; AS STRING is the text null.
- PUBLISH … WITH {result} sends that same JSON string.
- Script must be deployed with `broker.add_python` before calling it
- If the function raises, or runs past 30 seconds, the call logs an error and the result is
  the text null — the action keeps running. Check `GET JSON "success"` instead of assuming data
- Imports: the standard library is available (`math`, `statistics`, `json`, `datetime`,
  `collections`, `re`, `csv`, `hashlib`, `base64`, …). Third-party packages must be installed
  with `broker.install_python_package` first; a script whose top-level import is missing is
  rejected by add_python ("Python import failed")

### Parsing the returned JSON in LOT
```
DEFINE ACTION ProcessStats
ON TOPIC "sensors/run" DO
    SET "raw" WITH GET TOPIC "sensors/batch/data"
    CALL PYTHON "SensorUtils.analyze"
        WITH ({raw})
        RETURN AS {stats}
    SET "ok" WITH (GET JSON "success" IN {stats} AS BOOL)
    IF {ok} EQUALS TRUE THEN
        SET "avg" WITH GET JSON "mean" IN {stats} AS DOUBLE
        SET "lo" WITH GET JSON "min"  IN {stats} AS DOUBLE
        SET "hi" WITH GET JSON "max"  IN {stats} AS DOUBLE
        PUBLISH TOPIC "sensors/summary" WITH {stats}
        IF {hi} > 90 THEN
            PUBLISH TOPIC "alerts/overtemp" WITH "Max: " + {hi}
```

### PUBLISH MODEL + Python (combined pattern)
```
DEFINE MODEL SensorAnalysis COLLAPSED
    ADD STRING "timestamp"    WITH TIMESTAMP "UTC"
    ADD STRING "zone"
    ADD DOUBLE "mean"
    ADD DOUBLE "min"
    ADD DOUBLE "max"
    ADD STRING "status"

DEFINE ACTION AnalyzeZone
ON TOPIC "zones/+/readings" DO
    SET "zone" WITH TOPIC POSITION 2
    SET "raw" WITH PAYLOAD
    CALL PYTHON "SensorUtils.analyze"
        WITH ({raw})
        RETURN AS {stats}
    SET "avg" WITH GET JSON "mean"   IN {stats} AS DOUBLE
    SET "lo" WITH GET JSON "min"    IN {stats} AS DOUBLE
    SET "hi" WITH GET JSON "max"    IN {stats} AS DOUBLE
    SET "status" WITH "normal"
    IF {hi} > 85 THEN
        SET "status" WITH "critical"
    PUBLISH MODEL SensorAnalysis TO "zones/" + {zone} + "/analysis" WITH
        zone   = {zone}
        mean   = {avg}
        min    = {lo}
        max    = {hi}
        status = {status}
```

## Complete Example — Sensor Monitor with Alerting
```
DEFINE ACTION SensorMonitor
ON TOPIC "factory/sensors/+/temperature" DO
    SET "zone" WITH TOPIC POSITION 3
    SET "temp" WITH PAYLOAD AS DOUBLE
    SET "ts" WITH TIMESTAMP "ISO"
    IF {temp} > 85 THEN
        PUBLISH TOPIC "factory/alerts/" + {zone} WITH "CRITICAL: " + {temp} + "°C at " + {ts}
        KEEP TOPIC "factory/alerts/" + {zone} + "/last" WITH {temp}
    ELSE
        IF {temp} > 70 THEN
            PUBLISH TOPIC "factory/warnings/" + {zone} WITH "WARNING: " + {temp} + "°C"
```

## Complete Example — Callable Conversion Utility
```
DEFINE ACTION CelsiusToFahrenheit
INPUT celsius AS DOUBLE
DO
    SET "fahrenheit" WITH {celsius} * 1.8 + 32
RETURN
    OUTPUT fahrenheit
```

## Common Mistakes

| WRONG | RIGHT | Why |
|-------|-------|-----|
| DEFINE ACTION "Heartbeat" | DEFINE ACTION Heartbeat | Action names are plain identifiers — no quotes |
| PUBLISH TOPIC "t" MESSAGE "v" | PUBLISH TOPIC "t" WITH "v" | MESSAGE is not valid here — use WITH |
| KEEP TOPIC "t" MESSAGE "v" | KEEP TOPIC "t" WITH "v" | Same — WITH, not MESSAGE |
| SET x TO "value" | SET "x" WITH "value" | Accepted, but quoted name + WITH is the canonical form |
| SET x "value" | SET "x" WITH "value" | SET requires WITH between name and value |
| TOPIC POSITION 0 | TOPIC POSITION 1 | 1-based; 0 deploys but yields an empty string |
| IF {x} > 5 | IF {x} > 5 THEN | IF always requires THEN |
| ON EVERY 10 SECONDS | ON EVERY 10 SECONDS DO | Trigger always requires DO |
| `DEFINE ACTION X\n    ON EVERY 1 SECONDS DO` | `DEFINE ACTION X\nON EVERY 1 SECONDS DO` | Trigger sits at column 0, NOT indented under DEFINE. Indenting the trigger creates a stray INDENT token before the trigger and the parser rejects the action. |
| temp (no braces) | {temp} | Variables always need curly braces |
| RETURN OUTPUT result | RETURN then OUTPUT result on separate lines | Single-line RETURN OUTPUT is rejected |
| RETURN OUTPUT a, b, c | RETURN then one OUTPUT per line | Comma-separated outputs are rejected |
| CALL PYTHON "S.f" WITH (x) RETURN AS {r} | WITH / RETURN AS on indented lines below | One-line CALL PYTHON/MCP/LLM/AGENT is rejected |
| SWITCH {x} / CASE | IF … ELSE IF … ELSE | SWITCH is not an action statement |
| PAYLOAD AND_THEN TRIM | PAYLOAD TRIM, or FILTER … AND THEN TRIM | Chain keyword is AND THEN (two words) |
| WITH { "k": {v} } | PUBLISH MODEL, or a dict from CALL PYTHON | No JSON object literal |
| PAYLOAD inside ON EVERY / ON START / ON CONNECT | GET TOPIC "…" AS DOUBLE | Only ON TOPIC / ON CHANGE have a message |
| CALL MCP "Route" TOOL "search" | CALL MCP "Route.search" (WITH / RETURN AS indented) | There is no TOOL keyword |
| PUBLISH … WITH PAYLOAD (binary data) | PUBLISH … WITH PAYLOAD AS BYTES | Plain PAYLOAD is decoded as UTF-8 text |

### Trigger indentation - the most common AI mistake

The trigger line (`ON EVERY ...`, `ON TOPIC ...`, `ON START`) MUST be at the
same column as `DEFINE ACTION`. Only the body is indented. Indenting the trigger
under `DEFINE ACTION` produces a stray INDENT token before the trigger and the
parser rejects the action.

```
-- WRONG: trigger indented under DEFINE (parser rejects with an unexpected INDENT)
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

The same rule applies to every trigger type - `ON TOPIC`, `ON EVERY N <UNIT>`,
`ON EVERY <DAY> AT`, `ON START`. Callable actions use INPUT lines instead of ON.
When emitting the definition as a
JSON string, this means `\nON EVERY ...\n    BODY` - never `\n    ON EVERY ...\n        BODY`.
