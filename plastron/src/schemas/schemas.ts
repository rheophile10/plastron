import { z } from "zod";
import type { Schema, SchemaRecords } from "./types/schema.js";

// ========================================================================
// Reusable Zod types — building blocks for the default SchemaRecords
// below. Kept local since nothing outside this file references them.
// ========================================================================

const num       = z.number();
const str       = z.string();
const bool      = z.boolean();
const arr       = z.array(z.unknown());
const obj       = z.unknown();

const itemsInputZ    = z.object({ items: z.array(z.unknown()) });
const totalCountZ    = z.object({ total: z.number(), count: z.number() });
const rateInputZ     = z.object({ numerator: z.number(), denominator: z.number() });
const errorInputZ    = z.object({ error: z.unknown(), input: z.unknown() });
const unopInputZ     = z.object({ a: z.unknown() });
const binopInputZ    = z.object({ a: z.unknown(), b: z.unknown() });
const ternopInputZ   = z.object({ a: z.unknown(), b: z.unknown(), c: z.unknown() });
const opInputZ       = z.object({
  operator: z.string(),
  args: z.tuple([z.unknown(), z.unknown()]),
  alias: z.record(z.string(), z.string()).default({}),
});
const formatInputZ   = z.object({
  value: z.union([z.string(), z.number()]).optional(),
  pattern: z.string().optional(),
});
const recalcConfigZ  = z.object({
  mode: z.enum(["automatic", "automaticExceptData", "manual"]),
  intervalMs: z.number().optional(),
});

// ========================================================================
// SchemaRecords — wraps Zod types with metadata for the DAG registry.
// ========================================================================

const s = (key: string, zodType: z.ZodType, description?: string): Schema => ({
  key, name: key, description, zod: zodType,
});

export const defaultSchemas: SchemaRecords = {
  number:          s("number",          num,           "A JS number"),
  string:          s("string",          str,           "A JS string"),
  boolean:         s("boolean",         bool,          "A JS boolean"),
  array:           s("array",           arr,           "An array of unknowns"),
  object:          s("object",          obj,           "An unknown (object-shaped)"),
  itemsInput:      s("itemsInput",      itemsInputZ,   "Input for aggregator functions"),
  totalCountInput: s("totalCountInput", totalCountZ,   "Input for average calculation"),
  rateInput:       s("rateInput",       rateInputZ,    "Input for rate/percentage"),
  errorInput:      s("errorInput",      errorInputZ,   "Input for error handlers"),
  unopInput:       s("unopInput",       unopInputZ,    "Input for unary operators"),
  binopInput:      s("binopInput",      binopInputZ,   "Input for binary operators"),
  ternopInput:     s("ternopInput",     ternopInputZ,  "Input for ternary operators"),
  opInput:         s("opInput",         opInputZ,      "Input for the op dispatcher"),
  formatInput:     s("formatInput",     formatInputZ,  "Input for the regex formatter"),
  recalcConfig:    s("recalcConfig",    recalcConfigZ, "Recalculation configuration"),
};
