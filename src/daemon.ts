/**
 * Daemon entry point: an MCP server over stdio supervising PTY sessions.
 *
 * Usage: bun run src/daemon.ts
 * (Wire it into an MCP client as a stdio server; see README.md.)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager } from "./manager";
import { buildServer } from "./mcp";

const manager = new SessionManager();
const server = buildServer(manager);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    manager.shutdown();
    process.exit(0);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout belongs to the MCP transport.
console.error(`[agent-term] MCP daemon up (runtime dir: ${manager.runtimeDir})`);
