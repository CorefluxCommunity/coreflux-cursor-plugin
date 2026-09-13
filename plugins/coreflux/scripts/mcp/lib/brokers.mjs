// Broker profiles: named connection settings the MCP tools can switch between.
//
// Sources, later ones override earlier ones with the same name:
//   1. `localhost`            implicit anonymous mqtt://localhost:1883
//   2. COREFLUX_BROKERS       plugin variable / env: "name=mqtt://user:pass@host:1883; other=mqtts://…"
//                             or a JSON object { name: { url, username, password, … } }
//   3. ~/.coreflux/brokers.json            user profiles      { active, brokers: { name: {…} } }
//   4. <cwd>/.coreflux/brokers.json        workspace profiles (same shape)
//   5. <cwd>/.broker                       legacy single-broker file → profile `workspace`
//   6. COREFLUX_MQTT_URL (+ USERNAME/PASSWORD/CLIENT_ID/TLS_INSECURE) → profile `default`
//
// Active profile, first match wins:
//   session override (broker_use) → COREFLUX_BROKER → workspace file `active` → user file `active`
//   → `default` (plugin connection variables) → `workspace` (.broker file) → `localhost`.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const IMPLICIT_PROFILE = "localhost";
export const DEFAULT_PROFILE = "default";
export const BROKER_FILE_PROFILE = "workspace";
export const PROFILE_FIELDS = ["url", "username", "password", "passwordEnv", "clientId", "tlsInsecure", "description"];

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidProfileName(name) {
  return typeof name === "string" && NAME_PATTERN.test(name);
}

export function userBrokersPath(env = process.env) {
  const override = clean(env.COREFLUX_BROKERS_FILE);
  if (override) return override;
  const home = clean(env.COREFLUX_HOME) ?? path.join(homedir(), ".coreflux");
  return path.join(home, "brokers.json");
}

export function workspaceBrokersPath(cwd = process.cwd()) {
  return path.join(cwd, ".coreflux", "brokers.json");
}

function clean(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === "" || trimmed.startsWith("${")) return undefined; // unexpanded plugin variable
  return trimmed;
}

function normaliseProfile(name, raw, source) {
  if (!raw || typeof raw !== "object") return null;
  const url = clean(raw.url);
  if (!url || !/^(mqtt|mqtts|tcp|ssl|tls)s?:\/\//i.test(url)) return null;
  const profile = { name, url, source };
  if (clean(raw.username ?? raw.user)) profile.username = clean(raw.username ?? raw.user);
  if (raw.password !== undefined && raw.password !== null && String(raw.password) !== "") profile.password = String(raw.password);
  if (clean(raw.passwordEnv)) profile.passwordEnv = clean(raw.passwordEnv);
  if (clean(raw.clientId)) profile.clientId = clean(raw.clientId);
  if (raw.tlsInsecure !== undefined) profile.tlsInsecure = String(raw.tlsInsecure).toLowerCase() === "true";
  if (clean(raw.description)) profile.description = clean(raw.description);
  return profile;
}

/**
 * Parses the COREFLUX_BROKERS variable. Accepts a JSON object or a `;`/newline separated list of
 * `name=url` pairs where the URL may carry `user:pass@` and `?tlsInsecure=true&clientId=x`.
 */
export function parseBrokersVariable(value) {
  const text = clean(value);
  if (!text) return {};
  if (text.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`COREFLUX_BROKERS is not valid JSON: ${error.message}`);
    }
    return Object.fromEntries(Object.entries(parsed).map(([name, raw]) => [name, typeof raw === "string" ? { url: raw } : raw]));
  }
  const result = {};
  for (const entry of text.split(/[;\n]/).map((part) => part.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`COREFLUX_BROKERS entry "${entry}" must look like name=mqtt://host:1883`);
    const name = entry.slice(0, eq).trim();
    let url;
    try {
      url = new URL(entry.slice(eq + 1).trim());
    } catch {
      throw new Error(`COREFLUX_BROKERS entry "${name}" has an invalid URL`);
    }
    const raw = { url: `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}` };
    if (url.username) raw.username = decodeURIComponent(url.username);
    if (url.password) raw.password = decodeURIComponent(url.password);
    for (const [key, val] of url.searchParams) {
      if (key === "tlsInsecure") raw.tlsInsecure = val;
      else if (key === "clientId") raw.clientId = val;
      else if (key === "passwordEnv") raw.passwordEnv = val;
      else if (key === "description") raw.description = val;
    }
    result[name] = raw;
  }
  return result;
}

export function readBrokersFile(file) {
  if (!existsSync(file)) return { file, exists: false, active: undefined, brokers: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { file, exists: true, error: `invalid JSON (${error.message})`, active: undefined, brokers: {} };
  }
  const brokers = parsed?.brokers && typeof parsed.brokers === "object" ? parsed.brokers : {};
  return { file, exists: true, active: clean(parsed?.active), brokers };
}

function writeBrokersFile(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ active: data.active, brokers: data.brokers }, null, 2)}\n`;
  writeFileSync(file, body, "utf8");
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best effort — the file may live on a filesystem without POSIX modes
    }
  }
}

/** Legacy `.broker` file: URL on one line, key=value pairs for the rest. */
export function readLegacyBrokerFile(env = process.env, cwd = process.cwd()) {
  const candidates = [clean(env.COREFLUX_BROKER_FILE), path.join(cwd, ".broker")].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const lines = readFileSync(candidate, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    const settings = { file: candidate };
    for (const line of lines) {
      if (/^[a-z]+:\/\//i.test(line)) {
        settings.url = line;
        continue;
      }
      const eq = line.indexOf("=");
      if (eq > 0) settings[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return settings;
  }
  return null;
}

/**
 * Collects every profile visible from `cwd` with the given environment.
 * @returns {{ profiles: Record<string, object>, active: string, activeSource: string, files: object, warnings: string[] }}
 */
export function loadProfiles({ env = process.env, cwd = process.cwd(), sessionOverride } = {}) {
  const warnings = [];
  const profiles = {};
  const add = (name, raw, source) => {
    if (!isValidProfileName(name)) {
      warnings.push(`${source}: profile name "${name}" is invalid (letters, digits, . _ -)`);
      return;
    }
    const profile = normaliseProfile(name, raw, source);
    if (!profile) {
      warnings.push(`${source}: profile "${name}" has no valid mqtt:// or mqtts:// url and was skipped`);
      return;
    }
    profiles[name] = profile;
  };

  add(IMPLICIT_PROFILE, { url: "mqtt://localhost:1883", description: "Anonymous local broker (built in)" }, "built-in");

  try {
    for (const [name, raw] of Object.entries(parseBrokersVariable(env.COREFLUX_BROKERS))) add(name, raw, "COREFLUX_BROKERS variable");
  } catch (error) {
    warnings.push(error.message);
  }

  const userFile = readBrokersFile(userBrokersPath(env));
  if (userFile.error) warnings.push(`${userFile.file}: ${userFile.error}`);
  for (const [name, raw] of Object.entries(userFile.brokers)) add(name, raw, `user file ${userFile.file}`);

  const workspaceFile = readBrokersFile(workspaceBrokersPath(cwd));
  if (workspaceFile.error) warnings.push(`${workspaceFile.file}: ${workspaceFile.error}`);
  for (const [name, raw] of Object.entries(workspaceFile.brokers)) add(name, raw, `workspace file ${workspaceFile.file}`);

  const legacy = readLegacyBrokerFile(env, cwd);
  if (legacy?.url) {
    add(BROKER_FILE_PROFILE, { url: legacy.url, username: legacy.username ?? legacy.user, password: legacy.password, clientId: legacy.clientId, tlsInsecure: legacy.tlsInsecure }, `.broker file ${legacy.file}`);
  }

  if (clean(env.COREFLUX_MQTT_URL)) {
    add(
      DEFAULT_PROFILE,
      { url: env.COREFLUX_MQTT_URL, username: env.COREFLUX_MQTT_USERNAME, password: clean(env.COREFLUX_MQTT_PASSWORD), clientId: env.COREFLUX_MQTT_CLIENT_ID, tlsInsecure: clean(env.COREFLUX_MQTT_TLS_INSECURE) ?? "false", description: "Plugin connection variables" },
      "plugin variables (COREFLUX_MQTT_*)",
    );
  }

  const candidates = [
    [sessionOverride, "broker_use (this session)"],
    [clean(env.COREFLUX_BROKER), "COREFLUX_BROKER variable"],
    [workspaceFile.active, `workspace file ${workspaceFile.file}`],
    [userFile.active, `user file ${userFile.file}`],
    [profiles[DEFAULT_PROFILE] ? DEFAULT_PROFILE : undefined, "plugin connection variables"],
    [profiles[BROKER_FILE_PROFILE] ? BROKER_FILE_PROFILE : undefined, ".broker file"],
    [IMPLICIT_PROFILE, "built-in fallback"],
  ];
  let active = IMPLICIT_PROFILE;
  let activeSource = "built-in fallback";
  for (const [name, source] of candidates) {
    if (!name) continue;
    if (!profiles[name]) {
      warnings.push(`${source} selects profile "${name}" but no such profile exists`);
      continue;
    }
    active = name;
    activeSource = source;
    break;
  }

  return { profiles, active, activeSource, files: { user: userFile.file, workspace: workspaceFile.file }, warnings };
}

/**
 * Turns the active profile into the settings object the MQTT client consumes.
 */
export function resolveSettings(options = {}) {
  const env = options.env ?? process.env;
  const loaded = loadProfiles(options);
  const profile = loaded.profiles[loaded.active];
  let password = profile.password;
  if (!password && profile.passwordEnv) {
    password = clean(env[profile.passwordEnv]);
    if (!password) loaded.warnings.push(`profile "${profile.name}" reads its password from $${profile.passwordEnv}, which is not set`);
  }
  return {
    profile: profile.name,
    url: profile.url,
    username: profile.username,
    password,
    clientId: profile.clientId,
    rejectUnauthorized: profile.tlsInsecure !== true,
    source: `profile "${profile.name}" via ${loaded.activeSource} (defined by ${profile.source})`,
    description: profile.description,
    warnings: loaded.warnings,
  };
}

/** Public, password-free view of every profile for listing. */
export function describeProfiles(loaded) {
  return Object.values(loaded.profiles)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((profile) => ({
      name: profile.name,
      active: profile.name === loaded.active,
      url: profile.url,
      username: profile.username ?? null,
      auth: profile.password ? "password" : profile.passwordEnv ? `env ${profile.passwordEnv}` : "none",
      clientId: profile.clientId,
      tlsInsecure: profile.tlsInsecure === true || undefined,
      description: profile.description,
      source: profile.source,
    }));
}

function scopeFile(scope, env, cwd) {
  if (scope === "user") return userBrokersPath(env);
  if (scope === "workspace") return workspaceBrokersPath(cwd);
  throw new Error(`scope must be "user" or "workspace" (got ${scope})`);
}

/**
 * Creates or updates a profile in the user or workspace brokers.json.
 * Fields set to null are removed; undefined fields are left as they are.
 */
export function saveProfile({ scope = "user", name, activate = false, env = process.env, cwd = process.cwd(), ...fields }) {
  if (!isValidProfileName(name)) throw new Error(`Profile name "${name}" is invalid (letters, digits, . _ - ; max 64 chars)`);
  if (name === IMPLICIT_PROFILE && !fields.url) throw new Error(`"${IMPLICIT_PROFILE}" is the built-in profile; give the new one a different name`);
  const file = scopeFile(scope, env, cwd);
  const data = readBrokersFile(file);
  if (data.error) throw new Error(`${file}: ${data.error}`);
  const current = { ...(data.brokers[name] ?? {}) };
  for (const key of PROFILE_FIELDS) {
    if (fields[key] === undefined) continue;
    if (fields[key] === null) delete current[key];
    else current[key] = key === "tlsInsecure" ? String(fields[key]).toLowerCase() === "true" : fields[key];
  }
  if (!normaliseProfile(name, current, scope)) throw new Error(`Profile "${name}" needs a url like mqtt://host:1883 or mqtts://host:8883`);
  if (current.password && current.passwordEnv) delete current.passwordEnv;
  data.brokers[name] = current;
  if (activate) data.active = name;
  writeBrokersFile(file, data);
  return { file, name, active: data.active === name, profile: { ...current, password: current.password ? "•••••" : undefined } };
}

export function removeProfile({ scope = "user", name, env = process.env, cwd = process.cwd() }) {
  const file = scopeFile(scope, env, cwd);
  const data = readBrokersFile(file);
  if (!data.exists) throw new Error(`${file} does not exist`);
  if (data.error) throw new Error(`${file}: ${data.error}`);
  if (!data.brokers[name]) throw new Error(`Profile "${name}" is not defined in ${file}`);
  delete data.brokers[name];
  if (data.active === name) data.active = undefined;
  writeBrokersFile(file, data);
  return { file, removed: name, remaining: Object.keys(data.brokers) };
}

/** Records `active` in the user or workspace file so the choice survives restarts. */
export function setActiveProfile({ scope = "user", name, env = process.env, cwd = process.cwd() }) {
  const loaded = loadProfiles({ env, cwd });
  if (!loaded.profiles[name]) throw new Error(`Unknown profile "${name}". Known: ${Object.keys(loaded.profiles).join(", ")}`);
  const file = scopeFile(scope, env, cwd);
  const data = readBrokersFile(file);
  if (data.error) throw new Error(`${file}: ${data.error}`);
  data.active = name;
  writeBrokersFile(file, data);
  return { file, active: name };
}
