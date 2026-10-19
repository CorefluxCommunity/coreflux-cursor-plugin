#!/usr/bin/env node
// Bundle the Coreflux agent skills into plugins/coreflux/skills/.
//
// CorefluxCommunity/coreflux-skills is generated from the broker (its source of truth) and tagged
// per broker release. This copies one tag of it into the plugin. The tag in use is recorded as
// `brokerVersion` in plugins/coreflux/skills/skills.json, so a plain run re-syncs the pinned tag.
// Skill directories not listed in that manifest (coreflux-cursor-tools) belong to the plugin and
// are left alone. Never edit a synced skill here: fix it in the broker and bump the tag.
//
//   node scripts/sync-skills.mjs                          re-sync the pinned tag
//   node scripts/sync-skills.mjs --ref 2.21.17            move the pin to another tag
//   node scripts/sync-skills.mjs --from ../coreflux-skills   use a local checkout
//   node scripts/sync-skills.mjs --check                  fail if the bundle differs from the pinned tag

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/CorefluxCommunity/coreflux-skills.git";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "plugins", "coreflux", "skills");
const manifestPath = path.join(dest, "skills.json");

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const check = args.includes("--check");

const readManifest = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const current = readManifest(manifestPath);

let source = option("--from");
let tmp;
if (!source) {
  const ref = option("--ref") ?? current?.brokerVersion;
  if (!ref) {
    console.error("no pinned tag in plugins/coreflux/skills/skills.json; pass --ref <tag>");
    process.exit(1);
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coreflux-skills-"));
  execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", ref, REPO, tmp], { stdio: "inherit" });
  source = tmp;
}

// Every file a synced bundle consists of, relative to plugins/coreflux/skills.
function bundleFiles(dir, manifest) {
  const files = ["skills.json", "LICENSE"];
  for (const skill of manifest.skills) {
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = path.posix.join(rel, entry.name);
        if (entry.isDirectory()) walk(child);
        else files.push(child);
      }
    };
    walk(skill.name);
  }
  return files.sort();
}

try {
  const incoming = readManifest(path.join(source, "skills.json"));
  const sourceLayout = { root: path.join(source, "skills"), at: (rel) => (rel === "skills.json" || rel === "LICENSE" ? path.join(source, rel) : path.join(source, "skills", rel)) };

  if (check) {
    if (!current) throw new Error("plugins/coreflux/skills/skills.json is missing");
    const want = bundleFiles(sourceLayout.root, incoming);
    const have = bundleFiles(dest, current);
    const problems = [];
    for (const rel of new Set([...want, ...have])) {
      if (!want.includes(rel)) problems.push(`${rel}: not in coreflux-skills ${incoming.brokerVersion}`);
      else if (!have.includes(rel)) problems.push(`${rel}: missing from the bundle`);
      else if (!fs.readFileSync(sourceLayout.at(rel)).equals(fs.readFileSync(path.join(dest, rel)))) problems.push(`${rel}: differs from coreflux-skills ${incoming.brokerVersion}`);
    }
    if (problems.length) {
      console.error(`synced skills drifted (fix them in the broker, then run node scripts/sync-skills.mjs):\n${problems.map((p) => `- ${p}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`skills match coreflux-skills ${incoming.brokerVersion} (${incoming.skills.length} skills)`);
  } else {
    const owned = new Set(incoming.skills.map((skill) => skill.name));
    for (const skill of current?.skills ?? []) fs.rmSync(path.join(dest, skill.name), { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
      if (entry.isDirectory() && owned.has(entry.name)) throw new Error(`skills/${entry.name} is plugin-owned but coreflux-skills now ships a skill of that name; rename one`);
    }
    for (const skill of incoming.skills) fs.cpSync(path.join(source, "skills", skill.name), path.join(dest, skill.name), { recursive: true });
    fs.copyFileSync(path.join(source, "skills.json"), manifestPath);
    fs.copyFileSync(path.join(source, "LICENSE"), path.join(dest, "LICENSE"));
    console.log(`bundled ${incoming.skills.length} skills (broker ${incoming.brokerVersion || "main"}) into plugins/coreflux/skills`);
  }
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}
