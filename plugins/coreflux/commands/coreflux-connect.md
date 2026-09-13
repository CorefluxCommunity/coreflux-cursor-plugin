---
name: coreflux-connect
description: Pick or add the Coreflux broker the tools talk to — list profiles (local, edge, prod…), switch with broker_use, or save a new one.
---

# Select a Coreflux broker

Argument (optional): a profile name, or `add`.

1. Run `broker_list`. Show the profiles as a table: name, URL, user, auth, source, and mark
   the active one.
2. If a profile name was given, run `broker_use <name>`. Otherwise, when more than one profile
   exists, ask which one to use; when only `localhost` exists, offer to add one.
3. Adding (`add`, or the user names a broker that does not exist): ask for name, `mqtt://` or
   `mqtts://` URL, username and password. Save with `broker_save`. Scope rules:
   - `user` (default) → `~/.coreflux/brokers.json`, fine for passwords.
   - `workspace` → `.coreflux/brokers.json` in the project. Never put a password there; use
     `passwordEnv` and tell the user which environment variable to export, or keep the
     credentials in the user scope with the same profile name.
   Pass `activate: true` when the user wants to use it right away.
4. After switching, run `broker_connection` and report: profile, URL, user, connected,
   `commandOutputSubscribed`. If the connection fails, quote the error and suggest the fix
   (credentials, TLS with `tlsInsecure`, firewall/port).
5. If the choice should stick, run `broker_use <name>` again with `persist: "workspace"` (project
   default) or `persist: "user"` (everywhere). Say where it was written.

Always state which profile subsequent deploys will go to. Ask before switching to anything
named like production when the conversation has been about development work.
