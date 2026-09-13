import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describeProfiles, loadProfiles, parseBrokersVariable, removeProfile, resolveSettings, saveProfile, setActiveProfile, userBrokersPath, workspaceBrokersPath } from "../scripts/mcp/lib/brokers.mjs";

let home;
let cwd;
let env;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "cf-home-"));
  cwd = mkdtempSync(path.join(tmpdir(), "cf-ws-"));
  env = { COREFLUX_HOME: home }; // no inherited COREFLUX_* variables
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("parseBrokersVariable accepts name=url lists with credentials and query options, and JSON", () => {
  const list = parseBrokersVariable("local=mqtt://root:core%40flux@localhost:1883; edge=mqtts://ops@10.0.0.5:8883?tlsInsecure=true&clientId=cursor-edge\nprod=mqtts://mqtt.example.com:8883?passwordEnv=PROD_PW");
  assert.deepEqual(list.local, { url: "mqtt://localhost:1883", username: "root", password: "core@flux" });
  assert.deepEqual(list.edge, { url: "mqtts://10.0.0.5:8883", username: "ops", tlsInsecure: "true", clientId: "cursor-edge" });
  assert.deepEqual(list.prod, { url: "mqtts://mqtt.example.com:8883", passwordEnv: "PROD_PW" });

  const json = parseBrokersVariable('{"a": "mqtt://a:1883", "b": {"url": "mqtts://b:8883", "username": "u"}}');
  assert.deepEqual(json, { a: { url: "mqtt://a:1883" }, b: { url: "mqtts://b:8883", username: "u" } });

  assert.deepEqual(parseBrokersVariable(""), {});
  assert.deepEqual(parseBrokersVariable("${COREFLUX_BROKERS}"), {}, "unexpanded plugin variable is ignored");
  assert.throws(() => parseBrokersVariable("nonsense"), /name=mqtt/);
  assert.throws(() => parseBrokersVariable("x=not a url"), /invalid URL/);
});

test("with nothing configured the built-in localhost profile is active", () => {
  const loaded = loadProfiles({ env, cwd });
  assert.deepEqual(Object.keys(loaded.profiles), ["localhost"]);
  assert.equal(loaded.active, "localhost");
  assert.equal(loaded.activeSource, "built-in fallback");
  const settings = resolveSettings({ env, cwd });
  assert.equal(settings.url, "mqtt://localhost:1883");
  assert.equal(settings.username, undefined);
  assert.equal(settings.rejectUnauthorized, true);
});

test("COREFLUX_MQTT_* variables become the default profile and win over .broker", () => {
  writeFileSync(path.join(cwd, ".broker"), "mqtt://legacy:1883\nusername=old\npassword=pw\n");
  const legacyOnly = resolveSettings({ env, cwd });
  assert.equal(legacyOnly.profile, "workspace");
  assert.equal(legacyOnly.url, "mqtt://legacy:1883");
  assert.equal(legacyOnly.username, "old");

  const withVars = resolveSettings({ env: { ...env, COREFLUX_MQTT_URL: "mqtts://team:8883", COREFLUX_MQTT_USERNAME: "root", COREFLUX_MQTT_PASSWORD: "s3cret", COREFLUX_MQTT_TLS_INSECURE: "true" }, cwd });
  assert.equal(withVars.profile, "default");
  assert.equal(withVars.url, "mqtts://team:8883");
  assert.equal(withVars.password, "s3cret");
  assert.equal(withVars.rejectUnauthorized, false);
  assert.match(withVars.source, /profile "default"/);
});

test("precedence: COREFLUX_BROKER > workspace active > user active > default", () => {
  const brokersEnv = { ...env, COREFLUX_BROKERS: "a=mqtt://a:1883; b=mqtt://b:1883; c=mqtt://c:1883", COREFLUX_MQTT_URL: "mqtt://default:1883" };
  assert.equal(loadProfiles({ env: brokersEnv, cwd }).active, "default");

  saveProfile({ scope: "user", name: "u", url: "mqtt://u:1883", activate: true, env: brokersEnv, cwd });
  assert.equal(loadProfiles({ env: brokersEnv, cwd }).active, "u");

  setActiveProfile({ scope: "workspace", name: "b", env: brokersEnv, cwd });
  assert.equal(loadProfiles({ env: brokersEnv, cwd }).active, "b");

  const pinned = loadProfiles({ env: { ...brokersEnv, COREFLUX_BROKER: "c" }, cwd });
  assert.equal(pinned.active, "c");
  assert.equal(pinned.activeSource, "COREFLUX_BROKER variable");

  const session = loadProfiles({ env: { ...brokersEnv, COREFLUX_BROKER: "c" }, cwd, sessionOverride: "a" });
  assert.equal(session.active, "a");

  const missing = loadProfiles({ env: { ...brokersEnv, COREFLUX_BROKER: "nope" }, cwd });
  assert.equal(missing.active, "b", "an unknown selection falls through to the next source");
  assert.match(missing.warnings.join("\n"), /"nope" but no such profile/);
});

test("workspace file overrides a same-named user profile field by field source", () => {
  saveProfile({ scope: "user", name: "edge", url: "mqtt://user-edge:1883", username: "alice", password: "pw", env, cwd });
  saveProfile({ scope: "workspace", name: "edge", url: "mqtt://ws-edge:1883", username: "bob", passwordEnv: "EDGE_PW", env, cwd });
  const loaded = loadProfiles({ env, cwd });
  assert.equal(loaded.profiles.edge.url, "mqtt://ws-edge:1883");
  assert.equal(loaded.profiles.edge.username, "bob");
  assert.equal(loaded.profiles.edge.password, undefined, "workspace definition replaces the user one entirely");
  assert.match(loaded.profiles.edge.source, /workspace file/);

  const unresolved = resolveSettings({ env: { ...env, COREFLUX_BROKER: "edge" }, cwd });
  assert.equal(unresolved.password, undefined);
  assert.match(unresolved.warnings.join("\n"), /\$EDGE_PW, which is not set/);
  const resolved = resolveSettings({ env: { ...env, COREFLUX_BROKER: "edge", EDGE_PW: "from-env" }, cwd });
  assert.equal(resolved.password, "from-env");
});

test("saveProfile writes JSON with restricted mode, merges fields, clears with null and validates", () => {
  const first = saveProfile({ scope: "user", name: "lab", url: "mqtt://lab:1883", username: "root", password: "coreflux", description: "Bench broker", env, cwd });
  assert.equal(first.file, userBrokersPath(env));
  assert.equal(first.profile.password, "•••••", "the response must not echo the password");
  const stored = JSON.parse(readFileSync(first.file, "utf8"));
  assert.equal(stored.brokers.lab.password, "coreflux");
  assert.equal(stored.active, undefined);

  saveProfile({ scope: "user", name: "lab", password: null, passwordEnv: "LAB_PW", tlsInsecure: true, env, cwd });
  const merged = JSON.parse(readFileSync(first.file, "utf8")).brokers.lab;
  assert.equal(merged.url, "mqtt://lab:1883", "unspecified fields are kept");
  assert.equal(merged.password, undefined);
  assert.equal(merged.passwordEnv, "LAB_PW");
  assert.equal(merged.tlsInsecure, true);

  assert.throws(() => saveProfile({ scope: "user", name: "bad name!", url: "mqtt://x", env, cwd }), /invalid/);
  assert.throws(() => saveProfile({ scope: "user", name: "nourl", username: "x", env, cwd }), /needs a url/);
  assert.throws(() => saveProfile({ scope: "user", name: "http", url: "http://x", env, cwd }), /needs a url/);
  assert.throws(() => saveProfile({ scope: "elsewhere", name: "x", url: "mqtt://x", env, cwd }), /scope must be/);
});

test("removeProfile and setActiveProfile keep the files consistent", () => {
  saveProfile({ scope: "workspace", name: "one", url: "mqtt://one:1883", activate: true, env, cwd });
  saveProfile({ scope: "workspace", name: "two", url: "mqtt://two:1883", env, cwd });
  const file = workspaceBrokersPath(cwd);
  assert.ok(existsSync(file));
  assert.equal(loadProfiles({ env, cwd }).active, "one");

  const removed = removeProfile({ scope: "workspace", name: "one", env, cwd });
  assert.deepEqual(removed.remaining, ["two"]);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.active, undefined, "removing the active profile clears the selection");
  assert.equal(loadProfiles({ env, cwd }).active, "localhost");

  assert.throws(() => removeProfile({ scope: "workspace", name: "ghost", env, cwd }), /not defined/);
  assert.throws(() => setActiveProfile({ scope: "user", name: "ghost", env, cwd }), /Unknown profile/);
  setActiveProfile({ scope: "user", name: "two", env, cwd });
  assert.equal(loadProfiles({ env, cwd }).active, "two");
  assert.equal(loadProfiles({ env, cwd }).activeSource, `user file ${userBrokersPath(env)}`);
});

test("describeProfiles never exposes passwords and marks the active one", () => {
  mkdirSync(path.join(cwd, ".coreflux"));
  writeFileSync(path.join(cwd, ".coreflux", "brokers.json"), JSON.stringify({ active: "prod", brokers: { prod: { url: "mqtts://p:8883", username: "svc", password: "top-secret" }, broken: { username: "no-url" } } }));
  const loaded = loadProfiles({ env, cwd });
  assert.match(loaded.warnings.join("\n"), /"broken" has no valid/);
  const described = describeProfiles(loaded);
  const prod = described.find((profile) => profile.name === "prod");
  assert.equal(prod.active, true);
  assert.equal(prod.auth, "password");
  assert.equal(JSON.stringify(described).includes("top-secret"), false);
  assert.equal(described.find((profile) => profile.name === "localhost").active, false);
});

test("a corrupt brokers.json is reported, not fatal", () => {
  mkdirSync(path.dirname(userBrokersPath(env)), { recursive: true });
  writeFileSync(userBrokersPath(env), "{ not json");
  const loaded = loadProfiles({ env, cwd });
  assert.equal(loaded.active, "localhost");
  assert.match(loaded.warnings.join("\n"), /invalid JSON/);
  assert.throws(() => saveProfile({ scope: "user", name: "x", url: "mqtt://x:1883", env, cwd }), /invalid JSON/, "never overwrite a file we could not parse");
});
