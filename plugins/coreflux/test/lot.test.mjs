import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deployCommand, lintLot, loadLotFile, pythonScriptName, sortForDeploy, splitLotEntities } from "../scripts/mcp/lib/lot.mjs";

const VALID_ACTION = `DEFINE ACTION AlertOnHighTemp
ON TOPIC "sensors/+/temperature" DO
    SET "temp" WITH (PAYLOAD AS DOUBLE)
    IF {temp} > 85 THEN
        PUBLISH TOPIC "alerts/temperature" WITH {temp}`;

const VALID_MODEL = `DEFINE MODEL MachineStatus WITH TOPIC "machines/{machineId}/status"
    ADD "temperature" WITH TOPIC "sensors/{machineId}/temperature" AS TRIGGER
    ADD "updatedAt" WITH TIMESTAMP "UTC"`;

const VALID_ROUTE = `DEFINE ROUTE PlantDb WITH TYPE POSTGRESQL
    ADD POSTGRESQL_CONFIG
        WITH HOST GET ENV "PLANT_DB_HOST"
        WITH PASSWORD GET SECRET "PLANT_DB_PASSWORD"`;

test("splitLotEntities separates DEFINE blocks and keeps line numbers", () => {
  const source = `-- header comment\n${VALID_MODEL}\n\n-- glue comment\n${VALID_ACTION}\n${VALID_ROUTE}`;
  const entities = splitLotEntities(source);
  assert.deepEqual(
    entities.map((entity) => [entity.kind, entity.name, entity.line]),
    [
      ["MODEL", "MachineStatus", 2],
      ["ACTION", "AlertOnHighTemp", 7],
      ["ROUTE", "PlantDb", 12],
    ],
  );
  assert.match(entities[0].code, /^-- header comment\nDEFINE MODEL MachineStatus/);
  assert.match(entities[0].code, /-- glue comment$/);
  assert.match(entities[1].code, /^DEFINE ACTION AlertOnHighTemp/);
  assert.equal(entities[2].code, VALID_ROUTE);
});

test("splitLotEntities treats indented DEFINE as body text, not a new entity", () => {
  const entities = splitLotEntities(`DEFINE ACTION Outer\nON START DO\n    DEFINE ACTION NotAnEntity`);
  assert.equal(entities.length, 1);
});

test("sortForDeploy follows broker load order", () => {
  const sorted = sortForDeploy([
    { kind: "PANEL", name: "p" },
    { kind: "RULE", name: "r" },
    { kind: "ACTION", name: "a" },
    { kind: "MODEL", name: "m" },
    { kind: "PYTHON", name: "py" },
    { kind: "ROUTE", name: "rt" },
    { kind: "THEME", name: "t" },
  ]);
  assert.deepEqual(
    sorted.map((entity) => entity.kind),
    ["MODEL", "ACTION", "ROUTE", "RULE", "PYTHON", "THEME", "PANEL"],
  );
});

test("deployCommand prefixes the right verb without wrapping quotes", () => {
  assert.equal(deployCommand({ kind: "ACTION", code: VALID_ACTION }), `-addAction ${VALID_ACTION}`);
  assert.equal(deployCommand({ kind: "PYTHON", code: "# Script Name: X\nprint(1)" }), "-addPython # Script Name: X\nprint(1)");
  assert.throws(() => deployCommand({ kind: "THING", code: "" }), /cannot be deployed/);
});

test("pythonScriptName reads the header", () => {
  assert.equal(pythonScriptName("# Script Name: Sum\ndef sum(a, b):\n    return a + b"), "Sum");
  assert.equal(pythonScriptName("print(1)"), null);
});

test("lintLot accepts valid action, model and route", () => {
  for (const source of [VALID_ACTION, VALID_MODEL, VALID_ROUTE]) {
    const errors = lintLot(source).filter((finding) => finding.severity === "error");
    assert.deepEqual(errors, [], `unexpected errors for:\n${source}`);
  }
});

test("lintLot accepts trigger on the DEFINE ACTION line", () => {
  const errors = lintLot(`DEFINE ACTION Heartbeat ON EVERY 10 SECONDS DO\n    PUBLISH TOPIC "heartbeat" WITH "ok"`).filter((finding) => finding.severity === "error");
  assert.deepEqual(errors, []);
});

test("lintLot ignores keywords inside string literals", () => {
  const errors = lintLot(`DEFINE ACTION Relay\nON TOPIC "in/message" DO\n    PUBLISH TOPIC "output/message" WITH PAYLOAD`).filter((finding) => finding.severity === "error");
  assert.deepEqual(errors, []);
});

const CASES = [
  ["indented trigger", `DEFINE ACTION A\n    ON TOPIC "x" DO\n        PUBLISH TOPIC "y" WITH 1`, /indented/],
  ["missing DO", `DEFINE ACTION A\nON TOPIC "x"\n    PUBLISH TOPIC "y" WITH 1`, /missing DO/],
  ["MESSAGE keyword", `DEFINE ACTION A\nON TOPIC "x" DO\n    PUBLISH TOPIC "y" MESSAGE 1`, /MESSAGE is not a keyword/],
  ["zero-based position", `DEFINE ACTION A\nON TOPIC "x/+" DO\n    SET "id" WITH TOPIC POSITION 0`, /1-based/],
  ["quoted action name", `DEFINE ACTION "A"\nON START DO\n    PUBLISH TOPIC "y" WITH 1`, /quoted/],
  ["quoted model name", `DEFINE MODEL "M" WITH TOPIC "m"\n    ADD DOUBLE "v" WITH TOPIC "v" AS TRIGGER`, /Model name "M" is quoted/],
  ["quoted rule name", `DEFINE RULE "R" WITH PRIORITY 100 FOR Subscribe TO TOPIC "x/#"\n    ALLOW`, /Rule name "R" is quoted/],
  ["quoted route name", `DEFINE ROUTE "R" WITH TYPE MODBUS_TCP\n    ADD MODBUS_CONFIG`, /Route name "R" is quoted/],
  ["quoted parent model", `DEFINE MODEL Child FROM "Parent" WITH TOPIC "c"\n    ADD DOUBLE "v" WITH TOPIC "v" AS TRIGGER`, /Parent model after FROM is quoted/],
  ["END IF", `DEFINE ACTION A\nON START DO\n    IF 1 > 0 THEN\n        PUBLISH TOPIC "y" WITH 1\n    END IF`, /END IF/],
  ["ADD METADATA", `DEFINE ROUTE R WITH TYPE MODBUS_TCP\n    ADD METADATA\n        WITH DESCRIPTION "x"`, /template-only/],
  ["PAYLOAD on timer", `DEFINE ACTION A\nON EVERY 5 SECONDS DO\n    PUBLISH TOPIC "y" WITH PAYLOAD`, /no payload exists/],
  ["tabs", `DEFINE ACTION A\nON START DO\n\tPUBLISH TOPIC "y" WITH 1`, /Tabs/],
  ["odd indentation", `DEFINE ACTION A\nON START DO\n   PUBLISH TOPIC "y" WITH 1`, /multiple of 4/],
  ["route without type", `DEFINE ROUTE R\n    ADD MODBUS_CONFIG`, /WITH TYPE/],
  ["lowercase keyword", `DEFINE ACTION A\nON START DO\n    publish TOPIC "y" WITH 1`, /uppercase/],
  ["no trigger", `DEFINE ACTION A\n    PUBLISH TOPIC "y" WITH 1`, /no trigger/],
];

for (const [label, source, pattern] of CASES) {
  test(`lintLot flags ${label}`, () => {
    const errors = lintLot(source).filter((finding) => finding.severity === "error");
    assert.ok(errors.some((finding) => pattern.test(finding.message)), `expected /${pattern.source}/ in ${JSON.stringify(errors)}`);
  });
}

test("lintLot warns about hardcoded credentials and models without AS TRIGGER", () => {
  const findings = lintLot(`DEFINE ROUTE R WITH TYPE POSTGRESQL\n    ADD POSTGRESQL_CONFIG\n        WITH PASSWORD "hunter2"\nDEFINE MODEL M WITH TOPIC "m"\n    ADD "a" WITH TOPIC "a"`);
  const warnings = findings.filter((finding) => finding.severity === "warning").map((finding) => finding.message);
  assert.ok(warnings.some((message) => /Hardcoded credential/.test(message)));
  assert.ok(warnings.some((message) => /AS TRIGGER/.test(message)));
});

test("loadLotFile parses .lotnb cells, adds Script Name headers and sorts for deploy", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cf-lot-"));
  try {
    const notebook = [
      { kind: 1, language: "markdown", value: "# Demo" },
      { kind: 2, language: "lot", value: `${VALID_ACTION}\n${VALID_MODEL}` },
      { kind: 2, language: "python", value: "# Script Name: Sum\ndef sum(a, b):\n    return a + b" },
      { kind: 2, language: "python", scriptName: "Legacy", value: "def x():\n    return 1" },
      { kind: 2, language: "shellscript", value: "echo ignored" },
    ];
    const file = path.join(dir, "demo.lotnb");
    writeFileSync(file, JSON.stringify(notebook));
    const entities = await loadLotFile(file);
    assert.deepEqual(
      entities.map((entity) => [entity.kind, entity.name]),
      [
        ["MODEL", "MachineStatus"],
        ["ACTION", "AlertOnHighTemp"],
        ["PYTHON", "Sum"],
        ["PYTHON", "Legacy"],
      ],
    );
    assert.match(entities[3].code, /^# Script Name: Legacy\n/);
    assert.equal(entities[0].source, "demo.lotnb#cell1");

    writeFileSync(path.join(dir, "bad.lotnb"), "{ not json");
    await assert.rejects(loadLotFile(path.join(dir, "bad.lotnb")), /not valid \.lotnb JSON/);

    writeFileSync(path.join(dir, "plain.lot"), VALID_ROUTE);
    const plain = await loadLotFile(path.join(dir, "plain.lot"));
    assert.deepEqual(plain.map((entity) => entity.name), ["PlantDb"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
