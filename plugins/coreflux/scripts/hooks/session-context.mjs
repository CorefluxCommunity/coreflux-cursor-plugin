#!/usr/bin/env node
// sessionStart hook: tell the agent which Coreflux broker profile is active, which others exist,
// and what LoT assets the workspace holds, so it reaches for the right tools without being asked.
//
// Output (stdout): { additional_context?: string }

import { readdirSync } from "node:fs";
import { readStdinJson, respond } from "./lib/destructive.mjs";
import { loadProfiles } from "../mcp/lib/brokers.mjs";

await readStdinJson();

const root = process.env.CURSOR_PROJECT_DIR || process.cwd();
const lines = [];

try {
  const loaded = loadProfiles({ cwd: root });
  const active = loaded.profiles[loaded.active];
  const others = Object.keys(loaded.profiles).filter((name) => name !== loaded.active).sort();
  const user = active.username ? ` as ${active.username}` : "";
  lines.push(`Active broker profile "${active.name}" → ${active.url}${user} (chosen by ${loaded.activeSource}).`);
  if (others.length) lines.push(`Other profiles: ${others.join(", ")} — switch with broker_use, list with broker_list.`);
  else lines.push("No other broker profiles are configured; broker_save adds one (ask for name, mqtt:// URL, user, password).");
  if (loaded.warnings.length) lines.push(`Profile warnings: ${loaded.warnings.join("; ")}`);
} catch (error) {
  lines.push(`Broker profiles could not be read (${error.message}); run broker_connection to diagnose.`);
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
    const full = `${dir}/${entry.name}`;
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

respond({ additional_context: `Coreflux plugin: ${lines.join(" ")}` });
