// Input validation for the three operations (spec §6). Zod checks the shape
// and format of every argument first, with messages that tell Claude how to
// fix the call; the operations then check what needs the database (R1–R4,
// R9–R11). Unknown parameters are refused rather than silently ignored.
//
// The same schemas are the MCP tool definitions (phase 4): the SDK turns them
// into the JSON Schema Claude reads, including the field descriptions, and
// validates calls with them. Messages therefore leave out the field name; both
// the SDK and parse() below put it in front ("name: must be …").

import { z } from "zod";
import { BankError } from "../errors";
import { WALL_CLOCK_EXAMPLE, wallClockToMillis } from "./time";

export const MAX_BODY = 16_000;
export const MAX_DESCRIPTION = 200;
export const MAX_IDS = 3;
export const MAX_RECALL_RESULTS = 20;
export const MAX_TOPICS_RESULTS = 200;

const name = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/, {
    error: "must be lowercase letters, digits and hyphens (1–64 characters), e.g. vanilla-cupcakes",
  });

const wallClock = z.string().refine((s) => wallClockToMillis(s) !== null, {
  error: `must be a real wall-clock time with offset, e.g. ${WALL_CLOCK_EXAMPLE}`,
});

const recordId = z.int({ error: "must be a whole positive number, e.g. 57" }).positive({
  error: "must be a whole positive number, e.g. 57",
});

const maxResults = (max: number, fallback: number) =>
  z
    .int({ error: `must be a whole number from 1 to ${max}` })
    .min(1, { error: `must be a whole number from 1 to ${max}` })
    .max(max, { error: `must be a whole number from 1 to ${max}` })
    .optional()
    .meta({ description: `How many to return, 1–${max}. Default ${fallback}.` });

const pageToken = z
  .string()
  .optional()
  .meta({ description: "next_page_token from the previous result, to continue. Repeat the same filters." });

/** The type parameter: free text for the operations, an enum in the tool definitions. */
type TypeField = z.ZodType<string | undefined>;
const anyType: TypeField = z.string().optional();

export interface TypeInfo {
  name: string;
  description: string;
}

/**
 * The type parameter as the tools show it: the types table as an enum. Only
 * remember lists the descriptions, because only creating a name needs them;
 * repeating them in every tool would cost tokens in every conversation.
 */
export function typeEnum(types: TypeInfo[], purpose: string, withDescriptions = false): TypeField {
  const names = types.map((t) => t.name) as [string, ...string[]];
  const list = withDescriptions ? `\n${types.map((t) => `- ${t.name}: ${t.description}`).join("\n")}` : "";
  return z
    .enum(names, { error: `must be one of: ${names.join(", ")}` })
    .optional()
    .meta({ description: `${purpose}${list}` });
}

// ── remember ────────────────────────────────────────────────────────────────

const rememberShape = (type: TypeField) => ({
  name: name.meta({ description: "The topic slug: lowercase letters, digits and hyphens. Reuse an existing name when one fits (call list_topics if unsure)." }),
  new_name: z
    .literal(true, { error: "must be true, or left out" })
    .optional()
    .meta({ description: "true to create the name. Required for a name that doesn't exist yet; refused for one that does." }),
  type,
  description: z
    .string()
    .min(1, { error: "can't be empty" })
    .max(MAX_DESCRIPTION, { error: `must be one line of at most ${MAX_DESCRIPTION} characters` })
    .refine((s) => !/[\r\n]/.test(s), { error: `must be one line of at most ${MAX_DESCRIPTION} characters` })
    .meta({ description: "One-line summary shown in lists, at most 200 characters." }),
  body: z
    .string()
    .min(1, { error: "can't be empty" })
    .refine((s) => s.length <= MAX_BODY, {
      error: (issue) => `is ${(issue.input as string).length} characters; the limit is ${MAX_BODY}`,
    })
    .meta({ description: "The memory itself, stored exactly as given. Keep the user's own words. For non-log types, write the whole current state, not just the change." }),
  occurred_at: wallClock.meta({ description: "When the thing described happened, as wall-clock time with the user's offset, e.g. 2026-10-15T21:00:00+07:00. For something happening now, the current time. Never in the future." }),
  corrects: recordId
    .optional()
    .meta({ description: "Only when an earlier record of this name was wrong: its id. Needs kind." }),
  kind: z
    .enum(["correction", "retraction"], { error: "must be correction or retraction" })
    .optional()
    .meta({ description: "With corrects: correction (this is what really happened; occurred_at is the event's real time) or retraction (it never happened; occurred_at is now)." }),
});

/** R8: corrects and kind go together. */
function checkCorrection(v: { corrects?: number; kind?: string }, ctx: z.RefinementCtx): void {
  if (v.corrects !== undefined && v.kind === undefined) {
    ctx.addIssue({ code: "custom", path: ["kind"], message: "is required with corrects (correction or retraction)" });
  }
  if (v.kind !== undefined && v.corrects === undefined) {
    ctx.addIssue({ code: "custom", path: ["kind"], message: "needs corrects (the id of the record that was wrong)" });
  }
}

const rememberSchema = (type: TypeField) => z.strictObject(rememberShape(type)).superRefine(checkCorrection);

export const rememberInput = rememberSchema(anyType);
export const rememberTool = (types: TypeInfo[]) =>
  rememberSchema(typeEnum(types, "Only together with new_name: the new name's type, fixed forever.", true));

// ── recall ──────────────────────────────────────────────────────────────────

const recallShape = (type: TypeField) => ({
  query: z
    .string()
    .optional()
    .meta({ description: "Keywords only, not the user's question, e.g. \"cupcake vanilla\". Words are combined with OR." }),
  ids: z
    .array(recordId)
    .min(1, { error: `takes 1 to ${MAX_IDS} ids` })
    .max(MAX_IDS, { error: `takes 1 to ${MAX_IDS} ids` })
    .optional()
    .meta({ description: "Up to 3 record ids, on their own (no other parameters). Returns exactly those records, full bodies." }),
  name: name.optional().meta({ description: "Only records of this name." }),
  type,
  after: wallClock
    .optional()
    .meta({ description: "Only things that happened at or after this wall-clock time with offset (inclusive)." }),
  before: wallClock
    .optional()
    .meta({ description: "Only things that happened before this wall-clock time with offset (exclusive)." }),
  order_by: z
    .enum(["relevance", "occurred_at", "created_at"], { error: "must be relevance, occurred_at or created_at" })
    .optional()
    .meta({ description: "relevance (needs query; the default with one), occurred_at (when it happened; the default otherwise) or created_at (when it was saved: with one name and max_results 1, that name's latest version)." }),
  direction: z
    .enum(["newest", "oldest"], { error: "must be newest or oldest" })
    .optional()
    .meta({ description: "newest (default) or oldest first. Ignored for relevance." }),
  max_results: maxResults(MAX_RECALL_RESULTS, 10),
  page_token: pageToken,
});

export const recallInput = z.strictObject(recallShape(anyType));
export const recallTool = (types: TypeInfo[]) =>
  z.strictObject(recallShape(typeEnum(types, "Only records whose name has this type.")));

// ── list_topics ─────────────────────────────────────────────────────────────

const listTopicsShape = (type: TypeField) => ({
  type,
  max_results: maxResults(MAX_TOPICS_RESULTS, 50),
  page_token: pageToken,
});

export const listTopicsInput = z.strictObject(listTopicsShape(anyType));
export const listTopicsTool = (types: TypeInfo[]) =>
  z.strictObject(listTopicsShape(typeEnum(types, "Only names of this type.")));

export type RememberInput = z.infer<typeof rememberInput>;
export type RecallInput = z.infer<typeof recallInput>;
export type ListTopicsInput = z.infer<typeof listTopicsInput>;

/** Parses input, turning every Zod issue into one BankError message. */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const messages = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new BankError([...new Set(messages)].join("; "));
}
