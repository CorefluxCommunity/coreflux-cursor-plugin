#!/usr/bin/env node
// Coreflux broker MCP server (stdio) — dependency-free.
//
// Exposes the Coreflux broker command surface ($SYS/Coreflux/Command -> $SYS/Coreflux/Command/Output)
// plus raw MQTT publish/subscribe, LoT linting, and .lot/.lotnb deployment as MCP tools.
//
// Connection settings come from named broker profiles (see ./lib/brokers.mjs): plugin variables
// (COREFLUX_BROKERS, COREFLUX_MQTT_*), ~/.coreflux/brokers.json, <cwd>/.coreflux/brokers.json and
// the legacy <cwd>/.broker file. `broker_list` shows them, `broker_use` switches at runtime.

import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { MqttClient, topicMatches } from "./lib/mqtt-client.mjs";
import { deployCommand, lintLot, loadLotFile, sortForDeploy, splitLotEntities, ENTITY_COMMANDS } from "./lib/lot.mjs";
import { zipDirectory } from "./lib/zip.mjs";
import { describeProfiles, loadProfiles, removeProfile, resolveSettings as resolveProfileSettings, saveProfile, setActiveProfile } from "./lib/brokers.mjs";

const SERVER_NAME = "coreflux-broker";
const SERVER_VERSION = "0.1.0";
const COMMAND_TOPIC = "$SYS/Coreflux/Command";
const OUTPUT_TOPIC = "$SYS/Coreflux/Command/Output";
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_SUBSCRIBE_MS = 120000;

// ---------------------------------------------------------------------------------------------
// Connection settings
// ---------------------------------------------------------------------------------------------

/** Profile chosen with broker_use for the lifetime of this server process (null = configured default). */
let sessionProfile = null;

function resolveSettings() {
  return resolveProfileSettings({ sessionOverride: sessionProfile });
}

function currentProfiles() {
  return loadProfiles({ sessionOverride: sessionProfile });
}

// ---------------------------------------------------------------------------------------------
// Broker session: one MQTT connection, command/response correlation, topic capture helpers
// ---------------------------------------------------------------------------------------------

class BrokerSession {
  constructor() {
    this.client = null;
    this.waiters = []; // { requestId, expectedCommand, resolve, reject, timer }
    this.listeners = new Set(); // (message) => void
    this.outputSubscribed = false;
  }

  async connect() {
    if (this.client?.connected) return this.client;
    const settings = resolveSettings();
    this.settings = settings;
    const client = new MqttClient({
      url: settings.url,
      username: settings.username,
      password: settings.password,
      clientId: settings.clientId,
      rejectUnauthorized: settings.rejectUnauthorized,
    });
    client.on("message", (message) => this.onMessage(message));
    client.on("close", () => {
      this.outputSubscribed = false;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("MQTT connection closed while waiting for the broker response"));
      }
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async ensureOutputSubscription() {
    const client = await this.connect();
    if (this.outputSubscribed) return;
    try {
      await client.subscribe(OUTPUT_TOPIC, 1);
      this.outputSubscribed = true;
    } catch (error) {
      throw new Error(`${error.message}. The user needs SubscribeSys access to ${OUTPUT_TOPIC} (root, admin, AllowedSystemConfiguration or AllowedUserManagement).`);
    }
  }

  onMessage(message) {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // listener errors must not break the stream
      }
    }
    if (message.topic !== OUTPUT_TOPIC || this.waiters.length === 0) return;

    const text = message.payload.toString("utf8");
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      envelope = { raw: text };
    }

    let index = -1;
    if (envelope.requestId) {
      index = this.waiters.findIndex((waiter) => waiter.requestId === envelope.requestId);
      if (index < 0) return; // somebody else's response
    } else {
      const command = String(envelope.command ?? "").toLowerCase();
      index = this.waiters.findIndex((waiter) => command && waiter.expectedCommand === command);
      if (index < 0 && this.waiters.length === 1) index = 0;
      if (index < 0) return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(envelope);
  }

  /**
   * Publishes a command and waits for its envelope on $SYS/Coreflux/Command/Output.
   * @param {string} command e.g. "-listRoutes" or "-addAction DEFINE ACTION …"
   */
  async command(command, { timeoutMs = DEFAULT_TIMEOUT_MS, expectResponse = true } = {}) {
    const trimmed = command.trim();
    if (!trimmed.startsWith("-")) throw new Error(`Commands start with a dash, e.g. -listRoutes (got "${trimmed.slice(0, 30)}")`);
    await this.ensureOutputSubscription();

    const requestId = `cursor-${randomUUID().slice(0, 8)}`;
    const verb = trimmed.split(/\s+/)[0];
    const expectedCommand = verb.replace(/^-+/, "").replace(/-/g, "").toLowerCase();
    const payload = `${trimmed} -requestId ${requestId}`;

    if (!expectResponse) {
      await this.client.publish(COMMAND_TOPIC, payload, { qos: 1 });
      return { published: true, requestId, note: "No response expected for this command." };
    }

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((waiter) => waiter.requestId === requestId);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`No response on ${OUTPUT_TOPIC} within ${timeoutMs} ms for ${verb} (requestId ${requestId}). Check that the user has CommandCall permission and that the broker is a Coreflux broker.`));
      }, timeoutMs);
      this.waiters.push({ requestId, expectedCommand, resolve, reject, timer });
    });
    await this.client.publish(COMMAND_TOPIC, payload, { qos: 1 });
    return response;
  }

  /**
   * Subscribes to a filter, collects messages for a duration, then unsubscribes.
   */
  async capture(filter, { durationMs = 3000, maxMessages = 50, retainedOnly = false, stopWhen } = {}) {
    const client = await this.connect();
    const messages = [];
    let done;
    const finished = new Promise((resolve) => (done = resolve));
    const listener = (message) => {
      if (!topicMatches(filter, message.topic)) return;
      // Coreflux delivers $SYS/Coreflux entity snapshots (action/model/route source, status) to a
      // new subscriber without the retain flag on the first delivery; they are state, so keep them.
      if (retainedOnly && !message.retain && !message.topic.startsWith("$SYS/")) return;
      messages.push(message);
      if (messages.length >= maxMessages || (stopWhen && stopWhen(message))) done();
    };
    this.listeners.add(listener);
    const timer = setTimeout(done, Math.min(durationMs, MAX_SUBSCRIBE_MS));
    try {
      await client.subscribe(filter, 1);
      await finished;
    } finally {
      clearTimeout(timer);
      this.listeners.delete(listener);
      if (filter !== OUTPUT_TOPIC) {
        try {
          await client.unsubscribe(filter);
        } catch {
          // best effort
        }
      }
    }
    return messages;
  }

  async publish(topic, payload, options) {
    const client = await this.connect();
    await client.publish(topic, payload, options);
  }

  async close() {
    if (this.client) await this.client.end();
    this.client = null;
    this.outputSubscribed = false;
  }

  /** Drops the current connection so the next call connects with the (possibly new) active profile. */
  async reset() {
    try {
      await this.close();
    } catch {
      // the old connection may already be gone
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Broker profile changed while waiting for a response"));
    }
  }
}

const session = new BrokerSession();

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

function decodePayload(buffer, maxChars) {
  const text = buffer.toString("utf8");
  const looksBinary = /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(text);
  if (looksBinary) return { encoding: "base64", payload: buffer.toString("base64").slice(0, maxChars), bytes: buffer.length };
  if (text.length > maxChars) return { encoding: "utf8", payload: text.slice(0, maxChars), truncated: true, chars: text.length };
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return { encoding: "json", payload: JSON.parse(trimmed) };
    } catch {
      // fall through
    }
  }
  return { encoding: "utf8", payload: text };
}

function formatMessages(messages, maxChars = 4000) {
  return messages.map((message) => ({
    topic: message.topic,
    retain: message.retain,
    qos: message.qos,
    receivedAt: message.receivedAt,
    ...decodePayload(message.payload, maxChars),
  }));
}

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function summarizeEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return envelope;
  return envelope;
}

// ---------------------------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------------------------

async function deployEntities(entities, { dryRun = false, stopOnError = true, lint = true, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const plan = sortForDeploy(entities).map((entity) => ({
    kind: entity.kind,
    name: entity.name,
    source: entity.source,
    command: ENTITY_COMMANDS[entity.kind]?.add,
  }));

  const lintFindings = lint
    ? entities
        .filter((entity) => entity.kind !== "PYTHON")
        .flatMap((entity) => lintLot(entity.code).map((finding) => ({ entity: `${entity.kind} ${entity.name}`, ...finding, line: finding.line + entity.line - 1 })))
    : [];
  const lintErrors = lintFindings.filter((finding) => finding.severity === "error");

  if (dryRun) {
    return { dryRun: true, plan, lint: lintFindings, note: lintErrors.length ? "Lint errors would block deployment unless lint=false." : undefined };
  }
  if (lintErrors.length) {
    return { deployed: [], plan, lint: lintFindings, aborted: `${lintErrors.length} lint error(s). Fix them or pass lint=false to deploy anyway.` };
  }

  const results = [];
  for (const entity of sortForDeploy(entities)) {
    let outcome;
    try {
      const envelope = await session.command(deployCommand(entity), { timeoutMs });
      outcome = { kind: entity.kind, name: entity.name, success: envelope.success === true, message: envelope.message, errors: envelope.errors, warnings: envelope.warnings };
    } catch (error) {
      outcome = { kind: entity.kind, name: entity.name, success: false, message: error.message };
    }
    results.push(outcome);
    if (!outcome.success && stopOnError) {
      results.push({ note: "Stopped after first failure (stopOnError=true). Remaining entities were not deployed." });
      break;
    }
  }
  return { deployed: results, lint: lintFindings.length ? lintFindings : undefined };
}

function stripTemplateMetadata(template) {
  const lines = template.split(/\r?\n/);
  const output = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*ADD\s+METADATA\b/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s{0,4}\S/.test(line) && !/^\s{5,}/.test(line) && line.trim() !== "") skipping = false;
      else continue;
    }
    output.push(line);
  }
  return output.join("\n").trimEnd();
}

function parseTemplateFields(template) {
  const regex = /#([^,#]+),([^,#]+),([^,#]*),([^,#]*),([^#]+)#/g;
  const fields = [];
  let match;
  while ((match = regex.exec(template)) !== null) {
    fields.push({ name: match[1], type: match[2], description: match[3], validation: match[4], env: match[5].trim() === "true" });
  }
  return fields;
}

const tools = [
  {
    name: "broker_connection",
    description:
      "Show the active Coreflux broker profile (name, URL, user, where the settings came from) and test it by connecting over MQTT. Use first when a broker call fails or when the user asks which broker is configured. To see or switch between several brokers use broker_list / broker_use.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const settings = resolveSettings();
      const loaded = currentProfiles();
      const report = {
        profile: settings.profile,
        url: settings.url,
        username: settings.username ?? null,
        password: settings.password ? "•••••" : null,
        clientId: settings.clientId ?? "(random cursor-coreflux-*)",
        tlsVerification: settings.rejectUnauthorized,
        settingsSource: settings.source,
        otherProfiles: Object.keys(loaded.profiles).filter((name) => name !== settings.profile),
        warnings: settings.warnings.length ? settings.warnings : undefined,
        cwd: process.cwd(),
      };
      try {
        await session.close();
        const client = await session.connect();
        report.connected = true;
        report.clientId = client.clientId;
        try {
          await session.ensureOutputSubscription();
          report.commandOutputSubscribed = true;
        } catch (error) {
          report.commandOutputSubscribed = false;
          report.warning = error.message;
        }
      } catch (error) {
        report.connected = false;
        report.error = error.message;
        report.hint =
          "Pick another profile with broker_use, save one with broker_save (name + mqtt:// url + credentials), or set the COREFLUX_MQTT_URL / COREFLUX_MQTT_USERNAME / COREFLUX_MQTT_PASSWORD plugin variables.";
      }
      return text(report);
    },
  },
  {
    name: "broker_list",
    description:
      "List every configured Coreflux broker profile (name, URL, user, auth kind, where it is defined) and which one is active. Profiles come from the COREFLUX_BROKERS plugin variable, ~/.coreflux/brokers.json, <workspace>/.coreflux/brokers.json, a workspace .broker file and the COREFLUX_MQTT_* variables. Call this when the user mentions another broker, environment (dev/edge/prod) or asks what is connected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const loaded = currentProfiles();
      return text({
        active: loaded.active,
        activeSource: loaded.activeSource,
        profiles: describeProfiles(loaded),
        files: loaded.files,
        warnings: loaded.warnings.length ? loaded.warnings : undefined,
        hint: "broker_use <name> switches; broker_save adds or edits a profile; the COREFLUX_BROKER plugin variable fixes the default.",
      });
    },
  },
  {
    name: "broker_use",
    description:
      "Switch the broker the tools talk to. Takes a profile name from broker_list; disconnects the current session and reconnects to the chosen broker on the next call. persist=\"session\" (default) only affects this MCP session; \"workspace\" writes .coreflux/brokers.json in the working directory so the project remembers it; \"user\" writes ~/.coreflux/brokers.json for every workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name, e.g. local, edge-line-3, prod." },
        persist: { type: "string", enum: ["session", "workspace", "user"], description: "Where to remember the choice (default session)." },
        connect: { type: "boolean", description: "Connect immediately to verify (default true)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async run({ name, persist, connect }) {
      const loaded = loadProfiles();
      if (!loaded.profiles[name]) return errorResult(`Unknown profile "${name}". Known profiles: ${Object.keys(loaded.profiles).join(", ")}. Use broker_save to add one.`);
      const result = { profile: name, url: loaded.profiles[name].url, persisted: persist ?? "session" };
      if (persist === "workspace" || persist === "user") result.file = setActiveProfile({ scope: persist, name }).file;
      sessionProfile = name;
      await session.reset();
      if (connect ?? true) {
        try {
          const client = await session.connect();
          result.connected = true;
          result.clientId = client.clientId;
          result.username = client.username ?? null;
        } catch (error) {
          result.connected = false;
          result.error = error.message;
        }
      }
      return text(result);
    },
  },
  {
    name: "broker_save",
    description:
      "Create or update a named broker profile in ~/.coreflux/brokers.json (scope user, default) or <cwd>/.coreflux/brokers.json (scope workspace — do not commit passwords; prefer passwordEnv there). Pass activate=true to also make it the active profile. Only provided fields change; pass null to clear a field.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name (letters, digits, . _ -)." },
        url: { type: "string", description: "mqtt://host:1883 or mqtts://host:8883." },
        username: { type: ["string", "null"] },
        password: { type: ["string", "null"], description: "Stored in clear text in the JSON file (mode 600 on POSIX). Prefer passwordEnv for shared or committed files." },
        passwordEnv: { type: ["string", "null"], description: "Name of an environment variable holding the password." },
        clientId: { type: ["string", "null"] },
        tlsInsecure: { type: ["boolean", "null"], description: "Accept self-signed certificates on mqtts://." },
        description: { type: ["string", "null"] },
        scope: { type: "string", enum: ["user", "workspace"], description: "Default user." },
        activate: { type: "boolean", description: "Also select it (persisted in the same file)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async run({ scope, activate, ...fields }) {
      const saved = saveProfile({ scope: scope ?? "user", activate: activate ?? false, ...fields });
      if (activate) {
        sessionProfile = fields.name;
        await session.reset();
      }
      return text({ ...saved, note: activate ? "Profile saved and selected for this session." : "Profile saved. Use broker_use to switch to it." });
    },
  },
  {
    name: "broker_remove",
    description: "Delete a broker profile from the user (~/.coreflux/brokers.json) or workspace (.coreflux/brokers.json) file. Built-in and variable-defined profiles cannot be removed this way.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        scope: { type: "string", enum: ["user", "workspace"], description: "Default user." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async run({ name, scope }) {
      const result = removeProfile({ scope: scope ?? "user", name });
      if (sessionProfile === name) {
        sessionProfile = null;
        await session.reset();
      }
      return text(result);
    },
  },
  {
    name: "broker_command",
    description:
      "Run any Coreflux broker command by publishing it to $SYS/Coreflux/Command and returning the JSON envelope from $SYS/Coreflux/Command/Output (correlated by -requestId). Examples: -listRoutes, -listProjects, -connectionStatus, -listEnv, -listSecrets, -routeCode MODBUS_TCP, -runAction Name, -actionTrace Name, -lotDiagnostic action Name, -setSecret NAME=value, -addUserToGroup user group, -loadProject Name, -removeRoute Name. Multi-line LoT bodies are allowed: -addAction DEFINE ACTION … (no quotes around the body). For deploying files prefer lotnb_deploy / lot_deploy.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Full command payload starting with a dash, e.g. \"-listRoutes\". Do not append -requestId; it is added automatically." },
        timeoutMs: { type: "integer", description: `Wait for the response this long (default ${DEFAULT_TIMEOUT_MS}).`, minimum: 500, maximum: 120000 },
        expectResponse: { type: "boolean", description: "Set false for commands that produce no Output message (e.g. -updateData)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run({ command, timeoutMs, expectResponse }) {
      const envelope = await session.command(command, { timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, expectResponse: expectResponse ?? true });
      return text(summarizeEnvelope(envelope));
    },
  },
  {
    name: "broker_overview",
    description:
      "One-shot health snapshot of the connected Coreflux broker: routes with connection/health, projects, active project, route connection status, pending models/actions, and any retained action errors from $SYS/Coreflux/Actions/+/Error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const settings = resolveSettings();
      const overview = { profile: settings.profile, broker: settings.url };
      const steps = [
        ["routes", "-listRoutes"],
        ["projects", "-listProjects"],
        ["connectionStatus", "-connectionStatus"],
        ["pending", "-getPendingStatus"],
      ];
      for (const [key, command] of steps) {
        try {
          const envelope = await session.command(command, { timeoutMs: 10000 });
          overview[key] = envelope.data && (Array.isArray(envelope.data) ? envelope.data.length : Object.keys(envelope.data).length) ? envelope.data : envelope.message;
        } catch (error) {
          overview[key] = `error: ${error.message}`;
        }
      }
      try {
        const [active] = await session.capture("$SYS/Coreflux/Projects/active", { durationMs: 1200, maxMessages: 1, retainedOnly: true });
        overview.activeProject = active ? decodePayload(active.payload, 2000).payload : null;
      } catch (error) {
        overview.activeProject = `error: ${error.message}`;
      }
      try {
        const errors = await session.capture("$SYS/Coreflux/Actions/+/Error", { durationMs: 1500, maxMessages: 100, retainedOnly: true });
        overview.actionErrors = formatMessages(errors, 1500).map((message) => ({ action: message.topic.split("/")[3], ...message.payload }));
      } catch (error) {
        overview.actionErrors = `error: ${error.message}`;
      }
      return text(overview);
    },
  },
  {
    name: "mqtt_publish",
    description: "Publish a message to any MQTT topic on the connected Coreflux broker (triggers ON TOPIC actions, route events, model fields). Use retain=true to seed retained state that rules or GET TOPIC read.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        payload: { type: "string", description: "Payload text. Pass JSON as a string." },
        qos: { type: "integer", enum: [0, 1], description: "Default 1." },
        retain: { type: "boolean", description: "Default false." },
      },
      required: ["topic", "payload"],
      additionalProperties: false,
    },
    async run({ topic, payload, qos, retain }) {
      await session.publish(topic, payload, { qos: qos ?? 1, retain: retain ?? false });
      return text({ published: true, topic, bytes: Buffer.byteLength(payload, "utf8"), qos: qos ?? 1, retain: retain ?? false });
    },
  },
  {
    name: "mqtt_subscribe",
    description:
      "Subscribe to an MQTT topic filter for a bounded time and return the messages received (retained messages arrive first). Use to inspect live data, verify an action published, watch $SYS/Coreflux/Actions/+/Trace, or read $SYS/Coreflux/Routes/+/status. Wildcards: + (one level), # (multi-level).",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic or filter, e.g. sensors/+/temperature or $SYS/Coreflux/#" },
        durationMs: { type: "integer", description: `How long to listen (default 3000, max ${MAX_SUBSCRIBE_MS}).`, minimum: 100, maximum: MAX_SUBSCRIBE_MS },
        maxMessages: { type: "integer", description: "Stop after this many messages (default 50).", minimum: 1, maximum: 1000 },
        maxPayloadChars: { type: "integer", description: "Truncate each payload to this many characters (default 4000).", minimum: 100 },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    async run({ topic, durationMs, maxMessages, maxPayloadChars }) {
      const messages = await session.capture(topic, { durationMs: durationMs ?? 3000, maxMessages: maxMessages ?? 50 });
      return text({ filter: topic, count: messages.length, messages: formatMessages(messages, maxPayloadChars ?? 4000) });
    },
  },
  {
    name: "mqtt_read_retained",
    description:
      "Read retained messages matching a topic filter (snapshot of current state) — e.g. $SYS/Coreflux/Routes/MyRoute/Tools, $SYS/Coreflux/Projects/list, $SYS/Coreflux/Entities/ownership, or a device's retained config. Waits briefly and returns only retained messages.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        waitMs: { type: "integer", description: "Default 1500.", minimum: 100, maximum: 30000 },
        maxMessages: { type: "integer", minimum: 1, maximum: 1000 },
        maxPayloadChars: { type: "integer", minimum: 100 },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    async run({ topic, waitMs, maxMessages, maxPayloadChars }) {
      const messages = await session.capture(topic, { durationMs: waitMs ?? 1500, maxMessages: maxMessages ?? 200, retainedOnly: true });
      return text({ filter: topic, count: messages.length, messages: formatMessages(messages, maxPayloadChars ?? 4000) });
    },
  },
  {
    name: "lot_lint",
    description:
      "Statically check LoT source for the mistakes that break the broker parser (indentation, indented triggers, missing DO/WITH/THEN, MESSAGE keyword, 0-based TOPIC POSITION, quoted action/model/route/rule names, ADD METADATA, hardcoded passwords, PAYLOAD on timers, models without AS TRIGGER…). Pass either code or a path to a .lot/.lotnb file. Run before deploying.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "LoT source to check." },
        path: { type: "string", description: "Path to a .lot or .lotnb file (alternative to code)." },
      },
      additionalProperties: false,
    },
    async run({ code, path: filePath }) {
      if (!code && !filePath) return errorResult("Provide code or path.");
      if (filePath) {
        const entities = await loadLotFile(filePath);
        const findings = entities
          .filter((entity) => entity.kind !== "PYTHON")
          .flatMap((entity) => lintLot(entity.code).map((finding) => ({ entity: `${entity.kind} ${entity.name}`, source: entity.source, ...finding })));
        return text({ file: filePath, entities: entities.map((entity) => `${entity.kind} ${entity.name}`), findings, ok: findings.every((finding) => finding.severity !== "error") });
      }
      const findings = lintLot(code);
      return text({ entities: splitLotEntities(code).map((entity) => `${entity.kind} ${entity.name}`), findings, ok: findings.every((finding) => finding.severity !== "error") });
    },
  },
  {
    name: "lot_deploy",
    description:
      "Deploy LoT source (one or more DEFINE blocks, or a Python script with a # Script Name header) to the broker. Splits entities, lints them, deploys in broker order (models → actions → routes → rules → python → themes → panels) and returns each envelope. Use dryRun=true to see the plan first.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "LoT source. May contain several DEFINE blocks." },
        python: { type: "string", description: "Optional Python script (must include '# Script Name: Name')." },
        dryRun: { type: "boolean", description: "Only return the plan and lint findings." },
        stopOnError: { type: "boolean", description: "Stop at the first failed entity (default true)." },
        lint: { type: "boolean", description: "Block deployment on lint errors (default true)." },
        timeoutMs: { type: "integer", minimum: 500, maximum: 120000 },
      },
      additionalProperties: false,
    },
    async run({ code, python, dryRun, stopOnError, lint, timeoutMs }) {
      const entities = code ? splitLotEntities(code).map((entity) => ({ ...entity, source: "inline" })) : [];
      if (python) {
        const match = /^\s*#\s*Script Name:\s*([A-Za-z_][A-Za-z0-9_]*)/im.exec(python);
        if (!match) return errorResult("Python script must start with '# Script Name: <Name>' within its first lines.");
        entities.push({ kind: "PYTHON", name: match[1], code: python, line: 1, source: "inline" });
      }
      if (!entities.length) return errorResult("No DEFINE blocks or Python script found.");
      return text(await deployEntities(entities, { dryRun: dryRun ?? false, stopOnError: stopOnError ?? true, lint: lint ?? true, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS }));
    },
  },
  {
    name: "lotnb_deploy",
    description:
      "Deploy a .lotnb notebook or .lot file from disk to the broker: parses cells (lot + python), lints, deploys in broker load order and reports every envelope. Use dryRun=true to preview. This is the fastest way to push a whole notebook.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative path to a .lotnb or .lot file." },
        dryRun: { type: "boolean" },
        stopOnError: { type: "boolean", description: "Default true." },
        lint: { type: "boolean", description: "Default true." },
        only: { type: "array", items: { type: "string" }, description: "Optional entity names to deploy (others are skipped)." },
        timeoutMs: { type: "integer", minimum: 500, maximum: 120000 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run({ path: filePath, dryRun, stopOnError, lint, only, timeoutMs }) {
      let entities = await loadLotFile(filePath);
      if (only?.length) {
        const wanted = new Set(only.map((name) => name.toLowerCase()));
        entities = entities.filter((entity) => wanted.has(entity.name.toLowerCase()));
      }
      if (!entities.length) return errorResult(`No deployable entities found in ${filePath}.`);
      return text({ file: filePath, ...(await deployEntities(entities, { dryRun: dryRun ?? false, stopOnError: stopOnError ?? true, lint: lint ?? true, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS })) });
    },
  },
  {
    name: "lot_remove",
    description: "Remove a single LoT entity from the broker (-removeAction / -removeModel / -removeRoute / -removeRule / -removePython / -removeTheme / -removePanel).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ACTION", "MODEL", "ROUTE", "RULE", "PYTHON", "THEME", "PANEL"] },
        name: { type: "string" },
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
    async run({ kind, name }) {
      const verb = ENTITY_COMMANDS[kind]?.remove;
      if (!verb) return errorResult(`Unknown kind ${kind}`);
      return text(await session.command(`${verb} ${name}`));
    },
  },
  {
    name: "project_upload",
    description:
      "Package a local project folder (.lotnb notebooks, .lot files, python, README) as a ZIP and register it on the broker with -addProject zip64:<base64> [name] [load]. Optionally load it immediately so its entities become the active project. Use this to ship a workspace project to a broker without git access.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder to upload (absolute or cwd-relative)." },
        name: { type: "string", description: "Project name on the broker (default: folder name)." },
        load: { type: "boolean", description: "Load the project after adding it (default false)." },
        maxBytes: { type: "integer", description: "Refuse archives larger than this (default 8000000). Larger projects should be copied to the broker host and added with -addProject <path>.", minimum: 1000 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run({ path: folder, name, load, maxBytes }) {
      const root = path.resolve(folder);
      if (!existsSync(root) || !statSync(root).isDirectory()) return errorResult(`${root} is not a directory.`);
      const { buffer, files } = zipDirectory(root);
      if (!files.length) return errorResult(`${root} contains no files.`);
      const limit = maxBytes ?? 8_000_000;
      if (buffer.length > limit) return errorResult(`Archive is ${buffer.length} bytes (> ${limit}). Copy the folder or a .zip to the broker host and run -addProject <path> instead.`);
      const projectName = name ?? path.basename(root);
      const args = [`zip64:${buffer.toString("base64")}`, projectName, load ? "load" : null].filter(Boolean).join(" ");
      const envelope = await session.command(`-addProject ${args}`, { timeoutMs: 60000 });
      return text({ project: projectName, files, zipBytes: buffer.length, envelope });
    },
  },
  {
    name: "project_export",
    description:
      "Export a broker project as a ZIP: runs -getProject <name>, captures the base64 archive from $SYS/Coreflux/Projects/<name>/download and writes it to disk (default <cwd>/<name>.zip). Use to pull notebooks off a broker into the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        outputPath: { type: "string", description: "Where to write the .zip (default ./<name>.zip)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async run({ name, outputPath }) {
      const downloadTopic = `$SYS/Coreflux/Projects/${name}/download`;
      const capturePromise = session.capture(downloadTopic, { durationMs: 30000, maxMessages: 1 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const envelope = await session.command(`-getProject ${name}`, { timeoutMs: 30000 });
      const [message] = await capturePromise;
      if (!message) return text({ envelope, note: `No archive arrived on ${downloadTopic}. Check the envelope for errors.` });
      let base64 = message.payload.toString("utf8").trim();
      try {
        const parsed = JSON.parse(base64);
        base64 = parsed.zip64 ?? parsed.data ?? parsed.content ?? base64;
      } catch {
        // raw base64 payload
      }
      base64 = base64.replace(/^zip64:/, "");
      const target = path.resolve(outputPath ?? `${name}.zip`);
      mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(base64, "base64");
      writeFileSync(target, bytes);
      return text({ project: name, writtenTo: target, bytes: bytes.length, envelope: { success: envelope.success, message: envelope.message } });
    },
  },
  {
    name: "broker_route_template",
    description:
      "Fetch the broker's own LoT template for a route type (-routeCode TYPE), return the parameter metadata (#name,type,description,regex,env#) and a deploy-ready skeleton with the template-only ADD METADATA block removed. Types: POSTGRESQL, MYSQL, MARIADB, SQLSERVER, MONGODB, OPENSEARCH, CRATEDB, SNOWFLAKE, FILE_STORAGE, MODBUS_TCP, MODBUS_SERIAL, MODBUS_SERVER, SIEMENS_S7, OPCUA, OPCUA_SERVER, ETHERNETIP, ALLEN_BRADLEY, ADS, FINS, BACNET, MQTT_BRIDGE, MQTT_CLUSTER, SPARKPLUG_B, SPARKPLUG_HOST, KAFKA, GRPC, REST_API, EMAIL, LLM, AGENT, MCP, MCP_SERVER, BARCODE, AUDIO_INPUT, VIDEO_INPUT, VIDEO_OUTPUT.",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string", description: "Route type, e.g. MODBUS_TCP" } },
      required: ["type"],
      additionalProperties: false,
    },
    async run({ type }) {
      const envelope = await session.command(`-routeCode ${type.toUpperCase()}`);
      const template = typeof envelope.data === "string" ? envelope.data : envelope.data?.template ?? envelope.data?.code ?? (typeof envelope.message === "string" && envelope.message.includes("DEFINE ROUTE") ? envelope.message : null);
      if (!template) return text({ envelope, note: "Template text not found in the response; inspect the envelope." });
      return text({ type: type.toUpperCase(), fields: parseTemplateFields(template), skeleton: stripTemplateMetadata(template), rawTemplate: template });
    },
  },
  {
    name: "broker_action_trace",
    description:
      "Debug an action end-to-end: arms -actionTrace for it, optionally runs it (-runAction, with an optional JSON payload or {\"topic\":…,\"payload\":…} trigger context), and collects the traces published on $SYS/Coreflux/Actions/<name>/Trace plus the retained Error topic. Returns trigger, timing, published messages and errors.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action name." },
        run: { type: "boolean", description: "Also run the action now (default true)." },
        payload: { type: "string", description: "Optional JSON object for -runAction: INPUT bindings for callable actions, or {\"topic\":\"…\",\"payload\":…} to simulate an inbound message on a topic-triggered action." },
        durationMs: { type: "integer", description: "How long to collect traces after arming/running (default 4000).", minimum: 500, maximum: 60000 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run({ action, run, payload, durationMs }) {
      const result = { action };
      result.trace = await session.command(`-actionTrace ${action}`);
      const wait = durationMs ?? 4000;
      const capturePromise = session.capture(`$SYS/Coreflux/Actions/${action}/Trace`, { durationMs: wait, maxMessages: 20 });
      if (run ?? true) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        result.run = await session.command(payload ? `-runAction ${action} ${payload}` : `-runAction ${action}`);
      }
      const traces = await capturePromise;
      result.traces = formatMessages(traces, 4000).map((message) => message.payload);
      const errors = await session.capture(`$SYS/Coreflux/Actions/${action}/Error`, { durationMs: 800, maxMessages: 1, retainedOnly: true });
      result.retainedError = errors.length ? formatMessages(errors, 2000)[0].payload : null;
      return text(result);
    },
  },
];

// ---------------------------------------------------------------------------------------------
// MCP stdio JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

const INSTRUCTIONS = [
  "Coreflux broker tools over MQTT.",
  `Commands go to ${COMMAND_TOPIC}; replies arrive on ${OUTPUT_TOPIC} as a JSON envelope {success, command, message, data, errors[]}.`,
  "Prefer lotnb_deploy / lot_deploy for files, lot_lint before deploying, broker_overview for health, mqtt_subscribe to verify data flow.",
  "Several brokers can be configured as profiles: broker_list shows them, broker_use <name> switches; always say which profile a change went to.",
  "Destructive commands (-removeAll*, -removeProject, -restoreRules, -removeUser) must be confirmed by the user first.",
].join(" ");

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    case "ping":
      respond(id, {});
      return;
    case "tools/list":
      respond(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case "tools/call": {
      const tool = tools.find((candidate) => candidate.name === params?.name);
      if (!tool) {
        respondError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const result = await tool.run(params?.arguments ?? {});
        respond(id, result);
      } catch (error) {
        respond(id, errorResult(`${tool.name} failed: ${error.message}`));
      }
      return;
    }
    case "resources/list":
      respond(id, { resources: [] });
      return;
    case "prompts/list":
      respond(id, { prompts: [] });
      return;
    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      respondError(null, -32700, `Parse error: ${error.message}`);
      return;
    }
    if (message.id === undefined || message.id === null) {
      // notification (e.g. notifications/initialized, notifications/cancelled) — nothing to answer
      return;
    }
    handleRequest(message).catch((error) => respondError(message.id, -32603, error.message));
  });
  reader.on("close", async () => {
    await session.close();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await session.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await session.close();
    process.exit(0);
  });
}

main();
