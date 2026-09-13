---
name: broker-observability
description: Inspect and debug a running Coreflux broker over MQTT — the $SYS/Coreflux topic map (route status, action traces and errors, projects, cluster, version, stats), how to watch live data, verify that an action or route actually produced output, and a triage playbook for "it deployed but nothing happens". Use when troubleshooting, monitoring, or asked what a $SYS topic means.
---

# Coreflux Broker Observability

The broker exposes its state as MQTT topics under `$SYS/Coreflux/…`. Reading them needs
`SubscribeSys` (root, admin, `AllowedSystemConfiguration`; `Command/Output` and
`Projects/#` also allow `AllowedUserManagement`).

Tools: `mqtt_read_retained` (snapshot of retained state), `mqtt_subscribe` (live stream for a
bounded time), `broker_overview` (routes + projects + pending + action errors in one call),
`broker_action_trace` (arm trace, run, collect).

## Topic map

| Topic | Retained | Content |
|-------|----------|---------|
| `$SYS/Coreflux/Version` | yes | Broker version / build payload |
| `$SYS/Coreflux/License/Status` | yes | Tier, expiry, connection count |
| `$SYS/Coreflux/Stats` | — | Throughput, active connections |
| `$SYS/Coreflux/Comms/Logins` | — | Client connect events |
| `$SYS/Coreflux/Comms/Sessions` | yes | Session snapshot |
| `$SYS/Coreflux/Command/Output` | — | Command envelopes (see `broker-commands`) |
| `$SYS/Coreflux/Routes/<Name>` | yes | Deployed route LoT source |
| `$SYS/Coreflux/Routes/<Name>/status` | — (~30 s + on change) | Route status JSON (below) |
| `$SYS/Coreflux/Routes/<Name>/Tools`, `…/Tools/<tool>` | yes | MCP route tool catalogue |
| `$SYS/Coreflux/Routes/<Name>/Capabilities`, `…/Metrics` | yes | LLM/agent route capabilities + usage |
| `$SYS/Coreflux/Routes/<Name>/Certificates` | yes | OPC UA / TLS cert store summary |
| `$SYS/Coreflux/Routes/<Name>/Events/<Event>` | — | Publish here to trigger a route event |
| `$SYS/Coreflux/Actions/<Name>` | yes | Deployed action LoT source |
| `$SYS/Coreflux/Actions/<Name>/Error` | yes | Last runtime error of the action |
| `$SYS/Coreflux/Actions/<Name>/Trace` | — | Per-execution trace while `-actionTrace` is armed |
| `$SYS/Coreflux/Models/<Name>`, `Rules/<Name>` | yes | Deployed model / rule source |
| `$SYS/Coreflux/Visus/<Name>`, `VoT/Panels/<Name>`, `VoT/Themes/<Name>` | yes | Panel / theme definitions |
| `$SYS/Coreflux/Projects/list` | yes | All projects JSON |
| `$SYS/Coreflux/Projects/active` | yes | Active project (`{"status":"unloaded"}` when none) |
| `$SYS/Coreflux/Projects/<Name>/status`, `…/manifest` | yes | Git status / content manifest |
| `$SYS/Coreflux/Projects/<Name>/download` | no | One-shot base64 zip after `-getProject` |
| `$SYS/Coreflux/Entities/ownership` | yes | `type:name → {project,file,cell}`; missing key = ad-hoc entity |
| `$SYS/Coreflux/Cluster/{Role,IsLeader,Leader,Term,Members,Status}` | yes | Cluster state (7 s cadence) |
| `$SYS/Coreflux/Log/Traces/<sink>/…` | — | Trace-log sinks created with `-addTraceLog` |
| `$SYS/Coreflux/Comms/PacketTrace/<clientId>/{In,Out}` | — | Raw packet trace (dispatcher-only command) |

## Route status JSON

```json
{ "name": "PLC1", "type": "MODBUS_TCP", "connection": "Connected", "health": "Green",
  "errors": { "total": 5, "consecutive": 0, "rate": 0.0 },
  "messages": { "total": 1042, "succeeded": 1037, "failed": 5 },
  "lastActivity": "…", "lastSuccess": "…", "lastError": "…",
  "uptime": "02:15:30", "connectedSince": "…", "timestamp": "…" }
```

`connection`: Disconnected | Connecting | Connected | Reconnecting. `health`: Green | Yellow
(error rate rising in the last 20 ops) | Red. `errors.consecutive > 0` with `Connected` means the
endpoint answers but rejects operations (bad query, wrong register, auth).

## Action trace JSON

```json
{ "action": "X", "traceId": "…", "trigger": { "topic": "…", "payload": "…", "clientId": "" },
  "timing": { "startUtc": "…", "endUtc": "…", "durationMs": 0 },
  "published": [ { "topic": "…", "payload": "…" } ], "result": "success", "error": null }
```

`-runAction X {"topic":"…","payload":…}` returns the same `traceId`, `status`, `published[]`
synchronously — the fastest way to check what an action would publish.

## Triage playbook

**Action deployed, no output**
1. `broker_action_trace { action, payload: {"topic": "<a matching topic>", "payload": …} }`
   — `published: []` means the logic never reached `PUBLISH` (check `IF` conditions and casts).
2. `mqtt_read_retained $SYS/Coreflux/Actions/<name>/Error` — runtime cast / null errors.
3. `broker_command -getPendingStatus` — action waiting on a model or Python script.
4. Wildcard mismatch: `ON TOPIC "a/+/b"` needs exactly one segment; `#` only at the end.
5. Timer actions cannot read `PAYLOAD`; use `GET TOPIC`.

**Route Connected but data missing**
1. OT tags publish on `<SOURCE_TOPIC>/<TagName>`; `mqtt_subscribe plc1/read/#`.
2. `errors.consecutive` in status → wrong address / data type / query.
3. `broker_command -checkRouteConnection <name>` for a fresh probe.
4. Events fire on `PUBLISH` (not `KEEP`) to `SOURCE_TOPIC`; results need `DESTINATION_TOPIC`.

**Route Disconnected / Reconnecting**
1. `mqtt_read_retained $SYS/Coreflux/Routes/<name>` — verify host/port/`GET ENV` names.
2. `broker_command -listEnv`, `-listSecrets` — the referenced names must exist.
3. For TLS/OPC UA: `$SYS/Coreflux/Routes/<name>/Certificates` → pending rejections.

**Model never publishes**
- A field must be `AS TRIGGER`; the trigger topic must receive a message; check
  `$SYS/Coreflux/Models/<name>` matches what you think is deployed.

**Permission denied everywhere**
- `broker_connection` shows the user; see `broker-security` for the flags a command needs.

**Nothing on `Command/Output` at all**
- The user lacks `CommandCall` or `SubscribeSys`; the broker may silently drop the publish.

## Watching live data safely

- `mqtt_subscribe` is bounded (`durationMs`, `maxMessages`); default 3 s / 50 messages. Widen
  only when the user asks for a longer capture; high-rate topics are truncated to
  `maxPayloadChars`.
- Prefer a concrete filter over `#` on production brokers.
- `mqtt_read_retained` returns only retained messages — ideal for state topics, useless for
  event streams.

## Publishing test data

`mqtt_publish { topic, payload, retain }` — use `retain: true` when seeding a topic that a
rule reads with `TOPIC EXISTS` or that a `GET TOPIC` should find after restart. Say what you
published; test messages on production topics can trigger real routes.
