#!/usr/bin/env node
// Runs every plugins/coreflux/test/*.test.mjs with node:test. Lists files explicitly because
// `node --test <glob>` only expands globs on Node ≥ 21 and the plugin supports Node 20.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const testDir = path.join(process.cwd(), "plugins", "coreflux", "test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testDir, name));

if (!files.length) {
  console.error(`No *.test.mjs files under ${testDir}`);
  process.exit(1);
}

const extra = process.argv.slice(2); // e.g. --test-name-pattern=lint
const result = spawnSync(process.execPath, ["--test", ...extra, ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
