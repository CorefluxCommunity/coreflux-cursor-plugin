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

const isolatedEnv = (home) => ({ COREFLUX_HOME: home, COREFLUX_BROKERS: "", COREFLUX_BROKER: "", COREFLUX_MQTT_URL: "", COREFLUX_MQTT_USERNAME: "", COREFLUX_MQTT_PASSWORD: "" });

test("session hook reports the active broker profile, the alternatives and notebook counts", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "cf-hook-"));
  const home = mkdtempSync(path.join(tmpdir(), "cf-hook-home-"));
  try {
    writeFileSync(path.join(dir, ".broker"), "# broker\nmqtt://10.0.0.5:1883\nusername=root\n");
    mkdirSync(path.join(dir, "project"));
    writeFileSync(path.join(dir, "project", "01-models.lotnb"), "[]");
    writeFileSync(path.join(dir, "project", "extra.lot"), "");
    const result = await runHook("session-context.mjs", {}, { ...isolatedEnv(home), CURSOR_PROJECT_DIR: dir });
    assert.match(result.additional_context, /Active broker profile "workspace" → mqtt:\/\/10\.0\.0\.5:1883 as root/);
    assert.match(result.additional_context, /Other profiles: localhost/);
    assert.match(result.additional_context, /1 \.lotnb notebook\(s\) and 1 \.lot file\(s\)/);

    const empty = mkdtempSync(path.join(tmpdir(), "cf-hook-empty-"));
    try {
      const bare = await runHook("session-context.mjs", {}, { ...isolatedEnv(home), CURSOR_PROJECT_DIR: empty });
      assert.match(bare.additional_context, /Active broker profile "localhost"/);
      assert.match(bare.additional_context, /No other broker profiles/);
      assert.doesNotMatch(bare.additional_context, /notebook/);

      const multi = await runHook("session-context.mjs", {}, { ...isolatedEnv(home), CURSOR_PROJECT_DIR: empty, COREFLUX_BROKERS: "edge=mqtt://edge:1883; prod=mqtts://prod:8883", COREFLUX_BROKER: "prod" });
      assert.match(multi.additional_context, /Active broker profile "prod" → mqtts:\/\/prod:8883 \(chosen by COREFLUX_BROKER variable\)/);
      assert.match(multi.additional_context, /Other profiles: edge, localhost/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("extension hook installs the LOT Notebooks extension once and caches the result", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(path.join(tmpdir(), "cf-ext-home-"));
  const fakeCliDir = mkdtempSync(path.join(tmpdir(), "cf-ext-cli-"));
  // A stand-in for the `cursor` CLI: lists whatever is in installed.txt and appends on install.
  const installedFile = path.join(fakeCliDir, "installed.txt");
  const cli = path.join(fakeCliDir, "fake-cursor.mjs");
  writeFileSync(
    cli,
    `import { readFileSync, appendFileSync, existsSync } from "node:fs";
const file = ${JSON.stringify(installedFile)};
const [command, id] = process.argv.slice(2);
if (command === "--list-extensions") process.stdout.write(existsSync(file) ? readFileSync(file, "utf8") : "");
else if (command === "--install-extension") appendFileSync(file, id + "\\n");
else process.exit(2);
`,
  );
  const env = { COREFLUX_HOME: home, COREFLUX_CURSOR_CLI: JSON.stringify([process.execPath, cli]) };
  const stateFile = path.join(home, "plugin-state.json");
  try {
    writeFileSync(installedFile, "github.copilot\n");
    const first = await runHook("ensure-lot-extension.mjs", {}, env);
    assert.match(first.additional_context, /coreflux\.vscode-lot-notebooks.*being installed/);
    await new Promise((resolve) => setTimeout(resolve, 700)); // detached install runs in the background
    assert.match(readFileSync(installedFile, "utf8"), /coreflux\.vscode-lot-notebooks/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).lotExtension.installed, false);

    const second = await runHook("ensure-lot-extension.mjs", {}, env);
    assert.deepEqual(second, {}, "already installed → nothing to say");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.lotExtension.installed, true);

    writeFileSync(installedFile, ""); // extension removed, but the daily cache says installed
    assert.deepEqual(await runHook("ensure-lot-extension.mjs", {}, env), {});

    assert.deepEqual(await runHook("ensure-lot-extension.mjs", {}, { ...env, COREFLUX_INSTALL_LOT_EXTENSION: "false" }), {});
    writeFileSync(stateFile, JSON.stringify({ installLotExtension: false }));
    assert.deepEqual(await runHook("ensure-lot-extension.mjs", {}, env), {});
    assert.ok(existsSync(stateFile));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeCliDir, { recursive: true, force: true });
  }
});
