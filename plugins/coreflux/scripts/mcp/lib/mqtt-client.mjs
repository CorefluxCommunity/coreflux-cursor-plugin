// Minimal dependency-free MQTT 3.1.1 client (TCP + TLS) for the Coreflux Cursor plugin.
//
// Scope: CONNECT/CONNACK, PUBLISH (QoS 0/1, plus inbound QoS 2 acknowledgement), SUBSCRIBE,
// UNSUBSCRIBE, PINGREQ keepalive, DISCONNECT. Enough to drive the Coreflux command topic
// ($SYS/Coreflux/Command -> $SYS/Coreflux/Command/Output) and to read/write arbitrary topics.

import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

const PacketType = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  PUBREC: 5,
  PUBREL: 6,
  PUBCOMP: 7,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

const CONNACK_ERRORS = {
  1: "unacceptable protocol version",
  2: "identifier rejected",
  3: "server unavailable",
  4: "bad user name or password",
  5: "not authorized",
};

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

function buildPacket(type, flags, body) {
  const header = Buffer.from([(type << 4) | (flags & 0x0f)]);
  return Buffer.concat([header, encodeRemainingLength(body.length), body]);
}

/** Parses "mqtt://host:1883", "mqtts://host:8883", "tcp://", "ssl://" (with optional user:pass@). */
export function parseMqttUrl(raw) {
  const url = new URL(raw);
  const scheme = url.protocol.replace(":", "").toLowerCase();
  const secure = scheme === "mqtts" || scheme === "ssl" || scheme === "tls";
  if (!["mqtt", "mqtts", "tcp", "ssl", "tls"].includes(scheme)) {
    throw new Error(`Unsupported MQTT URL scheme "${scheme}". Use mqtt:// or mqtts://.`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 8883 : 1883,
    secure,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

/** MQTT topic-filter match ("+" single level, "#" multi level, "$SYS" not matched by leading wildcards). */
export function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") {
      return !(i === 0 && t[0].startsWith("$"));
    }
    if (i >= t.length) return false;
    if (f[i] === "+") {
      if (i === 0 && t[0].startsWith("$")) return false;
      continue;
    }
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export class MqttClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.url            mqtt://host:port or mqtts://host:port
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {string} [options.clientId]
   * @param {boolean} [options.rejectUnauthorized=true]
   * @param {number} [options.keepalive=30]  seconds
   * @param {number} [options.connectTimeoutMs=8000]
   */
  constructor(options) {
    super();
    const parsed = parseMqttUrl(options.url);
    this.host = parsed.host;
    this.port = parsed.port;
    this.secure = parsed.secure;
    this.username = options.username ?? parsed.username;
    this.password = options.password ?? parsed.password;
    this.clientId = options.clientId || `cursor-coreflux-${randomBytes(4).toString("hex")}`;
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.keepalive = options.keepalive ?? 30;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 8000;

    this.socket = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this.nextPacketId = 1;
    this.pending = new Map(); // packetId -> { resolve, reject, timer }
    this.pingTimer = null;
    this.subscriptions = new Map(); // filter -> qos
  }

  get description() {
    return `${this.secure ? "mqtts" : "mqtt"}://${this.host}:${this.port} as ${this.username ?? "<anonymous>"} (clientId ${this.clientId})`;
  }

  connect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        this.teardown();
        reject(new Error(`MQTT connection to ${this.host}:${this.port} failed: ${error.message}`));
      };
      const timer = setTimeout(() => onError(new Error("timed out waiting for CONNACK")), this.connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("connack", onConnack);
        this.socket?.off("error", onError);
      };
      const onConnack = (returnCode) => {
        cleanup();
        if (returnCode !== 0) {
          this.teardown();
          reject(new Error(`MQTT broker refused connection: ${CONNACK_ERRORS[returnCode] ?? `return code ${returnCode}`}`));
          return;
        }
        this.connected = true;
        this.startKeepalive();
        resolve();
      };

      const socketOptions = { host: this.host, port: this.port };
      this.socket = this.secure
        ? tls.connect({ ...socketOptions, servername: this.host, rejectUnauthorized: this.rejectUnauthorized })
        : net.connect(socketOptions);

      this.socket.setNoDelay(true);
      this.socket.on("data", (chunk) => this.onData(chunk));
      this.socket.on("error", onError);
      this.socket.on("close", () => {
        const wasConnected = this.connected;
        this.teardown();
        if (wasConnected) this.emit("close");
      });
      this.once("connack", onConnack);
      this.socket.once(this.secure ? "secureConnect" : "connect", () => this.sendConnect());
    });
  }

  sendConnect() {
    let flags = 0x02; // clean session
    const payload = [encodeString(this.clientId)];
    if (this.username !== undefined && this.username !== "") {
      flags |= 0x80;
      payload.push(encodeString(this.username));
      if (this.password !== undefined) {
        flags |= 0x40;
        payload.push(encodeString(this.password));
      }
    }
    const variable = Buffer.concat([
      encodeString("MQTT"),
      Buffer.from([0x04, flags, (this.keepalive >> 8) & 0xff, this.keepalive & 0xff]),
    ]);
    this.write(buildPacket(PacketType.CONNECT, 0, Buffer.concat([variable, ...payload])));
  }

  startKeepalive() {
    if (this.keepalive <= 0) return;
    const interval = Math.max(1000, (this.keepalive * 1000) / 2);
    this.pingTimer = setInterval(() => {
      if (this.connected) this.write(buildPacket(PacketType.PINGREQ, 0, Buffer.alloc(0)));
    }, interval);
    this.pingTimer.unref?.();
  }

  write(buffer) {
    if (!this.socket || this.socket.destroyed) throw new Error("MQTT socket is not open");
    this.socket.write(buffer);
  }

  allocatePacketId() {
    const id = this.nextPacketId;
    this.nextPacketId = this.nextPacketId >= 65535 ? 1 : this.nextPacketId + 1;
    return id;
  }

  awaitAck(packetId, label, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(packetId);
        reject(new Error(`Timed out waiting for ${label} (packet id ${packetId})`));
      }, timeoutMs);
      this.pending.set(packetId, { resolve, reject, timer });
    });
  }

  settleAck(packetId, value) {
    const entry = this.pending.get(packetId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(packetId);
    entry.resolve(value);
  }

  /**
   * @param {string} topic
   * @param {string|Buffer} payload
   * @param {{qos?: 0|1, retain?: boolean}} [options]
   */
  async publish(topic, payload, options = {}) {
    this.ensureConnected();
    const qos = options.qos === 1 ? 1 : 0;
    const retain = options.retain ? 1 : 0;
    const body = [encodeString(topic)];
    let packetId = 0;
    if (qos === 1) {
      packetId = this.allocatePacketId();
      body.push(Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]));
    }
    body.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8"));
    const ack = qos === 1 ? this.awaitAck(packetId, "PUBACK") : Promise.resolve();
    this.write(buildPacket(PacketType.PUBLISH, (qos << 1) | retain, Buffer.concat(body)));
    await ack;
  }

  async subscribe(filter, qos = 1) {
    this.ensureConnected();
    const packetId = this.allocatePacketId();
    const body = Buffer.concat([
      Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]),
      encodeString(filter),
      Buffer.from([qos & 0x03]),
    ]);
    const ack = this.awaitAck(packetId, `SUBACK for ${filter}`);
    this.write(buildPacket(PacketType.SUBSCRIBE, 0x02, body));
    const granted = await ack;
    if (granted === 0x80) throw new Error(`Broker rejected subscription to "${filter}" (check Subscribe/SubscribeSys rules for this user)`);
    this.subscriptions.set(filter, granted);
    return granted;
  }

  async unsubscribe(filter) {
    if (!this.connected) return;
    const packetId = this.allocatePacketId();
    const body = Buffer.concat([Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]), encodeString(filter)]);
    const ack = this.awaitAck(packetId, `UNSUBACK for ${filter}`);
    this.write(buildPacket(PacketType.UNSUBSCRIBE, 0x02, body));
    this.subscriptions.delete(filter);
    await ack;
  }

  async end() {
    if (this.socket && !this.socket.destroyed && this.connected) {
      try {
        this.write(buildPacket(PacketType.DISCONNECT, 0, Buffer.alloc(0)));
      } catch {
        // ignore: socket already going away
      }
    }
    this.teardown();
  }

  teardown() {
    this.connected = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("MQTT connection closed"));
      this.pending.delete(id);
    }
    if (this.socket) {
      this.socket.removeAllListeners("data");
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = Buffer.alloc(0);
  }

  ensureConnected() {
    if (!this.connected) throw new Error("MQTT client is not connected");
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2) {
      // remaining length varint
      let multiplier = 1;
      let remaining = 0;
      let offset = 1;
      let complete = false;
      while (offset < this.buffer.length && offset <= 4) {
        const byte = this.buffer[offset];
        remaining += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        offset++;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete) return; // need more bytes for the length header
      const total = offset + remaining;
      if (this.buffer.length < total) return; // wait for the full packet
      const packet = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      this.handlePacket(packet[0] >> 4, packet[0] & 0x0f, packet.subarray(offset, total));
    }
  }

  handlePacket(type, flags, body) {
    switch (type) {
      case PacketType.CONNACK:
        this.emit("connack", body[1]);
        break;
      case PacketType.PUBLISH:
        this.handlePublish(flags, body);
        break;
      case PacketType.PUBACK:
      case PacketType.UNSUBACK:
        this.settleAck(body.readUInt16BE(0), true);
        break;
      case PacketType.SUBACK:
        this.settleAck(body.readUInt16BE(0), body[2]);
        break;
      case PacketType.PUBREC: {
        // We never send QoS 2, but answer defensively.
        this.write(buildPacket(PacketType.PUBREL, 0x02, body.subarray(0, 2)));
        break;
      }
      case PacketType.PUBREL:
        this.write(buildPacket(PacketType.PUBCOMP, 0, body.subarray(0, 2)));
        break;
      case PacketType.PUBCOMP:
      case PacketType.PINGRESP:
        break;
      default:
        break;
    }
  }

  handlePublish(flags, body) {
    const qos = (flags >> 1) & 0x03;
    const retain = (flags & 0x01) === 1;
    const topicLength = body.readUInt16BE(0);
    const topic = body.subarray(2, 2 + topicLength).toString("utf8");
    let offset = 2 + topicLength;
    let packetId = 0;
    if (qos > 0) {
      packetId = body.readUInt16BE(offset);
      offset += 2;
    }
    const payload = body.subarray(offset);
    if (qos === 1) {
      this.write(buildPacket(PacketType.PUBACK, 0, Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff])));
    } else if (qos === 2) {
      this.write(buildPacket(PacketType.PUBREC, 0, Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff])));
    }
    this.emit("message", { topic, payload, qos, retain, receivedAt: new Date().toISOString() });
  }
}
