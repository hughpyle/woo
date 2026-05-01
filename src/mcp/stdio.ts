// MCP stdio entry point.
//
// Bootstraps an in-process WooWorld (same machinery as the dev server),
// authenticates an actor from the WOO_MCP_TOKEN env var, and runs the MCP
// server over stdio so an MCP client (Claude Desktop, mcp-cli, etc.) can
// connect by spawning this process.
//
// Usage:
//   WOO_MCP_TOKEN=guest:mcp-agent node dist/mcp-stdio.js
//   WOO_MCP_TOKEN=wizard:<bootstrap> node dist/mcp-stdio.js
//
// Or via tsx for development:
//   WOO_MCP_TOKEN=guest:mcp-agent npx tsx src/mcp/stdio.ts

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWorld } from "../core/bootstrap";
import { parseAutoInstallCatalogs } from "../core/local-catalogs";
import { createMcpServer } from "./server";

async function main(): Promise<void> {
  const token = process.env.WOO_MCP_TOKEN;
  if (!token) {
    process.stderr.write("WOO_MCP_TOKEN env var is required (e.g. guest:mcp or wizard:<token>)\n");
    process.exit(2);
  }
  const world = createWorld({
    catalogs: parseAutoInstallCatalogs(process.env.WOO_AUTO_INSTALL_CATALOGS)
  });
  const session = world.auth(token);
  const { server } = createMcpServer({
    world,
    actor: session.actor,
    sessionId: session.id,
    serverName: "woo",
    serverVersion: "0.0.0"
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stdio transport keeps the process alive while the parent's pipes are open.
  // No explicit shutdown handler needed — the SDK closes on stdin EOF.
}

main().catch((err) => {
  process.stderr.write(`mcp stdio failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
