---
name: coreflux-setup
description: First-run check of the Coreflux plugin — broker profile reachable, LOT Notebooks extension installed, docs MCP available — with fixes for anything missing.
---

# Coreflux plugin setup check

1. **Broker**: run `broker_list`, then `broker_connection`. If nothing but `localhost` is
   configured and it does not answer, offer `/coreflux-connect add` and stop the broker checks.
   If it connects but `commandOutputSubscribed` is false, explain that the user needs
   `CommandCall` + `SubscribeSys` (root, admin, `AllowedSystemConfiguration`).
2. **Notebook editor**: run this in the shell and check the output contains
   `coreflux.vscode-lot-notebooks`:

   ```bash
   cursor --list-extensions
   ```

   When missing, install it (the plugin also tries this automatically on session start):

   ```bash
   cursor --install-extension coreflux.vscode-lot-notebooks
   ```

   Then ask the user to run `Developer: Reload Window`. If the CLI is not on PATH, point to
   the Extensions view (search "LOT Notebooks") or
   https://github.com/CorefluxCommunity/VSCodeLotNotebook/releases.
3. **Docs**: call the `coreflux-docs` MCP search once (e.g. "DEFINE ACTION") to confirm it
   answers.
4. **Workspace**: if `.lotnb` / `.lot` files exist, run `lot_lint` on each and summarise
   findings; suggest `/coreflux-deploy` for a clean file.
5. Report a checklist (broker · extension · docs · workspace) with ✅/❌ and the one command
   that fixes each ❌.
