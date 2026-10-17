// The bank's three operations, independent of MCP and login (phase 3).
// Their contract: inputs in ./schemas.ts, outputs in ./results.ts.
export { BankError } from "../errors";
export type { Kind, ListTopicsResult, RecalledRecord, RecallResult, RememberResult, Topic } from "./results";
export { listTopics } from "./topics";
export { recall } from "./recall";
export { remember } from "./remember";
