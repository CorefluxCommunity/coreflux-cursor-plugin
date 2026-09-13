#!/usr/bin/env node
// sessionStart hook: make sure the LOT Notebooks editor extension (coreflux.vscode-lot-notebooks)
// is installed, so .lotnb files open as notebooks instead of raw JSON. Cursor plugins cannot
// declare editor extensions as dependencies, so this asks the Cursor CLI to install it once.
//
// Behaviour:
//   - checks `cursor --list-extensions` at most once per day (stamp in ~/.coreflux/plugin-state.json)
//   - when the extension is missing, starts `cursor --install-extension …` detached so the hook
//     returns immediately, and tells the agent to mention the reload
//   - opt out with COREFLUX_INSTALL_LOT_EXTENSION=false or {"installLotExtension": false} in the state file
//
// Output (stdout): { additional_context?: string }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readStdinJson, respond } from "./lib/destructive.mjs";

export const EXTENSION_ID = "coreflux.vscode-lot-notebooks";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/CorefluxCommunity/VSCodeLotNotebook/releases";

function stateFile(env) {
  const home = env.COREFLUX_HOME?.trim() || path.join(homedir(), ".coreflux");
  return path.join(home, "plugin-state.json");
}

function readState(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // a read-only home must not break the session
  }
}

/**
 * Locates the Cursor CLI: explicit override (a path, or a JSON array command line), PATH, then the
 * usual install locations. Returns [command, ...leadingArgs] or null.
 */
export function findCursorCli(env = process.env) {
  const override = env.COREFLUX_CURSOR_CLI?.trim();
  if (override) {
    if (override.startsWith("[")) {
      try {
        const parsed = JSON.parse(override);
        if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
      } catch {
        // fall through to treating it as a path
      }
    }
    return [override];
  }
  const isWindows = process.platform === "win32";
  const onPath = spawnSync(isWindows ? "where.exe" : "which", ["cursor"], { encoding: "utf8", timeout: 5000 });
  if (onPath.status === 0) {
    const hits = onPath.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // Windows installs ship both an extensionless shell script and cursor.cmd; only the .cmd runs here.
    const usable = isWindows ? hits.find((hit) => /\.(cmd|bat|exe)$/i.test(hit)) ?? hits.map((hit) => `${hit}.cmd`).find((hit) => existsSync(hit)) : hits[0];
    if (usable) return [usable];
  }
  const candidates = isWindows
    ? [
        path.join(env.LOCALAPPDATA ?? "", "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
        path.join(env.ProgramFiles ?? "C:\\Program Files", "cursor", "resources", "app", "bin", "cursor.cmd"),
      ]
    : process.platform === "darwin"
      ? ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor", path.join(homedir(), "Applications", "Cursor.app", "Contents", "Resources", "app", "bin", "cursor")]
      : ["/usr/share/cursor/bin/cursor", "/opt/Cursor/resources/app/bin/cursor", "/usr/bin/cursor", path.join(homedir(), ".local", "share", "cursor", "bin", "cursor")];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  return found ? [found] : null;
}

function runCli([command, ...leading], args, { detached = false } = {}) {
  // .cmd shims need a shell on Windows; quote every token so paths with spaces survive it.
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const quote = (token) => (shell && /\s/.test(token) ? `"${token}"` : token);
  const argv = [...leading, ...args].map(quote);
  if (detached) {
    const child = spawn(quote(command), argv, { detached: true, stdio: "ignore", shell, windowsHide: true });
    child.unref();
    return { started: true };
  }
  return spawnSync(quote(command), argv, { encoding: "utf8", timeout: 20000, shell, windowsHide: true });
}

export function ensureExtension({ env = process.env, now = Date.now() } = {}) {
  if ((env.COREFLUX_INSTALL_LOT_EXTENSION ?? "true").toLowerCase() === "false") return { action: "opted-out" };
  const file = stateFile(env);
  const state = readState(file);
  if (state.installLotExtension === false) return { action: "opted-out" };
  if (state.lotExtension?.installed && now - (state.lotExtension.checkedAt ?? 0) < CHECK_INTERVAL_MS) return { action: "cached", installed: true };

  const cli = findCursorCli(env);
  if (!cli) return { action: "cli-not-found" };

  const list = runCli(cli, ["--list-extensions"]);
  if (list.error || list.status !== 0) return { action: "cli-failed", error: list.error?.message ?? list.stderr?.trim() };
  const installed = list.stdout.split(/\r?\n/).some((line) => line.trim().toLowerCase() === EXTENSION_ID);
  state.lotExtension = { installed, checkedAt: now };
  if (installed) {
    writeState(file, state);
    return { action: "present", installed: true };
  }
  if (state.lotExtension?.installStartedAt && now - state.lotExtension.installStartedAt < 10 * 60 * 1000) {
    return { action: "installing" };
  }
  runCli(cli, ["--install-extension", EXTENSION_ID], { detached: true });
  state.lotExtension.installStartedAt = now;
  writeState(file, state);
  return { action: "install-started" };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await readStdinJson();
  let outcome;
  try {
    outcome = ensureExtension();
  } catch (error) {
    outcome = { action: "error", error: error.message };
  }
  const messages = {
    "install-started": `Coreflux plugin: the LOT Notebooks extension (${EXTENSION_ID}) was missing and is being installed in the background. Tell the user to run "Developer: Reload Window" once so .lotnb files open as notebooks.`,
    installing: `Coreflux plugin: the LOT Notebooks extension (${EXTENSION_ID}) is still installing; a window reload finishes the setup.`,
    "cli-not-found": `Coreflux plugin: could not find the Cursor CLI to install the LOT Notebooks extension. If .lotnb files open as plain JSON, install "${EXTENSION_ID}" from the Extensions view or ${RELEASES_URL}.`,
    "cli-failed": `Coreflux plugin: the Cursor CLI could not list extensions; install "${EXTENSION_ID}" from the Extensions view if .lotnb notebooks do not render.`,
  };
  respond(messages[outcome.action] ? { additional_context: messages[outcome.action] } : {});
}
