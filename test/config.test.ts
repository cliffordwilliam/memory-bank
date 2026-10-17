// The settings schema (src/config.ts): values from outside the code are
// validated like any other input, and anything wrong fails closed.
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { ConfigError } from "../src/errors";

const good = {
  PUBLIC_URL: "https://memory-bank.example.workers.dev",
  GITHUB_CLIENT_ID: "client",
  GITHUB_CLIENT_SECRET: "secret",
  ALLOWED_GITHUB_ID: "131695663",
};
const read = (overrides: Record<string, unknown>) => readConfig({ ...good, ...overrides } as unknown as Env);

describe("readConfig", () => {
  it("accepts good settings and normalizes them", () => {
    expect(read({ PUBLIC_URL: "http://localhost:8787/" })).toEqual({
      publicUrl: "http://localhost:8787",
      githubClientId: "client",
      githubClientSecret: "secret",
      allowedGithubId: 131695663,
    });
  });

  it.each([
    ["PUBLIC_URL", undefined, "PUBLIC_URL: must be an http(s) URL"],
    ["PUBLIC_URL", "memory-bank.example.workers.dev", "PUBLIC_URL: must be an http(s) URL"],
    ["PUBLIC_URL", "ftp://example.com", "PUBLIC_URL: must be an http(s) URL"],
    ["PUBLIC_URL", "https://example.com/mcp", "PUBLIC_URL: must be an origin only"],
    ["PUBLIC_URL", "https://example.com/?x=1", "PUBLIC_URL: must be an origin only"],
    ["GITHUB_CLIENT_ID", "", "GITHUB_CLIENT_ID: must be set"],
    ["GITHUB_CLIENT_SECRET", undefined, "GITHUB_CLIENT_SECRET: must be set"],
    ["ALLOWED_GITHUB_ID", "", "ALLOWED_GITHUB_ID: must be a numeric GitHub user id"],
    ["ALLOWED_GITHUB_ID", "cliffordwilliam", "ALLOWED_GITHUB_ID: must be a numeric GitHub user id"],
    ["ALLOWED_GITHUB_ID", "0123", "ALLOWED_GITHUB_ID: must be a numeric GitHub user id"],
  ])("refuses %s = %j", (key, value, message) => {
    expect(() => read({ [key]: value })).toThrow(ConfigError);
    expect(() => read({ [key]: value })).toThrow(message);
  });

  it("names every problem at once", () => {
    expect(() => read({ PUBLIC_URL: undefined, ALLOWED_GITHUB_ID: "x" })).toThrow(
      /PUBLIC_URL: .*; ALLOWED_GITHUB_ID: /,
    );
  });
});
