---
name: lot-projects
description: Structure, author, deploy and version Coreflux projects — the .lotnb notebook JSON format (markdown / lot / python / shellscript cells), project folder layout, load order, ad-hoc vs project-owned entities, and the -addProject / -loadProject / -getProject / -project* git commands including zip64 upload. Use when creating or editing .lotnb files, scaffolding a project, or moving a project between a workspace and a broker.
---

# Coreflux Projects and LoT Notebooks

A **project** is a folder of `.lotnb` notebooks (plus optional `.lot`, `.py`, `README.md`)
that the broker loads as one unit. Entities loaded from a project are *owned* by it
(`$SYS/Coreflux/Entities/ownership`); anything deployed with a bare `-addX` is *ad-hoc* and
survives `-unloadProject`.

## `.lotnb` format

A JSON **array** of cells — no wrapper object:

```json
[
  { "kind": 1, "language": "markdown", "value": "# Line 3 monitoring\nWhat this notebook does." },
  { "kind": 2, "language": "lot", "value": "DEFINE MODEL \"Reading\" COLLAPSED WITH TOPIC \"line3/reading\"\n    ADD DOUBLE \"temp\" WITH TOPIC \"line3/plc/read/Temp\" AS TRIGGER" },
  { "kind": 2, "language": "python", "value": "# Script Name: Line3Stats\nimport statistics\n\ndef mean(values):\n    return {\"mean\": statistics.mean(values)}" },
  { "kind": 2, "language": "shellscript", "value": "mosquitto_sub -t 'line3/#' -v" }
]
```

| Property | Values |
|----------|--------|
| `kind` | `1` markdown (docs only) · `2` code |
| `language` | `markdown` · `lot` · `python` · `shellscript` |
| `value` | Raw text; escape newlines as `\n` and quotes as `\"` |

- One `lot` cell may hold several `DEFINE` blocks; the broker splits them.
- `python` cells **must** start with `# Script Name: Name` (first 10 lines; valid identifier).
- `shellscript` cells are documentation only — never executed by the broker.
- Tell the story in markdown cells: purpose, topics in/out, how to test. Notebooks are the
  project's documentation.

When writing a notebook file, build the JSON with a real serializer mentally: every LoT line
break inside `value` is `\n`, indentation stays 4 spaces, and the file must parse as JSON.
`lot_lint { path }` parses the notebook and lints every cell — run it after editing.

## Load order

models → actions → routes → rules → python → themes → panels. Within a kind, cells load in
file order, files alphabetically. Put parents before children (models with `FROM`), callable
actions before callers, and scripts before the actions that `CALL PYTHON` them (a Python cell
is still loaded after actions — the action stays *pending* until the script exists; check
`-getPendingStatus`).

## Recommended layout

```
my-project/
├── README.md                # what, why, broker prerequisites (env/secrets to set)
├── 01-models.lotnb
├── 02-actions.lotnb
├── 03-routes.lotnb          # credentials via GET ENV / GET SECRET only
├── 04-rules.lotnb
├── 05-dashboard.lotnb       # themes + panels
└── scripts/                 # optional: .py sources mirrored into python cells
```

Numbered prefixes make alphabetical order match intent. Keep secrets out of the repo: list the
`-setEnv` / `-setSecret` names in the README.

## Deploying

| Situation | Do |
|-----------|----|
| Iterate on one notebook against a dev broker | `lotnb_deploy { path, dryRun: true }` → `lotnb_deploy { path }` (ad-hoc entities) |
| Ship the whole folder | `project_upload { path, name, load: true }` (zips → `-addProject zip64:… name load`) |
| Broker can reach git | `broker_command -addProject https://github.com/org/proj.git main` then `-loadProject proj` |
| Folder or zip already on the broker host | `-addProject /path/to/folder` · `-addProject /path/file.zip [name] [load]` |
| Pull a broker project into the workspace | `project_export { name, outputPath }` → unzip |

`-addProject … load` returns the entity manifest (`entities[]`, `counts`) in the envelope;
`-loadProject` reports `errors[]` per failed entity — fix and reload.

## Project commands

| Command | Effect |
|---------|--------|
| `-listProjects` | Projects with status (`data[]`); also retained on `$SYS/Coreflux/Projects/list` |
| `-listEntities` | Loaded manifest with `origin` (`adhoc` or `project/file/cell`) |
| `-loadProject <name>` | Activate; remembered across restarts |
| `-unloadProject` | Remove project-owned entities, keep ad-hoc ones; clears the restart marker |
| `-removeProject <name>` | Delete from disk — **destructive, confirm** |
| `-duplicateProject <src> <new>` | Copy with fresh git init |
| `-getProject <name>` | Export zip on `$SYS/Coreflux/Projects/<name>/download` |
| `-projectStatus <name>` | Git status → also `$SYS/Coreflux/Projects/<name>/status` |
| `-projectManifest <name>` | File hashes + declared entities |
| `-projectCheckout <name> <ref>` · `-projectPull <name>` · `-projectPush <name>` | Git ops on the broker's clone |

Multi-word names: quote them (`-loadProject "Traceability System"`) or hyphenate.
`--project <name|url|path>` on the broker CLI loads at startup and overrides the remembered one.

## Review checklist for a project

- Every route credential is `GET ENV` / `GET SECRET`; README lists the names.
- Every action has a trigger or `INPUT`; timers do not read `PAYLOAD`.
- Models that should auto-publish have an `AS TRIGGER` field.
- Rules use priorities ≥ 100 and do not lock out `root`/admin (`broker-security`).
- Panels are `WITH STATE PUBLISHED` with an explicit visibility.
- `lot_lint { path }` is clean for each notebook; `lotnb_deploy dryRun` shows the expected plan.
