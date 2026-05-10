import type { z } from "zod";
import type { Key } from "./index.js";
import type { ChannelHandler, ChannelKey } from "./channels.js";
import type { Fn, LambdaKey, ResolvedInputs } from "./lambdas.js";
import type { SchemaKey } from "./schemas.js";
import type { TagKey } from "./tags.js";

// ============================================================================
// CelRef — a thin alias cel that holds a pointer into a slot of a
// consolidated structure rather than holding its own value.
//
// Reads resolve to source.v[slot] via the registered SlotAccessor for
// the source's tag (or a default array/object accessor when the source
// has no tag). Writes route through the accessor's write hook, which
// either mutates the source in place + bumps `gen` (Column / Matrix)
// or returns a shallow-cloned source (Table / plain object) that the
// kernel installs via the normal set path.
//
// Lifetime contract: a ref cel has no `v` of its own (always undefined /
// null). It coexists at the cel layer with `key`, `segment`, `schema`,
// `tag`, `channel`, `wave`, `dynamic` — those apply to the *resolved*
// value. A ref cel has no `f`, no `l`, no `_fn`, no `_evaluate`,
// no `_inputEntries`. The hydrate / setCel layers refuse to add
// compute fields to a ref cel and refuse to add a ref to a compute
// cel; users convert by clearing one side and installing the other in
// the same triple.
// ============================================================================

export interface CelRef {
  /** Cel key whose value is the consolidated structure. Must resolve
   *  to a cel in state.cels at hydrate / setCel time; dangling refs
   *  read undefined and write-fail (recorded into the errors cel). */
  source: Key;
  /** Index into the source's value. Interpretation depends on the
   *  source's shape — Column uses number, Table uses string column
   *  name, Matrix uses number[] coords. The source's SlotAccessor
   *  decides how to interpret it. */
  slot: number | string | number[];
}

export interface Cel {
  key: Key;
  v: unknown;
  /** Key of the lambda OR compiler in state.fns. Presence makes this
   *  cel "computed". Two regimes:
   *   • cel.f unset — cel.l names a runtime fn. runCascade calls
   *     state.fns.get(cel.l) directly with the cel's inputs.
   *   • cel.f set   — cel.l names the compiler that turns cel.f source
   *     into cel._fn at hydrate (state.fns.get(cel.l)(cel.f)). When
   *     cel.f is set without cel.l, hydrate defaults cel.l to "f".
   *  The cel.l value doubles as the "kind" tag for tooling/UI; no
   *  separate kind field is needed on the cel itself. */
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
  /** Source string. When set, hydrate compiles it into cel._fn via
   *  state.fns.get(cel.l ?? "f")(cel.f) and auto-wires inputMap from
   *  the compiler's extractDeps if present. Coexists with cel.l —
   *  cel.l names which compiler ("f", "py", "scheme", "wasm", …). */
  f?: string;
  /** Format tag identifying the value's protocol. When set,
   *  state.tagRegistry[tag] supplies comparator / serialize / release
   *  callbacks for opaque values (Buffers, handles, streams, …). */
  tag?: TagKey;
  /** Channel binding(s). When set, runCascade calls
   *  state.channelRegistry[channel].enqueue({cel, state}) every time
   *  this cel's value changes. A list fans out to every named channel.
   *  Channels own coalescing + commit timing — kernel just routes. */
  channel?: ChannelKey | ChannelKey[];
  /** When set, this cel is a ref into another cel's value. The ref
   *  cel has no `v` of its own (cel.v stays undefined / null); reads
   *  resolve through the source's slot, writes mutate the source's
   *  slot in place via the registered SlotAccessor.
   *
   *  Mutually exclusive with `f`, `l`, `_fn`, `_evaluate`. A ref cel
   *  may still declare `schema`, `tag`, `channel`, `dynamic` — those
   *  apply to the *resolved* value, not to the absent local v. */
  ref?: CelRef;

  // ── Materialized at hydrate time, runtime-only (not on DehydratedCel) ──

  /** Resolved change-detection fn for this cel's value. Cached from
   *  state.schemaMetadata[cel.schemaKey].isChanged → state.fns.get(...).
   *  Falsy means fall back to reference equality. Returns true when
   *  the value materially changed. */
  _isChanged?: Fn;
  /** Resolved diff fn for this cel's value. Cached from
   *  state.schemaMetadata[cel.schemaKey].diff. Optional — when present,
   *  runCascade calls it on (prev, next) after _isChanged returns true
   *  and stores the result on _diff. */
  _diffFn?: Fn;
  /** Last diff produced by _diffFn, refreshed by runCascade whenever
   *  the cel's value changes. Domain-specific shape; the kernel never
   *  inspects it. Consumers (DOM painter, audit log, sync) read this
   *  via state.cels.get(key)._diff. */
  _diff?: unknown;
  /** Per-cel compiled fn. When set, runCascade uses this directly
   *  instead of looking up cel.l in state.fns. Used for formula cels
   *  whose body is closed over a parsed AST at hydrate time. */
  _fn?: Fn;
  /** Cel-lifetime cleanup hook. Called when the cel is overwritten or
   *  removed. The kernel doesn't populate this itself — host code
   *  attaches it (e.g. a setup lambda that returns a teardown). */
  _dispose?: () => void;
  /** inputMap resolved to direct cel references, materialized at
   *  precompute time. The hot path iterates this instead of calling
   *  Map.get on every input on every fire. Slot order matches
   *  Object.entries(inputMap) at the time precompute ran. Each entry
   *  is `[name, Cel | Cel[] | undefined]`; undefined means the
   *  declared upstream key didn't resolve (preserves the prior
   *  Map.get(...)?.v behavior). Rebuilt on every precompute, so it
   *  stays consistent with hydrate / flush. Mutability surface kept
   *  loose so Array.isArray narrows in the hot path — only precompute
   *  writes this. */
  _inputEntries?: Array<[string, Cel | undefined | Array<Cel | undefined>]>;
  /** channel field resolved to live ChannelHandler references at
   *  precompute time. Replaces the per-fire Array.isArray check + Map
   *  lookup in enqueueChannels. Channels not in state.channelRegistry
   *  at precompute time are silently dropped — register channels
   *  before hydrating cels that reference them. */
  _channelHandlers?: ChannelHandler[];
  /** Compiler-supplied closure builder, captured at compile time from
   *  the CompiledEnvelope returned by the cel's compiler. The optional
   *  precompute pass invokes this with the live state and resolved
   *  inputs to produce cel._evaluate; the result may be a synchronous
   *  closure or a Promise of one (compilers that need async setup —
   *  WASM, worker spawn, network fetch — return the latter; the async
   *  pass awaits it before storing). Receiving `state` lets emitted
   *  closures resolve through ref cels via resolveValue without
   *  rediscovering the registry per fire. Compilers that don't provide
   *  one leave this undefined; fireCel uses the standard gather-and-
   *  call path. */
  _buildEvaluate?: (state: import("./index.js").State, inputs: ResolvedInputs) => (() => unknown) | Promise<() => unknown>;
  /** Per-cel monomorphic closure that returns the cel's next value.
   *  Built by precompute via cel._buildEvaluate(resolvedInputs); the
   *  closure captures live cel refs directly, so calling it skips both
   *  the inputs-object allocation and the registry-keyed fn lookup.
   *  fireCel uses this when present and falls back to fn(inputs)
   *  otherwise. Rebuilt on every precompute, like _inputEntries. */
  _evaluate?: () => unknown;
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
  channel?: ChannelKey | ChannelKey[];
  /** Ref-cel form. Round-trips as plain data; hydrate validates the
   *  source/slot against state.cels + slotAccessors *after* every
   *  segment is loaded so cross-segment ref/source ordering doesn't
   *  matter. See plastron/src/core/refs.ts. */
  ref?: CelRef;
}
