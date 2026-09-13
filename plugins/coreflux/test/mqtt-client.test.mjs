import { test, after, before } from "node:test";
import assert from "node:assert/strict";

import { MqttClient, parseMqttUrl, topicMatches } from "../scripts/mcp/lib/mqtt-client.mjs";
import { FakeBroker } from "./helpers/fake-broker.mjs";

test("parseMqttUrl handles schemes, defaults and embedded credentials", () => {
  assert.deepEqual(parseMqttUrl("mqtt://broker.local"), { host: "broker.local", port: 1883, secure: false, username: undefined, password: undefined });
  assert.deepEqual(parseMqttUrl("mqtts://user:p%40ss@broker.local"), { host: "broker.local", port: 8883, secure: true, username: "user", password: "p@ss" });
  assert.equal(parseMqttUrl("tcp://10.0.0.1:1884").port, 1884);
  assert.equal(parseMqttUrl("ssl://10.0.0.1").secure, true);
  assert.throws(() => parseMqttUrl("ws://broker.local"), /Unsupported MQTT URL scheme/);
});

test("topicMatches implements MQTT wildcard rules", () => {
  assert.ok(topicMatches("sensors/+/temperature", "sensors/line1/temperature"));
  assert.ok(!topicMatches("sensors/+/temperature", "sensors/line1/zone2/temperature"));
  assert.ok(topicMatches("sensors/#", "sensors/line1/zone2/temperature"));
  assert.ok(topicMatches("sensors/#", "sensors"));
  assert.ok(topicMatches("$SYS/Coreflux/Actions/+/Error", "$SYS/Coreflux/Actions/Alert/Error"));
  assert.ok(!topicMatches("#", "$SYS/Coreflux/Version"), "# must not match $SYS topics");
  assert.ok(!topicMatches("+/Coreflux/Version", "$SYS/Coreflux/Version"));
  assert.ok(!topicMatches("a/b", "a/b/c"));
});

let broker;
before(async () => {
  broker = await new FakeBroker({ users: { root: "coreflux", viewer: "viewer" } }).listen();
});
after(async () => {
  await broker.close();
});

test("client connects, subscribes, publishes with QoS 1 and receives retained messages", async () => {
  const client = new MqttClient({ url: broker.url, username: "root", password: "coreflux", clientId: "test-client" });
  await client.connect();
  assert.ok(client.connected);
  assert.match(client.description, /mqtt:\/\/127\.0\.0\.1:\d+ as root \(clientId test-client\)/);

  const received = [];
  client.on("message", (message) => received.push(message));

  broker.publish("plant/line1/state", "running", { retain: true });
  const granted = await client.subscribe("plant/+/state", 1);
  assert.equal(granted, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 1);
  assert.equal(received[0].topic, "plant/line1/state");
  assert.equal(received[0].payload.toString(), "running");
  assert.equal(received[0].retain, true);

  await client.publish("plant/line1/state", "stopped", { qos: 1 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 2);
  assert.equal(received[1].payload.toString(), "stopped");
  assert.equal(received[1].retain, false);

  await client.unsubscribe("plant/+/state");
  await client.publish("plant/line1/state", "ignored", { qos: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 2, "no delivery after unsubscribe");

  await client.end();
  assert.ok(!client.connected);
});

test("client surfaces CONNACK refusal and $SYS subscription denial", async () => {
  const bad = new MqttClient({ url: broker.url, username: "root", password: "wrong" });
  await assert.rejects(bad.connect(), /bad user name or password/);

  const viewer = new MqttClient({ url: broker.url, username: "viewer", password: "viewer" });
  await viewer.connect();
  await assert.rejects(viewer.subscribe("$SYS/Coreflux/Command/Output"), /rejected subscription/);
  await viewer.end();
});

test("client fails fast on a closed port", async () => {
  const closed = new MqttClient({ url: "mqtt://127.0.0.1:1", connectTimeoutMs: 2000 });
  await assert.rejects(closed.connect(), /MQTT connection to 127\.0\.0\.1:1 failed/);
});

test("client reassembles packets split across TCP chunks", async () => {
  const client = new MqttClient({ url: broker.url, username: "root", password: "coreflux" });
  await client.connect();
  const messages = [];
  client.on("message", (message) => messages.push(message));
  await client.subscribe("bulk/#", 0);

  const payload = "x".repeat(70000); // forces a multi-byte remaining-length header and several TCP segments
  broker.publish("bulk/big", payload);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.length, 70000);
  await client.end();
});
