import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only binding so the setup file can apply the migrations.
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Login settings for tests; real ones live in .dev.vars and secrets.
            PUBLIC_URL: "http://localhost:8787",
            GITHUB_CLIENT_ID: "test-github-client",
            GITHUB_CLIENT_SECRET: "test-github-secret",
            ALLOWED_GITHUB_ID: "1001",
          },
          // The real limits (wrangler.jsonc) would refuse the suite's many
          // logins; auth.test.ts checks the refusal itself.
          ratelimits: {
            REGISTER_LIMIT: { namespace_id: "7001", simple: { limit: 1000, period: 60 } },
            AUTHORIZE_LIMIT: { namespace_id: "7002", simple: { limit: 1000, period: 60 } },
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
