import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

// Phase 1 placeholder: proves the stack runs. Replaced in phase 4.
function createServer() {
  const server = new McpServer({ name: "memory-bank", version: "0.0.0" });
  server.registerTool(
    "ping",
    { description: "Returns pong. Placeholder until the bank tools exist." },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
