---
name: broker-security
description: Secure a Coreflux broker — RBAC with LoT DEFINE RULE (priorities, scopes, DENY-wins, locked built-ins, connection admission by client id), users, groups and permission flags (AllowedSystemConfiguration, AllowedUserManagement, AllowedLogManagement), which flag each command needs, secrets vs env, TLS/mTLS, and how not to lock yourself out. Use when a command returns Permission denied, when designing topic ACLs, or when onboarding users/devices.
---

# Coreflux Broker Security

Two mechanisms work together:

| Mechanism | Granularity | Set with |
|-----------|-------------|----------|
| **Permission flags** on a user | coarse system access | `-changeUserSettings <user> AllowedSystemConfiguration true` |
| **Groups** + **LoT rules** | per topic / per panel / per client id | `-addUserToGroup <user> <group>`, `-addRule DEFINE RULE …` |

Flags: `AllowedSystemConfiguration` (routes/models/actions/rules/env/secrets/commands),
`AllowedUserManagement` (users, groups, `Command/Output`, `Projects/#`), `AllowedLogManagement`
(trace logs). `root` bypasses everything and is always admitted (anti-lockout).

## What a command needs

| Operation | Gate |
|-----------|------|
| Any `$SYS/Coreflux/Command` publish | `CommandCall` → root, admin, `AllowedUserManagement` or `AllowedSystemConfiguration` |
| Reading `$SYS/Coreflux/Command/Output` | same set (`SubscribeSys` carve-out) |
| Other `$SYS/#` subscriptions | root, admin, `AllowedSystemConfiguration` |
| `-addRoute`/`-addModel`/`-addAction`/`-addPanel`/`-addRule` | `*ManagementCreation` → `AllowedSystemConfiguration` |
| `-removeX` | `*ManagementRemove` |
| `-runAction` | `ActionManagementRun` |
| `-setEnv`, `-setSecret`, `-restoreRules`, `-addProject` | `SystemConfiguration` |
| `-addUser` / `-removeUser` / `-changeUserPassword` / `-changeUserSettings` / groups | `UserManagement{Creation,Remove,PasswordChange,Update}` → `AllowedUserManagement` |
| Trace logs | `LogManagement*` → `AllowedLogManagement` |

`Permission denied: You are not allowed to execute -x` → grant the flag above or use a
different account. No `Command/Output` message at all → the publish was rejected
(`CommandCall`) or the client cannot subscribe (`SubscribeSys`).

## Rules

```lot
DEFINE RULE SensorAccess WITH PRIORITY 100 FOR Subscribe TO TOPIC "sensors/#"
    IF USER HAS "AllowedSubscribe" OR USER IN GROUP "operators" THEN
        ALLOW
    ELSE
        DENY
```

Evaluation:
1. Collect rules whose scope and topic match.
2. Only those with the **lowest priority number** decide.
3. Among them **DENY wins**.
4. No matching rule ⇒ **deny**.

Bands: `0–99` **reserved / locked built-ins** (`-addRule` rejects them; cannot be removed or
overridden) · `100–999 999` user rules · `1 000 000` the three shipped seeds
(`AllowPublishTopic`, `AllowSubscribeTopic`, `AllowConnect`) which make a fresh broker open to
every *authenticated* client. Restrict with any user-band rule; it outranks the seeds.

Scopes: `Connect` · `Publish` · `Subscribe` · `PublishSys` · `SubscribeSys` · `CommandCall` ·
`ShellCommand` · `SystemConfiguration` · `UserManagement{Creation,Remove,PasswordChange,Update}` ·
`RuleManagement{Creation,Remove}` · `ModelManagement{Creation,Remove}` ·
`ActionManagement{Creation,Remove,Run}` · `RouteManagement{Creation,Remove}` ·
`LogManagement{Creation,Update,Remove,Read}`.

Conditions: `USER IS "name"` · `USER HAS AllowedX` · `USER IN GROUP "g"` · `CLIENTID IS "…"` ·
`CLIENTID IS TOPIC POSITION N` · `CLIENTID MATCHES REGEX "^gw[0-9]+$"` (the `REGEX` keyword is
required; plain `MATCHES` is equality) · `ENDPOINT` · `TOPIC EXISTS <expr>` (retained message
present) · `GET TOPIC <expr> IS "true"` · `AND` / `OR` / `NOT`.

### Per-device topic isolation

```lot
DEFINE RULE DeviceOwnTopics WITH PRIORITY 200 FOR Publish TO TOPIC "devices/+/#"
    IF CLIENTID IS TOPIC POSITION 2 OR USER IS "root" THEN
        ALLOW
    ELSE
        DENY
```

### Connection admission (`FOR Connect`, no topic)

```lot
DEFINE RULE ImeiAdmission WITH PRIORITY 100 FOR Connect
    IF CLIENTID MATCHES REGEX "^gw[0-9]{15}$" AND TOPIC EXISTS "devices/" + CLIENTID + "/allowed" THEN
        ALLOW
    ELSE
        DENY
```

Maintain the allow-list with **retained** publishes (`mqtt_publish { retain: true }`), not `KEEP`.
`root` is always admitted, so a bad Connect rule is recoverable; `-restoreRules` resets the seeds.

### Protecting `$SYS`

Built-ins already deny `$SYS` to non-admins. To *widen* access (e.g. a dashboard user reading
route status) add a `SubscribeSys` rule in the user band:

```lot
DEFINE RULE OpsRouteStatus WITH PRIORITY 100 FOR SubscribeSys TO TOPIC "$SYS/Coreflux/Routes/+/status"
    IF USER IN GROUP "ops" THEN
        ALLOW
    ELSE
        DENY
```

## Users and groups

```
-addUser alice S3cure!pass
-changeUserSettings alice AllowedSystemConfiguration true
-addUserToGroup alice operators
-listUserGroups alice
-changeUserPassword alice N3wpass!
-removeUser alice            # destructive, confirm
```

Groups exist by being named; no create step. Prefer groups + rules for data access, flags only
for administration. Default credentials on a fresh broker are `root`/`coreflux` — tell the
user to change them before exposing the broker.

## Secrets vs environment

| | `-setEnv NAME=value` | `-setSecret NAME=value` |
|---|---|---|
| Storage | plain | encrypted at rest |
| Listing | values shown | names only |
| LoT | `GET ENV "NAME"`, `{env.NAME}` | `GET SECRET "NAME"`, `{secret.NAME}` |
| Use for | hosts, ports, topics, feature flags | passwords, API keys, tokens |

Never write a literal password into LoT or a notebook; `lot_lint` warns on `WITH PASSWORD "…"`.
Never echo a secret value back to the user, and do not put secret values in `-setSecret`
examples committed to a repo.

## Transport

- `mqtts://host:8883` for TLS; the plugin's `COREFLUX_MQTT_TLS_INSECURE=true` only for
  self-signed dev brokers.
- mTLS: broker validates client certificates when a CA is configured; `-routeCertificates`
  manages route-side stores (OPC UA, TLS bridges).
- Audit trail: `-auditStatus`, `-auditQuery YYYY-MM-DD`, `-decryptAudit`.

## Anti-lockout checklist

- Keep `root` credentials somewhere safe before adding `Connect` or `CommandCall` rules.
- Test a new DENY rule with a second account before applying to production.
- Prefer allow-lists on narrow topics over broad denies at low priority numbers.
- `-restoreRules` is the escape hatch for the seeds; locked built-ins cannot be broken by rules.
