import type { z } from "zod";
import type { Key } from "./index.js";
import type { Fn, LambdaKey } from "./lambdas.js";
import type { SchemaKey } from "./schemas.js";
import type { TagKey } from "./tags.js";

export interface Cel {
  key: Key;
  v: unknown;
  /** Key of the fn in state.fns. Presence makes this cel "computed". */
  l?: LambdaKey;
  /** Named inputs → upstream cel keys (or arrays of keys). */
  inputMap?: Record<string, Key | Key[]>;
  segment?: Key;
  schema?: z.ZodType;
  /** Declared wave index. Default 0. Wave N runs fully before wave N+1.
   *  Topological order is computed within each wave. */
  wave?: number;
  /** When true, hydrate will not overwrite this cel. */
  locked?: boolean;
  /** When true, this cel is volatile — every cycle re-fires it (and
   *  its downstream closure) regardless of whether its inputs changed.
   *  Use for clocks, random sources, externally-driven values. */
  dynamic?: boolean;
  /** Formula source. When set, hydrate compiles it into cel._fn,
   *  auto-wires inputMap from the formula's referenced identifiers,
   *  and stamps cel.l = "f". Mutually exclusive with cel.l declared
   *  by the user. */
  f?: string;
  /** Format tag identifying the value's protocol. When set,
   *  state.tagRegistry[tag] supplies comparator / serialize / release
   *  callbacks for opaque values (Buffers, handles, streams, …). */
  tag?: TagKey;

  // ── Materialized at hydrate time, runtime-only (not on DehydratedCel) ──

  /** Resolved change-detection fn for this cel's value. Cached from
   *  state.schemaMetadata[cel.schemaKey].diffFn → state.fns.get(diffFn).
   *  Falsy means fall back to reference equality. */
  _isChanged?: Fn;
  /** Per-cel compiled fn. When set, runCascade uses this directly
   *  instead of looking up cel.l in state.fns. Used for formula cels
   *  whose body is closed over a parsed AST at hydrate time. */
  _fn?: Fn;
  /** Cel-lifetime cleanup hook. Called when the cel is overwritten or
   *  removed. The kernel doesn't populate this itself — host code
   *  attaches it (e.g. a setup lambda that returns a teardown). */
  _dispose?: () => void;
}

/** On-disk / JSON shape. Identical to Cel except `v` is optional
 *  (defaults to null on inflate) and `schema` is a SchemaKey reference
 *  rather than a live ZodType. */
export interface DehydratedCel {
  key: Key;
  v?: unknown;
  l?: LambdaKey;
  inputMap?: Record<string, Key | Key[]>;
  segment?: Key;
  schema?: SchemaKey;
  wave?: number;
  locked?: boolean;
  dynamic?: boolean;
  f?: string;
  tag?: TagKey;
}
