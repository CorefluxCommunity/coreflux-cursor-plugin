// In-process fake MQTT 3.1.1 broker with a tiny Coreflux command emulation, for offline tests.
//
// - CONNECT: accepts any client; return code 4 when `users` is given and the password mismatches.
// - SUBSCRIBE: grants QoS; returns 0x80 for `$SYS/…` filters unless the user is in `sysUsers`.
// - PUBLISH: QoS 1 gets PUBACK; retained messages are stored; fan-out to matching subscribers.
// - Publishing to `$SYS/Coreflux/Command` produces a JSON envelope on `$SYS/Coreflux/Command/Output`.

import net from "node:net";
import { topicMatches } from "../../scripts/mcp/lib/mqtt-client.mjs";

const COMMAND_TOPIC = "$SYS/Coreflux/Command";
const OUTPUT_TOPIC = "$SYS/Coreflux/Command/Output";

function encodeString(value) {
  const bytes = Buffer.from(value, "utf8");
  const out = Buffer.allocUnsafe(bytes.length + 2);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

function encodeRemainingLength(length) {
  const bytes = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 0x80;
    bytes.push(digit);
  } while (length > 0);
  return Buffer.from(bytes);
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeRemainingLength(body.length), body]);
}

function pascal(verb) {
  return verb
    .replace(/^-+/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export class FakeBroker {
  constructor({ users = null, sysUsers = ["root"], echoRequestId = true } = {}) {
    this.users = users; // { username: password } or null for open
    this.sysUsers = new Set(sysUsers);
    this.echoRequestId = echoRequestId;
    this.retained = new Map();
    this.clients = new Set();
    this.entities = { actions: new Map(), models: new Map(), routes: new Map(), rules: new Map(), python: new Map() };
    this.commands = []; // every command payload received, for assertions
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        this.url = `mqtt://127.0.0.1:${this.port}`;
        resolve(this);
      });
    });
  }

  close() {
    for (const client of this.clients) client.socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  onConnection(socket) {
    const client = { socket, buffer: Buffer.alloc(0), subscriptions: new Map(), username: null, connected: false };
    this.clients.add(client);
    socket.on("data", (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      this.drain(client);
    });
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
  }

  drain(client) {
    while (client.buffer.length >= 2) {
      let multiplier = 1;
      let remaining = 0;
      let offset = 1;
      let complete = false;
      while (offset < client.buffer.length && offset <= 4) {
        const byte = client.buffer[offset++];
        remaining += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete || client.buffer.length < offset + remaining) return;
      const body = client.buffer.subarray(offset, offset + remaining);
      const first = client.buffer[0];
      client.buffer = client.buffer.subarray(offset + remaining);
      this.handle(client, first >> 4, first & 0x0f, body);
    }
  }

  handle(client, type, flags, body) {
    switch (type) {
      case 1: {
        // CONNECT
        let pos = 0;
        const protoLen = body.readUInt16BE(pos);
        pos += 2 + protoLen;
        pos += 1; // level
        const connectFlags = body[pos++];
        pos += 2; // keepalive
        const readString = () => {
          const len = body.readUInt16BE(pos);
          const value = body.subarray(pos + 2, pos + 2 + len).toString("utf8");
          pos += 2 + len;
          return value;
        };
        client.clientId = readString();
        if (connectFlags & 0x80) client.username = readString();
        if (connectFlags & 0x40) client.password = readString();
        let rc = 0;
        if (this.users && (this.users[client.username] === undefined || this.users[client.username] !== client.password)) rc = 4;
        client.socket.write(packet(2, 0, Buffer.from([0, rc])));
        if (rc !== 0) client.socket.end();
        else client.connected = true;
        break;
      }
      case 3: {
        // PUBLISH
        const qos = (flags >> 1) & 0x03;
        const retain = (flags & 0x01) === 1;
        const topicLen = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + topicLen).toString("utf8");
        let pos = 2 + topicLen;
        let packetId = 0;
        if (qos > 0) {
          packetId = body.readUInt16BE(pos);
          pos += 2;
        }
        const payload = body.subarray(pos);
        if (qos === 1) client.socket.write(packet(4, 0, Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff])));
        if (retain) {
          if (payload.length === 0) this.retained.delete(topic);
          else this.retained.set(topic, payload);
        }
        this.fanout(topic, payload, false);
        if (topic === COMMAND_TOPIC) this.handleCommand(client, payload.toString("utf8"));
        break;
      }
      case 8: {
        // SUBSCRIBE
        const packetId = body.readUInt16BE(0);
        let pos = 2;
        const grants = [];
        const deliveries = [];
        while (pos < body.length) {
          const len = body.readUInt16BE(pos);
          const filter = body.subarray(pos + 2, pos + 2 + len).toString("utf8");
          pos += 2 + len;
          const qos = body[pos++];
          const denied = filter.startsWith("$SYS") && !this.sysUsers.has(client.username);
          grants.push(denied ? 0x80 : qos);
          if (!denied) {
            client.subscriptions.set(filter, qos);
            for (const [topic, payload] of this.retained) if (topicMatches(filter, topic)) deliveries.push([topic, payload]);
          }
        }
        client.socket.write(packet(9, 0, Buffer.concat([Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]), Buffer.from(grants)])));
        for (const [topic, payload] of deliveries) this.deliver(client, topic, payload, true);
        break;
      }
      case 10: {
        // UNSUBSCRIBE
        const packetId = body.readUInt16BE(0);
        let pos = 2;
        while (pos < body.length) {
          const len = body.readUInt16BE(pos);
          client.subscriptions.delete(body.subarray(pos + 2, pos + 2 + len).toString("utf8"));
          pos += 2 + len;
        }
        client.socket.write(packet(11, 0, Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff])));
        break;
      }
      case 12:
        client.socket.write(packet(13, 0, Buffer.alloc(0)));
        break;
      case 14:
        client.socket.end();
        break;
      default:
        break;
    }
  }

  deliver(client, topic, payload, retain) {
    const body = Buffer.concat([encodeString(topic), payload]);
    client.socket.write(packet(3, retain ? 1 : 0, body));
  }

  fanout(topic, payload, retain) {
    for (const client of this.clients) {
      if (!client.connected) continue;
      for (const filter of client.subscriptions.keys()) {
        if (topicMatches(filter, topic)) {
          this.deliver(client, topic, payload, retain);
          break;
        }
      }
    }
  }

  /** Publishes from "the broker" (retained if requested). */
  publish(topic, payload, { retain = false } = {}) {
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    if (retain) this.retained.set(topic, buffer);
    this.fanout(topic, buffer, retain);
  }

  handleCommand(client, raw) {
    this.commands.push(raw);
    const match = /\s+-requestId\s+(\S+)\s*$/i.exec(raw);
    const requestId = match?.[1];
    const command = match ? raw.slice(0, match.index) : raw;
    const [verb, ...rest] = command.trim().split(/\s+/);
    const argText = command.trim().slice(verb.length).trim();
    const envelope = { success: true, command: pascal(verb), message: "", data: {} };
    if (this.echoRequestId && requestId) envelope.requestId = requestId;

    const defineName = (kind) => {
      const re = new RegExp(`DEFINE\\s+${kind}\\s+"?([A-Za-z0-9_]+)"?`, "i");
      return re.exec(argText)?.[1];
    };

    switch (verb.toLowerCase()) {
      case "-listroutes":
        envelope.data = [...this.entities.routes.keys()].map((name) => ({ name, type: "MODBUS_TCP", connection: "Connected", health: "Green" }));
        envelope.message = envelope.data.length ? `${envelope.data.length} route(s).` : "No routes registered.";
        break;
      case "-listprojects":
        envelope.data = [];
        envelope.message = "No projects found.";
        break;
      case "-connectionstatus":
        envelope.message = "No active connections found.";
        break;
      case "-getpendingstatus":
        envelope.message = "No pending models or actions.";
        break;
      case "-addaction":
      case "-addmodel":
      case "-addroute":
      case "-addrule": {
        const kind = verb.slice(4).toUpperCase();
        const name = defineName(kind);
        const bucket = { ACTION: "actions", MODEL: "models", ROUTE: "routes", RULE: "rules" }[kind];
        if (!name) {
          envelope.success = false;
          envelope.message = `Unexpected token at line 1`;
          envelope.errors = [{ message: envelope.message, line: 1 }];
        } else {
          this.entities[bucket].set(name, argText);
          envelope.entityType = kind.charAt(0) + kind.slice(1).toLowerCase();
          envelope.entityName = name;
          envelope.message = `${envelope.entityType} '${name}' added successfully.`;
        }
        break;
      }
      case "-addpython": {
        const name = /#\s*Script Name:\s*([A-Za-z_][A-Za-z0-9_]*)/i.exec(argText)?.[1];
        this.entities.python.set(name, argText);
        envelope.message = `Python script '${name}' added successfully.`;
        break;
      }
      case "-removeaction":
      case "-removemodel":
      case "-removeroute":
      case "-removerule": {
        const bucket = { removeaction: "actions", removemodel: "models", removeroute: "routes", removerule: "rules" }[verb.slice(1).toLowerCase()];
        const existed = this.entities[bucket].delete(rest[0]);
        envelope.success = existed;
        envelope.message = existed ? `Removed '${rest[0]}'.` : `'${rest[0]}' not found.`;
        break;
      }
      case "-runaction": {
        const name = rest[0];
        envelope.data = { action: name, traceId: "trace-1", status: "success", published: [{ topic: "out", payload: "1" }] };
        envelope.message = `Action '${name}' executed successfully.`;
        setImmediate(() => this.publish(`$SYS/Coreflux/Actions/${name}/Trace`, JSON.stringify({ action: name, traceId: "trace-1", result: "success", published: envelope.data.published })));
        break;
      }
      case "-actiontrace":
        envelope.message = `Tracing enabled for action '${rest[0]}'.`;
        envelope.data = { action: rest[0], expiresUtc: new Date(Date.now() + 300000).toISOString() };
        break;
      case "-routecode":
        envelope.data = `DEFINE ROUTE RouteName WITH TYPE ${rest[0]}\n    ADD MODBUS_CONFIG\n        WITH IP #IP,string,PLC address,,true#\n    ADD METADATA\n        WITH DESCRIPTION "template"\n        WITH VERSION "1"`;
        envelope.message = "Template";
        break;
      case "-updatedata":
        return; // no Output for this command
      default:
        envelope.success = false;
        delete envelope.command;
        envelope.message = `Unknown command: ${verb}`;
        envelope.errors = [{ message: envelope.message }];
    }
    setImmediate(() => this.publish(OUTPUT_TOPIC, JSON.stringify(envelope)));
  }
}
