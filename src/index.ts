import { createMcpHandler } from "agents/mcp/server";
import { createBankServer } from "./mcp";

// Phase 4: the bank's tools at /mcp, still without login (phase 5 adds it).
export default {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createBankServer(env.DB))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
