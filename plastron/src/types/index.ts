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
import type { SegmentManifest } from "./segments.js";
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
  /** Optional precomputed downstream closures: key → list of cel keys
   *  in its transitive downstream set (excluding self). When present,
   *  hydrate seeds the runtime cache so the first write to any of
   *  these keys skips the BFS warm-up. Fully derivable from inputMap
   *  — shipping this is a startup-latency optimization, not a
   *  correctness requirement. Closures only need to ship for keys the
   *  consumer is expected to write at startup; everything else
   *  lazy-fills on first use. */
  downstream?: Record<Key, Key[]>;
  /** Optional manifest. When present, hydrate validates dependsOn
   *  and records it in state.segments. When absent, the segment
   *  loads with no manifest entry (legacy behavior). */
  manifest?: SegmentManifest;
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
  /** Loaded-segment registry. Populated by hydrate when a segment
   *  ships a manifest; mutated when a segment is flushed. Queried
   *  by hydrate (dependency check), flush (dependent check),
   *  dehydrate (manifest emission), and host tooling. Empty for
   *  segments hydrated without a manifest (strictly backwards
   *  compatible with the pre-manifest flat-list world). */
  segments: Map<Key, SegmentManifest>;

  /** Per-cycle scratch — accumulates timing + counts during a cycle,
   *  flushed to stats cels at cycle end. Always allocated; only written
   *  when config_performance.v.enabled is true. */
  perfScratch: PerfScratch;

  /** Cumulative function-level stats. Survives across cycles. Reset by
   *  the resetStats core-fn. Keyed by lambda key (or cel key when no
   *  lambda is registered). */
  perfFunctions: Map<LambdaKey, { calls: number; totalNs: number; lastNs: number }>;

  /** Cumulative channel-level stats. Survives across cycles. Reset by
   *  the resetStats core-fn. */
  perfChannels: Map<ChannelKey, { enqueues: number; drains: number; queueDepth: number }>;

  /** Side-cache of original (un-instrumented) channel handlers. Set
   *  when perf instrumentation wraps a channel's drain so the original
   *  can be restored. v1: wrap-on-first-tracked-cycle, no auto-unwrap;
   *  toggling tracking off requires a fresh state. */
  _perfWrappedChannels?: Map<ChannelKey, ChannelHandler>;
}

/** Per-cycle scratch buffer. Always allocated on State; only written
 *  when config_performance.v.enabled is true and the cycle is sampled. */
export interface PerfScratch {
  /** Monotonically increasing cycle counter. Bumped at every runCycle
   *  entry regardless of tracking state — used as the sample selector
   *  (`cycleN % sampleRate === 0`) and as the cycle id in snapshots. */
  cycleN: number;
  cycleStartNs: number;
  trigger: Key | "batch" | undefined;
  firedCount: number;
  skippedCount: number;
  /** wave index → { fired, skipped, durationNs, parallelism } */
  waveStats: Map<number, { fired: number; skipped: number; durationNs: number; parallelism: number }>;
  /** When config_performance.v.watchCels is non-empty, per-cel timing
   *  (ns) for those cels during the current cycle. Cleared at the
   *  start of every sampled cycle. */
  watchedCelTimings: Map<Key, number>;
}

/** Fold a list of segments + fn registries into the state's four maps
 *  and run precompute. Returns the same state instance for chaining. */
export type Hydrate = (
  state: State,
  segments: Segment[],
  fns: Map<LambdaKey, Fn>[],
) => State;

export interface DehydrateOpts {
  /** Keys whose downstream closures should be computed (if not already
   *  cached) and shipped on the first emitted segment. Use this to
   *  pre-warm a consumer for keys it's expected to write at startup —
   *  the consumer's first write skips the BFS warm-up and goes
   *  straight to a cached closure. Closures already in the runtime
   *  cache from prior cascade activity always ship; this option just
   *  adds explicit warming. Pass `[]` (or omit) to ship only what's
   *  cached; pass nothing to skip the field entirely. */
  bakeDownstream?: Key[];
}

/** Decompose a State into JSON-serializable Segments. The inverse of
 *  Hydrate. Lossy where Zod schemas carry refinements, transforms, or
 *  brands. */
export type Dehydrate = (state: State, opts?: DehydrateOpts) => Segment[];

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
export type { SchemaKey, SchemaMetadata, WasmLayout, DehydrateSchemas, HydrateSchemas } from "./schemas.js";
export type { SegmentDependency, SegmentProvides, SegmentManifest } from "./segments.js";
export type { TagKey, TagHandler } from "./tags.js";
