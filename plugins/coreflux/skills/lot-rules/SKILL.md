---
name: lot-rules
description: "How to write LOT permission rules: ALLOW/DENY, topic patterns, user/group conditions, priority-based evaluation, and operation scopes."
---

# LOT Rules — Complete Reference

## Basic Structure

```
DEFINE RULE <name> WITH PRIORITY <number> FOR <scope> [TO TOPIC "<pattern>"]
    IF <condition> THEN
        ALLOW
    ELSE
        DENY
```

`TO TOPIC` is required for Publish, Subscribe, PublishSys and SubscribeSys, and is a parse
error on every other scope. Rule names are unquoted (`DEFINE RULE "X"` is LOT1001).

Rules control MQTT topic access. **Lower priority numbers win** — priority 100 is stronger than
priority 1000, the same way BACnet write priority and ISA-18.2 alarm priority work.

| Priority | Band |
|---|---|
| `0`–`99` | Reserved for locked system rules — rejected if you try to use it |
| `100`–`999` | Specific allow/deny rules (typical) |
| `1000`–`999999` | Coarser fallback rules |
| `1000000` | The shipped permissive catch-alls (`AllowPublishTopic` / `AllowSubscribeTopic` / `AllowConnect`) — weakest; above it is rejected |

## Operation Scopes

| Scope | Controls |
|-------|----------|
| Connect | Whether a client may connect at all (no TO TOPIC clause) |
| Subscribe | MQTT subscribe permissions |
| Publish | MQTT publish permissions |
| SubscribeSys | Access to $SYS topics |
| PublishSys | Publishing to $SYS topics |
| ActionManagementCreation | Creating/modifying actions |
| ModelManagementCreation | Creating/modifying models |
| RouteManagementCreation | Creating/modifying routes |
| RuleManagementCreation | Creating/modifying rules |
| UserManagementCreation | Creating/modifying users |
| SystemConfiguration | System-level configuration |
| CommandCall | Executing broker commands |
| ActionManagementRun | Running an action on demand |
| ActionManagementRemove / ModelManagementRemove / RouteManagementRemove / RuleManagementRemove | Removing entities |
| AgentManagementCreation / AgentManagementRemove / ThingManagementCreation / ThingManagementRemove | Agents and things |
| UserManagementUpdate / UserManagementPasswordChange / UserManagementRemove | User changes |
| LogManagementCreation / LogManagementUpdate / LogManagementRemove / LogManagementRead | Log traces |
| ShellCommand / McpTokenManagement | Shell commands, MCP tokens |

`ConnectorManagementCreation` / `ConnectorManagementRemove` are accepted aliases for the Route scopes.

**Which scopes a user rule can change.** Locked built-in rules sit at priority 10 (1 for some
`$SYS` carve-outs), and a user rule can't go below 100, so the locked rule always decides. A user
rule has effect only on: Publish, Subscribe, Connect, ModelManagementCreation,
ActionManagementRun (their built-ins sit at 1000000), and PublishSys on `$SYS` topics no
built-in covers. A user rule for SystemConfiguration, CommandCall, any `*Remove` scope,
Route/Rule/User/Action/Agent/Thing creation, or SubscribeSys is accepted but never consulted.

## Conditions

### User identity
```
IF USER IS "admin" THEN
    ALLOW
```

### User permissions
USER HAS reads a boolean flag on the user. Only three exist: `AllowedSystemConfiguration`,
`AllowedUserManagement`, `AllowedLogManagement`. Any other name is silently false; the
validator does not flag it.
```
IF USER HAS "AllowedSystemConfiguration" THEN
    ALLOW
```

### Group membership
```
IF USER IN GROUP "operators" THEN
    ALLOW
```

### Combined conditions
```
IF USER IS "admin" OR USER IS "operator" THEN
    ALLOW
ELSE
    DENY
```

### With AND
```
IF USER IN GROUP "monitoring" AND USER IS "monitor" THEN
    ALLOW
```

### Client id, endpoint (available in every scope; the main use is Connect)
```
IF CLIENTID IS "gateway-1" THEN
    ALLOW
```

### Regex matching — MATCHES REGEX
The REGEX keyword is REQUIRED. Plain MATCHES is a string equality test, not a regex.
Anchor patterns with ^ and $, or they match substrings. Negate with NOT MATCHES REGEX.
```
IF CLIENTID MATCHES REGEX "^gpay[0-9]{15}$" THEN
    ALLOW
ELSE
    DENY
```

### Retained-topic allow-lists — TOPIC EXISTS
True only when the topic holds an MQTT RETAINED message, so the answer does not depend on when the
device last published. The operand is an expression, so build the topic from CLIENTID. Write
allow-list topics with a retained MQTT publish. KEEP TOPIC stores a value for GET TOPIC without
broadcasting; PUBLISH TOPIC overwrites that value and notifies subscribers. TOPIC EXISTS does not
see KEEP. Retained state survives a broker restart only when durability is enabled (off by default).
```
IF TOPIC EXISTS "coreflux/devices/" + CLIENTID + "/allowed" THEN
    ALLOW
ELSE
    DENY
```
Bare TOPIC EXISTS ignores the payload, so a device whose flag says "false" is still admitted.
To test the value, compare it — these three are all value tests, and the first two are the same:
```
IF TOPIC EXISTS "coreflux/devices/" + CLIENTID + "/allowed" IS "true" THEN
IF GET TOPIC "coreflux/devices/" + CLIENTID + "/allowed" IS "true" THEN
IF GET TOPIC "coreflux/devices/" + CLIENTID + "/allowed" THEN
```
A bare GET TOPIC condition is true for "true"/"1"/"yes"/"on" (any case) and non-zero
numbers; a missing topic or empty payload is false. GET TOPIC lookup order (actions and
rules): in-flight, trigger payload, live cache (KEEP or PUBLISH; last write wins), then
MQTT retain as a restart fallback. Use TOPIC EXISTS when the grant must be an MQTT
retained message.

A permission check has no side effects: GET TOPIC on a topic with no stored value is simply false.
Unlike GET TOPIC in an action, it does not start tracking that topic, so a rule never waits for or
subscribes to a missing allow-list topic. Write the grant (KEEP or a retained publish) before the
client needs it.

## Topic Patterns

Use MQTT wildcards:
- `+` matches one level: `sensors/+/data` matches `sensors/temp/data`
- `#` matches any remaining levels: `sensors/#` matches `sensors/temp/data/raw`

```
DEFINE RULE SensorAccess WITH PRIORITY 200 FOR Subscribe TO TOPIC "sensors/#"
    IF USER IN GROUP "sensor-readers" THEN
        ALLOW
    ELSE
        DENY
```

## Complete Examples

### Admin-only model deployment
```
DEFINE RULE AdminOnlyModels WITH PRIORITY 100 FOR ModelManagementCreation
    IF USER IS "admin" THEN
        ALLOW
    ELSE
        DENY
```

### Restrict publishing to alerts
```
DEFINE RULE AlertPublish WITH PRIORITY 100 FOR Publish TO TOPIC "alerts/#"
    IF USER IS "admin" OR USER IS "supervisor" THEN
        ALLOW
    ELSE
        DENY
```

### Allow all users to subscribe to public topics
```
DEFINE RULE PublicRead WITH PRIORITY 500 FOR Subscribe TO TOPIC "public/#"
    IF USER IS "admin" OR USER IN GROUP "viewers" THEN
        ALLOW
    ELSE
        DENY
```

### Restrict on-demand action runs
```
DEFINE RULE ActionRunners WITH PRIORITY 100 FOR ActionManagementRun
    IF USER IS "admin" OR USER IN GROUP "operators" THEN
        ALLOW
    ELSE
        DENY
```

### Admit only provisioned IMEI devices
Devices connect with their IMEI as the client id (prefixed "gpay"), and a provisioning
system retains one topic per approved device. Both tests must pass: the right client-id
shape AND a provisioned topic for that specific device.
```
DEFINE RULE ImeiAdmission WITH PRIORITY 100 FOR Connect
    IF CLIENTID MATCHES REGEX "^gpay[0-9]{15}$" AND TOPIC EXISTS "coreflux/devices/" + CLIENTID + "/allowed" THEN
        ALLOW
    ELSE
        DENY
```

### Restrict a device to its own subtree
`TOPIC POSITION N` (1-based) reads a level of the requested topic, so position 3 of
`coreflux/devices/<id>/...` must equal the client id.
```
DEFINE RULE DeviceOwnTree WITH PRIORITY 100 FOR Subscribe TO TOPIC "coreflux/devices/#"
    IF CLIENTID MATCHES REGEX "^gpay[0-9]{15}$" AND CLIENTID IS TOPIC POSITION 3 THEN
        ALLOW
    ELSE
        DENY
```

## Priority Evaluation

Only the rules matching the operation (and topic) at the LOWEST priority number decide
(100 beats 1000). Among those, a DENY beats an ALLOW. If NO rule matches, the engine denies.
Publish/Subscribe catch-alls and AllowConnect sit at 1000000. Restrict Publish,
Subscribe, or Connect with any user-band rule (100–999999). Connect has no topic, so a
user Connect rule overlays the seed for every connection. Priorities 0–99 are reserved
and -addRule rejects them. Restore the three shipped seeds with -restoreRules (requires root
or AllowedSystemConfiguration).

## Common Mistakes
- Missing WITH PRIORITY — every rule must have a priority number
- Missing FOR <scope> — the operation scope is required
- TO TOPIC is required for Publish/Subscribe/PublishSys/SubscribeSys and rejected on every other scope
- A bare ALLOW or DENY body is valid. An IF without ELSE does the opposite when the condition
  is false (IF … THEN ALLOW denies everyone else at that priority)
- -addRule refuses a name that already exists — remove the rule first to change it
- USER HAS with a flag that does not exist (e.g. "AllowedSubscribe") is always false
- A user rule on a scope a locked rule covers (SystemConfiguration, CommandCall, SubscribeSys, …)
  is accepted but never consulted
- Lower number = stronger (priority 100 beats priority 1000). 0–99 is reserved.
- Writing MATCHES without REGEX — that is a string equality test, not a regex
- Unanchored regex — "gpay[0-9]{15}" also matches "evil-gpay123456789012345"; use ^...$
- Expecting TOPIC EXISTS to see a non-retained publish — it only sees retained messages
- Expecting bare TOPIC EXISTS to check the payload — add IS "true" (or use GET TOPIC) when
  the value matters, or a device flagged "false" is admitted
- A Connect DENY locks real clients out of the broker. Only root is exempt (anti-lockout
  backstop), so always show the rule to the user for approval before deploying it.
- A Connect rule at 100–999999 outranks AllowConnect (priority 1000000). Write a complete
  IF/THEN/ELSE policy — Connect has no topic, so the winning rule applies to every connection.
