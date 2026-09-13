import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { destructiveReason, normaliseVerb } from "../scripts/hooks/lib/destructive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hooksDir = path.resolve(here, "..", "scripts", "hooks");

function runHook(script, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(hooksDir, script)], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`${script} exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`${script} wrote invalid JSON: ${stdout} (${error.message})`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test("normaliseVerb and destructiveReason classify verbs regardless of spelling", () => {
  assert.equal(normaliseVerb("--remove-all-routes"), "-removeallroutes");
  assert.equal(normaliseVerb("-removeAllRoutes"), "-removeallroutes");
  assert.match(destructiveReason("-removeAllRoutes"), /deletes every route/);
  assert.match(destructiveReason("  -removeProject demo"), /deletes a project/);
  assert.equal(destructiveReason("-listRoutes"), null);
  assert.equal(destructiveReason(""), null);
});

test("MCP guard allows other servers and read-only broker tools", async () => {
  assert.deepEqual(await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-docs", tool_name: "search", tool_input: "{}" }), { permission: "allow" });
  assert.deepEqual(await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-broker", tool_name: "broker_command", tool_input: JSON.stringify({ command: "-listRoutes" }) }), { permission: "allow" });
  assert.deepEqual(await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-broker", tool_name: "mqtt_publish", tool_input: JSON.stringify({ topic: "sensors/a", payload: "1" }) }), { permission: "allow" });
});

test("MCP guard asks before destructive broker commands, $SYS retained writes and project loads", async () => {
  const removeAll = await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-broker", tool_name: "broker_command", tool_input: JSON.stringify({ command: "-removeAllActions" }) });
  assert.equal(removeAll.permission, "ask");
  assert.match(removeAll.user_message, /-removeAllActions/);

  const viaPublish = await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-broker", tool_name: "mqtt_publish", tool_input: JSON.stringify({ topic: "$SYS/Coreflux/Command", payload: "-removeUser bob" }) });
  assert.equal(viaPublish.permission, "ask");

  const sysRetained = await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-broker", tool_name: "mqtt_publish", tool_input: JSON.stringify({ topic: "$SYS/Coreflux/Whatever", payload: "x", retain: true }) });
  assert.equal(sysRetained.permission, "ask");

  const load = await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-broker", tool_name: "project_upload", tool_input: JSON.stringify({ path: "./demo", load: true }) });
  assert.equal(load.permission, "ask");
  const noLoad = await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-broker", tool_name: "project_upload", tool_input: JSON.stringify({ path: "./demo" }) });
  assert.equal(noLoad.permission, "allow");
});

test("MCP guard tolerates malformed tool_input", async () => {
  const result = await runHook("guard-broker-tools.mjs", { mcp_server_name: "coreflux-broker", tool_name: "broker_command", tool_input: "{not json" });
  assert.equal(result.permission, "allow");
});

test("shell guard only inspects commands aimed at the broker", async () => {
  assert.deepEqual(await runHook("guard-shell-commands.mjs", { command: "ls -la" }), { permission: "allow" });
  assert.deepEqual(await runHook("guard-shell-commands.mjs", { command: "mosquitto_pub -t '$SYS/Coreflux/Command' -m '-listRoutes'" }), { permission: "allow" });

  const destructive = await runHook("guard-shell-commands.mjs", { command: `mosquitto_pub -t '$SYS/Coreflux/Command' -m '-removeUser bob'` });
  assert.equal(destructive.permission, "ask");
  assert.match(destructive.user_message, /sends -removeUser to the broker/);

  const kebab = await runHook("guard-shell-commands.mjs", { command: `python publish.py --topic "$SYS/Coreflux/Command" --payload "--remove-all-routes"` });
  assert.equal(kebab.permission, "ask");
});

test("session hook reports .broker URL and notebook counts", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "cf-hook-"));
  try {
    writeFileSync(path.join(dir, ".broker"), "# broker\nmqtt://10.0.0.5:1883\nusername=root\n");
    mkdirSync(path.join(dir, "project"));
    writeFileSync(path.join(dir, "project", "01-models.lotnb"), "[]");
    writeFileSync(path.join(dir, "project", "extra.lot"), "");
    const result = await runHook("session-context.mjs", {}, { CURSOR_PROJECT_DIR: dir });
    assert.match(result.additional_context, /mqtt:\/\/10\.0\.0\.5:1883/);
    assert.match(result.additional_context, /1 \.lotnb notebook\(s\) and 1 \.lot file\(s\)/);

    const empty = mkdtempSync(path.join(tmpdir(), "cf-hook-empty-"));
    try {
      assert.deepEqual(await runHook("session-context.mjs", {}, { CURSOR_PROJECT_DIR: empty }), {});
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
