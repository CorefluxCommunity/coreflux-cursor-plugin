// LoT (Language of Things) helpers: entity splitting, deploy-order, .lotnb parsing, and a
// static linter for the mistakes that most often break the broker parser.

import { readFile } from "node:fs/promises";
import path from "node:path";

/** Deploy verb per entity kind, in the order the broker loads projects. */
export const ENTITY_ORDER = ["MODEL", "ACTION", "ROUTE", "RULE", "PYTHON", "THEME", "PANEL"];

export const ENTITY_COMMANDS = {
  MODEL: { add: "-addModel", remove: "-removeModel" },
  ACTION: { add: "-addAction", remove: "-removeAction" },
  ROUTE: { add: "-addRoute", remove: "-removeRoute" },
  RULE: { add: "-addRule", remove: "-removeRule" },
  PYTHON: { add: "-addPython", remove: "-removePython" },
  THEME: { add: "-addTheme", remove: "-removeTheme" },
  PANEL: { add: "-addPanel", remove: "-removePanel" },
};

const DEFINE_RE = /^DEFINE\s+(ACTION|MODEL|ROUTE|RULE|THEME|PANEL|VISU|THING)\b\s*("([^"]+)"|([A-Za-z0-9_\-.]+))?/i;
const SCRIPT_NAME_RE = /^\s*#\s*Script Name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/im;

function stripComments(line) {
  // Remove -- and // comments outside string literals.
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    if (!inString && ((ch === "-" && line[i + 1] === "-") || (ch === "/" && line[i + 1] === "/"))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Splits LoT source into entity blocks. Every top-level `DEFINE` starts a new block; everything
 * until the next `DEFINE` belongs to it (comments between entities are attached to the following one).
 * @returns {{kind: string, name: string, code: string, line: number}[]}
 */
export function splitLotEntities(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const entities = [];
  let current = null;
  let pendingComments = [];

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const match = DEFINE_RE.exec(raw);
    if (match && !raw.startsWith(" ") && !raw.startsWith("\t")) {
      if (current) {
        current.code = current.lines.join("\n").trimEnd();
        delete current.lines;
        entities.push(current);
      }
      let kind = match[1].toUpperCase();
      if (kind === "VISU") kind = "PANEL";
      const name = match[3] ?? match[4] ?? "";
      current = { kind, name, line: index + 1, lines: [...pendingComments, raw] };
      pendingComments = [];
      continue;
    }
    if (current) {
      current.lines.push(raw);
    } else if (raw.trim().length > 0) {
      pendingComments.push(raw);
    }
  }
  if (current) {
    current.code = current.lines.join("\n").trimEnd();
    delete current.lines;
    entities.push(current);
  }
  return entities;
}

/** Extracts the `# Script Name:` of a Python cell/script, or null. */
export function pythonScriptName(code) {
  const match = SCRIPT_NAME_RE.exec(code);
  return match ? match[1] : null;
}

/**
 * Reads a `.lotnb` notebook (JSON array of {kind, language, value}) or a plain `.lot` file and
 * returns deployable entities in broker load order.
 */
export async function loadLotFile(filePath) {
  const absolute = path.resolve(filePath);
  const text = await readFile(absolute, "utf8");
  const entities = [];

  if (absolute.toLowerCase().endsWith(".lotnb")) {
    let cells;
    try {
      cells = JSON.parse(text);
    } catch (error) {
      throw new Error(`${filePath} is not valid .lotnb JSON: ${error.message}`);
    }
    if (!Array.isArray(cells)) throw new Error(`${filePath}: a .lotnb file must be a JSON array of cells`);
    cells.forEach((cell, cellIndex) => {
      if (!cell || cell.kind !== 2 || typeof cell.value !== "string") return;
      const language = String(cell.language ?? "").toLowerCase();
      if (language === "lot") {
        for (const entity of splitLotEntities(cell.value)) {
          entities.push({ ...entity, source: `${path.basename(absolute)}#cell${cellIndex}` });
        }
      } else if (language === "python") {
        const name = pythonScriptName(cell.value) ?? cell.scriptName ?? null;
        entities.push({
          kind: "PYTHON",
          name: name ?? "",
          code: name && !SCRIPT_NAME_RE.test(cell.value) ? `# Script Name: ${name}\n${cell.value}` : cell.value,
          line: 1,
          source: `${path.basename(absolute)}#cell${cellIndex}`,
        });
      }
    });
  } else {
    for (const entity of splitLotEntities(text)) {
      entities.push({ ...entity, source: path.basename(absolute) });
    }
  }
  return sortForDeploy(entities);
}

export function sortForDeploy(entities) {
  return [...entities].sort((a, b) => ENTITY_ORDER.indexOf(a.kind) - ENTITY_ORDER.indexOf(b.kind));
}

/** Builds the exact MQTT payload for deploying one entity. */
export function deployCommand(entity) {
  const verb = ENTITY_COMMANDS[entity.kind]?.add;
  if (!verb) throw new Error(`Unsupported entity kind "${entity.kind}"`);
  if (entity.kind === "THING") throw new Error("DEFINE THING is composed by the notebook runtime and cannot be deployed directly");
  return `${verb} ${entity.code}`;
}

/**
 * Static LoT lint. Returns findings; `severity` is "error" (parser will reject) or "warning".
 * This is deliberately conservative: it flags the well-known anti-patterns, not full grammar.
 */
export function lintLot(source) {
  const findings = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const add = (severity, line, message, fix) => findings.push({ severity, line, message, fix });

  let currentKind = null;

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const code = stripComments(raw);
    const trimmed = code.trim();
    if (!trimmed) return;
    // Keyword checks run against a copy with string literals blanked out, so a topic such as
    // "output/message" does not trip the MESSAGE rule.
    const bare = trimmed.replace(/"[^"]*"/g, '""');
    const indent = raw.match(/^[ \t]*/)[0];

    if (indent.includes("\t")) {
      add("error", lineNo, "Tabs used for indentation; LoT requires 4 spaces per level.", "Replace tabs with 4 spaces.");
    } else if (indent.length % 4 !== 0) {
      add("error", lineNo, `Indentation of ${indent.length} spaces is not a multiple of 4.`, "Indent bodies by exactly 4 spaces per level.");
    }

    const define = DEFINE_RE.exec(trimmed);
    if (define) {
      if (indent.length > 0) add("error", lineNo, "DEFINE must start at column 0.", "Remove the leading indentation.");
      currentKind = define[1].toUpperCase();
      if (currentKind === "ACTION" && define[3]) {
        add("error", lineNo, `Action name "${define[3]}" is quoted; action names are unquoted.`, `Write DEFINE ACTION ${define[3]}.`);
      }
      if (currentKind === "MODEL" && /\bWITH\s+FORMATS\b/i.test(trimmed)) {
        add("error", lineNo, "WITH FORMATS is not a keyword.", "Use WITH FORMAT PROTOBUF | JSON | BOTH.");
      }
      if (currentKind === "MODEL" && /\bWITH\s+COLLAPSED\b/i.test(trimmed)) {
        add("error", lineNo, "COLLAPSED stands alone in the model header.", 'Write DEFINE MODEL "Name" COLLAPSED WITH TOPIC "…".');
      }
      if (currentKind === "ROUTE" && !/\bWITH\s+TYPE\b/i.test(trimmed)) {
        add("error", lineNo, "DEFINE ROUTE is missing WITH TYPE <ROUTE_TYPE>.", "Add WITH TYPE POSTGRESQL, MODBUS_TCP, MQTT_BRIDGE, …");
      }
      if (/^DEFIN\s/i.test(trimmed) || /\bTOPICO\b/i.test(trimmed)) {
        add("error", lineNo, "Misspelled keyword (DEFIN / TOPICO).", "Use DEFINE / TOPIC.");
      }
      return;
    }

    const isTrigger = /^ON\s+(TOPIC|CHANGE|EVERY|START|CONNECT|DISCONNECT|SUBSCRIBE)\b/i.test(trimmed);
    if (isTrigger && currentKind === "ACTION") {
      if (indent.length > 0) {
        add("error", lineNo, "Action trigger (ON …) is indented; it must sit at the same column as DEFINE ACTION.", "Move the ON … line to column 0 and indent the body by 4 spaces under it.");
      }
      if (!/\bDO\s*$/i.test(trimmed) && !/\bDO\s+\S/i.test(trimmed)) {
        add("error", lineNo, "Trigger line is missing DO.", "End the trigger with DO, e.g. ON EVERY 10 SECONDS DO");
      }
      if (/^ON\s+EVERY\s+\d+\s*$/i.test(trimmed)) {
        add("error", lineNo, "ON EVERY needs a unit.", "ON EVERY 10 SECONDS DO");
      }
    }

    if (/\b(PUBLISH|KEEP)\s+TOPIC\b/i.test(bare)) {
      if (/\bMESSAGE\b/i.test(bare)) {
        add("error", lineNo, "MESSAGE is not a keyword after PUBLISH/KEEP TOPIC.", 'Use PUBLISH TOPIC "t" WITH <value>.');
      } else if (!/\bWITH\b/i.test(bare)) {
        add("error", lineNo, "PUBLISH/KEEP TOPIC requires WITH <value>.", 'PUBLISH TOPIC "t" WITH {value}');
      } else if (/\bWITH\s*$/i.test(bare)) {
        add("error", lineNo, "WITH has no value; an empty WITH compiles to a null crash.", "Provide a value after WITH.");
      }
    }

    if (/^SET\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s+(?!WITH\b|TO\b|AS\b|=)/i.test(trimmed) && !/^SET\s+(LABEL|UNIT|RANGE|STYLE|TITLE|PRIMARY|SECONDARY|SUCCESS|WARNING|CRITICAL|INFO|BACKGROUND|FOREGROUND|CARD|BORDER|MUTED|MIN|MAX|STEP|FORMAT|COLOR|ICON|SIZE|DECIMALS|PLACEHOLDER|OPTIONS|VARIANT|HEIGHT|WIDTH|DEFAULT|TEXT|VALUE)\b/i.test(trimmed) && currentKind !== "PANEL" && currentKind !== "THEME") {
      add("error", lineNo, "SET needs a separator (WITH / TO / AS) between the variable and the value.", 'SET "count" WITH 0');
    }

    if (/\bTOPIC\s+POSITION\s+0\b/i.test(bare)) {
      add("error", lineNo, "TOPIC POSITION is 1-based; position 0 is invalid.", "Use TOPIC POSITION 1 for the first segment.");
    }

    if (/^IF\b/i.test(bare) && !/\bTHEN\b/i.test(bare)) {
      add("error", lineNo, "IF condition is missing THEN.", "IF {x} > 5 THEN");
    }

    if (/^\s*END\s+IF\b/i.test(trimmed)) {
      add("error", lineNo, "END IF does not exist in LoT; blocks are closed by indentation.", "Remove END IF.");
    }

    if (/\bWITH\s+VALUE\b/i.test(bare) && currentKind === "MODEL") {
      add("error", lineNo, "WITH VALUE is rejected in model fields.", 'Use WITH "static" / WITH TIMESTAMP "ISO" directly.');
    }

    if (/^ADD\s+METADATA\b/i.test(trimmed)) {
      add("error", lineNo, "ADD METADATA is template-only; the parser rejects it in deployed routes.", "Delete the ADD METADATA block and everything nested under it.");
    }

    if (/^ADD\s+TAG\b/i.test(trimmed) && indent.length < 8 && currentKind === "ROUTE") {
      add("error", lineNo, "ADD TAG must be nested inside an ADD MAPPING block (8 spaces).", "Wrap tags in ADD MAPPING \"Name\" WITH SOURCE_TOPIC … WITH EVERY … then indent tags by 8 spaces.");
    }

    if (/\bWITH\s+PASSWORD\s+"[^"]+"/i.test(trimmed) || /\bWITH\s+API_KEY\s+"[^"]+"/i.test(trimmed)) {
      add("warning", lineNo, "Hardcoded credential.", 'Use WITH PASSWORD GET SECRET "NAME" and store it with -setSecret NAME=value.');
    }

    if (/\bRETURN\s+OUTPUT\b/i.test(bare)) {
      add("error", lineNo, "RETURN OUTPUT on one line is rejected.", "Write RETURN on its own line, then one indented OUTPUT <var> per line.");
    }

    if (/\bCALL\s+MCP\s+"[^"]+"\s+TOOL\b/i.test(trimmed)) {
      add("error", lineNo, 'CALL MCP "Route" TOOL "name" is an unsupported legacy form.', 'Use CALL MCP "Route.tool" WITH (arg = {x}) RETURN AS {result}.');
    }

    // Uppercase keyword check on the first token of a statement line.
    const firstToken = trimmed.split(/\s+/)[0];
    const knownKeywords = ["DEFINE", "ON", "DO", "SET", "PUBLISH", "KEEP", "IF", "ELSE", "SWITCH", "CASE", "DEFAULT", "LOOP", "UNTIL", "CALL", "TRIGGER", "STORE", "ADD", "WITH", "INPUT", "RETURN", "OUTPUT", "GET", "DELETE", "ALLOW", "DENY", "BIND", "AT", "INVOKE", "FETCH", "NAVIGATE"];
    if (knownKeywords.includes(firstToken.toUpperCase()) && firstToken !== firstToken.toUpperCase()) {
      add("error", lineNo, `Keyword "${firstToken}" must be uppercase.`, `Write ${firstToken.toUpperCase()}.`);
    }
  });

  // Trigger/PAYLOAD sanity per action: evaluate blocks individually.
  for (const entity of splitLotEntities(source)) {
    if (entity.kind !== "ACTION") continue;
    // Triggers may sit on their own line or on the DEFINE ACTION line itself.
    const body = entity.code;
    const hasTopicTrigger = /(^|^DEFINE\s+ACTION\s+\S+\s+)ON\s+(TOPIC|CHANGE)\b/im.test(body);
    const hasTimeTrigger = /(^|^DEFINE\s+ACTION\s+\S+\s+)ON\s+(EVERY|START)\b/im.test(body);
    const hasOtherTrigger = /(^|^DEFINE\s+ACTION\s+\S+\s+)ON\s+(CONNECT|DISCONNECT|SUBSCRIBE)\b/im.test(body);
    const hasInput = /^INPUT\s+/im.test(body);
    if (!hasTopicTrigger && !hasTimeTrigger && !hasOtherTrigger && !hasInput) {
      add("error", entity.line, `Action "${entity.name}" has no trigger (ON …) and no INPUT declaration.`, "Add ON TOPIC / ON EVERY / ON START, or make it callable with INPUT … DO … RETURN.");
    }
    if (hasTimeTrigger && !hasTopicTrigger && /\bPAYLOAD\b/i.test(body.replace(/GET\s+TOPIC\s+"[^"]*"/gi, ""))) {
      add("error", entity.line, `Action "${entity.name}" uses PAYLOAD but is triggered by ON EVERY / ON START, where no payload exists.`, 'Read state with GET TOPIC "…" instead, or switch to ON TOPIC.');
    }
  }

  // Model trigger sanity.
  for (const entity of splitLotEntities(source)) {
    if (entity.kind !== "MODEL") continue;
    const hasTopicBinding = /\bWITH\s+TOPIC\s+"/i.test(entity.code.split("\n").slice(1).join("\n"));
    if (hasTopicBinding && !/\bAS\s+TRIGGER\b/i.test(entity.code)) {
      add("warning", entity.line, `Model "${entity.name}" binds topics but marks none AS TRIGGER, so it will never auto-publish.`, "Add AS TRIGGER to the field whose update should publish the model.");
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return findings;
}
