// remember: add one record to a name (spec §7.1). Zod checks the arguments;
// this checks what needs the database (R1–R4, R9, R10) and inserts the name
// (if new) and the record in one batch, so either both land or neither does.

import { BankError } from "./errors";
import { describeNames, getName, typeNames } from "./lookups";
import { parse, rememberInput } from "./schemas";
import { wallClockToMillis } from "./time";

/** Slack for clock differences and Claude rounding "just now" up (R6). */
const FUTURE_SLACK_MS = 5 * 60_000;

export interface RememberResult {
  id: number;
  name: string;
  type: string;
  occurred_at: string;
  created_at: string;
  previous_id: number | null;
  corrects?: number;
  kind?: "correction" | "retraction";
}

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
      throw new BankError(`type must be one of: ${types.join(", ")}`);
    }
    type = input.type;
  }

  // R9, R10: a correction points to a record of this name that hasn't been corrected yet.
  if (input.corrects !== undefined) {
    await checkCorrectable(db, input.corrects, input.name);
  }

  const statements: D1PreparedStatement[] = [];
  if (!existing) {
    statements.push(db.prepare("INSERT INTO names (name, type) VALUES (?, ?)").bind(input.name, type));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO records (name, occurred_at, description, body, corrects, kind)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id, occurred_at, created_at`,
      )
      .bind(input.name, input.occurred_at, input.description, input.body, input.corrects ?? null, input.kind ?? null),
  );

  let inserted: { id: number; occurred_at: string; created_at: string };
  try {
    const results = await db.batch<{ id: number; occurred_at: string; created_at: string }>(statements);
    inserted = results[results.length - 1]!.results[0]!;
  } catch (error) {
    // Another save got in between our checks and this insert.
    throw await explainConflict(db, error, input.name, input.corrects);
  }

  const previous = await db
    .prepare("SELECT max(id) AS id FROM records WHERE name = ? AND id < ?")
    .bind(input.name, inserted.id)
    .first<{ id: number | null }>();

  return {
    id: inserted.id,
    name: input.name,
    type,
    occurred_at: inserted.occurred_at,
    created_at: inserted.created_at,
    previous_id: previous?.id ?? null,
    ...(input.corrects !== undefined && { corrects: input.corrects, kind: input.kind }),
  };
}

async function checkCorrectable(db: D1Database, id: number, name: string): Promise<void> {
  const target = await db
    .prepare(
      `SELECT r.name, c.id AS corrected_by
       FROM records r LEFT JOIN records c ON c.corrects = r.id
       WHERE r.id = ?`,
    )
    .bind(id)
    .first<{ name: string; corrected_by: number | null }>();
  if (!target) throw new BankError(`#${id} doesn't exist`);
  if (target.name !== name) throw new BankError(`#${id} is in '${target.name}', not '${name}'`);
  if (target.corrected_by !== null) {
    throw new BankError(
      `#${id} is already corrected by #${target.corrected_by}. To fix the correction, pass corrects=${target.corrected_by}.`,
    );
  }
}

/** Turns a constraint failure caused by a concurrent save into a fixable message. */
async function explainConflict(db: D1Database, error: unknown, name: string, corrects?: number): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed: names\.name/.test(message)) {
    return new BankError(`'${name}' was just created by another save. Omit new_name and type to add to it.`);
  }
  if (corrects !== undefined && /UNIQUE constraint failed: records\.corrects|corrects: must point/.test(message)) {
    try {
      await checkCorrectable(db, corrects, name);
    } catch (explained) {
      return explained;
    }
  }
  return error;
}
