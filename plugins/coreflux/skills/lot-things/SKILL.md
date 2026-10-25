---
name: lot-things
description: "How DEFINE THING works: templates and roots, WITH clauses, {{param}} placeholders, references, expanded child names, and why a Thing-owned child must be changed through its Thing."
---

# LOT Things — DEFINE THING

A Thing groups the connectors, models, agents, actions, rules and panels of one asset (a pump,
a line, a site) under one name. A **template** describes the asset once; a **root** deploys it.
The broker expands each root into ordinary `DEFINE` declarations, its **children**, and keeps
owning them.

**You cannot deploy Things from inside the broker.** `create_lot` has no `thing` target, and
`-addThing` / `-removeThing` run only from the CLI, over MQTT or through MCP. You can read them:
`read_lot` with target `thing` lists every Thing. Use this skill to explain a Thing, review one,
or draft one for a person to deploy.

## CRITICAL SYNTAX

- A clause is a standalone declaration with `DEFINE` replaced by `WITH`, indented one level
  (4 spaces) under `DEFINE THING`. Every kind keeps its full syntax.
- An action clause's trigger (`ON TOPIC … DO`), `INPUT`, `DO` and `RETURN` sit at the **same
  column as its `WITH ACTION` line**, exactly as under a standalone `DEFINE ACTION`.
- `{{name}}` is an expansion-time placeholder. Single-brace `{x}` is runtime (action variables,
  `{payload}`, `{topic.2}`) and is never substituted.
- `OF` must name a `DEFINE THING TEMPLATE`. Naming a root, an unknown Thing or a cycle is an error.
- Names match `[A-Za-z_][A-Za-z0-9_]*`: no spaces, `-` or `.`. Placeholders are not allowed in names.

## Minimal Thing

```
DEFINE THING TEMPLATE TempSensor
    WITH PARAM limit 80
    WITH MODEL Reading WITH TOPIC "{{path}}/reading"
        ADD DOUBLE "temperature" WITH TOPIC "{{path}}/temp" AS TRIGGER
        ADD STRING "ts" WITH TIMESTAMP "ISO"
    WITH ACTION Overheat
    ON TOPIC "{{path}}/temp" DO
        SET "temp" WITH PAYLOAD AS DOUBLE
        IF {temp} > {{limit}} THEN
            PUBLISH TOPIC "{{path}}/alarm" WITH "overheat " + {temp}

DEFINE THING Oven
    WITH THING inlet OF TempSensor
    WITH THING outlet OF TempSensor
        WITH PARAM limit 120
```

`TempSensor` deploys nothing. `Oven` deploys four children: models `Oven_inlet_Reading` and
`Oven_outlet_Reading` (topics `Oven/inlet/reading`, `Oven/outlet/reading`) and actions
`Oven_inlet_Overheat` (alarms above 80) and `Oven_outlet_Overheat` (alarms above 120).

## Declarations and clauses

| Line | Meaning |
|---|---|
| `DEFINE THING TEMPLATE <name>` | Template. Stored, never deployed by itself |
| `DEFINE THING <name>` | Root. Deploys its whole instance tree |
| `DEFINE THING <name> OF <template>` | Root that is one instance of a template. Only `WITH PARAM` lines follow |
| `WITH ROUTE <n> WITH TYPE <t>` / `WITH CONNECTOR …` | A connector child |
| `WITH MODEL` / `WITH ACTION` / `WITH RULE` / `WITH AGENT` / `WITH PANEL <n>` | A child of that kind |
| `WITH THING <child> OF <template>` | One more instance of a template |
| `WITH PARAM <name> [value]` | Declares a param, or passes an argument |

Children deploy connectors → models → agents → actions → rules → panels, and are removed in
reverse. Python scripts and themes are not clauses.

## Params and placeholders

| Where | `WITH PARAM ip "10.0.0.5"` | `WITH PARAM ip` |
|---|---|---|
| In a template | default | required param |
| In a plain root | its value | error |
| Under `WITH THING … OF T` or `DEFINE THING r OF T` | argument to `T` | error |

- Resolution: call-site argument, then the template default, then (for a required param only)
  the nearest enclosing instance that has a value, else an error.
- Reserved: `{{thing}}` (instance name), `{{parent}}` (parent name, empty at the root),
  `{{path}}` (topic prefix: the instance chain joined with `/`, or an explicit `path` param).
- An unresolved `{{x}}` is an error; write `\{{` for a literal `{{`.
- An argument may use the caller's placeholders: `WITH PARAM ip "{{baseIp}}.11"`. Defaults are
  literals. A value may not contain `"`, a line break or `{{`.
- `WITH PARAM peer AS AGENT` (or `ROUTE`, `CONNECTOR`, `MODEL`, `ACTION`, `PANEL`) is a
  reference param: its value names an entity and resolves to the expanded name.
- Keep secrets in `GET SECRET` / `GET ENV` inside clause bodies, never in params: params are
  published on `$SYS/Coreflux/Things/<name>/tree`.

## Names and references

- A child is named `<root>_<instance>…_<clause>`: `Oven_inlet_Overheat`. With
  `DEFINE THING north OF Station` the clauses land directly at `north_<clause>`.
- Inside a Thing, refer to a sibling clause by its local name (`CALL ACTION Normalize`,
  `USES LLM CONNECTOR Brain`, `CALL AGENT "Assistant.execute"`) and to a descendant's clause by
  a dotted path (`WITH AGENTS "p1.Assistant, p2.Assistant"`). The broker rewrites them.
- A single name that matches no sibling clause is a global name and passes through unchanged.
- A dotted reference that does not resolve rejects the Thing.
- Only these sites are rewritten: `CALL ACTION`, `CALL AGENT "<ref>.<method>"`, `CALL LLM` /
  `CALL MCP`, `PUBLISH|GET MODEL`, model `FROM`, `ADD MODEL`, `STORE IN`, `FETCH FROM`,
  `TRIGGER "<event>" TO`, agent `USES LLM ROUTE|CONNECTOR`, `WITH AGENTS`, tool `WITH TARGET`, and
  in panels `INVOKE ACTION`, `TRIGGER ROUTE`, `NAVIGATE TO PANEL`, `BIND … TO MODEL|QUERY`.
- Topic strings and payloads are never rewritten. To reach a sibling instance or go upward, use
  a reference param passed by the parent.
- An existing ad-hoc entity with the same kind and expanded name is **adopted**: the Thing takes
  it over (the plan says `adopt`). A name owned by another Thing or project is an error.
- An agent child is refused when its delegation tool name `agent__<name>__ask` would exceed 64
  characters, so keep agent instance chains short.

## Agents and panels in a Thing

```
DEFINE THING TEMPLATE SmartPump
    WITH PARAM llm AS CONNECTOR
    WITH PARAM agentUser
    WITH AGENT Assistant
        USES LLM CONNECTOR {{llm}}
        WITH DEFAULT_USER "{{agentUser}}"
        WITH INTERACTION_TOPIC "{{path}}/assistant"
        ADD TOOL "read_mqtt"
            WITH TOPICS "{{path}}/#"
    WITH ACTION DiagnoseAlarm
    ON TOPIC "{{path}}/alarm" DO
        CALL AGENT "Assistant.execute"
            WITH (task = "Pump {{thing}} alarm: " + PAYLOAD)
            RETURN AS {advice}
        PUBLISH TOPIC "{{path}}/advice" WITH {advice}
    WITH PANEL Dashboard
        WITH TITLE "Pump {{thing}}"
        WITH LAYOUT "grid" COLUMNS 2
        WITH VISIBILITY PUBLIC
        WITH STATE PUBLISHED
        ADD COMPONENT "Advice" WITH TYPE "text"
            BIND CONTENT TO TOPIC "{{path}}/advice"

DEFINE THING north
    WITH THING p1 OF SmartPump
        WITH PARAM llm "PlantLLM"
        WITH PARAM agentUser "agent-north"
```

This deploys agent `north_p1_Assistant` (`USES LLM CONNECTOR PlantLLM`, a global connector),
action `north_p1_DiagnoseAlarm` (`CALL AGENT "north_p1_Assistant.execute"`) and panel
`north_p1_Dashboard`. The LLM connector and the `DEFAULT_USER` must already exist: LoT cannot
create users. For a connector of its own, the template declares
`WITH CONNECTOR Brain WITH TYPE LLM` and writes `USES LLM CONNECTOR Brain`. An agent child keeps
its task topics at `$SYS/Coreflux/Agents/<expanded name>/…`; a Thing generates no rules for them.

## Managing Things (outside the agent)

| Command | Does |
|---|---|
| `-addThing <DEFINE THING …>` | Adds or updates every Thing in the payload as one unit; a failure rolls everything back |
| `-addThing --dryRun <…>` | Returns the plan and each child's expanded `code`; changes nothing |
| `-removeThing <name>` | Removes a root and its children, or an unused template |
| `-listThings` | Lists `name`, `kind` (`root` / `template`), `template`, `uses`, `usedBy`, `childCount`, `project` |

Editing a template redeploys every root that uses it, touching only the children whose code
changed. Each Thing is published retained on `$SYS/Coreflux/Things/<name>` (source),
`/tree` and, for roots, `/status`.

## Owned children

Children run, publish and can be called like any entity. They are read-only except through
their Thing: an add or remove of a child is refused with
`… is owned by THING Oven (instance Oven/inlet, clause Overheat); edit the Thing instead.`
Never call `create_lot` (or any add/remove tool) on a name such as `Oven_inlet_Overheat`.
Tell the user which clause to change and that the Thing must be redeployed with `-addThing`.

## Common Mistakes

- **WRONG:** `IF {temp} > {limit} THEN` for a param **RIGHT:** `IF {temp} > {{limit}} THEN`
- **WRONG:** `DEFINE THING Oven OF Sensor` where `Sensor` is a root **RIGHT:** `DEFINE THING TEMPLATE Sensor`
- **WRONG:** trigger indented under `WITH ACTION Overheat` **RIGHT:** `ON TOPIC … DO` at the column of `WITH ACTION`
- **WRONG:** `DEFINE ACTION` inside a Thing **RIGHT:** `WITH ACTION`
- **WRONG:** `WITH THING inlet-1 OF TempSensor` **RIGHT:** `WITH THING inlet1 OF TempSensor`
- **WRONG:** `create_lot` / `-addAction` on `Oven_inlet_Overheat` **RIGHT:** change the `Overheat` clause and redeploy the Thing with `-addThing`
- **WRONG:** `WITH PARAM apiKey "sk-…"` **RIGHT:** `GET SECRET "API_KEY"` in the clause body
