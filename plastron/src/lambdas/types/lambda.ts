import type { Key, Common } from "../../common.js";
import type { SchemaKey } from "../../schemas/types/schema.js";

export type LambdaKey = Key;

/** A lambda function — optionally carries an extractDeps method for
 *  formula-parser lambdas. Attached to cels at hydrate time as cel._fn. */
export interface Fn<I = unknown, O = unknown> {
  (input: I): O | Promise<O>;
  /** Only the formula-parser fn carries this. Returns the cel keys a
   *  formula string references; used by hydrate to auto-wire inputMap. */
  extractDeps?: (formula: string) => Key[];
}

/** Static description of a lambda — schema keys, arity, source, etc.
 *  Travels with the cel graph through JSON; not the function itself.
 *  The actual function is supplied separately via a fnRegistry keyed
 *  by lambda key. */
export interface LambdaMetadata extends Common {
  key: LambdaKey;
  /** Registered schema key for the lambda's input shape. Used for LLM
   *  metadata and for runtime validation when config_recalculation.strictTypes is true. */
  inputSchema?: SchemaKey;
  /** Registered schema key for the lambda's output shape. */
  outputSchema?: SchemaKey;
  /** Positional arity — enforced by formula parsers for exact arg-count match. */
  arity?: number;
  /** Minimum cel.prevDepth required by cels using this lambda. */
  prevMinDepth?: number;
  /** Relative path (from src/lambdas/) to the file the fn lives in. */
  filename?: string;
  /** Stringified function body — useful for LLMs and archival. */
  source?: string;
}
