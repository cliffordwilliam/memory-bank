// Input validation for the three operations (spec §6). Zod checks the shape
// and format of every argument first, with messages that tell Claude how to
// fix the call; the operations then check what needs the database (R1–R4,
// R9–R11). Unknown parameters are refused rather than silently ignored.

import { z } from "zod";
import { BankError } from "./errors";
import { WALL_CLOCK_EXAMPLE, wallClockToMillis } from "./time";

const NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

export const MAX_BODY = 16_000;
export const MAX_DESCRIPTION = 200;
export const MAX_IDS = 3;

const name = z
  .string()
  .regex(NAME_PATTERN, { error: "name must be lowercase letters, digits and hyphens (1–64), e.g. vanilla-cupcakes" });

const wallClock = (field: string) =>
  z.string().refine((s) => wallClockToMillis(s) !== null, {
    error: `${field} must be a real wall-clock time with offset, e.g. ${WALL_CLOCK_EXAMPLE}`,
  });

const recordId = z.int({ error: "ids are whole numbers, e.g. 57" }).positive({ error: "ids are positive, e.g. 57" });

export const rememberInput = z
  .strictObject({
    name,
    new_name: z.literal(true, { error: "new_name is either true or left out" }).optional(),
    type: z.string().optional(),
    description: z
      .string()
      .min(1, { error: "description can't be empty" })
      .max(MAX_DESCRIPTION, { error: `description must be one line of at most ${MAX_DESCRIPTION} characters` })
      .refine((s) => !/[\r\n]/.test(s), {
        error: `description must be one line of at most ${MAX_DESCRIPTION} characters`,
      }),
    body: z
      .string()
      .min(1, { error: "body can't be empty" })
      .refine((s) => s.length <= MAX_BODY, {
        error: (issue) => `body is ${(issue.input as string).length} characters; the limit is ${MAX_BODY}`,
      }),
    occurred_at: wallClock("occurred_at"),
    corrects: recordId.optional(),
    kind: z
      .enum(["correction", "retraction"], { error: "kind is correction or retraction" })
      .optional(),
  })
  .superRefine((v, ctx) => {
    // R8: corrects and kind go together.
    if (v.corrects !== undefined && v.kind === undefined) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "kind is required with corrects: correction or retraction" });
    }
    if (v.kind !== undefined && v.corrects === undefined) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "kind needs corrects (the id of the record that was wrong)" });
    }
  });

export const recallInput = z.strictObject({
  query: z.string().optional(),
  ids: z
    .array(recordId)
    .min(1, { error: "ids needs at least one id" })
    .max(MAX_IDS, { error: `ids takes at most ${MAX_IDS} ids` })
    .optional(),
  name: name.optional(),
  type: z.string().optional(),
  after: wallClock("after").optional(),
  before: wallClock("before").optional(),
  order_by: z
    .enum(["relevance", "occurred_at", "created_at"], { error: "order_by is relevance, occurred_at or created_at" })
    .optional(),
  direction: z.enum(["newest", "oldest"], { error: "direction is newest or oldest" }).optional(),
  max_results: z
    .int({ error: "max_results is a whole number from 1 to 20" })
    .min(1, { error: "max_results is a whole number from 1 to 20" })
    .max(20, { error: "max_results is a whole number from 1 to 20" })
    .optional(),
  page_token: z.string().optional(),
});

export const listTopicsInput = z.strictObject({
  type: z.string().optional(),
  max_results: z
    .int({ error: "max_results is a whole number from 1 to 200" })
    .min(1, { error: "max_results is a whole number from 1 to 200" })
    .max(200, { error: "max_results is a whole number from 1 to 200" })
    .optional(),
  page_token: z.string().optional(),
});

export type RememberInput = z.infer<typeof rememberInput>;
export type RecallInput = z.infer<typeof recallInput>;
export type ListTopicsInput = z.infer<typeof listTopicsInput>;

/** Parses input, turning every Zod issue into one BankError message. */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const messages = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    // Our own messages already start with the field name.
    return path && !issue.message.startsWith(path) ? `${path}: ${issue.message}` : issue.message;
  });
  throw new BankError([...new Set(messages)].join("; "));
}
