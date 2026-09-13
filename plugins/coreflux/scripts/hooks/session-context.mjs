#!/usr/bin/env node
// sessionStart hook: tell the agent which Coreflux broker this workspace points at and what LoT
// assets exist, so it reaches for the right tools without being asked.
//
// Output (stdout): { additional_context?: string }

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readStdinJson, respond } from "./lib/destructive.mjs";

await readStdinJson();

const root = process.env.CURSOR_PROJECT_DIR || process.cwd();
const lines = [];

const brokerFile = path.join(root, ".broker");
if (existsSync(brokerFile)) {
  const url = readFileSync(brokerFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[a-z]+:\/\//i.test(line));
  if (url) lines.push(`Workspace .broker file points at ${url}; the coreflux-broker MCP tools use it unless COREFLUX_MQTT_URL is set.`);
}

function countNotebooks(dir, depth = 0, acc = { lotnb: 0, lot: 0 }) {
  if (depth > 4) return acc;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "bin" || entry.name === "obj") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) countNotebooks(full, depth + 1, acc);
    else if (entry.name.endsWith(".lotnb")) acc.lotnb++;
    else if (entry.name.endsWith(".lot")) acc.lot++;
  }
  return acc;
}

const counts = countNotebooks(root);
if (counts.lotnb || counts.lot) {
  lines.push(`Workspace contains ${counts.lotnb} .lotnb notebook(s) and ${counts.lot} .lot file(s): treat it as a Coreflux LoT project (skills: lot-authoring, lot-projects).`);
}

respond(lines.length ? { additional_context: `Coreflux plugin: ${lines.join(" ")}` } : {});
