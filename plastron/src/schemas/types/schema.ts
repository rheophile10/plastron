import type { z } from "zod";
import type { Key, Common } from "../../common.js";

export type SchemaKey = Key;

/** A schema wraps a Zod type with metadata for the DAG registry. */
export interface Schema extends Common {
  key: SchemaKey;
  zod: z.ZodType;
}

export type SchemaRecords = Record<SchemaKey, Schema>;
