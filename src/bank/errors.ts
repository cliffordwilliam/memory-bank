/**
 * An error Claude can act on: the message says what was wrong and how to fix
 * the call. Phase 4 turns these into MCP tool errors; anything else that
 * escapes is a bug and is reported generically.
 */
export class BankError extends Error {
  override name = "BankError";
}
