// End-to-end test of the MCP server over stdio against the in-process fake broker.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FakeBroker } from "./helpers/fake-broker.mjs";
import { McpTestClient } from "./helpers/mcp-client.mjs";

const EXPECTED_TOOLS = [
  "broker_connection",
  "broker_list",
  "broker_use",
  "broker_save",
  "broker_remove",
  "broker_command",
  "broker_overview",
  "mqtt_publish",
  "mqtt_subscribe",
  "mqtt_read_retained",
  "lot_lint",
  "lot_deploy",
  "lotnb_deploy",
  "lot_remove",
  "project_upload",
  "project_export",
  "broker_route_template",
  "broker_action_trace",
];

let broker;
let mcp;
let workdir;
let home;
/** Environment that isolates the server from the developer's own ~/.coreflux and plugin variables. */
let baseEnv;

before(async () => {
  broker = await new FakeBroker({ users: { root: "coreflux", viewer: "viewer" } }).listen();
  workdir = mkdtempSync(path.join(tmpdir(), "cf-mcp-"));
  home = mkdtempSync(path.join(tmpdir(), "cf-mcp-home-"));
  baseEnv = { COREFLUX_HOME: home, COREFLUX_BROKERS: "", COREFLUX_BROKER: "", COREFLUX_MQTT_URL: "", COREFLUX_MQTT_USERNAME: "", COREFLUX_MQTT_PASSWORD: "", COREFLUX_MQTT_CLIENT_ID: "", COREFLUX_MQTT_TLS_INSECURE: "" };
  mcp = new McpTestClient({
    cwd: workdir,
    env: { ...baseEnv, COREFLUX_MQTT_URL: broker.url, COREFLUX_MQTT_USERNAME: "root", COREFLUX_MQTT_PASSWORD: "coreflux", COREFLUX_MQTT_CLIENT_ID: "mcp-test" },
  });
  await mcp.initialize();
});

after(async () => {
  await mcp.close();
  await broker.close();
  rmSync(workdir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("initialize and tools/list expose every documented tool with a schema", async () => {
  const { result } = await mcp.call("tools/list", {});
  const names = result.tools.map((tool) => tool.name);
  assert.deepEqual(names, EXPECTED_TOOLS);
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} schema`);
    assert.ok(tool.description.length > 40, `${tool.name} needs a useful description`);
  }
});

test("unknown tool and invalid arguments produce JSON-RPC/tool errors, not crashes", async () => {
  const unknown = await mcp.call("tools/call", { name: "does_not_exist", arguments: {} });
  assert.ok(unknown.error || unknown.result?.isError, "unknown tool should error");
  const lint = await mcp.tool("lot_lint", {});
  assert.ok(lint.isError);
});

test("broker_connection reports the resolved settings and connects", async () => {
  const { data } = await mcp.tool("broker_connection");
  assert.equal(data.url, broker.url);
  assert.equal(data.username, "root");
  assert.equal(data.password, "•••••", "password must be masked");
  assert.equal(data.profile, "default");
  assert.match(data.settingsSource, /profile "default" via plugin connection variables/);
  assert.deepEqual(data.otherProfiles, ["localhost"]);
  assert.equal(data.connected, true);
  assert.equal(data.commandOutputSubscribed, true);
  assert.equal(data.clientId, "mcp-test");
});

test("broker profiles: list, save, switch (session and persisted), remove", async () => {
  const second = await new FakeBroker({ users: { ops: "ops-pw" } }).listen();
  try {
    const initial = await mcp.tool("broker_list");
    assert.equal(initial.data.active, "default");
    assert.deepEqual(initial.data.profiles.map((profile) => profile.name), ["default", "localhost"]);
    assert.equal(JSON.stringify(initial.data.profiles).includes("coreflux"), false, "passwords never appear in listings");
    assert.equal(initial.data.profiles.find((profile) => profile.name === "default").auth, "password");

    const unknown = await mcp.tool("broker_use", { name: "edge" });
    assert.ok(unknown.isError);
    assert.match(unknown.text, /Unknown profile "edge"/);

    const saved = await mcp.tool("broker_save", { name: "edge", url: second.url, username: "ops", password: "ops-pw", scope: "workspace", description: "Second fake broker" });
    // macOS reports the spawned process cwd under /private/var while mkdtemp returned /var; compare real paths.
    assert.equal(realpathSync(saved.data.file), realpathSync(path.join(workdir, ".coreflux", "brokers.json")));
    assert.equal(saved.data.profile.password, "•••••");
    assert.equal(JSON.parse(readFileSync(saved.data.file, "utf8")).brokers.edge.username, "ops");

    const switched = await mcp.tool("broker_use", { name: "edge" });
    assert.equal(switched.data.connected, true, switched.data.error);
    assert.equal(switched.data.username, "ops");
    assert.equal(switched.data.persisted, "session");
    await mcp.tool("mqtt_publish", { topic: "from/edge", payload: "1", retain: true });
    assert.ok(second.retained.has("from/edge"), "publishes go to the newly selected broker");
    assert.ok(!broker.retained.has("from/edge"), "…and not to the previous one");
    const connection = await mcp.tool("broker_connection");
    assert.equal(connection.data.profile, "edge");
    assert.equal(connection.data.url, second.url);
    assert.match(connection.data.settingsSource, /broker_use \(this session\)/);

    const persisted = await mcp.tool("broker_use", { name: "default", persist: "workspace", connect: false });
    assert.equal(realpathSync(persisted.data.file), realpathSync(saved.data.file));
    assert.equal(JSON.parse(readFileSync(saved.data.file, "utf8")).active, "default");
    const back = await mcp.tool("broker_connection");
    assert.equal(back.data.profile, "default");
    assert.equal(back.data.url, broker.url);
    assert.equal(back.data.connected, true);

    const removed = await mcp.tool("broker_remove", { name: "edge", scope: "workspace" });
    assert.deepEqual(removed.data.remaining, []);
    const afterRemove = await mcp.tool("broker_list");
    assert.deepEqual(afterRemove.data.profiles.map((profile) => profile.name), ["default", "localhost"]);
  } finally {
    await second.close();
  }
});

test("broker_command correlates the Output envelope by requestId", async () => {
  const { data } = await mcp.tool("broker_command", { command: "-listRoutes" });
  assert.equal(data.success, true);
  assert.equal(data.command, "ListRoutes");
  assert.match(data.requestId, /^cursor-[0-9a-f]{8}$/);
  assert.match(broker.commands.at(-1), /^-listRoutes -requestId cursor-/);

  const bad = await mcp.tool("broker_command", { command: "listRoutes" });
  assert.ok(bad.isError);
  assert.match(bad.text, /start with a dash/);

  const unknown = await mcp.tool("broker_command", { command: "-noSuchVerb" });
  assert.equal(unknown.data.success, false);
});

test("lot_lint works without touching the broker", async () => {
  const ok = await mcp.tool("lot_lint", { code: 'DEFINE ACTION Ping\nON EVERY 5 SECONDS DO\n    PUBLISH TOPIC "ping" WITH "1"' });
  assert.equal(ok.data.ok, true);
  assert.deepEqual(ok.data.entities, ["ACTION Ping"]);

  const bad = await mcp.tool("lot_lint", { code: 'DEFINE ACTION Ping\n    ON EVERY 5 SECONDS DO\n        PUBLISH TOPIC "ping" MESSAGE "1"' });
  assert.equal(bad.data.ok, false);
  assert.ok(bad.data.findings.length >= 2);
});

test("lot_deploy: dry run, lint gate, then real deployment in broker order", async () => {
  const code = `DEFINE ACTION UseModel\nON TOPIC "plant/status" DO\n    PUBLISH TOPIC "plant/echo" WITH PAYLOAD\nDEFINE MODEL PlantStatus WITH TOPIC "plant/status"\n    ADD "state" WITH TOPIC "plant/state" AS TRIGGER`;

  const dry = await mcp.tool("lot_deploy", { code, dryRun: true });
  assert.equal(dry.data.dryRun, true);
  assert.deepEqual(dry.data.plan.map((step) => [step.kind, step.name, step.command]), [
    ["MODEL", "PlantStatus", "-addModel"],
    ["ACTION", "UseModel", "-addAction"],
  ]);
  const commandsBefore = broker.commands.length;

  const blocked = await mcp.tool("lot_deploy", { code: `DEFINE ACTION Broken\n    ON START DO\n        PUBLISH TOPIC "x" WITH 1` });
  assert.match(blocked.data.aborted, /lint error/);
  assert.equal(broker.commands.length, commandsBefore, "lint errors must not reach the broker");

  const real = await mcp.tool("lot_deploy", { code, python: "# Script Name: Helper\ndef helper():\n    return 1" });
  assert.deepEqual(real.data.deployed.map((step) => [step.kind, step.name, step.success]), [
    ["MODEL", "PlantStatus", true],
    ["ACTION", "UseModel", true],
    ["PYTHON", "Helper", true],
  ]);
  assert.ok(broker.entities.models.has("PlantStatus"));
  assert.ok(broker.entities.actions.has("UseModel"));
  assert.ok(broker.entities.python.has("Helper"));
  assert.match(broker.commands.find((command) => command.startsWith("-addAction")), /^-addAction DEFINE ACTION UseModel\n/, "LoT body must not be wrapped in quotes");
});

test("lot_deploy stops on the first failure by default", async () => {
  const code = `DEFINE ACTION First\nON START DO\n    PUBLISH TOPIC "a" WITH 1\nDEFINE ACTION Second\nON START DO\n    PUBLISH TOPIC "b" WITH 1`;
  broker.entities.actions.clear();
  const originalHandle = broker.handleCommand.bind(broker);
  broker.handleCommand = (client, raw) => originalHandle(client, raw.startsWith("-addAction DEFINE ACTION First") ? "-addAction DEFINE ACTION" : raw);
  try {
    const { data } = await mcp.tool("lot_deploy", { code });
    assert.equal(data.deployed[0].success, false);
    assert.ok(data.deployed.some((step) => /Stopped after first failure/.test(step.note ?? "")));
    assert.ok(!broker.entities.actions.has("Second"));
  } finally {
    broker.handleCommand = originalHandle;
  }
});

test("lotnb_deploy reads a notebook from disk and honours `only`", async () => {
  const notebook = [
    { kind: 1, language: "markdown", value: "# Notebook" },
    { kind: 2, language: "lot", value: `DEFINE ACTION NbOne\nON START DO\n    PUBLISH TOPIC "nb/one" WITH 1\nDEFINE ACTION NbTwo\nON START DO\n    PUBLISH TOPIC "nb/two" WITH 1` },
  ];
  const file = path.join(workdir, "demo.lotnb");
  writeFileSync(file, JSON.stringify(notebook));
  const { data } = await mcp.tool("lotnb_deploy", { path: file, only: ["NbTwo"] });
  assert.equal(data.file, file);
  assert.deepEqual(data.deployed.map((step) => step.name), ["NbTwo"]);
  assert.ok(!broker.entities.actions.has("NbOne"));

  const removed = await mcp.tool("lot_remove", { kind: "ACTION", name: "NbTwo" });
  assert.equal(removed.data.success, true);
  assert.ok(!broker.entities.actions.has("NbTwo"));
});

test("mqtt_publish, mqtt_subscribe and mqtt_read_retained round-trip through the broker", async () => {
  const published = await mcp.tool("mqtt_publish", { topic: "cells/7/state", payload: JSON.stringify({ running: true }), retain: true });
  assert.equal(published.data.published, true);

  const retained = await mcp.tool("mqtt_read_retained", { topic: "cells/+/state", waitMs: 300 });
  assert.equal(retained.data.count, 1);
  assert.equal(retained.data.messages[0].encoding, "json");
  assert.deepEqual(retained.data.messages[0].payload, { running: true });
  assert.equal(retained.data.messages[0].retain, true);

  setTimeout(() => broker.publish("cells/7/temperature", "21.5"), 150);
  const live = await mcp.tool("mqtt_subscribe", { topic: "cells/7/#", durationMs: 800, maxMessages: 2 });
  assert.equal(live.data.count, 2);
  assert.deepEqual(live.data.messages.map((message) => message.topic).sort(), ["cells/7/state", "cells/7/temperature"]);
});

test("broker_overview aggregates commands and retained action errors", async () => {
  broker.publish("$SYS/Coreflux/Actions/Broken/Error", JSON.stringify({ message: "boom" }), { retain: true });
  broker.publish("$SYS/Coreflux/Projects/active", "demo", { retain: true });
  const { data } = await mcp.tool("broker_overview");
  assert.equal(data.broker, broker.url);
  assert.equal(data.projects, "No projects found.");
  assert.equal(data.activeProject, "demo");
  assert.deepEqual(data.actionErrors, [{ action: "Broken", message: "boom" }]);
});

test("broker_route_template strips ADD METADATA and parses field placeholders", async () => {
  const { data } = await mcp.tool("broker_route_template", { type: "modbus_tcp" });
  assert.equal(data.type, "MODBUS_TCP");
  assert.deepEqual(data.fields, [{ name: "IP", type: "string", description: "PLC address", validation: "", env: true }]);
  assert.ok(!/ADD METADATA/.test(data.skeleton));
  assert.ok(/ADD METADATA/.test(data.rawTemplate));
});

test("broker_action_trace arms tracing, runs the action and collects traces", async () => {
  const { data } = await mcp.tool("broker_action_trace", { action: "UseModel", durationMs: 600 });
  assert.equal(data.trace.success, true);
  assert.equal(data.run.success, true);
  assert.equal(data.traces.length, 1);
  assert.equal(data.traces[0].traceId, "trace-1");
  assert.equal(data.retainedError, null);
});

test("project_upload packages a folder into -addProject zip64", async () => {
  const project = path.join(workdir, "demo-project");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project);
  const { randomBytes } = await import("node:crypto");
  writeFileSync(path.join(project, "README.md"), `# demo\n${randomBytes(4000).toString("hex")}`); // ~4 KB even after deflate
  writeFileSync(path.join(project, "01-models.lotnb"), "[]");
  const { data } = await mcp.tool("project_upload", { path: project, name: "demo" });
  assert.deepEqual(data.files, ["01-models.lotnb", "README.md"]);
  assert.equal(data.project, "demo");
  const command = broker.commands.at(-1);
  assert.match(command, /^-addProject zip64:[A-Za-z0-9+/=]+ demo -requestId/);
  assert.equal(Buffer.from(command.split(" ")[1].slice(6), "base64").length, data.zipBytes);

  const tooBig = await mcp.tool("project_upload", { path: project, name: "demo", maxBytes: 1000 });
  assert.ok(tooBig.isError);
});

test("project_export writes the archive delivered on the download topic", async () => {
  const zipBytes = Buffer.from("PK\u0003\u0004fake");
  const originalHandle = broker.handleCommand.bind(broker);
  broker.handleCommand = (client, raw) => {
    if (raw.startsWith("-getProject demo")) {
      const requestId = /-requestId (\S+)/.exec(raw)[1];
      setImmediate(() => {
        broker.publish("$SYS/Coreflux/Projects/demo/download", JSON.stringify({ zip64: zipBytes.toString("base64") }));
        broker.publish("$SYS/Coreflux/Command/Output", JSON.stringify({ success: true, command: "GetProject", requestId, message: "ok" }));
      });
      return;
    }
    originalHandle(client, raw);
  };
  try {
    const target = path.join(workdir, "exports", "demo.zip");
    const { data } = await mcp.tool("project_export", { name: "demo", outputPath: target });
    assert.equal(data.writtenTo, target);
    assert.ok(existsSync(target));
    assert.deepEqual(readFileSync(target), zipBytes);
  } finally {
    broker.handleCommand = originalHandle;
  }
});

test("a viewer without $SYS rights gets an actionable error", async () => {
  const viewer = new McpTestClient({ cwd: workdir, env: { ...baseEnv, COREFLUX_MQTT_URL: broker.url, COREFLUX_MQTT_USERNAME: "viewer", COREFLUX_MQTT_PASSWORD: "viewer" } });
  try {
    await viewer.initialize();
    const connection = await viewer.tool("broker_connection");
    assert.equal(connection.data.connected, true);
    assert.equal(connection.data.commandOutputSubscribed, false);
    assert.match(connection.data.warning, /SubscribeSys/);
    const command = await viewer.tool("broker_command", { command: "-listRoutes" });
    assert.ok(command.isError);
  } finally {
    await viewer.close();
  }
});

test(".broker file in cwd is used when no environment is set", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cf-brokerfile-"));
  writeFileSync(path.join(dir, ".broker"), `${broker.url}\nusername=root\npassword=coreflux\n`);
  const client = new McpTestClient({ cwd: dir, env: baseEnv });
  try {
    await client.initialize();
    const { data } = await client.tool("broker_connection");
    assert.equal(data.url, broker.url);
    assert.equal(data.profile, "workspace");
    assert.match(data.settingsSource, /\.broker file/);
    assert.equal(data.connected, true);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
