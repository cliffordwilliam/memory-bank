// The spec promises the server only ever SELECTs and INSERTs (§5, §10): the
// edits the triggers still allow are the owner's alone. src/bank/store.ts is
// the one file with SQL, so this checks the promise across the whole source.
import { describe, expect, it } from "vitest";

// Every source file as text (a Vite feature; the test runner goes through Vite).
const sources = (import.meta as unknown as {
  glob: (pattern: string, options: object) => Record<string, string>;
}).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

describe("the data layer", () => {
  it("found the source files", () => {
    expect(Object.keys(sources)).toContain("../src/bank/store.ts");
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it("no file in src/ contains an UPDATE or DELETE statement", () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
      expect(text, file).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });

  it("only store.ts runs SQL", () => {
    for (const [file, text] of Object.entries(sources)) {
      if (file === "../src/bank/store.ts") continue;
      expect(text, file).not.toMatch(/\.(prepare|batch)\(/);
      expect(text, file).not.toMatch(/\b(db|DB)\.exec\(/); // (time.ts calls exec on a regex, which is fine)
    }
  });
});
