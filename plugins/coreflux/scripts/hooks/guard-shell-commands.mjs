#!/usr/bin/env node
// beforeShellExecution hook: catch destructive Coreflux commands sent through mosquitto_pub or
// any other CLI that targets $SYS/Coreflux/Command, so the MCP guard cannot be bypassed via shell.
//
// Input (stdin):  { command, cwd, sandbox }
// Output (stdout): { permission: "allow" | "ask" | "deny", user_message?, agent_message? }

import { DESTRUCTIVE_VERBS, normaliseVerb, readStdinJson, respond } from "./lib/destructive.mjs";

const input = await readStdinJson();
const command = String(input.command ?? "");

if (!/Coreflux\/Command|mosquitto_pub/i.test(command)) {
  respond({ permission: "allow" });
  process.exit(0);
}

const verbs = command.match(/(?:^|[\s'"=])(--?[A-Za-z][A-Za-z-]+)/g) ?? [];
for (const raw of verbs) {
  const token = raw.trim().replace(/^['"=]/, "");
  const reason = DESTRUCTIVE_VERBS.get(normaliseVerb(token));
  if (reason) {
    respond({
      permission: "ask",
      user_message: `Coreflux: shell command sends ${token} to the broker — this ${reason}.`,
      agent_message: `This shell command publishes ${token} to the Coreflux command topic, which ${reason}. Confirm the user explicitly asked for this before proceeding.`,
    });
    process.exit(0);
  }
}

respond({ permission: "allow" });
