// ============================================================================
// plastron — type barrel
//
// State is four maps: cels, fns, fnMetadata, schemas.
//
//   • Cels hold values. A lambda cel additionally has `l` (the key of a
//     fn in state.fns) and `inputMap` (names → other cel keys).
//   • Fns hold the callable bodies. Pure functions, no flags.
//   • FnMetadata carries the static description of each lambda — kind,
//     arity, source, schemas, and the `locked` flag that hydrate
//     consults before overwriting an existing fn entry.
//   • Schemas hold live Zod validators. They round-trip through
//     Segments as JSON Schema documents.
//
// A Segment is the JSON-shaped on-disk form: dehydrated cels, optional
// fnMetaData and schemas. Hydrate merges segments + a separate fns
// registry into a State; Dehydrate decomposes a State back to Segments.
// ============================================================================

import type { z } from "zod";
import type { Cel, DehydratedCel } from "./cels.js";
import type { ChannelKey, ChannelHandler } from "./channels.js";
import type { Fn, LambdaKey, LambdaMetadata } from "./lambdas.js";
import type { SchemaKey, SchemaMetadata } from "./schemas.js";
import type { TagKey, TagHandler } from "./tags.js";

export type Key = string;

// ============================================================================
// Lambda registration model
//
// All lambdas — whether native JS bodies or source-compiled (formula,
// python, scheme, wasm, …) — live as Fns in state.fns. There is no
// parallel "kind handler" registry. Compilers are themselves Fns,
// keyed by the language they accept (state.fns.get("f"),
// state.fns.get("py"), …); they consume source strings and return
// runtime bodies. See types/lambdas.ts for Compiler / CompiledLambda.
//
// At hydrate, cels with cel.f set are compiled by looking up the
// compiler at state.fns.get(cel.l ?? "f") and applying it to cel.f.
// Lambdas declared via segment.fnMetaData with both `source` and
// `kind` populated are auto-compiled by hydrate (compiler resolved
// from state.fns.get(meta.kind)) and registered into state.fns.
// ============================================================================

export interface Segment {
  key: Key;
  cels: DehydratedCel[];
  fnMetaData?: Record<LambdaKey, LambdaMetadata>;
  schemas?: Record<SchemaKey, z.core.JSONSchema.JSONSchema>;
  schemaMetadata?: Record<SchemaKey, SchemaMetadata>;
}

export interface State {
  cels: Map<Key, Cel>;
  fns: Map<LambdaKey, Fn>;
  fnMetadata: Map<LambdaKey, LambdaMetadata>;
  schemas: Map<SchemaKey, z.ZodType>;
  schemaMetadata: Map<SchemaKey, SchemaMetadata>;
  /** Per-format protocols for opaque values. Tag handlers don't
   *  round-trip through JSON — host code installs them at runtime. */
  tagRegistry: Map<TagKey, TagHandler>;
  /** Runtime cleanup hooks for registered fns. Populated when a
   *  compiler returns the {fn, dispose} envelope (a WASM instance, a
   *  worker, an FFI handle, …). Fired when the entry is overwritten
   *  via registerLambda or replaced at hydrate. Not serialized —
   *  parallel to state.fns, lives only at runtime. */
  fnDispose: Map<LambdaKey, () => void>;
  /** Pluggable side-effect outputs, keyed by channel name. runCascade
   *  enqueues changed cels onto their bound channels; channels own
   *  scheduling + commit. Like tag handlers, these don't round-trip. */
  channelRegistry: Map<ChannelKey, ChannelHandler>;
  /** Topology-version token. Bumped synchronously inside precompute()
   *  whenever the cel graph changes. The async optional pass captures
   *  this value at start and checks it before each cel commit; any
   *  mismatch means a newer essential pass has run, so the optional
   *  pass aborts cleanly without writing partial results to a
   *  superseded view of the graph. */
  precomputeGeneration: number;
}

/** Fold a list of segments + fn registries into the state's four maps
 *  and run precompute. Returns the same state instance for chaining. */
export type Hydrate = (
  state: State,
  segments: Segment[],
  fns: Map<LambdaKey, Fn>[],
) => State;

/** Decompose a State into JSON-serializable Segments. The inverse of
 *  Hydrate. Lossy where Zod schemas carry refinements, transforms, or
 *  brands. */
export type Dehydrate = (state: State) => Segment[];

// ============================================================================
// Cel triple — the per-cel update payload used by getCel / setCel and
// their batch variants.
//
// Read shape: returned with whichever of {v, f, l} is present on the
// cel. v is always present (defaults to null). f and l are absent when
// the cel doesn't use them.
//
// Write shape (setCel / setCelBatch):
//   • field absent / undefined  — leave the slot alone
//   • field === null            — clear the slot (cel.f, cel.l)
//   • field === concrete value  — install
// Distinguishing "absent" from "null" requires `"f" in triple` checks
// at the call site. Setting f or l triggers re-compilation; setting v
// alone is the fast value-write path. setCel/setCelBatch are atomic:
// either every requested mutation applies or none does (lock and
// compute-path checks happen before any state mutation).
// ============================================================================

export interface CelTriple {
  v?: unknown;
  f?: string | null;
  l?: LambdaKey | null;
}

// ============================================================================
// registerLambda — runtime lambda registration. Adds a fn (or compiles
// one from source) into state.fns, installs metadata into
// state.fnMetadata, and optionally registers companion schemas in the
// same call. Either `fn` or `source` (with `kind` selecting the
// compiler) must be provided — not both.
//
// Atomicity: all pre-flight checks (lock, fn xor source, compiler
// resolution, compilation) run before any state mutation. A failing
// registerLambda leaves state untouched.
// ============================================================================

export interface RegisterLambdaArgs {
  /** Registry key. Mirrors LambdaMetadata.key. */
  key: LambdaKey;

  // ── Body — exactly one of {fn, source} ──
  /** Native JS body. */
  fn?: Fn;
  /** Source string for compilation. Compiler is resolved as
   *  state.fns.get(kind ?? "f"). */
  source?: string;
  /** Names the compiler in state.fns when source is set. Also stored
   *  on LambdaMetadata.kind for descriptive/tooling purposes. */
  kind?: string;

  // ── Companion metadata fields stored on LambdaMetadata ──
  inputSchema?: SchemaKey;
  outputSchema?: SchemaKey;
  /** Positional arity — enforced by formula compilers for exact arg-count match. */
  arity?: number;
  /** Compiler-shaped fns may carry an extractDeps companion for auto-wiring. */
  extractDeps?: (source: string) => Key[];
  /** Optional dispose hook for fns that own runtime resources. Fires
   *  on overwrite or kernel-side replacement. Compiler-supplied
   *  dispose (from {fn, dispose} return) takes precedence over this. */
  dispose?: () => void;
  /** When true, refuses overwrite at later registerLambda / hydrate. */
  locked?: boolean;

  // ── Inline schema registration ──
  /** Schemas to install into state.schemas before the fn is wired in.
   *  Useful when the lambda references a schema the host hasn't yet
   *  registered. Pass live Zod validators, not JSON Schema. */
  schemas?: Record<SchemaKey, z.ZodType>;
  /** Schema metadata to install into state.schemaMetadata. Same shape
   *  as Segment.schemaMetadata. */
  schemaMetadata?: Record<SchemaKey, SchemaMetadata>;
}

export type { Cel, DehydratedCel } from "./cels.js";
export type { ChannelKey, ChannelHandler, ChannelEnqueue } from "./channels.js";
export type { Fn, LambdaKey, LambdaMetadata, Compiler, CompiledLambda, CompiledEnvelope, ResolvedInputs } from "./lambdas.js";
export type { SchemaKey, SchemaMetadata, DehydrateSchemas, HydrateSchemas } from "./schemas.js";
export type { TagKey, TagHandler } from "./tags.js";
