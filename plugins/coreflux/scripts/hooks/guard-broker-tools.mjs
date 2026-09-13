#!/usr/bin/env node
// beforeMCPExecution hook: require user approval for destructive Coreflux broker operations.
//
// Input (stdin):  { tool_name, tool_input (JSON string), mcp_server_name, command? }
// Output (stdout): { permission: "allow" | "ask" | "deny", user_message?, agent_message? }

import { destructiveReason, readStdinJson, respond } from "./lib/destructive.mjs";

const input = await readStdinJson();

if (input.mcp_server_name !== "coreflux-broker") {
  respond({ permission: "allow" });
  process.exit(0);
}

let args = {};
try {
  args = typeof input.tool_input === "string" ? JSON.parse(input.tool_input || "{}") : input.tool_input ?? {};
} catch {
  args = {};
}

const ask = (what, reason) =>
  respond({
    permission: "ask",
    user_message: `Coreflux: ${what} — this ${reason}. Approve only if you asked for it.`,
    agent_message: `The Coreflux plugin paused "${what}" because it ${reason}. Make sure the user explicitly requested this exact operation, state the consequence, and let them approve the call.`,
  });

switch (input.tool_name) {
  case "broker_command": {
    const reason = destructiveReason(args.command);
    if (reason) {
      ask(String(args.command).trim().split(/\s+/).slice(0, 2).join(" "), reason);
      break;
    }
    respond({ permission: "allow" });
    break;
  }
  case "mqtt_publish": {
    const topic = String(args.topic ?? "");
    if (/^\$SYS\/Coreflux\/Command$/i.test(topic)) {
      const reason = destructiveReason(args.payload);
      if (reason) {
        ask(`publish ${String(args.payload).trim().split(/\s+/)[0]} to ${topic}`, reason);
        break;
      }
    }
    if (topic.startsWith("$SYS/") && args.retain === true) {
      ask(`retained publish to ${topic}`, "overwrites broker system state");
      break;
    }
    respond({ permission: "allow" });
    break;
  }
  case "project_upload": {
    if (args.load === true) {
      ask(`upload and load project ${args.name ?? args.path}`, "replaces the active project's entities on the broker");
      break;
    }
    respond({ permission: "allow" });
    break;
  }
  default:
    respond({ permission: "allow" });
}
