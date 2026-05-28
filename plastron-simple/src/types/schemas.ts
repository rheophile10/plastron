import type { z } from "zod";
import type { Key } from "./index.js";
import type { BaseCel, BaseCelMetadata } from "./cels.js";
import type { WitType } from "./wit.js";

export interface Schema {
  key: Key;
  zod: z.core.JSONSchema.JSONSchema;
  protocols: {
    isChanged?: Key;
    /** Operates on cel.v at hydrate time. JSON → live value (e.g.
     *  ISO string → Date). Best-effort; skipped if absent. */
    hydrate?: Key;
    /** Inverse of hydrate. Live value → JSON. */
    dehydrate?: Key;
    /** Operates on cel.f at dehydrate time, for fireable cels only.
     *  Use case: split a multi-line lambda source string into a
     *  string[] so it pretty-prints in the .json file. The built-in
     *  `lambda-source` schema ships this protocol. Inflate is
     *  permissive on both shapes — string[] in DehydratedCel.f is
     *  always joined with "\n" at inflate, no schema required — so a
     *  hydrate-side protocol isn't needed. */
    sourceDehydrate?: Key;
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
  /** When true, signals that ref-eq is sound for using this schema's
   *  values as L1 cache keys: values are primitives, conventionally
   *  immutable, or composites whose producers maintain reference
   *  stability via the schema's isChanged protocol. Defaults to false
   *  (conservative). See docs/1-design/3-accepted/03-caching/execution-hooks.md "Schema memoSafe flag". */
  memoSafe?: boolean;
}

export interface SchemaCel extends BaseCel {
  celType: "SchemaCel";
  metadata: BaseCelMetadata;
  v: Schema;
}

export type ZodToJsonSchema = (schema: z.ZodType) => z.core.JSONSchema.JSONSchema;
export type JsonSchemaToZod = (json: z.core.JSONSchema.JSONSchema) => z.ZodType;
