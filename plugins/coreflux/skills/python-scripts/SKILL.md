---
name: python-scripts
description: "How to write and manage Python scripts: naming conventions, function structure, add/remove scripts, CALL PYTHON from LOT, available modules."
---

# Python Scripts — Complete Reference

## Script Structure

Every Python script MUST start with a `# Script Name:` comment in the first 10 lines:

```python
# Script Name: MyUtils

import json

def calculate_average(values):
    """Calculate average of a JSON array of numbers (arrives as a str)."""
    values = json.loads(values) if isinstance(values, str) else values
    if not values:
        return 0
    return sum(values) / len(values)

def format_reading(device_id, value, unit):
    """Format a sensor reading as a string."""
    return f"{device_id}: {value} {unit}"
```

## Adding a Python Script

Use `broker.add_python` with the full script code including the `# Script Name:` header
as its single argument. The name comes from that header (letters, digits and `_`, not
starting with a digit; the header match is case-insensitive). If a script with the same name
exists, it is replaced. The broker imports the script on add: a syntax error or a missing
import rejects it ("Python import failed") and nothing is registered.

## Removing a Python Script

Use `broker.remove_python` with just the script name (e.g., "MyUtils").

## Calling Python from LOT Actions

```
SET "values" WITH "[10, 20, 30]"
CALL PYTHON "MyUtils.calculate_average"
    WITH ({values})
    RETURN AS {avg}
CALL PYTHON "MyUtils.format_reading"
    WITH ("sensor1", {temp}, "°C")
    RETURN AS {formatted}
```

Format: "ScriptName.function_name" — the dot separates script from function.
WITH and RETURN AS each sit on their own line, indented under CALL PYTHON; the one-line
form is rejected. Arguments are passed in parentheses, comma-separated.
Pass strings, numbers, booleans or variables — an array literal (`WITH ([10, 20, 30])`)
fails to compile, so pass a JSON string and `json.loads` it. A variable read from PAYLOAD
without `AS DOUBLE`/`AS INT` arrives as a Python `str`.

## Available Modules

The broker does not restrict imports. The Python standard library is available, for example:
- math, statistics — numerical computation
- json — JSON parsing and formatting
- datetime — date/time operations
- collections — specialized containers (Counter, defaultdict, etc.)
- re — regular expressions
- csv, io — data parsing
- hashlib, base64 — encoding/hashing

Third-party packages (numpy, requests, …) must be installed first with
`broker.install_python_package` (pip); list them with `broker.list_python_packages`.

When the broker runs scripts in the sandboxed runner (COREFLUX_RUNNER_ENABLED), each call
runs in a fresh process: module-level state does not survive between calls, network egress
is off by default, and only single-file scripts work.

## Example: Data Processing Script

```python
# Script Name: DataProcessor

import json
import statistics

def analyze_readings(readings_json):
    """Analyze a JSON array of sensor readings."""
    readings = json.loads(readings_json) if isinstance(readings_json, str) else readings_json
    values = [r['value'] for r in readings if 'value' in r]
    if not values:
        return {'success': False, 'error': 'No values found'}
    return {
        'success': True,
        'count': len(values),
        'mean': round(statistics.mean(values), 2),
        'median': round(statistics.median(values), 2),
        'min': min(values),
        'max': max(values),
        'stdev': round(statistics.stdev(values), 2) if len(values) > 1 else 0
    }

def classify_value(value, low_threshold, high_threshold):
    """Classify a value as low, normal, or high."""
    if value < low_threshold:
        return 'low'
    elif value > high_threshold:
        return 'high'
    return 'normal'
```

### Using this script from LOT:

```
DEFINE ACTION AnalyzeSensors
ON TOPIC "sensors/analyze" DO
    SET "readings" WITH GET TOPIC "sensors/data/all"
    CALL PYTHON "DataProcessor.analyze_readings"
        WITH ({readings})
        RETURN AS {stats}
    SET "ok" WITH (GET JSON "success" IN {stats} AS BOOL)
    IF {ok} EQUALS TRUE THEN
        SET "avg" WITH GET JSON "mean" IN {stats} AS DOUBLE
        PUBLISH TOPIC "sensors/statistics" WITH {stats}
```

## Example: Alert Script

```python
# Script Name: AlertEngine

import json
from datetime import datetime

def check_thresholds(value, config_json):
    """Check if value exceeds configured thresholds."""
    config = json.loads(config_json) if isinstance(config_json, str) else config_json
    alerts = []
    for rule in config.get('rules', []):
        if rule['type'] == 'above' and value > rule['threshold']:
            alerts.append({
                'level': rule.get('level', 'warning'),
                'message': rule.get('message', f'Value {value} exceeds {rule["threshold"]}'),
                'timestamp': datetime.utcnow().isoformat()
            })
        elif rule['type'] == 'below' and value < rule['threshold']:
            alerts.append({
                'level': rule.get('level', 'warning'),
                'message': rule.get('message', f'Value {value} below {rule["threshold"]}'),
                'timestamp': datetime.utcnow().isoformat()
            })
    return alerts
```

## Common Mistakes
- Missing `# Script Name:` header — the script will fail to register
- A function that raises, or runs past 30 seconds, makes RETURN AS the text null (error in the
  broker log) and the action carries on — return a `success` flag and check it
- Script name must be in the first 10 lines of the code
- Function names must be valid Python identifiers
- Return values become a JSON string before RETURN AS: dict/list/number/bool are serialized;
  a Python str (including json.dumps output) is kept as-is; None becomes null
- Prefer returning a dict and reading fields with GET JSON — json.dumps() is optional
- Missing GET JSON keys do not crash the action (AS BOOL/INT/DOUBLE → false/0)
- When calling from LOT, use dot notation: "ScriptName.function_name"
- Arguments are positional — order matters
