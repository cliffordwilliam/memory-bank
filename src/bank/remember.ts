// remember: add one record to a name (spec §7.1). Zod checks the arguments;
// this checks what needs the database (R1–R4, R9, R10) and inserts the name
// (if new) and the record in one batch, so either both land or neither does.

import { BankError } from "../errors";
import { describeNames } from "./lookups";
import type { RememberResult } from "./results";
import { parse, rememberInput } from "./schemas";
import { correctionTarget, getName, insertRecord, previousId, typeNames } from "./store";
import { wallClockToMillis } from "./time";

/** Slack for clock differences and Claude rounding "just now" up (R6). */
const FUTURE_SLACK_MS = 5 * 60_000;

export interface Clock {
  now?: number;
}

export async function remember(db: D1Database, raw: unknown, clock: Clock = {}): Promise<RememberResult> {
  const input = parse(rememberInput, raw);
  const now = clock.now ?? Date.now();

  // R6: not in the future.
  if (wallClockToMillis(input.occurred_at)! > now + FUTURE_SLACK_MS) {
    throw new BankError("occurred_at is in the future; check the date and offset");
  }

  const existing = await getName(db, input.name);
  let type: string;

  if (existing) {
    // R3, R4: an existing name is added to as it is.
    if (input.new_name) {
      throw new BankError(
        `'${input.name}' already exists (${existing.type}, head #${existing.head}). ` +
          "Omit new_name to add a new version, or choose a different name.",
      );
    }
    if (input.type !== undefined) {
      throw new BankError(`type is only for new names; '${input.name}' already exists (${existing.type}). Omit type.`);
    }
    type = existing.type;
  } else {
    const types = await typeNames(db);
    // R2: an unknown name is never created by accident.
    if (!input.new_name) {
      const hint = await describeNames(db, input.type && types.includes(input.type) ? input.type : undefined);
      throw new BankError(
        `name '${input.name}' doesn't exist. ${hint} ` +
          `Use one of these, or pass new_name=true with a type to create '${input.name}'.`,
      );
    }
    // R1: a new name needs a known type.
    if (input.type === undefined || !types.includes(input.type)) {
      throw new BankError(`type: must be one of: ${types.join(", ")}`);
    }
    type = input.type;
  }

  // R9, R10: a correction points to a record of this name that hasn't been corrected yet.
  if (input.corrects !== undefined) {
    await checkCorrectable(db, input.corrects, input.name);
  }

  let inserted: { id: number; occurred_at: string; created_at: string };
  try {
    inserted = await insertRecord(db, {
      name: input.name,
      ...(!existing && { newNameType: type }),
      occurred_at: input.occurred_at,
      description: input.description,
      body: input.body,
      corrects: input.corrects,
      kind: input.kind,
    });
  } catch (error) {
    // Another save got in between our checks and this insert.
    throw await explainConflict(db, error, input.name, input.corrects);
  }

  return {
    id: inserted.id,
    name: input.name,
    type,
    occurred_at: inserted.occurred_at,
    created_at: inserted.created_at,
    previous_id: await previousId(db, input.name, inserted.id),
    ...(input.corrects !== undefined && { corrects: input.corrects, kind: input.kind }),
  };
}

async function checkCorrectable(db: D1Database, id: number, name: string): Promise<void> {
  const target = await correctionTarget(db, id);
  if (!target) throw new BankError(`#${id} doesn't exist`);
  if (target.name !== name) throw new BankError(`#${id} is in '${target.name}', not '${name}'`);
  if (target.corrected_by !== null) {
    throw new BankError(
      `#${id} is already corrected by #${target.corrected_by}. To fix the correction, pass corrects=${target.corrected_by}.`,
    );
  }
}

/**
 * Turns a constraint failure caused by a concurrent save into a fixable
 * message. Throws the explanation when there is one (checkCorrectable throws
 * it), otherwise returns the original error for the caller to rethrow.
 */
async function explainConflict(db: D1Database, error: unknown, name: string, corrects?: number): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed: names\.name/.test(message)) {
    return new BankError(`'${name}' was just created by another save. Omit new_name and type to add to it.`);
  }
  if (corrects !== undefined && /UNIQUE constraint failed: records\.corrects|corrects: must point/.test(message)) {
    await checkCorrectable(db, corrects, name); // throws the BankError that explains it
  }
  return error;
}
