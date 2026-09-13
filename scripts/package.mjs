#!/usr/bin/env node
// Builds dist/coreflux-plugin-<version>.zip (the installable plugin folder without tests) plus a
// SHA-256 checksum. Dependency-free: reuses the plugin's own ZIP writer.

import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { zipDirectory } from "../plugins/coreflux/scripts/mcp/lib/zip.mjs";

const root = process.cwd();
const pluginDir = path.join(root, "plugins", "coreflux");
const { version } = JSON.parse(readFileSync(path.join(pluginDir, ".cursor-plugin", "plugin.json"), "utf8"));
const dist = path.join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const { buffer, files } = zipDirectory(pluginDir, {
  include: (rel) => !rel.startsWith("test/") && !rel.startsWith("scripts/smoke-test") && !rel.startsWith("scripts/e2e-test"),
});
const archive = path.join(dist, `coreflux-plugin-${version}.zip`);
writeFileSync(archive, buffer);
const sha256 = createHash("sha256").update(buffer).digest("hex");
writeFileSync(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);

console.log(`${path.relative(root, archive)} (${buffer.length} bytes, ${files.length} files)`);
console.log(`sha256 ${sha256}`);
