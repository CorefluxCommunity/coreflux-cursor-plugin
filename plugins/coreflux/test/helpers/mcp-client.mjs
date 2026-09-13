// Spawns the MCP server over stdio and exposes a tiny JSON-RPC client for tests.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_PATH = path.resolve(here, "..", "..", "scripts", "mcp", "coreflux-mqtt-mcp.mjs");

export class McpTestClient {
  constructor({ env = {}, cwd } = {}) {
    this.process = spawn(process.execPath, [SERVER_PATH], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.process.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
    this.pending = new Map();
    this.nextId = 1;
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
    });
  }

  call(method, params) {
    const id = this.nextId++;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No response to ${method} within 30s. stderr: ${this.stderr}`));
      }, 30000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  notify(method, params) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    const result = await this.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    this.notify("notifications/initialized");
    return result;
  }

  /** Calls a tool and returns the parsed JSON text content (or raw text when not JSON). */
  async tool(name, args = {}) {
    const response = await this.call("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    const text = response.result?.content?.[0]?.text ?? "";
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // plain text result
    }
    return { isError: response.result?.isError === true, text, data: parsed };
  }

  close() {
    return new Promise((resolve) => {
      this.process.once("exit", () => resolve());
      this.process.stdin.end();
      setTimeout(() => {
        this.process.kill();
        resolve();
      }, 3000).unref();
    });
  }
}
