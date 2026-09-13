#!/usr/bin/env node
// Sets the same version everywhere it is declared and opens a CHANGELOG section for it.
//
//   node scripts/bump-version.mjs 0.2.0

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bump-version.mjs <semver>   e.g. 0.2.0 or 1.0.0-rc.1");
  process.exit(2);
}
const root = process.cwd();

function updateJson(file, mutate) {
  const full = path.join(root, file);
  const data = JSON.parse(readFileSync(full, "utf8"));
  mutate(data);
  writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`updated ${file}`);
}

updateJson("package.json", (data) => (data.version = version));
updateJson("plugins/coreflux/.cursor-plugin/plugin.json", (data) => (data.version = version));
updateJson(".cursor-plugin/marketplace.json", (data) => (data.metadata.version = version));

const serverFile = path.join(root, "plugins", "coreflux", "scripts", "mcp", "coreflux-mqtt-mcp.mjs");
const server = readFileSync(serverFile, "utf8").replace(/const SERVER_VERSION = "[^"]+"/, `const SERVER_VERSION = "${version}"`);
writeFileSync(serverFile, server);
console.log("updated plugins/coreflux/scripts/mcp/coreflux-mqtt-mcp.mjs");

const changelogFile = path.join(root, "CHANGELOG.md");
let changelog = readFileSync(changelogFile, "utf8");
if (!changelog.includes(`## [${version}]`)) {
  const today = new Date().toISOString().slice(0, 10);
  changelog = changelog.replace(/^## \[Unreleased\]\s*\n/m, `## [Unreleased]\n\n## [${version}] - ${today}\n`);
  writeFileSync(changelogFile, changelog);
  console.log(`opened CHANGELOG.md section [${version}] — move the Unreleased entries into it`);
}
