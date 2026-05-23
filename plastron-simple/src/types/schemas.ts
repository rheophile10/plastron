import type { z } from "zod";
import type { Key } from "./index.js";
import type { BaseCel, BaseCelMetadata } from "./cels.js";
import type { WitType } from "./wit.js";

export interface Schema {
  key: Key;
  zod: z.core.JSONSchema.JSONSchema;
  protocols: {
    isChanged?: Key;
    hydrate?: Key;
    dehydrate?: Key;
    dispose?: Key;
    [k: string]: Key | undefined;
  };
  /** Optional discriminator. Absent / "zod" means the schema validates
   *  arbitrary JS values via its `zod` JSONSchema. "wasm" marks the cel
   *  as living in a wasm domain — its value either stays inline as a
   *  scalar (for WIT primitives) or is a WasmHandle into a per-kind
   *  worker table (for WIT composites). Bridge cels (task 7) and
   *  per-kind precompute layers (task 8) dispatch on this field. */
  kind?: "zod" | "wasm";
  /** Present when `kind === "wasm"`. The WIT type the cel's value
   *  conforms to. Authored as a JSON tree in the SchemaCel's seed;
   *  see types/wit.ts for the shape. */
  wit?: WitType;
}

export interface SchemaCel extends BaseCel {
  celType: "SchemaCel";
  metadata: BaseCelMetadata;
  v: Schema;
}

export type ZodToJsonSchema = (schema: z.ZodType) => z.core.JSONSchema.JSONSchema;
export type JsonSchemaToZod = (json: z.core.JSONSchema.JSONSchema) => z.ZodType;
