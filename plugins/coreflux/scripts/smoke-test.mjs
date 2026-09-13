#!/usr/bin/env node
// Smoke test for the coreflux-broker MCP server: lists tools, tests the connection, runs
// read-only commands and a lint. Never deploys or removes anything.
//
//   COREFLUX_MQTT_URL=mqtt://localhost:1883 COREFLUX_MQTT_USERNAME=root COREFLUX_MQTT_PASSWORD=… node scripts/smoke-test.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [path.join(here, "mcp", "coreflux-mqtt-mcp.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const reader = createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;

reader.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});

function call(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function tool(name, args = {}) {
  return call("tools/call", { name, arguments: args });
}

function print(label, message) {
  const body = message.result?.content?.[0]?.text ?? JSON.stringify(message.error ?? message);
  console.log(`\n== ${label}${message.result?.isError ? " (error)" : ""}\n${body.length > 1500 ? `${body.slice(0, 1500)}\n…` : body}`);
}

let failed = false;
try {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test", version: "0" } });
  console.log(`server: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list = await call("tools/list");
  console.log(`tools (${list.result.tools.length}): ${list.result.tools.map((entry) => entry.name).join(", ")}`);

  const connection = await tool("broker_connection");
  print("broker_connection", connection);
  const connected = JSON.parse(connection.result.content[0].text).connected === true;

  print("lot_lint", await tool("lot_lint", { code: 'DEFINE ACTION SmokeLint\nON TOPIC "smoke/in" DO\n    PUBLISH TOPIC "smoke/out" WITH PAYLOAD' }));

  if (connected) {
    print("broker_command -listRoutes", await tool("broker_command", { command: "-listRoutes", timeoutMs: 8000 }));
    print("broker_overview", await tool("broker_overview"));
  } else {
    console.log("\nBroker not reachable — skipped command checks.");
    failed = true;
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  server.stdin.end();
  process.exitCode = failed ? 1 : 0;
}
