#!/usr/bin/env node
// Release gate: the git tag must equal the plugin version, and CHANGELOG.md must have a section
// for it. With --notes, prints that section (used as the GitHub release body).
//
//   node scripts/check-release.mjs v0.2.0
//   node scripts/check-release.mjs v0.2.0 --notes > dist/RELEASE_NOTES.md

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [tag, flag] = process.argv.slice(2);
if (!tag) {
  console.error("usage: check-release.mjs <tag> [--notes]");
  process.exit(2);
}
const version = tag.replace(/^v/, "");
const root = process.cwd();
const plugin = JSON.parse(readFileSync(path.join(root, "plugins", "coreflux", ".cursor-plugin", "plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const problems = [];
if (plugin.version !== version) problems.push(`plugin.json version ${plugin.version} != tag ${version}`);
if (pkg.version !== version) problems.push(`package.json version ${pkg.version} != tag ${version}`);

const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Body runs until the next "## [" heading or the link-reference block at the end of the file.
const section = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]: |$(?![\\s\\S]))`, "m").exec(changelog);
if (!section) problems.push(`CHANGELOG.md has no "## [${version}]" section`);
else if (!section[1].trim()) problems.push(`CHANGELOG.md section for ${version} is empty`);

if (problems.length) {
  console.error(`check-release: ${problems.join("; ")}`);
  process.exit(1);
}

if (flag === "--notes") {
  const body = section[1].trim();
  process.stdout.write(`${body}\n\n---\n\nInstall from the Cursor Marketplace or unpack \`coreflux-plugin-${version}.zip\` as a local plugin. Verify with the \`.sha256\` file.\n`);
} else {
  console.log(`check-release: ${tag} matches plugin ${plugin.version} and CHANGELOG.md`);
}
