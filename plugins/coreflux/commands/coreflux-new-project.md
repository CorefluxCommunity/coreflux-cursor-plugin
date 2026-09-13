---
name: coreflux-new-project
description: Scaffold a Coreflux LoT project folder with numbered .lotnb notebooks, README and a workspace broker profile, ready to deploy with project_upload.
---

# New Coreflux project

Ask for: project name (kebab-case), what it should do (devices/sources, outputs), and which
broker it targets (an existing profile from `broker_list`, or a new URL).

1. Create the layout described in the `lot-projects` skill:
   `README.md`, `01-models.lotnb`, `02-actions.lotnb`, `03-routes.lotnb`, `04-rules.lotnb`,
   `05-dashboard.lotnb` (skip files that would be empty). For the broker, write
   `.coreflux/brokers.json` with `broker_save { scope: "workspace", name, url, username,
   passwordEnv, activate: true }` — the password goes in an environment variable or in the
   user-scope profile of the same name, never in the project.
2. Each notebook starts with a markdown cell (purpose, topics in/out, how to test) followed by
   `lot` cells written with the `lot-authoring` skill. Use realistic names from the user's
   domain, never `foo`/`test`.
3. README lists: what the project does, required `-setEnv` / `-setSecret` names, how to deploy
   (`project_upload` or `-addProject`), how to verify.
4. `lot_lint { path }` on every notebook; fix until clean.
5. `lotnb_deploy { path, dryRun: true }` per notebook to show the plan. If a broker is
   configured and the user agrees, `project_upload { path, name, load: true }` and verify with
   `broker_command -listEntities`.
