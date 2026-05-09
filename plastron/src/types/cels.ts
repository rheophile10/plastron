import type { z } from "zod";
import type { Key } from "./index.js";
import type { ChannelHandler, ChannelKey } from "./channels.js";
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
  /** Channel binding(s). When set, runCascade calls
   *  state.channelRegistry[channel].enqueue({cel, state}) every time
   *  this cel's value changes. A list fans out to every named channel.
   *  Channels own coalescing + commit timing — kernel just routes. */
  channel?: ChannelKey | ChannelKey[];

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
}
