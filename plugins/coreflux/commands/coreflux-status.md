---
name: coreflux-status
description: Health snapshot of the connected Coreflux broker — routes, projects, pending entities, action errors — with a short triage.
---

# Coreflux broker status

1. Run `broker_connection`. If it fails, point to `/coreflux-connect` (pick another profile or
   save one with `broker_save`) and stop. If other profiles exist and the user named one,
   `broker_use` it first.
2. Run `broker_overview`.
3. For every route that is not `Connected`/`Green`, run
   `mqtt_read_retained $SYS/Coreflux/Routes/<name>/status` and note `errors.consecutive`,
   `lastError`.
4. Report: broker + user; routes table (name, type, connection, health); active project and
   project count; pending models/actions; action errors (action → message).
5. End with the top three things to fix, each with the tool call or `-command` that fixes it.
