---
name: lot-panels
description: "How to write LoTV panel definitions: DEFINE PANEL, ADD COMPONENT, BIND, ON events, WITH VISIBILITY, WITH INTERACT, and the mandatory workflow for deploying panels via broker.add_panel."
---

# LoTV Panel Authoring — Coreflux Visual Language

ALWAYS call broker.load_skill("lot-panels") before broker.add_panel.

---

## Dashboard Generation Best Practices (read before writing any panel)

These rules apply to EVERY panel you generate. Follow them by default — only
deviate when the user explicitly asks for something different.

### Rule 0 — CANONICAL INDENTATION (mandatory; mixed indent breaks the parser)

Every panel-level `WITH …` line AND every top-level `ADD COMPONENT` line must
be indented EXACTLY 4 spaces under `DEFINE PANEL`. Component child lines
(`SET`, `BIND`, `ON …`, nested `ADD COMPONENT`) indent a further 4 spaces.
NEVER mix flush-left and indented `WITH` lines in the same panel. The parser
re-aligns the panel-level `WITH` lines that come before the first `ADD COMPONENT`
and returns a warning, but any other mixed indentation shifts lines to the wrong
nesting level.

```lot
// ❌ WRONG — WITH VISIBILITY at column 0 mixes indentation; the parser
//          re-aligns it and warns "had mixed panel-level WITH indentation".
DEFINE PANEL "OperationalKpiDashboard"
    WITH TITLE "Operational KPI Dashboard"
    WITH LAYOUT COLUMNS 3
    WITH STATE PUBLISHED
WITH VISIBILITY PUBLIC

    ADD COMPONENT value WITH ID MessageCountValue
        ...
```

```lot
// ✅ CORRECT — every panel-level WITH and every top-level ADD COMPONENT
//             at exactly 4 spaces under DEFINE PANEL.
DEFINE PANEL "OperationalKpiDashboard"
    WITH TITLE "Operational KPI Dashboard"
    WITH LAYOUT "grid" COLUMNS 3
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "MessageCountGauge" WITH TYPE "gauge"
        SET LABEL "Message Count"
        SET UNIT "msg"
        SET RANGE FROM 0 TO 200
        BIND VALUE TO TOPIC "kpi/operational/messageCount"
```

If a `broker.add_panel` response ever contains a warning like
`had mixed panel-level WITH indentation`, your panel is malformed. Re-emit
it with consistent 4-space indentation.

### Rule 0.5 — GRID-FIRST (mandatory; never omit `WITH LAYOUT`)

EVERY panel you emit MUST declare `WITH LAYOUT "grid" COLUMNS N` immediately
after `DEFINE PANEL` (right after `WITH TITLE`). Omitting `WITH LAYOUT` falls
back to the legacy `vertical` default, which renders every widget as a single
full-width row stacked top-to-bottom — that is BROKEN output, not a layout.

**Pick `N` (`COLUMNS`) by counting top-level `ADD COMPONENT` lines in the panel:**

| Top-level component count | `COLUMNS` value |
|---|---|
| 1                         | `COLUMNS 1` (single full-width widget — rare; usually means you should add more) |
| 2                         | `COLUMNS 2` |
| 3                         | `COLUMNS 3` |
| 4–6                       | `COLUMNS 3` |
| 7+                        | `COLUMNS 4` |
| Form-only panel (only `text-field` / `switch` / `slider` / `button`) | `COLUMNS 2` |

**Only exception:** HMI / SCADA / P&ID / control-panel screens use
`WITH LAYOUT "positioned"` (see Decision A below). Every other panel — every
dashboard, monitoring view, KPI screen, form, overview — uses `grid`.

```lot
// ❌ WRONG — no WITH LAYOUT line. Every widget renders full-width, stacked.
DEFINE PANEL "OperationalKpiDashboard"
    WITH TITLE "Operational KPI Dashboard"
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "MessageCountGauge" WITH TYPE "gauge" ...
    ADD COMPONENT "MessagesPerMinuteGauge" WITH TYPE "gauge" ...
    ADD COMPONENT "StatusIndicator" WITH TYPE "indicator" ...
    ADD COMPONENT "TrendChart" WITH TYPE "realtime-chart" ...
```

```lot
// ✅ CORRECT — 4 top-level components → COLUMNS 3 by the count rule.
DEFINE PANEL "OperationalKpiDashboard"
    WITH TITLE "Operational KPI Dashboard"
    WITH LAYOUT "grid" COLUMNS 3
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "MessageCountGauge" WITH TYPE "gauge" ...
    ADD COMPONENT "MessagesPerMinuteGauge" WITH TYPE "gauge" ...
    ADD COMPONENT "StatusIndicator" WITH TYPE "indicator" ...
    ADD COMPONENT "TrendChart" WITH TYPE "realtime-chart" ...
```

If a `broker.add_panel` response contains a warning like `has N top-level
components but no WITH LAYOUT line; defaulting to 'vertical'`, your panel is
broken. Re-emit it with `WITH LAYOUT "grid" COLUMNS N` chosen via the table
above.

**Self-check before calling `broker.add_panel`:** read your own source —
does the line immediately after `DEFINE PANEL`/`WITH TITLE` start with
`WITH LAYOUT "grid" COLUMNS` (or `WITH LAYOUT "positioned"` for an HMI)?
If not, re-emit before deploying.

### Rule 1 — VISUAL-FIRST (mandatory; never emit a panel of plain "value" widgets)

Dashboards must be GRAPHICAL. Operators read shape and colour faster than
numbers. Pick the most visual component for each data shape — `value` is a
fallback, not a default.

| Data shape                                        | REQUIRED component |
|---|---|
| Numeric scalar with a known/inferable range       | `gauge` (and add a `realtime-chart` beside it if it updates continuously) |
| Numeric scalar with unknown range                 | Ask via `agent.ask_user` for the range, THEN use `gauge`. Do NOT fall back to `value`. |
| Continuously updating scalar (live trend)         | `realtime-chart` (often paired with a `gauge` for the instantaneous reading) |
| Historical JSON array with timestamps             | `chart` + `SET COLUMNS "timestamp,..."` + `BIND DATA` |
| Boolean / discrete state (on/off, run/idle, alarm)| `indicator` (color changes by state). ALWAYS the default. Do NOT also add a `switch` unless the user explicitly asks for a toggle (see Rule 1.5). |
| Command / write action                            | ONLY when user explicitly asks for a control. `button` (one-shot, requires `ON CLICK DO PUBLISH`) or `switch` (boolean toggle, requires `ON TOGGLE DO PUBLISH ... WITH STATE`). NEVER a `value`. NEVER auto-add. |
| Setpoint or any user-editable number              | ONLY when user explicitly asks. `slider` or `text-field` with `ON CHANGE DO PUBLISH ... WITH VALUE`. |
| Status string / text counter / non-numeric label  | `text` (or `value` only if `text` is wrong) |
| GPS position, fleet locations                     | `map` with `BIND LOCATION` / `BIND MARKERS` |
| JSON array of records                             | `table` (with `SET COLUMNS`) — NEVER repeated `value` widgets |

**Hard ban:** `WITH TYPE "value"` is FORBIDDEN for any numeric scalar that
has (or can have) a sensible range. Replace it with `gauge`. Every panel you
emit MUST contain at least one `gauge`, `chart`, `realtime-chart`, `indicator`,
`map`, or `svg` widget. A panel made entirely of `value` / `text` widgets is
considered broken and must be re-emitted.

### Rule 1.5 — DO NOT AUTO-CREATE WRITE CONTROLS (mandatory)

`switch`, `slider`, `text-field`, and write-style `button` components are
INTERACTIVE WRITE CONTROLS. They send data back to the broker. Never add one
"because the topic looks writable" or "to pair with an indicator". Only emit
a write control when the user EXPLICITLY asks for it (e.g. "let me toggle X",
"add a button to start the pump", "I want to set the setpoint from the UI").

For booleans the DEFAULT is read-only `indicator`. A `switch` next to an
`indicator` is FORBIDDEN unless the user asked for the toggle. Topic paths
that look like writes (e.g. `.../write`, `.../cmd`, `.../setpoint`) are NOT a
license to auto-add a control — still wait for an explicit user request.

When (and ONLY when) you do emit a `switch`, it MUST contain an
`ON TOGGLE DO PUBLISH TOPIC "..." WITH STATE` block. A `switch` bound only
with `BIND VALUE TO TOPIC ...` (no `ON TOGGLE`) is a DEAD toggle and is
considered broken output — either remove it, or add the publish action. The
same rule applies to `button` (requires `ON CLICK DO PUBLISH`), `slider`
(requires `ON CHANGE DO PUBLISH ... WITH VALUE`), and `text-field` used as a
setpoint (requires `ON CHANGE DO PUBLISH ... WITH VALUE`).

```lot
// ❌ WRONG — auto-added next to an indicator, no publish action. Dead toggle.
ADD COMPONENT "BoolWriteIndicator" WITH TYPE "indicator"
    BIND STATE TO TOPIC "s7/simulator/io/BoolWrite"
ADD COMPONENT "BoolWriteSwitch" WITH TYPE "switch"
    SET LABEL "Write BoolWrite"
    BIND VALUE TO TOPIC "s7/simulator/io/BoolWrite/write"

// ✅ CORRECT — read-only by default; no switch unless user explicitly asked.
ADD COMPONENT "BoolWriteIndicator" WITH TYPE "indicator"
    SET LABEL "BoolWrite Input"
    BIND STATE TO TOPIC "s7/simulator/io/BoolWrite"

// ✅ CORRECT — user explicitly asked "add a toggle to write BoolWrite".
//    The switch has the mandatory ON TOGGLE DO PUBLISH ... WITH STATE block.
ADD COMPONENT "BoolWriteSwitch" WITH TYPE "switch"
    SET LABEL "Write BoolWrite"
    BIND VALUE TO TOPIC "s7/simulator/io/BoolWrite/write"
    ON TOGGLE DO
        PUBLISH TOPIC "s7/simulator/io/BoolWrite/write" WITH STATE
```

### Digital twin renderer extensions

Updated Hub renderers support `web-view` for scoped static iframe surfaces
(`SET SRC`, optional `SET ALLOWED_ORIGIN` for an exact remote HTTPS origin,
`SET HEIGHT`) and `twin-controls` for acknowledged supervisory commands
(`SET CONTRACT_TOPIC`, optional comma-separated `SET ACTIONS`). Do not treat
`frame` as an iframe: it remains a transparent layout group. On a card,
`SET LIVE_CONTRACT` and comma-separated `SET LIVE_MODELS` enable identity,
wall-clock freshness and monotonic-sequence guards in the matching Hub.
Use exact MQTT topics with explicit `WITH JSON_PATH` for collapsed JSON fields.
Do not generate static reused command envelopes or report publish receipts as
host acceptance. These extensions require a compatible Hub renderer; there is
no negotiated capability handshake yet.

### Rule 2 — TIME-SERIES FIRST

Any time-based data uses a chart (`realtime-chart` for live scalars, `chart`
for historical JSON arrays). Never render trends as a single value or gauge
alone.

### Rule 3 — Naming and labels

Give widgets descriptive PascalCase IDs (`NozzleTempGauge`, `AlarmsTable`)
and human-readable labels with units (e.g. `'Nozzle Temp (°C)'`). Never name
widgets `Comp1` or reuse topic paths as labels.

### Rule 4 — Layout order

Arrange top-to-bottom: headline gauges + indicators first, then realtime-charts,
then tables, then controls. The `COLUMNS` value itself is set by the
widget-count rule in Rule 0.5 (1–3 → COLUMNS = count, 4–6 → 3, 7+ → 4,
forms-only → 2) — never emit a panel without `WITH LAYOUT "grid" COLUMNS N`.

### Rule 5 — CANONICAL `SET` vs `WITH` vs `BIND` (mandatory; mixing them silently breaks panels)

`WITH` is **only** for the `ADD COMPONENT` header and a short list of header
clauses. Every *property* of a component goes on its own indented `SET` line.
Every *data source* goes on its own indented `BIND` line. The broker parser
now emits a warning on `$SYS/Coreflux/Command/Output` every time you get this
wrong, and `broker.add_panel` returns those warnings in its response — **read
the warnings and re-emit the panel in canonical form**.

**`WITH` is allowed only for (component header):** `TYPE`, `ID`, `COLUMN_SPAN`,
`ROW_SPAN`, `LABEL`, `STYLE`, `TEXT`, `MIN`, `MAX`, `TOPIC`, `INTERACT`,
`INTERACT_DENY`. Everything else on a component goes under an indented `SET`
line.

**Every bind needs both `TO` and a source keyword.** The canonical form is:
`BIND <TARGET> TO <SOURCE> "reference"`, where `<TARGET> ∈ VALUE / STATE /
CONTENT / COLOR / TITLE / LABEL / MAX / MIN / VISIBLE / DATA / SPEED /
LOCATION / MARKERS / TRACE` and `<SOURCE> ∈ TOPIC / MODEL / QUERY`. Any
shorthand that omits the target or the `TO` keyword is wrong — the parser
auto-corrects the common cases but **you must not emit them**.

| Anti-pattern (WRONG) | Canonical (CORRECT) |
|---|---|
| `WITH UNIT "msg"` (on component body) | `SET UNIT "msg"` (indented under component) |
| `WITH RANGE 0, 200` / `WITH RANGE 0 TO 200` | `SET RANGE FROM 0 TO 200` |
| `WITH RANGE "0,200"` / `WITH RANGE "0-127"` (quoted CSV/dash) | `SET RANGE FROM 0 TO 200` — the quoted form silently rendered gauges as NaN before the parser learned to split it |
| `WITH DECIMALS 2` | `SET DECIMALS 2` |
| `WITH PLACEHOLDER "…"` | `SET PLACEHOLDER "…"` |
| `WITH Y_MIN 0` / `WITH Y_MAX 100` | `SET Y_MIN 0` / `SET Y_MAX 100` |
| `WITH CHART_TYPE "line"` | `SET CHART_TYPE "line"` |
| `WITH ZOOM 6` / `WITH CENTER_LAT 35.0` / `WITH CLUSTER true` / `WITH TILE_URL "…"` | `SET ZOOM 6` / `SET CENTER_LAT 35.0` / `SET CLUSTER true` / `SET TILE_URL "…"` |
| `WITH SERIES "Message Count"` on a realtime-chart | `BIND VALUE TO TOPIC "…"` + indented `SET SERIES_LABEL "Message Count"` |
| `WITH TRACE_DEPTH 20` / `WITH LAT_FIELD "lat"` | Indented `SET TRACE_DEPTH 20` / `SET LAT_FIELD "lat"` **under the matching BIND** |
| `WITH TYPE "line"` **inside a component body** after `ADD COMPONENT "X" TYPE "realtime-chart"` | Remove the duplicate line — TYPE goes **only** on the `ADD COMPONENT` header |
| `BIND TOPIC "kpi/x"` (no target, no `TO`) | `BIND VALUE TO TOPIC "kpi/x"` |
| `BIND MODEL "M.f"` / `BIND QUERY "Route"` | `BIND VALUE TO MODEL "M.f"` / `BIND DATA TO QUERY "Route"` |
| `BIND VALUE TOPIC "kpi/x"` (missing `TO`) | `BIND VALUE TO TOPIC "kpi/x"` |
| `BIND SERIES "Label" TO TOPIC "…"` (SERIES is not a bind target) | `BIND VALUE TO TOPIC "…"` + `SET SERIES_LABEL "Label"` |
| `BIND ROWS TO TOPIC "…"` / `BIND RECORD TO TOPIC "…"` on a table | `BIND DATA TO TOPIC "…"` + `SET COLUMNS "field1,field2"` |
| `BIND VALUE TO TOPIC "…" AS LENGTH` / `AS COUNT` / `AS JSON` | Gauges cannot count JSON arrays. Bind a **scalar number** topic with `AS NUMBER`, or `WITH JSON_PATH "countField"`. Tables use `BIND DATA`. |
| `ADD COMPONENT StatusGauge OF TYPE gauge` | `ADD COMPONENT "StatusGauge" WITH TYPE "gauge"` |
| `BIND STATE TO TOPIC "MbtaAlertsFeed/status"` | Route health lives at `$SYS/Coreflux/Routes/<RouteName>/status` — then `WITH JSON_PATH "health"` or `"connection"` |
| `ON CLICK PUBLISH TOPIC "…"` (missing `DO`) | `ON CLICK DO PUBLISH TOPIC "…" WITH "{}"` |
| `BIND TEXT TO TOPIC "status"` on `value`/`text` widgets (SVG-only form) | `BIND VALUE TO TOPIC "status"` (or `BIND CONTENT` for `text` type) |
| `BIND TEXT "id" TO TOPIC "t"` outside an `svg` component | Move into `WITH TYPE "svg"` or use `BIND VALUE TO TOPIC` on gauges/values |

**Five failures from a real broken panel, with fixes:**

```lot
// WRONG — every one of these lines used to parse "successfully" and the dashboard
// rendered gauges stuck at 0.0 and charts stuck on "Waiting for data…".
ADD COMPONENT "MessageCountGauge" TYPE "gauge"
    WITH LABEL "Message Count"
    WITH RANGE 0, 200                 // only 0 reached min; 200 eaten
    WITH UNIT "msg"                 // stored as Props["UNIT"]; renderer reads "unit"
    BIND TOPIC "kpi/…"              // binding SILENTLY DROPPED

ADD COMPONENT "MessageCountTrend" TYPE "realtime-chart"
    BIND TOPIC "kpi/…"              // binding SILENTLY DROPPED
    WITH SERIES "Message Count"     // unknown prop; series never shown
    WITH TYPE "line"                // OVERWROTE realtime-chart → "line" → card placeholder

// CORRECT
ADD COMPONENT "MessageCountGauge" TYPE "gauge"
    SET LABEL "Message Count"
    SET RANGE FROM 0 TO 200
    SET UNIT "msg"
    BIND VALUE TO TOPIC "kpi/…"

ADD COMPONENT "MessageCountTrend" TYPE "realtime-chart"
    BIND VALUE TO TOPIC "kpi/…"
        SET SERIES_LABEL "Message Count"
        SET UNIT "msg"
```

**Pre-deploy self-check — run this on your source BEFORE calling `broker.add_panel`:**

1. Does every numeric gauge use `SET RANGE FROM x TO y`? (Reject **any**
   `WITH RANGE` form — including the quoted `WITH RANGE "min,max"` trap
   that historically rendered gauges as NaN because the entire "min,max"
   string was stored as `min`.)
2. Does every `BIND` line start with `BIND <TARGET> TO <SOURCE>`? (Reject
   `BIND TOPIC`, `BIND MODEL`, `BIND QUERY`, and `BIND <TARGET> <SOURCE>` —
   the `TO` keyword is mandatory.)
3. Does every numeric `BIND VALUE TO TOPIC "…"` on a gauge / chart /
   value end with `AS NUMBER` — and ONLY `AS NUMBER`? Valid coerce suffixes
   are `AS NUMBER`, `AS BOOLEAN`, and `AS STRING`. NEVER invent `AS LENGTH`,
   `AS COUNT`, `AS JSON`, or `AS ARRAY`. MQTT JSON objects/arrays are NOT
   numbers; a gauge bound to a JSON blob renders 0.0 even when the topic is
   live. If `explore_topics` / `broker__read_mqtt` shows `type=object`
   or `type=array`, either pick a sibling scalar topic (e.g. `…/metrics/alerts_active`)
   or add `WITH JSON_PATH "numericField"`. Tables: `BIND DATA` + `SET COLUMNS`.
4. Does every `ADD COMPONENT` header declare the type exactly once? (Reject
   any body-line `WITH TYPE` — the header is authoritative. Reject
   `ADD COMPONENT Name OF TYPE type` — use `ADD COMPONENT "Name" WITH TYPE "type"`.)
5. Do realtime-chart series use `BIND VALUE TO TOPIC` + indented
   `SET SERIES_LABEL`? (Reject `WITH SERIES` and `BIND SERIES`.)
6. Do units / decimals / placeholders / chart axes / map zoom-and-center
   properties use indented `SET`? (Reject them under `WITH`.)
7. After deploy, read the `broker.add_panel` response — if it includes
   warnings about non-canonical forms, rewrite the panel and redeploy. Do
   not tell the user the dashboard is live while warnings remain.
8. Does every `ON CLICK` / `ON CHANGE` / `ON TOGGLE` line include `DO` before
   the action verb? Reject `ON CLICK PUBLISH TOPIC` — the canonical form is
   `ON CLICK DO PUBLISH TOPIC`.
9. Do tables have `BIND DATA` + `SET COLUMNS` + (for JSON:API `{"data":[…]}`)
   `WITH JSON_PATH "data"`? A table without columns stays empty even when
   the topic is live.

---

## STEP 0 — Choose Layout AND Components Before Writing Any Code

Before writing a single line of LoTV, make TWO decisions in order:
  A) Which LAYOUT type?   (grid vs positioned)
  B) Which COMPONENT types?  (gauge vs svg vs table vs button…)

Picking the wrong layout or component type is the most common source of broken panels.

---

### Decision A — Which layout type?

**Use WITH LAYOUT "grid" COLUMNS N (MANDATORY for any dashboard / monitoring / form panel):**
- Dashboard-style content: cards with gauges, charts, values, tables
- Responsive content that fills available space
- Forms and data entry
- Any panel where exact pixel placement doesn't matter
- When the user says: "dashboard", "overview", "monitoring", "form"
- Pick `N` via the widget-count rule in Rule 0.5 (1–3 → `COLUMNS = count`,
  4–6 → `COLUMNS 3`, 7+ → `COLUMNS 4`, forms-only → `COLUMNS 2`).

```lot
DEFINE PANEL "ProductionDashboard"
    WITH LAYOUT "grid" COLUMNS 3
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "TempGauge" WITH TYPE "gauge" ...
    ADD COMPONENT "TrendChart" WITH TYPE "chart" ...
    ADD COMPONENT "AlertTable" WITH TYPE "table" ...
```

**Use WITH LAYOUT "positioned" (use this for HMI / SCADA / control panels):**
- When the user says: "HMI", "SCADA", "P&ID", "control panel", "process screen",
  "plant view", "operator screen", "mimic diagram"
- When exact pixel placement matters — controls must be at specific X/Y coordinates
- When controls overlay a background SVG image or plant diagram
- When components need to overlap (Z_INDEX stacking)
- When the user provides a drawing, diagram, or screenshot to replicate

```lot
DEFINE PANEL "PumpStationHMI"
    WITH TITLE "Pump Station Control"
    WITH LAYOUT "positioned"
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED
```

**RULES for positioned layout — ALL of these are mandatory:**
- EVERY component MUST have SET POSITION X n Y n
- EVERY component MUST have SET WIDTH n and SET HEIGHT n
- Without position/size, components will stack at (0,0) and overlap each other
- Ask the user for canvas size (e.g. 1280x800) or assume 1200x800 as default

---

### Decision A — Summary table

  User says...                      Layout
  ──────────────────────────────    ────────────────────────────
  "show a dashboard"               grid
  "monitoring screen"              grid
  "data table / list"              grid
  "form / data entry"              grid
  "HMI" / "SCADA"               positioned
  "control panel"                  positioned
  "P&ID" / "process diagram"     positioned
  "operator screen"                positioned
  "plant view" / "mimic"         positioned
  "I want controls on a diagram"   positioned (SVG background + components on top)
  "match this drawing/screenshot"  positioned

---

### How to build a positioned HMI — full pattern

A positioned HMI typically has:
1. A full-canvas SVG background (plant diagram, P&ID, floor plan image)
2. Positioned gauges/indicators/buttons overlaid at exact coordinates on top

```lot
DEFINE PANEL "PumpStationHMI"
    WITH TITLE "Pump Station"
    WITH LAYOUT "positioned"
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    // Background diagram — covers the full canvas
    ADD COMPONENT "Background" WITH TYPE "svg"
        SET INLINE "<svg viewBox='0 0 1200 800' xmlns='http://www.w3.org/2000/svg'>
  <!-- plant diagram shapes here -->
  <rect x='0' y='0' width='1200' height='800' fill='#0f172a'/>
  <rect x='100' y='200' width='200' height='300' rx='8' fill='#1e293b' stroke='#475569' stroke-width='2'/>
  <text x='200' y='250' text-anchor='middle' fill='#94a3b8' font-size='14'>Tank 1</text>
  <rect id='tank1-fill' x='102' y='350' width='196' height='148' fill='#3b82f6' opacity='0.6'/>
</svg>"
        SET POSITION X 0 Y 0
        SET WIDTH 1200
        SET HEIGHT 800
        SET Z_INDEX 0
        BIND CSS "--tank1-level" TO TOPIC "tank1/level" RANGE FROM 0 TO 100 OUTPUT FROM 0 TO 148 UNIT "px"
        BIND TEXT "tank1-fill" TO TOPIC "tank1/level" SUFFIX "% full" DECIMALS 0

    // Gauge overlaid at specific position on the canvas
    ADD COMPONENT "Tank1Level" WITH TYPE "gauge"
        SET LABEL "Tank 1 Level"
        SET UNIT "%"
        SET RANGE FROM 0 TO 100
        SET POSITION X 130 Y 420
        SET WIDTH 140
        SET HEIGHT 140
        SET Z_INDEX 10
        BIND VALUE TO TOPIC "tank1/level"

    // Status indicator at pump location
    ADD COMPONENT "Pump1Status" WITH TYPE "indicator"
        SET LABEL "Pump 1"
        SET POSITION X 420 Y 310
        SET WIDTH 60
        SET HEIGHT 60
        SET Z_INDEX 10
        BIND STATE TO TOPIC "pump1/state"

    // Control button at specific location
    ADD COMPONENT "Pump1Start" WITH TYPE "button"
        SET LABEL "START P1"
        SET STYLE "primary"
        SET POSITION X 410 Y 390
        SET WIDTH 80
        SET HEIGHT 36
        SET Z_INDEX 10
        ON CLICK DO
            PUBLISH TOPIC "pump1/cmd" WITH "start"

    // Live flow rate — gauge (NOT value) so the operator sees the range at a glance
    ADD COMPONENT "FlowRate" WITH TYPE "gauge"
        SET LABEL "Flow"
        SET UNIT "L/min"
        SET RANGE FROM 0 TO 200
        SET DECIMALS 1
        SET POSITION X 600 Y 200
        SET WIDTH 140
        SET HEIGHT 140
        SET Z_INDEX 10
        BIND VALUE TO TOPIC "flow/main"
```

**Before writing a positioned HMI, ask the user:**
1. What is the canvas size? (width × height in pixels, default 1200 × 800)
2. Do you have a background image/diagram? If yes, use it as the SVG background.
3. Where should each instrument/control be placed? (X, Y coordinates from top-left)
4. What MQTT topics feed each instrument?

---

### Decision B — Single panel or multi-panel navigation?

**BEFORE deciding layout, decide navigation structure.**

COUNT THE SECTIONS. If the user's panel has 3 or more distinct sections
(e.g. Overview / Process / Setpoints / Production / History), you MUST use
multi-panel navigation. A single scrolling grid is NEVER acceptable for
operator panels — it is confusing, unprofessional, and operators reject it.

**Use a SINGLE PANEL when:**
- 1 or 2 logical sections that fit in one screen without scrolling
- Simple monitoring dashboard (4–8 gauges/values)
- A form or data entry screen

**Use MULTI-PANEL NAVIGATION when:**
- 3+ distinct sections or topics (e.g. Overview, Process, Setpoints, Production)
- Operator panel / HMI with named views
- The user says "tabs", "sections", "pages", or lists named groups
- Operator panels for machines (injection molding, pump station, conveyor, etc.)

**How to build multi-panel navigation (the correct pattern):**

Deploy MULTIPLE panels — one per section — plus a navigation home panel.
Navigation between them uses ON CLICK DO NAVIGATE TO PANEL.

```lot
// ── NAV HOME — shown first, always visible at top or as main entry ──
DEFINE PANEL "INJ001Nav"
    WITH TITLE "INJ-001 Operator Panel"
    WITH LAYOUT "grid" COLUMNS 5
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED
    ADD COMPONENT "OverviewBtn" WITH TYPE "button"
        SET LABEL "Overview"
        ON CLICK DO
            NAVIGATE TO PANEL "INJ001Overview"
    ADD COMPONENT "ProcessBtn" WITH TYPE "button"
        SET LABEL "Process"
        ON CLICK DO
            NAVIGATE TO PANEL "INJ001Process"
    ADD COMPONENT "SetpointsBtn" WITH TYPE "button"
        SET LABEL "Setpoints"
        ON CLICK DO
            NAVIGATE TO PANEL "INJ001Setpoints"
    ADD COMPONENT "ProductionBtn" WITH TYPE "button"
        SET LABEL "Production"
        ON CLICK DO
            NAVIGATE TO PANEL "INJ001Production"
    ADD COMPONENT "HistoryBtn" WITH TYPE "button"
        SET LABEL "History"
        ON CLICK DO
            NAVIGATE TO PANEL "INJ001History"

// ── OVERVIEW section panel ──
DEFINE PANEL "INJ001Overview"
    WITH TITLE "INJ-001 — Overview"
    WITH LAYOUT "grid" COLUMNS 4
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED
    ADD COMPONENT "BackBtn" WITH TYPE "button"
        SET LABEL "← Back"
        ON CLICK DO
            NAVIGATE BACK
    ADD COMPONENT "MachineState" WITH TYPE "indicator"
        SET LABEL "Machine State"
        BIND STATE TO TOPIC "inj001/state"
    ADD COMPONENT "CyclePhase" WITH TYPE "text"
        SET LABEL "Current Phase"
        BIND VALUE TO TOPIC "inj001/cycle/phase"
    ADD COMPONENT "AutoMode" WITH TYPE "indicator"
        SET LABEL "Auto Mode"
        BIND STATE TO TOPIC "inj001/mode/auto"

// ── PROCESS section panel ──
DEFINE PANEL "INJ001Process"
    WITH TITLE "INJ-001 — Process"
    WITH LAYOUT "grid" COLUMNS 4
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED
    ADD COMPONENT "BackBtn" WITH TYPE "button"
        SET LABEL "← Back"
        ON CLICK DO
            NAVIGATE BACK
    ADD COMPONENT "NozzleTemp" WITH TYPE "gauge"
        SET LABEL "Nozzle Temp"
        SET UNIT "°C"
        SET RANGE FROM 0 TO 400
        BIND VALUE TO TOPIC "inj001/temp/nozzle"
    ADD COMPONENT "MoldTemp" WITH TYPE "gauge"
        SET LABEL "Mold Temp"
        SET UNIT "°C"
        SET RANGE FROM 0 TO 400
        BIND VALUE TO TOPIC "inj001/temp/mold"
    ADD COMPONENT "InjPressure" WITH TYPE "gauge"
        SET LABEL "Injection Pressure"
        SET UNIT "bar"
        SET RANGE FROM 0 TO 200
        BIND VALUE TO TOPIC "inj001/pressure/injection"

// ── SETPOINTS section panel ──
DEFINE PANEL "INJ001Setpoints"
    WITH TITLE "INJ-001 — Setpoints"
    WITH LAYOUT "grid" COLUMNS 3
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED
    ADD COMPONENT "BackBtn" WITH TYPE "button"
        SET LABEL "← Back"
        ON CLICK DO
            NAVIGATE BACK
    ADD COMPONENT "NozzleSP" WITH TYPE "text-field"
        SET LABEL "Nozzle Setpoint (°C)"
        BIND VALUE TO TOPIC "inj001/setpoint/nozzle"
        ON CHANGE DO
            PUBLISH TOPIC "inj001/setpoint/nozzle" WITH VALUE
    ADD COMPONENT "MoldSP" WITH TYPE "text-field"
        SET LABEL "Mold Setpoint (°C)"
        BIND VALUE TO TOPIC "inj001/setpoint/mold"
        ON CHANGE DO
            PUBLISH TOPIC "inj001/setpoint/mold" WITH VALUE
```

**Rules for multi-panel navigation:**
- Every section panel MUST have a "← Back" button with NAVIGATE BACK
- Use NAVIGATE TO PANEL (not links or URLs) — the Hub manages the navigation stack
- The broker auto-splits multi-panel source at DEFINE PANEL boundaries
- Deploy all panels in ONE broker.add_panel call (all source joined — broker handles splitting)
- Bake `WITH STATE PUBLISHED` into every `DEFINE PANEL` header so each section
  goes live on the first deploy. Do NOT chain `broker.update_visu_state` calls
  after `broker.add_panel` — they are unnecessary when the header already
  declares the desired state.
- The broker.add_panel response will confirm which panel names were deployed

**NEVER make a single flat grid when the user has 3+ named sections.**
"Sections" in a flat grid means operators must scroll endlessly.
Multi-panel navigation means one clean screen per topic — that IS the HMI standard.

---

### What does the user want to display?

SINGLE LIVE NUMBER (temperature, pressure, speed, count)
  → WITH TYPE "gauge"      DEFAULT — set RANGE + UNIT so the operator sees the scale.
  → WITH TYPE "indicator"  when it is a state (running/stopped/fault)
  → WITH TYPE "realtime-chart" pair with the gauge if the value updates continuously
  → WITH TYPE "value"      ONLY for non-numeric counters / status strings where "text" is wrong.
                            ❌ Banned for any numeric scalar — use "gauge" instead.
  DO NOT use SVG for this. A gauge is always better.

TREND OVER TIME (last N readings of a scalar)
  → WITH TYPE "realtime-chart"   if the topic sends one value at a time (subscribe live)
  → WITH TYPE "chart"            if the topic sends a JSON array of historical records
  DO NOT use SVG for this.

TABLE OF RECORDS (list of machines, alarms, orders, readings)
  → WITH TYPE "table"    with SET COLUMNS, SET SORTABLE, SET FILTERABLE, etc.
  DO NOT use SVG for this.

ON/OFF CONTROL (button, toggle, slider) — EXPLICIT REQUEST ONLY
  Only emit these when the user explicitly asks for a control. Never auto-add
  one beside an indicator just because the topic looks writable. See Rule 1.5.
  → WITH TYPE "button"    publishes on click — REQUIRES `ON CLICK DO PUBLISH`
  → WITH TYPE "switch"    toggle             — REQUIRES `ON TOGGLE DO PUBLISH ... WITH STATE`
  → WITH TYPE "slider"    range input        — REQUIRES `ON CHANGE DO PUBLISH ... WITH VALUE`
  A control without its publish action is a DEAD widget; do not emit it.
  DO NOT use SVG for this.

LIVE TRACKING — anything with a position (vehicles, vessels, people, drones,
  containers, animals, sensors, delivery riders, field workers, packages, robots)
  → WITH TYPE "map"   with BIND LOCATION / BIND MARKERS / BIND TRACE
  Use when the user needs to show ANY moving or positioned thing on a map.
  Single entity: BIND LOCATION TO TOPIC "thing/gps"
  All entities:  BIND MARKERS TO TOPIC "things/+" (wildcard — each topic = one marker)
  History trail: BIND TRACE TO TOPIC "thing/gps" (polyline from trace buffer)
  The pattern is always the same regardless of WHAT is being tracked.

CUSTOM INDUSTRIAL DIAGRAM (tank, pipe, HVAC schematic, machine layout)
  → WITH TYPE "svg"   using SET INLINE + BIND TEXT/CSS/ELEMENT
  ONLY use this when no built-in component can represent the visual.
  LOAD draw-svg-visu skill BEFORE writing any SVG.

### Decision tree — should I use SVG?

Ask these questions in order. Stop at the first YES that applies:

  1. Can the user's need be met by gauge, value, indicator, chart, or table?
     YES → use that component. Do NOT load draw-svg-visu.

  2. Does the user explicitly ask for a diagram, schematic, or custom graphic?
     NO  → do NOT generate SVG. Ask the user what visual they actually need.

  3. Is the shape geometrically simple (tanks, pipes, circles, rectangles, arrows)?
     NO  → do NOT generate SVG. Recommend uploading a pre-drawn SVG file.
            Tell the user: "This diagram is too complex to generate as code.
            Please upload an SVG file and I will bind live data to it."

  4. Do you have all the MQTT topic paths for the data to display?
     NO  → call explore_topics (MCP) or broker__read_mqtt (DEFINE AGENT) first.

  5. Are you confident the SVG will render correctly on the first attempt?
     NO  → do NOT generate SVG yet. Ask the user to confirm the exact shapes needed.

  ALL YES → call broker.load_skill("draw-svg-visu") and proceed.

### Quick reference — components

  User says...                          Use this
  ─────────────────────────────────     ───────────────────────────────────────
  "show temperature as a gauge"        WITH TYPE "gauge"
  "show current value of X"            WITH TYPE "gauge" (DEFAULT for numeric); "value" only for non-numeric strings
  "show if machine is running"         WITH TYPE "indicator"
  "show history/trend of readings"     WITH TYPE "chart" or "realtime-chart"
  "show a table of records"            WITH TYPE "table"
  "show a tank with fill level"        WITH TYPE "svg" — load draw-svg-visu
  "show an HVAC diagram"               WITH TYPE "svg" — load draw-svg-visu
  "show machine layout/schematic"      WITH TYPE "svg" if simple; else ask user to upload SVG
  "show assets on a map"               WITH TYPE "map" + BIND MARKERS
  "track vehicle/person/drone"         WITH TYPE "map" + BIND LOCATION + BIND TRACE
  "show fleet/group positions"         WITH TYPE "map" + BIND MARKERS + SET CLUSTER true
  "show ALL boats/trucks/people/..."   WITH TYPE "map" + BIND MARKERS TO TOPIC "prefix/+" (wildcard!)
  "where are my [things]?"             WITH TYPE "map" + BIND LOCATION or BIND MARKERS
  "show movement history/trace"        WITH TYPE "map" + BIND TRACE (polyline on map)
  "show live scrolling chart"          WITH TYPE "realtime-chart" + BIND VALUE
  "table of all [entities]"            WITH TYPE "table" + BIND DATA TO TOPIC "prefix/+" (wildcard!)
  "compare [metric] across [things]"   WITH TYPE "realtime-chart" + BIND VALUE TO TOPIC "prefix/+" (wildcard!)
  "show a button to start machine"     WITH TYPE "button" + ON CLICK DO PUBLISH (only if user explicitly asked for a control)
  "show a switch to turn on light"     WITH TYPE "switch" + ON TOGGLE DO PUBLISH ... WITH STATE (only if user explicitly asked; NEVER auto-add next to an indicator)
  "navigate between screens"           WITH TYPE "button" + ON CLICK DO NAVIGATE
  "button that asks an agent"          WITH TYPE "button" + SET AWAIT "AnswerText" (+ "text" with SET MARKDOWN true)

### Quick reference — layout and navigation

  User says...                          Structure
  ─────────────────────────────────     ───────────────────────────────────────
  "dashboard" (1 page)                single panel, grid layout
  "monitoring screen" (1 page)        single panel, grid layout
  "table / list / form" (1 page)      single panel, grid layout
  "operator panel" with sections      MULTI-PANEL — one panel per section + nav panel
  "tabs" / "pages" / "sections"   For full-screen operator views with 3+ topics, use
                                        MULTI-PANEL (one panel per section + NAVIGATE TO PANEL).
                                        For in-panel tab strips within a single dashboard, use
                                        ADD COMPONENT … TYPE "tabs" with ADD TAB "Title" lines.
  "Overview / Process / Setpoints…"   MULTI-PANEL — always when 3+ named sections
  "HMI" / "SCADA" (full screen)     positioned layout + ask for canvas size
  "P&ID" / "mimic diagram"          positioned layout + ask for canvas size
  "match this drawing"                positioned layout + ask for canvas size

  ⚠️ 3+ NAMED SECTIONS = MULTI-PANEL. Never use a flat scrolling grid.
  ⚠️ POSITIONED LAYOUT: every component must have SET POSITION X Y + SET WIDTH + SET HEIGHT

---

## Mode awareness — deploying a panel is a write

Insight mode is read-only: the broker refuses every writing tool in an
insight-mode task with `out_of_scope`, and deploying a panel is a write. Only
the read tools (reading topics, reading LoT such as the panel source) run in
Insight mode. In Insight mode, show the panel source and say what you would
deploy instead of trying.

In Agent mode, call `broker.add_panel` directly. The deploy response is the
confirmation. Do NOT respond with phrases like "the panel source is ready for
deployment" when you are in Agent mode and allowed to deploy.

---

## Mandatory Workflow

```
broker.load_skill("lot-panels")                    ← load this skill FIRST
explore_topics(filter="factory/")                  ← discover topics (MCP; DEFINE AGENT: broker__read_mqtt(topic="factory/#"))
explore_topics(filter="sensor/readings", response_format="detailed")  ← INSPECT PAYLOAD before binding
                                                     ← is it a number? JSON object? JSON array?
                                                     ← determines whether to use JSON_PATH
broker.get_panel_code(name="X")                    ← retrieve existing panel source (if updating)
broker.add_panel(definition=...)                    ← deploy directly — publishes to $Visu
                                                     ← NO broker.show_approval beforehand —
                                                       the deploy response IS the confirmation;
                                                       show_approval is also blocked in Insight mode
broker.refresh_visu()                                ← if Hub can't see panel after deploy
```

> **No approval card for panels.** Bake `WITH STATE PUBLISHED` into every
> `DEFINE PANEL` header so the panel goes live on the first deploy and you
> never need `broker.update_panel_state` (which is Agent-mode only).

> **Inspect every topic payload before binding.** JSON objects need `WITH JSON_PATH "field"`.
> JSON arrays need `WITH JSON_PATH "0.field"` for first element, or `BIND DATA` for charts/tables.
> **For maps:** if lat/lng are inside a JSON object, use `BIND LOCATION TO TOPIC` + `SET LAT_FIELD` / `SET LNG_FIELD`.
> NEVER assume sub-topics exist. NEVER invent new LoTV keywords (WITH TEXT, WITH MIN, etc.).

---

## Minimal Panel Template

```lot
DEFINE PANEL "PanelName"
    WITH TITLE "Human Readable Title"
    WITH LAYOUT "grid" COLUMNS 3
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "GaugeID" WITH TYPE "gauge"
        SET LABEL "Temperature"
        SET UNIT "°C"
        SET RANGE FROM 0 TO 150
        BIND VALUE TO TOPIC "factory/zone1/temp"
```

---

## Panel Header Options

| Keyword | Required | Example |
|---|---|---|
| `WITH TITLE "..." ` | No | `WITH TITLE "Zone 1 Dashboard"` |
| `WITH LAYOUT "grid" COLUMNS n` | No | `WITH LAYOUT "grid" COLUMNS 4` |
| `WITH VISIBILITY PUBLIC` | No | PUBLIC / SHARED / PRIVATE (default: PRIVATE) |
| `WITH SHARE TO GROUP "g"` | When SHARED | One line per group |
| `WITH SHARE TO USER "u"` | When SHARED | One line per user |
| `WITH STATE PUBLISHED` | Yes (to be visible) | DRAFT / PUBLISHED / ARCHIVED |
| `WITH THEME "light" \| "dark"` | No | Built-in Hub palette (`light` or `dark` only — not a deployed VoT theme name; use `DEFINE THEME` + `broker.add_theme` for custom design tokens) |

> NEVER combine `WITH VISIBILITY PRIVATE` with `WITH SHARE TO` — PRIVATE means no sharing.

---

## Component Types

Listed in PREFERENCE ORDER — pick from the top of the table first. `value` is
a FALLBACK and is forbidden for numeric scalars (use `gauge` instead).

| Type | Use case | Notes |
|---|---|---|
| `"gauge"` | DEFAULT for numeric scalars (temperature, pressure, level, count, KPI) | Requires `SET RANGE FROM a TO b` and `SET UNIT` |
| `"realtime-chart"` | DEFAULT for continuously updating scalars (live trend) | Uses DataPoint Store trace buffer; pair with a `gauge` |
| `"chart"` | Historical JSON arrays with timestamps | Requires `SET COLUMNS` |
| `"indicator"` | DEFAULT for booleans / discrete states (run/stop, alarm) | Color changes by state |
| `"map"` | Anything with a position (GPS, fleets, vehicles, people) | `BIND LOCATION` / `BIND MARKERS` / `BIND TRACE` |
| `"svg"` | Custom industrial diagrams (tanks, P&ID) | Load `draw-svg-visu` skill first |
| `"table"` | Tabular display for JSON arrays | Requires `SET COLUMNS`; NEVER repeat `value` widgets per row |
| `"button"` | One-shot commands (start, stop, reset) — ONLY when user explicitly asks for a control. NEVER auto-add. | MUST include `ON CLICK DO PUBLISH`; without it the button is dead |
| `"switch"` | ONLY when user explicitly asks for a write/toggle control. NEVER auto-create next to an `indicator`. (Booleans default to `indicator`.) | MUST include `ON TOGGLE DO PUBLISH TOPIC "..." WITH STATE` — without the publish block it is a dead toggle |
| `"slider"` | Numeric setpoint editor — ONLY when user explicitly asks for a control. | MUST include `ON CHANGE DO PUBLISH ... WITH VALUE` |
| `"text-field"` | Free-text or numeric setpoint entry | Publishes on change |
| `"text"` | Static or bound text strings | **Use this, NOT `"label"`** |
| `"card"` | Layout container — groups child components | — |
| `"value"` | **FALLBACK ONLY** — non-numeric counters or status strings where `text` is wrong | ❌ HARD BAN: never use for numeric scalars (use `gauge`) — every panel must contain at least one `gauge`/`chart`/`realtime-chart`/`indicator`/`map`/`svg` |

> ❌ NEVER use `WITH TYPE "label"` — there is no `label` renderer. The parser rewrites it to `"text"` and warns.  
> ✅ Use `WITH TYPE "text"` for all text display (static labels, bound strings, timestamps).

### ⚠️ Component type tokens MUST be the kebab-case lowercase strings above

The Hub renderer matches the type **case-sensitively**. PascalCase /
camelCase variants are auto-corrected by the broker (and emit a warning), but
you MUST emit the canonical form so the panel renders identically across
broker versions and so the warning channel stays clean for real bugs.

```lot
// ❌ WRONG — PascalCase. The parser rewrites it to the kebab-case form and
//    warns ("is not a canonical LoTV type token"); emit the canonical form.
ADD COMPONENT RealtimeChart "MessagesPerMinuteChart"
ADD COMPONENT Gauge         "MessageCountGauge"
ADD COMPONENT Indicator     "OperationalStatusIndicator"

// ✅ CORRECT — quoted, lowercase, kebab-case where applicable.
ADD COMPONENT "MessagesPerMinuteChart" WITH TYPE "realtime-chart"
ADD COMPONENT "MessageCountGauge"      WITH TYPE "gauge"
ADD COMPONENT "OperationalStatusIndicator" WITH TYPE "indicator"
```

Common offenders and their canonical form:

| Wrong (PascalCase / camelCase) | Correct (kebab-case lowercase) |
|---|---|
| `RealtimeChart`, `realtimeChart`, `realtime_chart` | `realtime-chart` |
| `Gauge`, `GAUGE` | `gauge` |
| `Indicator` | `indicator` |
| `TextField`, `text_field` | `text-field` |
| `NumberField`, `number_field` | `number-field` |
| `DatePicker`, `date_picker` | `date-picker` |
| `label` (any case) | `text` *(`label` has no renderer; use `text`)* |

### ADD COMPONENT — three accepted header forms

All three forms parse and assign a **stable id** to the component (required so
the Hub doesn't collapse two `gauge` widgets into one ghost card). Pick **one
style and stick with it for the whole panel** — mixing them within a panel
makes diff review harder.

```lot
// ✅ Form 1 — quoted id first, then explicit type (RECOMMENDED for new code)
ADD COMPONENT "MessageCountGauge" WITH TYPE "gauge"

// ✅ Form 2 — bare lowercase type, id given via WITH ID
ADD COMPONENT gauge WITH ID MessageCountGauge

// ✅ Form 3 — bare lowercase type, quoted positional id
ADD COMPONENT gauge "MessageCountGauge"

// ❌ WRONG — bare PascalCase type AND no id. The parser lowercases the type
//    (with a warning) and assigns an auto-id such as "gauge-1", which nothing
//    else in your source can refer to.
ADD COMPONENT Gauge

// ❌ WRONG — SQL/Pascal-flavoured `AS` form. The parser auto-corrects
//    (extracting the id from the bare token and the type from after AS,
//    then lowercasing the type) and emits warnings. NEVER emit this.
ADD COMPONENT EfficiencyGauge AS GAUGE
ADD COMPONENT MessageCountGauge AS Gauge
```

**Canonical fix for the `AS` form:** quote the id, lowercase the type, and use
`WITH TYPE`:

```lot
// ✅ CORRECT
ADD COMPONENT "EfficiencyGauge" WITH TYPE "gauge"
ADD COMPONENT "MessageCountGauge" WITH TYPE "gauge"
```

**⚠️ Component properties use SET, NOT WITH. These are non-canonical — the parser
auto-corrects some with a warning and drops others, so never emit them:**
- `WITH TEXT "..."` → use `SET LABEL "..."`  or `SET CONTENT "..."`
- `WITH TITLE "..."` on a component → use `SET LABEL "..."`  (WITH TITLE is panel-level only; on a component it is stored as an unknown prop with a warning)
- `WITH MIN 0` / `WITH MAX 100` → use `SET RANGE FROM 0 TO 100`
- `WITH UNIT "°C"` → use `SET UNIT "°C"`
- `WITH POSITION "1,2,8,6"` → use `SET POSITION X 1 Y 2` + `SET WIDTH 8` + `SET HEIGHT 6` (positioned layout). The quoted form is dropped with a warning.
- `BIND ... AND ...` → NOT VALID. Everything after the first topic is ignored. Each BIND is a separate statement.

---

## Forms and Data Entry — Correct Pattern

LoTV has **NO "form" component type** and **NO "ADD FIELD" keyword**.
Neither raises an error or a warning: `ADD FIELD` lines are dropped, and
`WITH TYPE "form"` is passed through as an unknown type the Hub has no renderer for.

The correct pattern: a `"card"` container + nested `"text-field"` / `"switch"` components + a `"button"` to submit.

```lot
// ── CORRECT form pattern ──
DEFINE PANEL "BoothLeadsPanel"
    WITH TITLE "Booth Leads"
    WITH LAYOUT "grid" COLUMNS 1
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "leadCard" WITH TYPE "card"
        SET TITLE "Visitor Lead Form"
        ADD COMPONENT "nameField" WITH TYPE "text-field"
            SET LABEL "Name"
            SET PLACEHOLDER "Enter name"
            ON CHANGE DO
                PUBLISH TOPIC "booth/leads/input/name" WITH VALUE
        ADD COMPONENT "surnameField" WITH TYPE "text-field"
            SET LABEL "Surname"
            SET PLACEHOLDER "Enter surname"
            ON CHANGE DO
                PUBLISH TOPIC "booth/leads/input/surname" WITH VALUE
        ADD COMPONENT "companyField" WITH TYPE "text-field"
            SET LABEL "Company"
            SET PLACEHOLDER "Enter company"
            ON CHANGE DO
                PUBLISH TOPIC "booth/leads/input/company" WITH VALUE
        ADD COMPONENT "emailField" WITH TYPE "text-field"
            SET LABEL "Email"
            SET PLACEHOLDER "Enter email"
            ON CHANGE DO
                PUBLISH TOPIC "booth/leads/input/email" WITH VALUE
        ADD COMPONENT "phoneField" WITH TYPE "text-field"
            SET LABEL "Phone"
            SET PLACEHOLDER "Enter phone"
            ON CHANGE DO
                PUBLISH TOPIC "booth/leads/input/phone" WITH VALUE
        ADD COMPONENT "otherInfoField" WITH TYPE "text-field"
            SET LABEL "Other Info"
            SET PLACEHOLDER "Any additional notes"
            ON CHANGE DO
                PUBLISH TOPIC "booth/leads/input/otherInfo" WITH VALUE
        ADD COMPONENT "submitBtn" WITH TYPE "button"
            SET LABEL "Submit Lead"
            SET STYLE "primary"
            ON CLICK DO
                PUBLISH TOPIC "booth/leads/form/submit" WITH 1
```

**For a setpoint field (show current value AND let user change it):**

```lot
ADD COMPONENT "TempSP" WITH TYPE "text-field"
    SET LABEL "Temperature Setpoint (°C)"
    BIND VALUE TO TOPIC "machine/setpoint/temp"   // shows current retained value
    ON CHANGE DO
        PUBLISH TOPIC "machine/setpoint/temp" WITH VALUE   // writes new value
```

**Component types for inputs:**

| Type | Use case |
|---|---|
| `"text-field"` | Any text/number input (name, email, setpoint, comment) — must include `ON CHANGE DO PUBLISH ... WITH VALUE` for setpoints |
| `"switch"` | Boolean on/off toggle — ONLY when user explicitly asks for a control; NEVER auto-add next to an indicator. MUST include `ON TOGGLE DO PUBLISH TOPIC "..." WITH STATE` (see Rule 1.5). |
| `"slider"` | Numeric range input — must include `ON CHANGE DO PUBLISH ... WITH VALUE` |
| `"button"` | Trigger, submit, or navigate — must include `ON CLICK DO PUBLISH` (or `ON CLICK DO NAVIGATE`) |

**NEVER use `"form"` as a component type — it does not exist. Use `"card"` to group fields.**

---

## Data Binding — Topic Payloads

```lot
// Simple scalar topic (value is a plain number or string)
BIND VALUE TO TOPIC "sensors/zone1/temp"
BIND STATE TO TOPIC "machines/pump/state"

// JSON OBJECT topic — extract ONE field with WITH JSON_PATH
// Topic payload example: {"temperature": 31.4, "pressure": 1.9, "machine_id": "m1"}
BIND VALUE TO TOPIC "plant/machine1/readings" WITH JSON_PATH "temperature"
BIND VALUE TO TOPIC "plant/machine1/readings" WITH JSON_PATH "pressure"
BIND CONTENT TO TOPIC "plant/machine1/readings" WITH JSON_PATH "machine_id"

// JSON ARRAY topic — extract field from FIRST element (index 0)
// Topic payload example: [{"id":19,"temperature":31.4,"pressure":1.9}, ...]
BIND VALUE TO TOPIC "plant/machine1/readings/last50" WITH JSON_PATH "0.temperature"
BIND VALUE TO TOPIC "plant/machine1/readings/last50" WITH JSON_PATH "0.pressure"
BIND CONTENT TO TOPIC "plant/machine1/readings/last50" WITH JSON_PATH "0.timestamp"

// Whole JSON array goes to chart or table only — NEVER a gauge/value/text
BIND DATA TO TOPIC "plant/machine1/readings/last50"   // for chart or table component

// Model field
BIND VALUE TO MODEL "SensorReading.temperature"

// GPS position — for map component
BIND LOCATION TO TOPIC "vehicle/gps"                  // payload: {lat, lng} or [lat, lng]

// Multiple markers — for map component
BIND MARKERS TO TOPIC "fleet/positions"               // payload: [{id, lat, lng, name}, ...]

// Historical trace — for map polyline or realtime-chart
BIND TRACE TO TOPIC "vehicle/gps"                     // uses DataPoint Store ring buffer
    SET TRACE_DEPTH 200                                 // how many points to keep
```

Bind targets (the ONLY tokens that may follow `BIND `):
VALUE / STATE / CONTENT / COLOR / TITLE / LABEL / MAX / MIN / VISIBLE / DATA / SPEED / LOCATION / MARKERS / TRACE

❌ `SERIES` is NOT a bind target. `BIND SERIES "…" TO TOPIC "…"` is invalid.
Write `BIND VALUE TO TOPIC "real/topic"` and put the legend on an indented
`SET SERIES_LABEL`. (The parser auto-corrects this form, but you must not emit it.)

❌ `ROWS` is NOT a bind target. Tables use `BIND DATA TO TOPIC "…"` + `SET COLUMNS`.

❌ `AS LENGTH` / `AS COUNT` / `AS JSON` are NOT coerce types. Only `AS NUMBER`,
`AS BOOLEAN`, `AS STRING`. Binding a JSON:API feed (`{"data": […]}`) to a gauge
with `AS LENGTH` leaves the needle at 0.0.

❌ Route status is NOT `<RouteName>/status`. It is
`$SYS/Coreflux/Routes/<RouteName>/status` (JSON with `health` / `connection`).
Bind `BIND STATE TO TOPIC "$SYS/Coreflux/Routes/MbtaAlertsFeed/status" WITH JSON_PATH "health"`.

---

## ⚠️ MANDATORY — Inspect the Topic Payload Before Writing ANY BIND Statement

**You MUST inspect the payload — `explore_topics(filter="...", response_format="detailed")` over MCP, `broker__read_mqtt(topic="...")` in a DEFINE AGENT — BEFORE writing any BIND statement.**
**Skipping this step is the #1 cause of broken panels. NEVER guess the payload structure.**

Both tools return the latest payload the broker has seen and do not wait for a live publish. If "parent/sub" is not in the result, the sub-topic is not being published.
Read the parent topic instead — it likely publishes JSON.

Then follow these rules:

- Plain number (31.4):                   BIND VALUE TO TOPIC "t" AS NUMBER
- Plain string (running):                BIND STATE TO TOPIC "t"
- JSON object ({"temp": 31.4, ...}):   BIND VALUE TO TOPIC "t" WITH JSON_PATH "temperature" AS NUMBER
- JSON:API / wrapped array ({"data":[…]}): table → BIND DATA TO TOPIC "t" WITH JSON_PATH "data" + SET COLUMNS
- JSON array first element:              BIND VALUE TO TOPIC "t" WITH JSON_PATH "0.temperature" AS NUMBER
- JSON array for chart or table:         BIND DATA TO TOPIC "t" plus SET COLUMNS "field1,field2"
- Count of a JSON array:                 NEVER AS LENGTH. Bind a sibling scalar (…/metrics/alerts_active) or a model field.
- Route health:                          BIND STATE TO TOPIC "$SYS/Coreflux/Routes/<Name>/status" WITH JSON_PATH "health"
- GPS position ({lat, lng}):             BIND LOCATION TO TOPIC "t"   (for map component)
- Rich JSON with lat/lng inside:         BIND LOCATION TO TOPIC "t" + SET LAT_FIELD / SET LNG_FIELD
- Nested JSON {data:{pos:{lat,lng}}}:    BIND LOCATION TO TOPIC "t" WITH JSON_PATH "data.pos"
- Array of positions ([{id,lat,lng}]):   BIND MARKERS TO TOPIC "t"    (for map component)

**If explore_topics schema is object or array, a gauge/realtime-chart MUST NOT bind VALUE to that topic without JSON_PATH or a different scalar topic.** Prefer already-projected metrics (models/actions) over the raw feed.

**NEVER** assume sub-topics exist just because the parent topic publishes JSON with those fields.
Topic plant/machine1/readings may publish {"temperature":31.4} as a JSON object,
but plant/machine1/readings/temperature is a SEPARATE topic that may not exist.
Always verify with explore_topics / broker__read_mqtt before writing any BIND.

```lot
// WRONG — assumes sub-topics exist; they may not
ADD COMPONENT "Gauge" WITH TYPE "gauge"
    BIND VALUE TO TOPIC "plant/machine1/readings/temperature"  // might not exist!

// CORRECT — parent topic publishes JSON object {"temperature": 31.4, "pressure": 1.9}
ADD COMPONENT "Gauge" WITH TYPE "gauge"
    BIND VALUE TO TOPIC "plant/machine1/readings" WITH JSON_PATH "temperature"

// CORRECT — parent topic publishes JSON array [{"temperature":31.4,...}, ...]
ADD COMPONENT "Gauge" WITH TYPE "gauge"
    BIND VALUE TO TOPIC "plant/machine1/readings/last50" WITH JSON_PATH "0.temperature"
```

---

## Chart Configuration

Charts need `SET COLUMNS` to know which JSON fields to render.
**Without `SET COLUMNS`, a chart bound to JSON data will appear empty.**

```lot
// ✅ CORRECT — chart from JSON array
ADD COMPONENT "ReadingsChart" WITH TYPE "chart"
    SET LABEL "Temperature & Pressure"
    SET COLUMNS "timestamp,temperature,pressure"   ← exact JSON field names
    BIND DATA TO TOPIC "plant/machine1/readings/last50"

// ✅ CORRECT — realtime chart from a live scalar topic
ADD COMPONENT "LiveTemp" WITH TYPE "realtime-chart"
    SET LABEL "Live Temperature"
    SET UNIT "°C"
    SET TIME_WINDOW 300
    BIND VALUE TO TOPIC "plant/machine1/temperature"

// ❌ WRONG — chart without SET COLUMNS; shows empty
ADD COMPONENT "Chart" WITH TYPE "chart"
    BIND DATA TO TOPIC "plant/machine1/readings/last50"
    // missing SET COLUMNS → chart is empty
```

Column rules:
- Names must match the exact JSON field names in the payload (case-sensitive)
- For charts: first column = X axis (time/label), remaining columns = Y series

---

## Table Component — Full CRUD Data Grid

The table component is a full-featured data grid: sort, filter, search, pagination,
row selection, and CRUD operations that publish back to the broker via MQTT.

```lot
// ── READ-ONLY MONITORING TABLE ──
ADD COMPONENT "AlertsTable" WITH TYPE "table"
    BIND DATA TO TOPIC "alarms/active"
    SET COLUMNS "severity,message,source,timestamp"
    SET COLUMN_LABELS "Severity,Message,Source,Time"
    SET COLUMN_TYPES "badge,string,string,datetime"
    SET SORTABLE true
    SET SEARCHABLE true
    SET PAGE_SIZE 15
    SET SELECTABLE "single"
    ON ROW_CLICK DO
        NAVIGATE TO PANEL "AlarmDetail" WITH "id" = VALUE

// ── FULL CRUD TABLE ──
ADD COMPONENT "MachinesGrid" WITH TYPE "table"
    BIND DATA TO TOPIC "machines/list"
    SET COLUMNS "id,name,location,status,last_seen"
    SET COLUMN_LABELS "ID,Name,Location,Status,Last Seen"
    SET COLUMN_TYPES "number,string,string,badge,datetime"
    SET COLUMN_WIDTHS "60,160,160,100,180"
    SET SORTABLE true
    SET FILTERABLE true
    SET SEARCHABLE true
    SET SELECTABLE "single"
    SET PAGE_SIZE 25
    SET ALLOW_CREATE true
    SET ALLOW_UPDATE true
    SET ALLOW_DELETE true
    ON SELECT DO
        PUBLISH TOPIC "ui/selected/machine" WITH VALUE
    ON CREATE DO
        INVOKE ACTION "RegisterMachine" WITH "data" = VALUE
    ON UPDATE DO
        INVOKE ACTION "UpdateMachine" WITH "data" = VALUE
    ON DELETE DO
        PUBLISH TOPIC "machines/remove" WITH VALUE

// ── MULTI-SELECT BULK OPERATIONS ──
ADD COMPONENT "OrdersTable" WITH TYPE "table"
    BIND DATA TO MODEL "OrderList"
    SET COLUMNS "order_id,customer,product,quantity,status"
    SET COLUMN_TYPES "string,string,string,number,badge"
    SET SORTABLE true
    SET FILTERABLE true
    SET SELECTABLE "multi"
    SET PAGE_SIZE 50
    SET ALLOW_DELETE true
    ON SELECT DO
        PUBLISH TOPIC "orders/selected" WITH VALUE
    ON DELETE DO
        INVOKE ACTION "BulkCancelOrders" WITH "ids" = VALUE
```

**SET properties for table:**

- SET COLUMNS "f1,f2,f3"         exact JSON field names, comma-separated
- SET COLUMN_LABELS "L1,L2,L3"   display headers (defaults to field names)
- SET COLUMN_TYPES "t1,t2,t3"    number / string / datetime / boolean / badge
- SET COLUMN_WIDTHS "w1,w2,w3"   pixel widths per column
- SET SORTABLE true/false          click column headers to sort
- SET FILTERABLE true/false        per-column filter inputs below headers
- SET SEARCHABLE true/false        global search bar in toolbar
- SET SELECTABLE "single" / "multi" / "none"
- SET PAGE_SIZE N                  rows per page
- SET ALLOW_CREATE true/false      show + button in toolbar
- SET ALLOW_UPDATE true/false      show ✎ button in toolbar
- SET ALLOW_DELETE true/false      show 🗑 button in toolbar

**Events:**
- ON SELECT DO      fires when row selection changes (VALUE = selected row JSON)
- ON ROW_CLICK DO   fires on row click (VALUE = row JSON)
- ON CREATE DO      fires when create form is submitted (VALUE = new record JSON)
- ON UPDATE DO      fires when edit form is submitted (VALUE = updated record JSON)
- ON DELETE DO      fires when delete confirmed (VALUE = id of deleted row)

---

## Map Component — Track Anything With a Position

The map component shows markers, current positions, and historical traces on an
interactive map. It works for ANY entity that has lat/lng coordinates: vehicles,
vessels, people, drones, containers, sensors, delivery riders, robots, animals,
field workers — the pattern is identical regardless of what you're tracking.

It uses BIND LOCATION (one entity), BIND MARKERS (many entities), and BIND TRACE
(historical path). Use MQTT wildcard ("+") in the topic to show ALL entities.

```lot
// ── SIMPLE — topic publishes only {lat, lng} ──
ADD COMPONENT "AssetTracker" WITH TYPE "map"
    SET ZOOM 14
    SET CENTER_LAT 38.7169
    SET CENTER_LON -9.1399
    BIND LOCATION TO TOPIC "vehicle/gps"
    BIND TRACE TO TOPIC "vehicle/gps"
        SET TRACE_DEPTH 200
        SET TRACE_COLOR "#3b82f6"
        SET TRACE_WIDTH 3

// ── RICH JSON — topic publishes {machine_id, temp, lat, lng, speed, status} ──
// The lat/lng are INSIDE a bigger JSON object, not a separate GPS topic
ADD COMPONENT "TelemetryMap" WITH TYPE "map"
    SET ZOOM 14
    SET CENTER_LAT 38.7169
    SET CENTER_LON -9.1399
    BIND LOCATION TO TOPIC "fleet/telemetry"
        SET LAT_FIELD "lat"
        SET LNG_FIELD "lng"
    BIND TRACE TO TOPIC "fleet/telemetry"
        SET TRACE_DEPTH 200

// ── NESTED JSON — topic publishes {id, data: {position: {latitude, longitude}}} ──
ADD COMPONENT "NestedMap" WITH TYPE "map"
    SET ZOOM 14
    SET CENTER_LAT 38.7169
    SET CENTER_LON -9.1399
    BIND LOCATION TO TOPIC "fleet/telemetry" WITH JSON_PATH "data.position"
        SET LAT_FIELD "latitude"
        SET LNG_FIELD "longitude"

// ── FLEET — multiple markers + custom field names + clustering ──
ADD COMPONENT "FleetMap" WITH TYPE "map"
    SET ZOOM 10
    SET CENTER_LAT 38.7169
    SET CENTER_LON -9.1399
    SET CLUSTER true
    BIND MARKERS TO TOPIC "fleet/positions"
    ON MARKER_CLICK DO
        NAVIGATE TO PANEL "VehicleDetail" WITH "vehicleId" = VALUE

// ── FLEET with custom field names — payload uses latitude/longitude not lat/lng ──
ADD COMPONENT "SensorMap" WITH TYPE "map"
    SET ZOOM 12
    SET CENTER_LAT 38.7169
    SET CENTER_LON -9.1399
    BIND MARKERS TO TOPIC "sensors/locations"
        SET LAT_FIELD "latitude"
        SET LNG_FIELD "longitude"
        SET MARKER_ID_FIELD "device_id"
        SET MARKER_LABEL_FIELD "label"

// ── COMBINED — fleet markers + selected vehicle trace ──
ADD COMPONENT "TrackingMap" WITH TYPE "map"
    SET ZOOM 11
    SET CENTER_LAT 38.7169
    SET CENTER_LON -9.1399
    SET CLUSTER true
    BIND MARKERS TO TOPIC "fleet/positions"
    BIND LOCATION TO TOPIC "fleet/selected/gps"
    BIND TRACE TO TOPIC "fleet/selected/gps"
        SET TRACE_DEPTH 300
        SET TRACE_COLOR "#f97316"
        SET TRACE_WIDTH 3
    ON MARKER_CLICK DO
        PUBLISH TOPIC "fleet/selected" WITH VALUE

// ── WILDCARD — all entities from prefix/+ as markers ──
// The pattern is IDENTICAL for any trackable entity:

// Vessels: vessels/live/+ → {mmsi, name, lat, lon, sog, ...}
ADD COMPONENT "AllVesselsMap" WITH TYPE "map"
    SET ZOOM 6
    SET CENTER_LAT 35.0
    SET CENTER_LON -9.0
    SET CLUSTER true
    BIND MARKERS TO TOPIC "vessels/live/+"
        SET LAT_FIELD "lat"
        SET LNG_FIELD "lon"
        SET MARKER_ID_FIELD "mmsi"
        SET MARKER_LABEL_FIELD "name"
        SET STALE_AFTER 300
    ON MARKER_CLICK DO
        NAVIGATE TO PANEL "VesselDetail" WITH "mmsi" = VALUE

// Delivery riders: riders/+/location → {rider_id, name, latitude, longitude, status}
ADD COMPONENT "RiderMap" WITH TYPE "map"
    SET ZOOM 12
    SET CENTER_LAT 38.72
    SET CENTER_LON -9.14
    BIND MARKERS TO TOPIC "riders/+/location"
        SET LAT_FIELD "latitude"
        SET LNG_FIELD "longitude"
        SET MARKER_ID_FIELD "rider_id"
        SET MARKER_LABEL_FIELD "name"
        SET STALE_AFTER 120

// Drones: drones/telemetry/+ → {drone_id, lat, lng, alt, battery, mission}
ADD COMPONENT "DroneMap" WITH TYPE "map"
    SET ZOOM 14
    SET CENTER_LAT 41.15
    SET CENTER_LON -8.61
    BIND MARKERS TO TOPIC "drones/telemetry/+"
        SET MARKER_ID_FIELD "drone_id"
        SET MARKER_LABEL_FIELD "drone_id"

// Field workers: workers/gps/+ → {employee_id, name, lat, lng, zone}
ADD COMPONENT "WorkerMap" WITH TYPE "map"
    SET ZOOM 16
    SET CENTER_LAT 40.42
    SET CENTER_LON -3.70
    BIND MARKERS TO TOPIC "workers/gps/+"
        SET MARKER_ID_FIELD "employee_id"
        SET MARKER_LABEL_FIELD "name"
        SET STALE_AFTER 60
```

**SET properties for map:**

- SET ZOOM N                   initial zoom level (1–18, default 12)
- SET CENTER_LAT N             initial center latitude (decimal degrees)
- SET CENTER_LON N             initial center longitude (decimal degrees)
- SET CLUSTER true/false       cluster nearby markers (default false)
- SET TILE_URL "url"         custom tile URL (default OpenStreetMap)

**BIND targets for map:**

- BIND LOCATION TO TOPIC "t"     single GPS position — payload: {lat, lng} or [lat, lng] or "lat,lng"
    WITH JSON_PATH "path"        navigate into larger JSON first (e.g. "data.position", "0")
    SET LAT_FIELD "fieldname"    override lat field name (default "lat", also tries "latitude")
    SET LNG_FIELD "fieldname"    override lng field name (default "lng", also tries "longitude")
- BIND MARKERS TO TOPIC "t"      array of markers — payload: [{id, lat, lng, name, ...}, ...]
    SET LAT_FIELD "fieldname"    override lat field name for each marker
    SET LNG_FIELD "fieldname"    override lng field name for each marker
    SET MARKER_ID_FIELD "field"  which field is the unique marker ID (default "id")
    SET MARKER_LABEL_FIELD "f"   which field is the marker popup label (default "name")
    SET STALE_AFTER N              seconds before unmarked entities are removed (optional)
- BIND TRACE TO TOPIC "t"        historical path polyline — uses DataPoint Store trace buffer
    SET TRACE_DEPTH N              max trace points (default 100)
    SET TRACE_COLOR "#hex"       polyline color (default "#3b82f6")
    SET TRACE_WIDTH N              polyline width in pixels (default 3)

**WILDCARD TOPICS — multi-entity aggregation (CRITICAL):**

Use MQTT wildcards (+ or #) in the topic to aggregate multiple sources:
- BIND MARKERS TO TOPIC "vessels/live/+"  → each matching topic becomes a marker
- BIND DATA TO TOPIC "sensors/+/readings" → each matching topic becomes a table row
- BIND VALUE TO TOPIC "fleet/+/speed"     → each matching topic becomes a chart series

When the topic contains + or #, the broker emits "wildcard": true in the A2UI binding.
The Hub subscribes to the wildcard and aggregates messages into a collection automatically.
Each entity is keyed by its actual topic (e.g. "vessels/live/636025061").

**Events:**
- ON MARKER_CLICK DO    fires when a marker is clicked (VALUE = marker data JSON)

// ── WILDCARD TABLE — any prefix/+ as rows (same pattern for any entity) ──
// Vessels:
ADD COMPONENT "VesselsTable" WITH TYPE "table"
    SET COLUMNS "mmsi,name,lat,lon,sog,heading,timestamp"
    SET COLUMN_LABELS "MMSI,Name,Latitude,Longitude,Speed,Heading,Last Update"
    SET COLUMN_TYPES "string,string,number,number,number,number,datetime"
    SET SORTABLE true
    SET SEARCHABLE true
    SET PAGE_SIZE 25
    BIND DATA TO TOPIC "vessels/live/+"
    ON ROW_CLICK DO
        NAVIGATE TO PANEL "VesselDetail" WITH "mmsi" = VALUE

// Workers:
ADD COMPONENT "WorkerTable" WITH TYPE "table"
    SET COLUMNS "employee_id,name,zone,lat,lng,timestamp"
    SET COLUMN_LABELS "ID,Name,Zone,Lat,Lng,Last Seen"
    SET COLUMN_TYPES "string,string,string,number,number,datetime"
    SET SORTABLE true
    SET SEARCHABLE true
    BIND DATA TO TOPIC "workers/gps/+"

---

## Realtime Chart — Trace-Driven Time Series

The realtime-chart component builds a scrolling time series from the DataPoint
Store's trace buffer. Unlike "chart" (which receives a full JSON array snapshot),
realtime-chart accumulates individual values over time.

```lot
// ── SINGLE SERIES ──
ADD COMPONENT "TempTrace" WITH TYPE "realtime-chart"
    SET LABEL "Temperature Over Time"
    SET UNIT "°C"
    SET TRACE_DEPTH 100
    SET Y_MIN 0
    SET Y_MAX 150
    BIND VALUE TO TOPIC "sensor/temperature"

// ── MULTIPLE SERIES — overlay two topics ──
ADD COMPONENT "ProcessVars" WITH TYPE "realtime-chart"
    SET LABEL "Process Variables"
    SET TRACE_DEPTH 200
    BIND VALUE TO TOPIC "sensor/temperature"
        SET SERIES_LABEL "Temperature"
        SET SERIES_COLOR "#ef4444"
    BIND VALUE TO TOPIC "sensor/pressure"
        SET SERIES_LABEL "Pressure"
        SET SERIES_COLOR "#3b82f6"
```

**SET properties for realtime-chart:**

- SET TRACE_DEPTH N           max data points to show (default 100)
- SET Y_MIN N / SET Y_MAX N   fixed Y axis range (auto-scale if omitted)
- SET UNIT "°C"              Y axis label
- SET CHART_TYPE "line"      chart type: line (default) or bar

**Per-series properties (after each BIND VALUE):**

- SET SERIES_LABEL "name"    legend label for this series
- SET SERIES_COLOR "#hex"    line color for this series
- SET SERIES_LABEL_FIELD "f" extract series label from payload field (for wildcard topics)

> **Series labels live on `SET SERIES_LABEL`, NOT on `BIND`.** `BIND` only takes a
> target keyword (`VALUE`, `STATE`, …). The label is a per-binding SET that must
> be **indented under** the `BIND VALUE TO TOPIC` line it belongs to.

### ❌ ANTI-PATTERNS — non-canonical forms the parser has to repair

```lot
// ❌ WRONG — `SERIES` is not a valid BIND target. The parser rewrites it to
//    BIND VALUE TO TOPIC "…" with the quoted text as the series label, and
//    warns. (Older brokers subscribed to a topic named "TOPIC".)
ADD COMPONENT "Trend" WITH TYPE "realtime-chart"
    BIND SERIES "Messages / Minute" TO TOPIC "kpi/messagesPerMinute"

// ❌ WRONG — `WITH UNIT` on a component body is non-canonical: the parser
//    rewrites it to SET UNIT and warns. Chart-scoped properties MUST use `SET`.
ADD COMPONENT "Trend" WITH TYPE "realtime-chart"
    WITH LABEL "Messages / Minute Trend"
    WITH UNIT  "msg/min"
    BIND VALUE TO TOPIC "kpi/messagesPerMinute"

// ✅ CORRECT — `SET` for properties, `BIND VALUE` + indented `SET SERIES_LABEL`
ADD COMPONENT "MessagesPerMinuteTrend" WITH TYPE "realtime-chart"
    SET LABEL "Messages / Minute Trend"
    SET UNIT "msg/min"
    SET TRACE_DEPTH 100
    BIND VALUE TO TOPIC "kpi/messagesPerMinute"
        SET SERIES_LABEL "Messages / Minute"
```

**Rule of thumb for charts (and every other component):**
- Component-level configuration → **`SET <KEY>`** (`SET LABEL`, `SET UNIT`, `SET TRACE_DEPTH`, `SET Y_MIN`, `SET CHART_TYPE`, …).
- Header-only modifiers (the line that starts with `ADD COMPONENT`) → `WITH TYPE`, `WITH ID`, `WITH COLUMN_SPAN`, `WITH ROW_SPAN`, `WITH INTERACT`. Nothing else belongs on a `WITH` sub-line for a chart.
- Bindings → **`BIND <TARGET> TO TOPIC "…"`** then optionally indented `SET SERIES_LABEL` / `SET SERIES_COLOR` / `SET SERIES_LABEL_FIELD` / `SET TRACE_DEPTH` / `SET STALE_AFTER`.

**Wildcard realtime-chart — each matching topic becomes a series:**

```lot
// Each vessel/live/<id> topic → separate speed line on the chart
ADD COMPONENT "SpeedChart" WITH TYPE "realtime-chart"
    SET LABEL "Vessel Speeds"
    SET UNIT "kn"
    SET TRACE_DEPTH 100
    SET Y_MIN 0
    SET Y_MAX 40
    BIND VALUE TO TOPIC "vessels/live/+"
        SET SERIES_LABEL_FIELD "name"
```

---

## Interaction — Visibility vs Interact

Viewing a panel ≠ permission to interact with every component.
Use `WITH INTERACT` per component to restrict who can write:

```lot
ADD COMPONENT "StopBtn" WITH TYPE "button"
    SET LABEL "⚠ STOP"
    SET STYLE "danger"
    WITH INTERACT FOR GROUP "supervisors"   ← only supervisors can click
    WITH INTERACT_DENY NOTIFY               ← sends denial message to UI
    ON CLICK DO
        PUBLISH TOPIC "zone1/emergency/stop" WITH 1

ADD COMPONENT "SpeedSlider" WITH TYPE "slider"
    WITH INTERACT PUBLIC                    ← any viewer can slide
    SET RANGE FROM 0 TO 100
    BIND VALUE TO TOPIC "zone1/speed"
    ON CHANGE DO
        PUBLISH TOPIC "zone1/speed/cmd" WITH VALUE
```

| Keyword | Who can interact |
|---|---|
| `WITH INTERACT PUBLIC` | Anyone who can view the panel |
| `WITH INTERACT FOR GROUP "g"` | Only members of group g |
| `WITH INTERACT FOR USER "u"` | Only the named user |
| *(omitted)* | Anyone who can view the panel (same as `PUBLIC`) — omitting it does NOT make the component view-only |

Denial modes:
- `WITH INTERACT_DENY SILENT` — the interaction is dropped with no feedback (default)
- `WITH INTERACT_DENY NOTIFY` — broker publishes to `$Visu/Session/<id>/Denied`

---

## Event Handlers — CRITICAL SYNTAX RULES

**Multi-line action bodies:** the canonical form ends the `ON ... DO` line at `DO` and puts
each action on the NEXT lines, indented MORE than the `ON` line. A single action on the
same line as `DO` also parses, but use the multi-line form so every handler looks the same.

```lot
// ✅ CORRECT — actions indented under DO on separate lines
ADD COMPONENT "StartBtn" WITH TYPE "button"
    SET LABEL "Start"
    ON CLICK DO
        PUBLISH TOPIC "machine/cmd" WITH "start"

// ✅ CORRECT — multiple actions under one DO
ADD COMPONENT "StartBtn" WITH TYPE "button"
    SET LABEL "Start Machine"
    ON CLICK DO
        PUBLISH TOPIC "machine/state" WITH "running"
        PUBLISH TOPIC "alarm/ack" WITH 1
        NAVIGATE TO PANEL "RunningView"

// ✅ CORRECT — navigation button
ADD COMPONENT "NavBtn" WITH TYPE "button"
    SET LABEL "Go to Dashboard"
    ON CLICK DO
        NAVIGATE TO PANEL "DashboardMain"

// ✅ CORRECT — navigate back
ADD COMPONENT "BackBtn" WITH TYPE "button"
    SET LABEL "Back"
    ON CLICK DO
        NAVIGATE BACK

// ✅ CORRECT — invoke a LOT action
ADD COMPONENT "ProcessBtn" WITH TYPE "button"
    SET LABEL "Process"
    ON CLICK DO
        INVOKE ACTION "ProcessOrder" WITH "id" = VALUE

// ✅ CORRECT — conditional
ADD COMPONENT "AlarmBtn" WITH TYPE "button"
    ON CLICK DO
        IF VALUE EQUALS "fault" THEN NAVIGATE TO PANEL "FaultPanel"

// ✅ CORRECT — other events
ADD COMPONENT "SpeedSlider" WITH TYPE "slider"
    ON CHANGE DO
        PUBLISH TOPIC "machine/speed" WITH VALUE

ADD COMPONENT "LampSwitch" WITH TYPE "switch"
    ON TOGGLE DO
        PUBLISH TOPIC "lamp/cmd" WITH STATE
```

**Avoid writing actions inline after DO on the same line** (they parse, but are not canonical):
```lot
// ⚠️ NON-CANONICAL — parses, but write the action on its own indented line
ON CLICK DO NAVIGATE TO PANEL "Dashboard"
ON CLICK DO PUBLISH TOPIC "x" WITH 1
```

---

## Absolute Positioning (Positioned Layout)

For HMI and SCADA screens where every element has a fixed pixel position:

```lot
DEFINE PANEL "HMIScreen"
    WITH TITLE "Machine HMI"
    WITH LAYOUT "positioned"
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "TempGauge" WITH TYPE "gauge"
        SET LABEL "Temperature"
        SET UNIT "°C"
        SET RANGE FROM 0 TO 100
        SET POSITION X 50 Y 80
        SET WIDTH 200
        SET HEIGHT 200
        BIND VALUE TO TOPIC "sensor/temperature"

    ADD COMPONENT "StartBtn" WITH TYPE "button"
        SET LABEL "START"
        SET POSITION X 300 Y 100
        SET WIDTH 120
        SET HEIGHT 48
        ON CLICK DO
            PUBLISH TOPIC "machine/cmd" WITH "start"
```

Position properties:
- `SET POSITION X 100 Y 200` — absolute pixel position
- `SET X 100` / `SET Y 200` — individual axis
- `SET WIDTH 300` / `SET HEIGHT 200` — component size
- `SET Z_INDEX 10` — stacking order
- `SET ROTATION 45` — rotation in degrees

---

## Other Supported Clauses — thresholds, state colours, grid placement, accordions, model writes, route events

```lot
DEFINE PANEL "LineOverview"
    WITH TITLE "Line Overview"
    WITH LAYOUT "grid" COLUMNS 3
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "OvenTemp" WITH TYPE "gauge" AT COLUMN 1 ROW 1 SPAN 2 COLUMNS
        SET LABEL "Oven Temp"
        SET UNIT "°C"
        SET RANGE FROM 0 TO 300
        ADD THRESHOLD AT 200 WITH COLOR "#f59e0b" LABEL "High"
        ADD THRESHOLD AT 250 WITH COLOR "#ef4444" LABEL "Critical"
        BIND VALUE TO TOPIC "line1/oven/temp"

    ADD COMPONENT "OvenState" WITH TYPE "indicator"
        SET LABEL "Oven"
        SET ON_VALUE "running" WITH COLOR "#22c55e"
        SET ON_VALUE "fault" WITH COLOR "#ef4444"
        BIND STATE TO TOPIC "line1/oven/state"

    ADD COMPONENT "Details" WITH TYPE "accordion"
        ADD SECTION "Setpoints"
            ADD COMPONENT "OvenSP" WITH TYPE "slider"
                SET LABEL "Oven Setpoint"
                SET RANGE FROM 0 TO 300
                ON CHANGE DO
                    SET MODEL "OvenControl.setpoint" WITH VALUE
        ADD SECTION "Maintenance"
            ADD COMPONENT "FlushBtn" WITH TYPE "button"
                SET LABEL "Flush"
                ON CLICK DO
                    TRIGGER ROUTE "LineDB" EVENT "LogFlush" WITH "line" = "line1"
```

- `AT COLUMN n ROW m [SPAN n COLUMNS] [SPAN m ROWS]` on the `ADD COMPONENT` line places a
  component in a grid cell (grid layout only).
- `ADD THRESHOLD AT <n> WITH COLOR "<c>" [LABEL "<text>"]` adds a colour band to a gauge.
- `SET ON_VALUE "<state>" WITH COLOR "<c>"` maps an indicator state to a colour (repeat per state).
- `ADD COMPONENT … WITH TYPE "accordion"` + indented `ADD SECTION "Title"` lines group
  components into collapsible sections (`"tabs"` + `ADD TAB "Title"` works the same way).
- `SET MODEL "Model.field" WITH VALUE` in a `DO` body writes the field's topic of a deployed
  model. It does not work on a `COLLAPSED` model yet (the write is logged and skipped).
- `TRIGGER ROUTE "Route" EVENT "Event" [WITH "key" = value …]` fires a route event as the
  clicking user. It is refused (logged, not run) for an event whose name starts with `_`
  and for an agent route.

### Slow answers — `SET AWAIT` on a button, `SET MARKDOWN` on text

When a button starts something that answers later on another topic (an agent
brief, a route reply), name the components that answer lands in with
`SET AWAIT`. When the answer is markdown (agent output usually is), add
`SET MARKDOWN true` to the `text` component that shows it.

```lot
ADD COMPONENT "Briefing" WITH TYPE "card"
    SET TITLE "Coordinator briefing"
    ADD COMPONENT "BriefingText" WITH TYPE "text"
        SET MARKDOWN true
        BIND CONTENT TO TOPIC "site/out/briefing"
    ADD COMPONENT "AskBriefing" WITH TYPE "button"
        SET LABEL "Brief me now"
        SET AWAIT "BriefingText"
        SET AWAIT_TIMEOUT 300
        ON CLICK DO
            PUBLISH TOPIC "site/requests/briefing" WITH "operator request from the panel"
```

- `SET AWAIT "Id[, Id…]"` (buttons only): on click the Hub disables the button
  with a spinner and marks each named component as waiting (dimmed, spinner and
  elapsed seconds; an empty `text` shows a skeleton instead of `---`). A
  component settles on the next message on any topic it is bound to, even an
  identical payload. The button frees up once every named component settled.
- `SET AWAIT_TIMEOUT <seconds>` (default 120, 1–3600): after it the button frees
  up and a component that is still waiting shows "No update after N s" until its
  next value. Set it a little above the agent's `TASK_TIMEOUT` or the route's
  worst case.
- Every `AWAIT` id must be a component of the same panel with a `BIND`; the
  parser warns otherwise. If the action can skip publishing (a cooldown, a
  guard), publish something on the awaited topic in that branch too, or the
  panel waits until the timeout.
- `SET MARKDOWN true` renders bold, italics, lists, headings, links and code.
  Raw HTML is never rendered (it shows as text) and images are dropped. Without
  it, text stays plain.

---

## Visibility Decision Tree

```
Everyone should see it?       → WITH VISIBILITY PUBLIC
Specific groups/users only?   → WITH VISIBILITY SHARED
                                 WITH SHARE TO GROUP "operators"
                                 WITH SHARE TO GROUP "supervisors"
Only the creator (me)?        → WITH VISIBILITY PRIVATE
```

> **`WITH VISIBILITY` takes a BARE keyword — never a string and never the
> wrong word.** The only valid values are `PUBLIC`, `SHARED`, `PRIVATE`. A
> common silent failure is confusing visibility with state and writing
> `WITH VISIBILITY "published"`. The parser maps any word other than
> PUBLIC / SHARED / PRIVATE to `PRIVATE` and the panel is **never published to `$Visu`**,
> so dashboard clients never see it. Nothing rewrites the quoted form for
> you, so the canonical source must be:

```lot
// ❌ WRONG — quoted, lowercase, AND not even a valid visibility value.
//    Falls through to PRIVATE → panel invisible to every dashboard client.
WITH VISIBILITY "published"

// ⚠️ NON-CANONICAL — the parser strips the quotes and ignores case, so this
//    is PUBLIC, but write the bare keyword.
WITH VISIBILITY "public"

// ✅ CORRECT — bare uppercase keyword.
WITH VISIBILITY PUBLIC

// (And `published` belongs on STATE, not VISIBILITY.)
WITH STATE PUBLISHED
```

---

## Common Mistakes — NEVER DO THESE

```lot
-- ❌ FLAT GRID for a multi-section operator panel — operators will reject this
DEFINE PANEL "INJ001OperatorPanel"
WITH LAYOUT "grid" COLUMNS 4
// 20 gauges and values in one endless scrolling grid
// WRONG: when user says Overview/Process/Setpoints/Production/History
// → always use multi-panel navigation: one panel per section + nav panel

-- ✅ CORRECT — multi-panel navigation for operator panels with 3+ sections
// Nav panel: INJ001Nav (buttons that NAVIGATE TO PANEL each section)
// Section panels: INJ001Overview, INJ001Process, INJ001Setpoints, INJ001Production
// Each section has a "← Back" button with NAVIGATE BACK

-- Missing WITH STATE PUBLISHED → panel is DRAFT and invisible
DEFINE PANEL "X"
WITH VISIBILITY PUBLIC
// no WITH STATE PUBLISHED    ← WRONG: panel stays in DRAFT

-- PRIVATE + SHARE (contradictory)
WITH VISIBILITY PRIVATE
WITH SHARE TO GROUP "ops"   ← WRONG: use SHARED instead

-- No BIND on a data component → shows static blank value
ADD COMPONENT "Temp" WITH TYPE "gauge"
    SET LABEL "Temp"
    // missing BIND VALUE TO TOPIC   ← WRONG: gauge shows nothing

-- ❌ Wrong component type for text — use "text" not "label"
ADD COMPONENT "Status" WITH TYPE "label"  ← WRONG: no label renderer; parser rewrites it to "text" and warns
ADD COMPONENT "Status" WITH TYPE "text"   ← CORRECT

-- ❌ Wrapping SVG in a card + text component — NEVER do this
ADD COMPONENT "BoxSvg" WITH TYPE "card"
    ADD COMPONENT "BoxSvgText" WITH TYPE "text"
        SET CONTENT "<svg...>"   ← WRONG: text renders as string, SVG not painted
                                  ← card title shows component ID, not SET LABEL value
                                  ← static content shows "---" because no BIND fires

-- ✅ CORRECT — even for static SVG with no live data, always use WITH TYPE "svg"
ADD COMPONENT "BoxSvg" WITH TYPE "svg"
    SET INLINE "<svg viewBox='0 0 220 180' xmlns='http://www.w3.org/2000/svg'>
  <rect x='30' y='50' width='160' height='100' rx='8' fill='#c08457'/>
  <path d='M30 50 L110 15 L190 50 L110 85 Z' fill='#d6a06a'/>
  <path d='M110 85 L110 150' stroke='#8b5a2b' stroke-width='4'/>
</svg>"
    SET WIDTH 220
    SET HEIGHT 180
    // No BIND statements needed for static SVG — it just renders as a graphic

-- ❌ Using SET TITLE on a card vs SET LABEL — card header uses TITLE not LABEL
ADD COMPONENT "MyCard" WITH TYPE "card"
    SET LABEL "Box Counter"   ← WRONG: Hub card uses props.title, LABEL is ignored
ADD COMPONENT "MyCard" WITH TYPE "card"
    SET TITLE "Box Counter"   ← CORRECT

-- ❌ Binding a JSON topic WITHOUT JSON_PATH — assumes sub-topics exist
-- Topic plant/machine1/readings publishes: {"temperature": 31.4, "pressure": 1.9}
BIND VALUE TO TOPIC "plant/machine1/readings/temperature"  ← WRONG: sub-topic doesn't exist!
BIND VALUE TO TOPIC "plant/machine1/readings" WITH JSON_PATH "temperature"  ← CORRECT

-- ❌ Binding a JSON ARRAY topic to a scalar widget without JSON_PATH — shows [object Object]
-- Topic last50 publishes: [{"temperature": 31.4, ...}, ...]
-- (Use "gauge" for numeric scalars, never "value" — "value" is forbidden for numbers.)
ADD COMPONENT "TempGauge" WITH TYPE "gauge"
    SET RANGE FROM 0 TO 100
    SET UNIT "°C"
    BIND VALUE TO TOPIC "plant/machine1/readings/last50"  ← WRONG: whole array → [object Object]

ADD COMPONENT "TempGauge" WITH TYPE "gauge"
    SET RANGE FROM 0 TO 100
    SET UNIT "°C"
    BIND VALUE TO TOPIC "plant/machine1/readings/last50" WITH JSON_PATH "0.temperature"  ← CORRECT

-- ❌ Chart without SET COLUMNS — renders empty even with data
ADD COMPONENT "Chart" WITH TYPE "chart"
    BIND DATA TO TOPIC "plant/machine1/readings/last50"   ← WRONG: no columns = nothing shown

ADD COMPONENT "Chart" WITH TYPE "chart"
    SET COLUMNS "timestamp,temperature,pressure"
    BIND DATA TO TOPIC "plant/machine1/readings/last50"   ← CORRECT

-- ⚠️ Inline action after DO — parses, but is not the canonical form
ADD COMPONENT "Btn" WITH TYPE "button"
    ON CLICK DO NAVIGATE TO PANEL "X"   ← NON-CANONICAL: write the action on the next line

-- ✅ Correct: DO ends the line, action is indented on the next line
ADD COMPONENT "Btn" WITH TYPE "button"
    ON CLICK DO
        NAVIGATE TO PANEL "X"   ← CORRECT

-- ❌ ❌ ❌ MAP + JSON TOPIC — THE MOST COMMON MAP MISTAKE ❌ ❌ ❌
-- Topic vessels/live/636025061 publishes ONE JSON payload:
-- {"mmsi":"636025061","name":"CHARLESTON","lat":31.92,"lon":34.27,"sog":0,"heading":317,...}

-- ❌ WRONG — assumes each field is a separate sub-topic (they DON'T EXIST)
BIND LOCATION TO TOPIC "vessels/live/636025061/lat"             ← sub-topic doesn't exist!
BIND VALUE TO TOPIC "vessels/live/636025061/name"               ← sub-topic doesn't exist!
BIND VALUE TO TOPIC "vessels/live/636025061/sog"                ← sub-topic doesn't exist!

-- ❌ WRONG — invented AND syntax (does not exist in LoTV)
BIND LOCATION TO TOPIC "vessels/live/+/lat" AND "vessels/live/+/lon"  ← NOT VALID SYNTAX

-- ❌ WRONG — non-canonical component WITH lines (auto-corrected or dropped; never emit)
WITH TEXT "some text"           ← NON-CANONICAL: use SET LABEL or SET CONTENT
WITH POSITION "1,2,8,6"        ← DROPPED with a warning: use SET POSITION X n Y n (positioned layout only)
WITH MIN 0                       ← NON-CANONICAL: use SET RANGE FROM 0 TO 40
WITH MAX 40                      ← NON-CANONICAL: use SET RANGE FROM 0 TO 40
WITH UNIT "kn"                 ← NON-CANONICAL (rewritten to SET UNIT with a warning): use SET UNIT "kn"
WITH TITLE "Speed"             ← This IS valid for panels; for components use SET LABEL

-- ✅ CORRECT — single JSON topic with JSON_PATH for each field + SET LAT_FIELD for map
ADD COMPONENT "VesselMap" WITH TYPE "map"
    SET ZOOM 8
    SET CENTER_LAT 31.92
    SET CENTER_LON 34.27
    BIND LOCATION TO TOPIC "vessels/live/636025061"
        SET LAT_FIELD "lat"
        SET LNG_FIELD "lon"         ← payload uses "lon" not "lng"!
    BIND TRACE TO TOPIC "vessels/live/636025061"
        SET TRACE_DEPTH 200
        SET TRACE_COLOR "#3b82f6"

ADD COMPONENT "SpeedGauge" WITH TYPE "gauge"
    SET LABEL "Speed Over Ground"
    SET UNIT "kn"
    SET RANGE FROM 0 TO 40
    BIND VALUE TO TOPIC "vessels/live/636025061" WITH JSON_PATH "sog"

ADD COMPONENT "VesselName" WITH TYPE "text"       ← "text" not "value" for strings!
    SET LABEL "Vessel Name"
    BIND CONTENT TO TOPIC "vessels/live/636025061" WITH JSON_PATH "name"

ADD COMPONENT "Heading" WITH TYPE "gauge"
    SET LABEL "Heading"
    SET UNIT "°"
    SET RANGE FROM 0 TO 360
    BIND VALUE TO TOPIC "vessels/live/636025061" WITH JSON_PATH "heading"

ADD COMPONENT "LastUpdate" WITH TYPE "text"       ← "text" not "value" for timestamps!
    SET LABEL "Last Update"
    BIND CONTENT TO TOPIC "vessels/live/636025061" WITH JSON_PATH "timestamp"

-- KEY RULES for map + JSON topics:
-- 1. ALWAYS inspect the payload FIRST (explore_topics / broker__read_mqtt)
-- 2. If it's a JSON object → use ONE topic + WITH JSON_PATH for each field
-- 3. For map: BIND LOCATION TO TOPIC "parent" + SET LAT_FIELD / SET LNG_FIELD
-- 4. Check the EXACT field names — "lon" ≠ "lng", "latitude" ≠ "lat"
-- 5. NEVER invent sub-topics — if "parent/field" is not in the explore_topics / broker__read_mqtt result, the sub-topic isn't being published
-- 6. String fields (name, source, timestamp) → type "text" + BIND CONTENT
-- 7. Numeric fields (speed, heading, pressure) → type "value" or "gauge" + BIND VALUE
-- 8. LoTV keywords are SET not WITH for component properties (SET LABEL, SET UNIT, SET RANGE)
-- 9. For ALL entities from a base topic → use MQTT wildcard: BIND MARKERS TO TOPIC "base/+"
--    Each matching topic becomes a marker/row/series automatically. NEVER loop over topics manually.
--    Works for ANYTHING: vessels, trucks, people, drones, sensors, containers, animals, robots.

-- ✅ WILDCARD DASHBOARD — all entities on a map + table from one base topic
-- This is the CORRECT way to show ALL things when each publishes to prefix/<id>
-- Replace "vessels/live" with any base topic: "trucks/gps", "workers/location", "drones/telemetry"
DEFINE PANEL "VesselFleetDashboard"
    WITH TITLE "Fleet Overview"
    WITH LAYOUT "grid" COLUMNS 2
    WITH VISIBILITY PUBLIC
    WITH STATE PUBLISHED

    ADD COMPONENT "FleetMap" WITH TYPE "map"
        SET ZOOM 6
        SET CENTER_LAT 35.0
        SET CENTER_LON -9.0
        SET CLUSTER true
        BIND MARKERS TO TOPIC "vessels/live/+"
            SET LAT_FIELD "lat"
            SET LNG_FIELD "lon"
            SET MARKER_ID_FIELD "mmsi"
            SET MARKER_LABEL_FIELD "name"
            SET STALE_AFTER 300
        ON MARKER_CLICK DO
            NAVIGATE TO PANEL "VesselDetail" WITH "mmsi" = VALUE

    ADD COMPONENT "FleetTable" WITH TYPE "table"
        SET COLUMNS "mmsi,name,lat,lon,sog,heading,timestamp"
        SET COLUMN_LABELS "MMSI,Name,Lat,Lon,Speed,Heading,Last Update"
        SET COLUMN_TYPES "string,string,number,number,number,number,datetime"
        SET SORTABLE true
        SET SEARCHABLE true
        BIND DATA TO TOPIC "vessels/live/+"
        ON ROW_CLICK DO
            NAVIGATE TO PANEL "VesselDetail" WITH "mmsi" = VALUE

-- ❌ ❌ ❌ FORM ANTI-PATTERNS — NO PARSE ERROR ❌ ❌ ❌
-- None of these fails to parse; each one is wrong or non-canonical.

-- ⚠️ TYPE without WITH — parses (TYPE "x" is sugar for WITH TYPE "x"), but WITH TYPE is canonical
ADD COMPONENT "myForm" TYPE "card"            ← NON-CANONICAL
ADD COMPONENT "myForm" WITH TYPE "card"       ← CORRECT
    SET TITLE "Visitor Lead Form"

-- ❌ "form" is NOT a valid component type — passed through with no warning; the Hub has no renderer for it
ADD COMPONENT "myForm" WITH TYPE "form"       ← WRONG: "form" type does not exist
ADD COMPONENT "leadCard" WITH TYPE "card"     ← CORRECT: card is the grouping container

-- ❌ BIND TOPIC "..." — missing target keyword AND TO
-- The parser rewrites it to BIND VALUE TO TOPIC "..." and warns; tables need BIND DATA.
BIND TOPIC "booth/leads/submit"                ← WRONG: no target, no TO
BIND DATA TO TOPIC "booth/leads/submit"        ← CORRECT
BIND VALUE TO TOPIC "sensor/reading"           ← CORRECT
BIND STATE TO TOPIC "machine/status"           ← CORRECT
-- BIND always requires: BIND <TARGET> TO TOPIC "..." — all three parts are mandatory.

-- ❌ ADD FIELD — NOT a LoTV keyword; silently ignored, produces nothing
ADD FIELD "name" TYPE "text" WITH LABEL "Name"     ← WRONG: keyword doesn't exist
ADD COMPONENT "nameField" WITH TYPE "text-field"    ← CORRECT
    SET LABEL "Name"
    SET PLACEHOLDER "Enter name"
    ON CHANGE DO
        PUBLISH TOPIC "form/input/name" WITH VALUE

-- ⚠️ Inline NAVIGATE with parameters — parses, but put it on its own line under DO
ON MARKER_CLICK DO NAVIGATE TO PANEL "Detail" WITH "id" = VALUE   ← NON-CANONICAL
ON MARKER_CLICK DO
    NAVIGATE TO PANEL "Detail" WITH "id" = VALUE                  ← CORRECT

-- ❌ Deploying without loading the skill
broker.add_panel(...)          ← WRONG: always load skill first
broker.load_skill("lot-panels")
broker.add_panel(...)          ← RIGHT
```

---

## Updating an Existing Panel

Call `broker.add_panel` with the same panel name — it performs an upsert:
the old panel is retracted from `$Visu` and the new version is compiled and published.
This works in BOTH Agent and Insight mode.

To change only the lifecycle state without redeploying the source (Agent mode only):
```
broker.update_visu_state("Zone1Dashboard ARCHIVED")
broker.update_visu_state("Zone1Dashboard PUBLISHED")
```

> The tool is `update_visu_state` (command `-updateVisuState`); its one argument
> is `"<panelName> <DRAFT|PUBLISHED|ARCHIVED>"`. There is no `update_panel_state`.
> Any other state word becomes DRAFT. You can also redeploy via
> `broker.add_panel` with the desired `WITH STATE` value in the header.

To retrieve the source code of an existing panel (e.g. before modifying it):
```
broker.get_panel_code(name="Zone1Dashboard")
```
Returns the full LoTV DEFINE PANEL source text. Available in both Agent and Insight mode.
