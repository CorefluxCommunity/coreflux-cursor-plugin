---
name: lot-themes
description: "How to write LoTV theme definitions: DEFINE THEME with design tokens (colors, typography, spacing), EXTENDS inheritance, WHEN MODE light/dark, DEFINE THEME_VARIANT for component overrides, and deployment via broker.add_theme."
---

# LoTV Theme Authoring — Design Token System

ALWAYS call broker.load_skill("lot-themes") before broker.add_theme.

---

## Mandatory Workflow

```
broker.load_skill("lot-themes")                                       ← load this skill FIRST
broker.add_theme(<DEFINE THEME source>)                                ← compile + publish themeUpdate JSON
```

`add_theme` (command `-addTheme`) is a write: it is refused in an insight-mode task.
It is an MCP tool; a `DEFINE AGENT` cannot deploy a theme, because `create_lot`
has no `theme` kind.

---

## DEFINE THEME — Basic Syntax

```lot
DEFINE THEME "ThemeName"
    // Brand colors
    SET PRIMARY WITH "#f97316"
    SET SECONDARY WITH "#fb923c"
    SET ACCENT WITH "#0ea5e9"

    // Status colors
    SET SUCCESS WITH "#22c55e"
    SET WARNING WITH "#f59e0b"
    SET CRITICAL WITH "#ef4444"

    // Surfaces
    SET BACKGROUND WITH "#0a0a0f"
    SET SURFACE WITH "#111118"
    SET FOREGROUND WITH "#fafafa"
    SET FOREGROUND_MUTED WITH "#a1a1aa"

    // Typography
    SET FONT_FAMILY WITH "'Inter', sans-serif"
    SET FONT_FAMILY_MONO WITH "'JetBrains Mono', monospace"
```

Token names → CSS custom properties automatically:
`PRIMARY` → `--primary`, `FONT_SIZE_SM` → `--font-size-sm`, `SURFACE_ELEVATED` → `--surface-elevated`
In the `tokens` map of the published JSON the same names are camelCase: `FONT_SIZE_SM` → `fontSizeSm`.

---

## Key Token Reference

### Colors
`PRIMARY` · `SECONDARY` · `ACCENT` · `SUCCESS` · `WARNING` · `CRITICAL` · `INFO`
`RUNNING` · `STOPPED` · `FAULT` · `MAINTENANCE` · `STANDBY` · `DISABLED`
`BACKGROUND` · `SURFACE` · `SURFACE_ELEVATED` · `CARD` · `BORDER` · `DIVIDER`
`FOREGROUND` · `FOREGROUND_MUTED` · `FOREGROUND_SUBTLE`

### Typography
`FONT_FAMILY` · `FONT_FAMILY_DISPLAY` · `FONT_FAMILY_MONO`
`FONT_SIZE_XS/SM/BASE/LG/XL/2XL/3XL/4XL/5XL`
`FONT_WEIGHT_LIGHT/NORMAL/MEDIUM/SEMIBOLD/BOLD`

### Spacing & Radius
`SPACING_0/1/2/3/4/5/6/8/10/12/16` · `RADIUS_SM/MD/LG/XL/2XL/3XL/FULL`

### Effects
`SHADOW_SM/MD/LG/XL/2XL/INNER` · `GLOW_PRIMARY/SUCCESS/WARNING/CRITICAL`
`BLUR_SM/MD/LG/XL` · `TRANSITION_INSTANT/FAST/NORMAL/SLOW/SLOWER`

---

## Theme Inheritance — EXTENDS

```lot
DEFINE THEME "CorefluxBase"
    SET PRIMARY WITH "#f97316"
    SET BACKGROUND WITH "#0a0a0f"
    SET FOREGROUND WITH "#fafafa"

DEFINE THEME "CorefluxBlue" EXTENDS "CorefluxBase"
    SET PRIMARY WITH "#3b82f6"     // override only this token
    SET SECONDARY WITH "#60a5fa"   // all other tokens inherited from CorefluxBase
```

The parent theme must be deployed first, or come **before** the child in the same call.
Inheritance is resolved when the child is published: a parent that arrives later
(even later in the same call) does not reach the child until the child is redeployed.

---

## Light/Dark Mode — WHEN MODE

```lot
DEFINE THEME "Adaptive"
    SET MODE "auto"              // auto | light | dark
    SET SYSTEM_PREFERENCE true    // follow OS light/dark preference
    SET PRIMARY WITH "#f97316"  // same in both modes

    WHEN MODE "light"
        SET BACKGROUND WITH "#ffffff"
        SET SURFACE WITH "#f4f4f5"
        SET FOREGROUND WITH "#18181b"

    WHEN MODE "dark"
        SET BACKGROUND WITH "#0a0a0f"
        SET SURFACE WITH "#111118"
        SET FOREGROUND WITH "#fafafa"
```

Time-based switching:
```lot
    SET TIME_BASED true
        DARK_START "18:00"
        DARK_END   "06:00"
        TIMEZONE   "local"
```

---

## Component-Level Overrides — DEFINE THEME_VARIANT

```lot
DEFINE THEME_VARIANT "gauge:industrial"
    SET TRACK_COLOR WITH "var(--surface)"
    SET FILL_GRADIENT WITH "linear-gradient(135deg, var(--primary), var(--secondary))"
    SET GLOW_ON_THRESHOLD WITH true

DEFINE THEME_VARIANT "button:scada"
    SET FONT_WEIGHT WITH "var(--font-weight-semibold)"
    SET BORDER_RADIUS WITH "var(--radius-md)"
    SET TRANSITION WITH "var(--transition-fast)"
```

Variants are published to `$SYS/Coreflux/VoT/ThemeVariants/{component}/{variant}`.
Multiple DEFINE blocks can be sent in a single `broker.add_theme` call.

---

## What the Broker Publishes

After `broker.add_theme`, the broker publishes to `$SYS/Coreflux/VoT/Themes/{ThemeName}`:

```json
{
  "themeUpdate": {
    "themeId": "CorefluxBlue",
    "inherits": "CorefluxBase",
    "tokens": { "primary": "#3b82f6", "background": "#0a0a0f" },
    "cssVariables": { "--primary": "#3b82f6", "--background": "#0a0a0f" },
    "modes": {
      "light": { "tokens": {...}, "cssVariables": {...} },
      "dark":  { "tokens": {...}, "cssVariables": {...} }
    },
    "modeConfig": { "mode": "auto", "systemPreference": true }
  }
}
```

---

## Common Mistakes

```lot
-- WITH is optional and a bare value is read up to the first space, so these all parse:
SET PRIMARY "#f97316"
SET PRIMARY WITH #f97316
SET PRIMARY WITH "#f97316"    ← canonical: always WITH and a quoted value

-- Unquoted value containing spaces → truncated at the first space
SET FONT_FAMILY WITH 'Inter', sans-serif      ← WRONG: value becomes 'Inter',
SET FONT_FAMILY WITH "'Inter', sans-serif"    ← RIGHT

-- EXTENDS before parent is deployed
broker.add_theme("DEFINE THEME \"Child\" EXTENDS \"Parent\" ...")
// Parent not yet deployed → the child carries "inherits" but none of the parent's tokens
// Fix: deploy the parent first, or put its DEFINE THEME block before the child in the same call

-- Deploying without loading the skill
broker.add_theme(...)                        ← WRONG
broker.load_skill("lot-themes")
broker.add_theme(...)                        ← RIGHT
```
