---
name: coreflux-deploy
description: Lint and deploy the current .lotnb/.lot file (or selected LoT) to the connected Coreflux broker in the correct order, then verify every entity.
---

# Deploy LoT to the broker

Target: the file the user has open or named (`.lotnb` / `.lot`), otherwise the LoT in the
selection or the message.

1. `lot_lint` (path or code). Fix errors in the file first; show the diff. Warnings: report,
   do not block.
2. `lotnb_deploy { path, dryRun: true }` (or `lot_deploy { code, dryRun: true }`) and show the
   plan (kind, name, command) so the user sees what will change.
3. Deploy for real with `stopOnError: true`. For each envelope: `success`, `message`,
   `errors[]` with line numbers.
4. Verify:
   - actions → `broker_action_trace` with a representative payload;
   - models → publish to a trigger topic with `mqtt_publish` and `mqtt_subscribe` the base topic;
   - routes → `mqtt_read_retained $SYS/Coreflux/Routes/<name>/status` and `-checkRouteConnection`;
   - rules → state which users/topics are now affected;
   - panels/themes → confirm `WITH STATE PUBLISHED` and the visibility.
5. Report entity → result → evidence. If anything failed, stop and propose the fix.

Routes referencing `GET ENV` / `GET SECRET` names that `-listEnv` / `-listSecrets` do not show:
list the missing names and the `-setEnv` / `-setSecret` commands (never invent values).
