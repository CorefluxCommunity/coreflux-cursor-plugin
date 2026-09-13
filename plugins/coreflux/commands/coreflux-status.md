---
name: coreflux-status
description: Health snapshot of the connected Coreflux broker — routes, projects, pending entities, action errors — with a short triage.
---

# Coreflux broker status

1. Run `broker_connection`. If it fails, explain how to configure the connection (plugin
   variables `COREFLUX_MQTT_URL` / `COREFLUX_MQTT_USERNAME` / `COREFLUX_MQTT_PASSWORD`, or a
   `.broker` file in the workspace root) and stop.
2. Run `broker_overview`.
3. For every route that is not `Connected`/`Green`, run
   `mqtt_read_retained $SYS/Coreflux/Routes/<name>/status` and note `errors.consecutive`,
   `lastError`.
4. Report: broker + user; routes table (name, type, connection, health); active project and
   project count; pending models/actions; action errors (action → message).
5. End with the top three things to fix, each with the tool call or `-command` that fixes it.
