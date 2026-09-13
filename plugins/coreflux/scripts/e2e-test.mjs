#!/usr/bin/env node
// End-to-end test against a real Coreflux broker (CI runs it against the official Docker image).
//
// Deploys a throw-away action + model with unique names, drives them with real MQTT traffic,
// traces the action, exports the entity list, and removes everything it created — even on failure.
//
//   COREFLUX_MQTT_URL=mqtt://localhost:1883 COREFLUX_MQTT_USERNAME=root COREFLUX_MQTT_PASSWORD=… \
//     node plugins/coreflux/scripts/e2e-test.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const suffix = Math.random().toString(36).slice(2, 8);
const ACTION = `CiEcho${suffix}`;
const MODEL = `CiStatus${suffix}`;
const IN_TOPIC = `ci/${suffix}/in`;
const OUT_TOPIC = `ci/${suffix}/out`;

const server = spawn(process.execPath, [path.join(here, "mcp", "coreflux-mqtt-mcp.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});

function call(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 90000).unref();
  });
}

async function tool(name, args = {}) {
  const response = await call("tools/call", { name, arguments: args });
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  const text = response.result?.content?.[0]?.text ?? "";
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain text
  }
  return { isError: response.result?.isError === true, data, text };
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1500)}` : ""}`);
  }
}

const workdir = mkdtempSync(path.join(tmpdir(), "cf-e2e-"));
try {
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const connection = await tool("broker_connection");
  check("broker_connection connects", connection.data.connected === true, connection.data);
  check("Command/Output subscribable", connection.data.commandOutputSubscribed === true, connection.data);
  if (connection.data.connected !== true) throw new Error("broker unreachable");

  const version = await tool("mqtt_read_retained", { topic: "$SYS/Coreflux/Version", waitMs: 2000 });
  check("$SYS/Coreflux/Version is retained", version.data.count >= 1, version.data);

  const routes = await tool("broker_command", { command: "-listRoutes" });
  check("-listRoutes envelope", routes.data.success === true && routes.data.command === "ListRoutes", routes.data);

  // Deploy from a notebook written to disk: exercises the .lotnb parser and the deploy ordering.
  const notebook = [
    { kind: 1, language: "markdown", value: "# CI notebook" },
    {
      kind: 2,
      language: "lot",
      value: `DEFINE ACTION ${ACTION}\nON TOPIC "${IN_TOPIC}" DO\n    PUBLISH TOPIC "${OUT_TOPIC}" WITH PAYLOAD\nDEFINE MODEL ${MODEL} WITH TOPIC "ci/${suffix}/status"\n    ADD "last" WITH TOPIC "${OUT_TOPIC}" AS TRIGGER`,
    },
  ];
  const notebookPath = path.join(workdir, "ci.lotnb");
  writeFileSync(notebookPath, JSON.stringify(notebook));

  const lint = await tool("lot_lint", { path: notebookPath });
  check("lot_lint on notebook is clean", lint.data.ok === true, lint.data);

  const dry = await tool("lotnb_deploy", { path: notebookPath, dryRun: true });
  check("lotnb_deploy dry-run orders MODEL before ACTION", dry.data.plan?.[0]?.kind === "MODEL" && dry.data.plan?.[1]?.kind === "ACTION", dry.data);

  const deploy = await tool("lotnb_deploy", { path: notebookPath });
  check("lotnb_deploy deploys both entities", Array.isArray(deploy.data.deployed) && deploy.data.deployed.filter((step) => step.kind).every((step) => step.success === true), deploy.data);

  // The broker publishes the entity snapshot a few seconds after the AddAction envelope, so poll.
  let source;
  for (let attempt = 0; attempt < 6; attempt++) {
    source = await tool("mqtt_read_retained", { topic: `$SYS/Coreflux/Actions/${ACTION}`, waitMs: 2000 });
    if (source.data.count >= 1) break;
  }
  check("deployed action source appears on $SYS/Coreflux/Actions/<name>", source.data.count >= 1 && source.text.includes(ACTION), source.data);

  // Drive the action with real traffic and watch the output topic.
  const subscribePromise = tool("mqtt_subscribe", { topic: OUT_TOPIC, durationMs: 6000, maxMessages: 1 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const publish = await tool("mqtt_publish", { topic: IN_TOPIC, payload: JSON.stringify({ ci: suffix }) });
  check("mqtt_publish", publish.data.published === true, publish.data);
  const received = await subscribePromise;
  check("action republished the payload", received.data.count === 1 && JSON.stringify(received.data.messages[0].payload).includes(suffix), received.data);

  const trace = await tool("broker_action_trace", { action: ACTION, payload: JSON.stringify({ topic: IN_TOPIC, payload: { ci: "trace" } }), durationMs: 4000 });
  check("broker_action_trace arms tracing", trace.data.trace?.success === true, trace.data.trace);
  check("broker_action_trace runs the action", trace.data.run?.success === true, trace.data.run);

  const overview = await tool("broker_overview");
  check("broker_overview returns routes and projects", overview.data.routes !== undefined && overview.data.projects !== undefined, overview.data);

  const template = await tool("broker_route_template", { type: "MQTT_BRIDGE" });
  check("broker_route_template returns a skeleton without ADD METADATA", typeof template.data.skeleton === "string" && !/ADD METADATA/.test(template.data.skeleton), template.data);

  // Project round-trip: upload without loading (does not disturb the broker's active project).
  const projectDir = path.join(workdir, `ci-project-${suffix}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(projectDir);
  writeFileSync(path.join(projectDir, "README.md"), `# CI project ${suffix}\n`);
  writeFileSync(path.join(projectDir, "01-actions.lotnb"), JSON.stringify(notebook));
  const upload = await tool("project_upload", { path: projectDir, name: `ci-project-${suffix}` });
  check("project_upload registers the project", upload.data.envelope?.success === true, upload.data.envelope ?? upload.text);
  if (upload.data.envelope?.success === true) {
    const exported = await tool("project_export", { name: `ci-project-${suffix}`, outputPath: path.join(workdir, "export.zip") });
    check("project_export writes a zip", typeof exported.data.bytes === "number" && exported.data.bytes > 0, exported.data);
    const removed = await tool("broker_command", { command: `-removeProject ci-project-${suffix}` });
    check("-removeProject cleans up", removed.data.success === true, removed.data);
  }
} catch (error) {
  failures++;
  console.error(`FAIL ${error.message}`);
} finally {
  // Always remove what we created.
  for (const [kind, name] of [
    ["ACTION", ACTION],
    ["MODEL", MODEL],
  ]) {
    try {
      const removed = await tool("lot_remove", { kind, name });
      console.log(`cleanup ${kind} ${name}: ${removed.data.success === true ? "removed" : removed.text.slice(0, 200)}`);
    } catch (error) {
      console.log(`cleanup ${kind} ${name}: ${error.message}`);
    }
  }
  rmSync(workdir, { recursive: true, force: true });
  server.stdin.end();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
}
