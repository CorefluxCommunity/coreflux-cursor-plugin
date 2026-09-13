---
name: coreflux-debug-action
description: Trace a deployed Coreflux action end-to-end — arm tracing, run it with a realistic payload, read what it published and any runtime error, and propose the fix.
---

# Debug a Coreflux action

Input: action name; optionally a topic + payload that should trigger it.

1. `mqtt_read_retained $SYS/Coreflux/Actions/<name>` → the deployed source. If it differs from
   the workspace file, say so.
2. `broker_action_trace { action, payload: {"topic": "<matching topic>", "payload": <sample>} }`
   (for callable actions pass the INPUT bindings as JSON instead).
3. Read the trace: `trigger`, `published[]`, `result`, `error`. Read `retainedError`.
4. If `published` is empty: walk the body against the sample payload — casts (`AS DOUBLE`),
   `GET JSON` paths, `IF` conditions, `TOPIC POSITION` indexes (1-based), wildcard shape.
5. If the action never fires on real traffic: `mqtt_subscribe` the trigger topic to see actual
   topics/payloads, and `broker_command -getPendingStatus` for missing dependencies.
6. Propose the corrected LoT, `lot_lint` it, and (with the user's go-ahead) `lot_deploy` and
   re-run the trace to prove the fix.

Report the trace evidence, root cause, and the fix in that order.
