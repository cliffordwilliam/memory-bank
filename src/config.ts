// The login's settings (spec §11). Wrangler checks that they *exist*:
// `wrangler deploy` refuses to go out while a setting in "secrets.required"
// is missing, and generates their types. It can't check that a value is
// *meaningful*, and locally a missing one is only a warning, so this schema
// validates them like any other input from outside the code, and fails
// closed: anything wrong means nobody gets in.

import { z } from "zod";
import { ConfigError } from "./errors";

const settings = z.object({
  PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
    // A pipe stops when the URL check above fails, so everything after it
    // only ever sees a parsed URL.
    .pipe(z.transform((value) => new URL(value)))
    .refine(
      (url) => url.pathname === "/" && !url.search && !url.hash,
      "must be an origin only, e.g. https://memory-bank.example.workers.dev",
    )
    .transform((url) => url.origin),
  GITHUB_CLIENT_ID: z.string({ error: "must be set" }).min(1, "must be set"),
  GITHUB_CLIENT_SECRET: z.string({ error: "must be set" }).min(1, "must be set"),
  ALLOWED_GITHUB_ID: z
    .string({ error: "must be set" })
    .regex(/^[1-9]\d{0,15}$/, "must be a numeric GitHub user id")
    .transform(Number),
});

export interface Config {
  /** Origin the bank is served from, e.g. https://memory-bank.example.workers.dev */
  publicUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  /** The one GitHub account (numeric id) allowed in. */
  allowedGithubId: number;
}

export function readConfig(env: Env): Config {
  const result = settings.safeParse(env);
  if (!result.success) {
    // e.g. "ALLOWED_GITHUB_ID: must be a numeric GitHub user id; PUBLIC_URL: must be set"
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const s = result.data;
  return {
    publicUrl: s.PUBLIC_URL,
    githubClientId: s.GITHUB_CLIENT_ID,
    githubClientSecret: s.GITHUB_CLIENT_SECRET,
    allowedGithubId: s.ALLOWED_GITHUB_ID,
  };
}

/** What a grant carries: who logged in. Encrypted by the OAuth library, given to /mcp as ctx.props. */
export interface Props {
  githubId: number;
  login: string;
}
