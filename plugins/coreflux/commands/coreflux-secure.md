---
name: coreflux-secure
description: Audit a Coreflux broker's access control — users, permission flags, groups, rules, default credentials, secrets hygiene — and produce concrete hardening steps without locking anyone out.
---

# Secure the broker

Use the `broker-security` skill throughout.

1. `broker_connection` — which user you are; note if it is `root`.
2. Inventory: `mqtt_read_retained $SYS/Coreflux/Rules/#` (deployed rules),
   `broker_command -listUserGroups <user>` for users the user names, `-listSecrets`, `-listEnv`
   (flag anything that looks like a secret stored as env).
3. Check the seeds: are `AllowPublishTopic` / `AllowSubscribeTopic` / `AllowConnect` still the
   only topic rules? Then every authenticated client can publish/subscribe everything.
4. Check LoT in the workspace for literal credentials (`WITH PASSWORD "`, `API_KEY "`).
5. Ask whether `root`/`coreflux` defaults were changed; never test the default password on a
   production broker without permission.
6. Propose, in order and with the exact LoT / `-command`:
   - per-device or per-group publish/subscribe rules (priority 100–999 999, allow-list style);
   - `FOR Connect` admission if devices have a client-id pattern;
   - `SubscribeSys` carve-outs for dashboard users instead of `AllowedSystemConfiguration`;
   - moving secrets from env to `-setSecret`;
   - password rotation via `-changeUserPassword` (values supplied by the user, never echoed).
7. For each rule, state which users/clients it affects and confirm `root`/admin stay allowed.
   Deploy only after explicit approval; test with a non-admin account where possible.
