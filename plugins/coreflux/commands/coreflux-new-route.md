---
name: coreflux-new-route
description: Create a Coreflux route (database, PLC/OT, REST, bridge, AI, MCP…) from the broker's own template, with secrets wired correctly, then deploy and check its connection.
---

# New Coreflux route

Ask only for what is missing: route type, target host/port (or endpoint), what data goes in
and out (topics), polling interval for OT routes.

1. `broker_route_template { type }` → use `fields` to know every setting, its type, regex and
   whether it should come from env (`env: true`). Start from `skeleton` (the `ADD METADATA`
   block is already removed).
2. Fill the skeleton following `lot-authoring` → `lot-routes.md`:
   - hosts/users → `GET ENV "NAME"`; passwords/keys → `GET SECRET "NAME"`;
   - OT routes: `ADD MAPPING` with `SOURCE_TOPIC` + `EVERY`, tags indented 8 spaces; values
     will appear on `<SOURCE_TOPIC>/<Tag>`;
   - DB/REST routes: `ADD EVENT` with `SOURCE_TOPIC`, `DESTINATION_TOPIC`, `QUERY`/`ENDPOINT`
     using 1-based placeholders.
3. Show the LoT, then `lot_lint`.
4. Check `-listEnv` / `-listSecrets`; list the `-setEnv NAME=value` / `-setSecret NAME=value`
   commands the user must run (do not invent values). Run `-setEnv` yourself only for
   non-secret values the user gave you.
5. `lot_deploy`, then `broker_command -checkRouteConnection <name>` and
   `mqtt_read_retained $SYS/Coreflux/Routes/<name>/status`.
6. Show how to see data: `mqtt_subscribe <SOURCE_TOPIC>/#` (OT) or publish a test message to
   the event's `SOURCE_TOPIC` and read `DESTINATION_TOPIC`.
7. Offer to save the route into the project notebook (`03-routes.lotnb` or the user's file).
