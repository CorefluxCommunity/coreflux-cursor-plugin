#!/usr/bin/env node
// Repository consistency checks that the generic template validator does not cover:
//  - every .mjs parses (node --check) and every .json parses
//  - versions agree across package.json, marketplace.json, plugin.json and the MCP server
//  - hooks.json / mcp.json reference scripts that exist
//  - agents, commands, rules and skills carry the frontmatter Cursor needs
//  - docs only mention MCP tools the server actually exposes
//  - no CRLF line endings or trailing whitespace in tracked text files
//
// Dependency-free; run with `npm run check`.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pluginDir = path.join(root, "plugins", "coreflux");
const errors = [];
const fail = (message) => errors.push(message);
const rel = (file) => path.relative(root, file).split(path.sep).join("/");

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", ".worktrees"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

const files = [];
walk(root, (file) => files.push(file));

// 1. Syntax of every JavaScript module and every JSON document.
for (const file of files.filter((candidate) => candidate.endsWith(".mjs"))) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    fail(`${rel(file)}: syntax error\n${error.stderr?.toString() ?? error.message}`);
  }
}
const json = {};
for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
  try {
    json[rel(file)] = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${rel(file)}: invalid JSON (${error.message})`);
  }
}

// 2. Versions.
const pkg = json["package.json"];
const marketplace = json[".cursor-plugin/marketplace.json"];
const plugin = json["plugins/coreflux/.cursor-plugin/plugin.json"];
const serverSource = readFileSync(path.join(pluginDir, "scripts", "mcp", "coreflux-mqtt-mcp.mjs"), "utf8");
const serverVersion = /const SERVER_VERSION = "([^"]+)"/.exec(serverSource)?.[1];
const versions = {
  "package.json": pkg?.version,
  ".cursor-plugin/marketplace.json (metadata.version)": marketplace?.metadata?.version,
  "plugins/coreflux/.cursor-plugin/plugin.json": plugin?.version,
  "coreflux-mqtt-mcp.mjs (SERVER_VERSION)": serverVersion,
};
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1 || distinct.has(undefined)) {
  fail(`Version mismatch:\n${Object.entries(versions).map(([where, version]) => `  ${where}: ${version ?? "(missing)"}`).join("\n")}`);
}
if (pkg?.version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) fail(`package.json version "${pkg.version}" is not semver`);

// 3. Hooks and MCP servers point at real scripts.
const hooks = json["plugins/coreflux/hooks/hooks.json"];
for (const [event, entries] of Object.entries(hooks?.hooks ?? {})) {
  for (const entry of entries) {
    const script = /node\s+(\S+)/.exec(entry.command ?? "")?.[1];
    if (!script) {
      fail(`hooks.json ${event}: command "${entry.command}" is not "node <script>"`);
      continue;
    }
    if (!existsSync(path.join(pluginDir, script))) fail(`hooks.json ${event}: ${script} does not exist under plugins/coreflux`);
  }
}
const mcp = json["plugins/coreflux/mcp.json"];
for (const [name, server] of Object.entries(mcp?.mcpServers ?? {})) {
  if (server.url) {
    if (!/^https:\/\//.test(server.url)) fail(`mcp.json ${name}: remote servers must use https (${server.url})`);
    continue;
  }
  for (const arg of server.args ?? []) {
    if (!arg.includes("${CURSOR_PLUGIN_ROOT}")) continue;
    const scriptPath = path.join(pluginDir, arg.replace("${CURSOR_PLUGIN_ROOT}/", ""));
    if (!existsSync(scriptPath)) fail(`mcp.json ${name}: ${arg} does not exist`);
  }
  for (const [key, value] of Object.entries(server.env ?? {})) {
    const variable = /^\$\{([A-Z0-9_]+)\}$/.exec(value)?.[1];
    if (variable && !plugin?.variables?.properties?.[variable]) fail(`mcp.json ${name}: env ${key} uses ${value} but plugin.json declares no such variable`);
  }
}

// 4. Frontmatter on agents, commands, rules and skills.
function frontmatter(file) {
  const text = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) data[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return data;
}
function requireFrontmatter(dir, keys, { nameMatchesFile = false } = {}) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const skill = path.join(file, "SKILL.md");
      if (!existsSync(skill)) {
        fail(`${rel(file)}: skill directory has no SKILL.md`);
        continue;
      }
      const data = frontmatter(skill);
      if (!data) fail(`${rel(skill)}: missing frontmatter`);
      else for (const key of keys) if (!data[key]) fail(`${rel(skill)}: frontmatter lacks "${key}"`);
      if (data?.name && data.name !== entry.name) fail(`${rel(skill)}: name "${data.name}" must equal directory name "${entry.name}"`);
      continue;
    }
    if (!/\.(md|mdc)$/.test(entry.name)) continue;
    const data = frontmatter(file);
    if (!data) {
      fail(`${rel(file)}: missing frontmatter`);
      continue;
    }
    for (const key of keys) if (!data[key]) fail(`${rel(file)}: frontmatter lacks "${key}"`);
    if (nameMatchesFile && data.name && data.name !== entry.name.replace(/\.md$/, "")) fail(`${rel(file)}: name "${data.name}" must equal file name`);
  }
}
requireFrontmatter(path.join(pluginDir, "agents"), ["name", "description"], { nameMatchesFile: true });
requireFrontmatter(path.join(pluginDir, "commands"), ["name", "description"], { nameMatchesFile: true });
requireFrontmatter(path.join(pluginDir, "rules"), ["description"]);
requireFrontmatter(path.join(pluginDir, "skills"), ["name", "description"]);

// 5. Docs reference only tools the server exposes.
const toolNames = new Set([...serverSource.matchAll(/^\s{4}name: "([a-z_]+)",$/gm)].map((match) => match[1]));
if (toolNames.size < 10) fail(`Could not extract tool names from the MCP server (found ${toolNames.size})`);
const docFiles = files.filter((file) => /\.(md|mdc)$/.test(file) && file.startsWith(pluginDir));
const knownPrefixes = /\b((?:broker|mqtt|lot|lotnb|project)_[a-z_]+)\b/g;
for (const file of docFiles) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(knownPrefixes)) {
    if (!toolNames.has(match[1])) fail(`${rel(file)}: mentions MCP tool "${match[1]}" which the server does not expose`);
  }
}

// 6. Line endings (as stored in git, so Windows checkouts with autocrlf are fine), trailing
//    whitespace and final newlines in text files.
try {
  const eol = execFileSync("git", ["ls-files", "--eol"], { cwd: root, stdio: "pipe" }).toString();
  for (const line of eol.split("\n")) {
    const match = /^i\/(\S+)\s+w\/\S+\s+attr\/\S*\s+(.+)$/.exec(line.trim());
    if (match && (match[1] === "crlf" || match[1] === "mixed")) fail(`${match[2]}: stored with ${match[1].toUpperCase()} line endings (repository uses LF; see .gitattributes)`);
  }
} catch {
  // not a git checkout (e.g. exported tarball) — skip the index check
}
const textExtensions = new Set([".mjs", ".js", ".json", ".md", ".mdc", ".yml", ".yaml", ".svg", ".txt", ".gitignore", ".gitattributes", ".editorconfig"]);
for (const file of files) {
  const ext = path.extname(file) || path.basename(file);
  if (!textExtensions.has(ext)) continue;
  if (statSync(file).size > 2_000_000) continue;
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (/[ \t]+\n/.test(text) && !file.endsWith(".md")) fail(`${rel(file)}: trailing whitespace`);
  if (text.length && !text.endsWith("\n")) fail(`${rel(file)}: missing final newline`);
}

if (errors.length) {
  console.error(`check-sources: ${errors.length} problem(s)\n`);
  for (const error of errors) console.error(`- ${error}\n`);
  process.exit(1);
}
console.log(`check-sources: OK (${files.length} files, ${toolNames.size} MCP tools, version ${pkg.version})`);
