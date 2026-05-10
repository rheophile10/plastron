import type {
  Cel, CelTriple, ChannelHandler, ChannelKey, Compiler, Fn, Key,
  LambdaMetadata, RegisterLambdaArgs, State,
} from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, precompute, type PrecomputedIndexes } from "./precompute.js";
import { compileCelBody, releaseValue } from "./hydrate.js";
import { resolveValue, writeThroughRef } from "./refs.js";
import { affectedFor, runCascade } from "./runCycle.js";

// ----------------------------------------------------------------------------
// Channel flush — drain pending channel work to completion.
//
//   spec === undefined | 'none'    no flush
//   spec === 'all'                 fixed-point drain over every channel
//   spec is a ChannelKey           drain that one channel
//
// Fixed-point drain handles channel commits that re-enter the graph via
// set/batch: a commit may trigger a new cascade that enqueues to other
// channels. We loop until no channel has pending work. Capped at
// FLUSH_MAX_ITERATIONS to surface runaway feedback as an error rather
// than hang.
//
// Within an iteration, all pending channels run concurrently — sync
// drains complete inline, async drains (IndexedDB, fetch, file write)
// run in parallel via Promise.all. Iterations stay sequential so a
// commit's writeback gets observed by the next pass rather than
// racing with the channel that triggered it.
//
// flushChannels is async-by-construction. Callers that don't pass an
// opts.flush avoid the microtask entirely by not awaiting it (see
// set/batch below). Callers that do pass flush pay one microtask hop
// even when every channel is sync — acceptable, since flushing is
// already a "settle now, then continue" semantic.
// ----------------------------------------------------------------------------

export type FlushSpec = ChannelKey | "all" | "none";

const FLUSH_MAX_ITERATIONS = 64;

const collectPending = (state: State): ChannelHandler[] => {
  const pending: ChannelHandler[] = [];
  for (const ch of state.channelRegistry.values()) {
    if (ch.hasPending()) pending.push(ch);
  }
  return pending;
};

export const flushChannels = async (
  state: State, spec: FlushSpec | undefined,
): Promise<void> => {
  if (!spec || spec === "none") return;

  if (spec === "all") {
    let iterations = 0;
    while (true) {
      if (++iterations > FLUSH_MAX_ITERATIONS) {
        throw new Error(
          `flushChannels: exceeded ${FLUSH_MAX_ITERATIONS} iterations — ` +
          `channels may be in a feedback loop (commit triggers cascade ` +
          `that re-enqueues the same channel).`,
        );
      }
      const pending = collectPending(state);
      if (pending.length === 0) return;
      // Run drains in parallel. Sync drains return undefined and complete
      // inline; async drains run concurrently via Promise.all.
      const promises: Promise<void>[] = [];
      for (const ch of pending) {
        const r = ch.drain();
        if (r instanceof Promise) promises.push(r);
      }
      if (promises.length > 0) await Promise.all(promises);
    }
  }

  const ch = state.channelRegistry.get(spec);
  if (!ch || !ch.hasPending()) return;
  const r = ch.drain();
  if (r instanceof Promise) await r;
};

// ============================================================================
// Standard input fns — read and write the cel map, then fire only the
// affected subset of the cascade with change suppression so a write
// only re-runs the work that actually depends on what changed.
//
//   • set(key, value)    — fire downstream(key) ∪ dynamicCascade,
//                          seeded with [key] in `changed`
//   • batch(writes)      — fire ⋃downstream(writtenKeys) ∪ dynamicCascade,
//                          seeded with writtenKeys in `changed`
//   • touch / consume    — fire dynamicCascade with empty `changed`
//                          (only cels with `dynamic: true` actually fire)
//
// Direct writes are treated as authoritative — no diff check at write
// time. Lambdas use cel._isChanged for output-side suppression.
//
// Writes to a missing cel, a locked cel, or a lambda cel throw. Reads
// of missing keys return undefined.
//
// Note (cel-refs / touch): the cel-refs spec contemplates a per-key
// `touch(key)` that, when called on a ref cel, re-fires the source's
// downstream cascade. The current kernel only exposes a keyless
// `touch(state, opts?)` that fires the dynamic cascade with an empty
// `changed` set, so there is no ref-aware touch path. Adding one would
// require a new entry point that calls `affectedFor([key])` without
// writing a value (and routes through the source key for refs).
// Tracked as a v2 kernel addition; the cel-refs implementation does
// NOT special-case touch.
// ============================================================================

// Returns the key the cascade should fire from. For a ref cel, that's
// the source key (writeThroughRef mutated the source slot, so the
// cascade originates at the source). For a normal cel, it's the same
// `key` passed in.
const writeOne = (state: State, key: Key, value: unknown): Key => {
  const cel = state.cels.get(key);
  if (!cel)        throw new Error(`set: unknown cel "${key}"`);
  if (cel.locked)  throw new Error(`set: cel "${key}" is locked`);
  if (cel.l)       throw new Error(`set: cel "${key}" is a lambda — cannot write directly`);
  if (cel.ref) {
    // Route through the slot accessor. The accessor either mutates
    // the source in place + bumps gen (Column / Matrix) or returns a
    // new source value we install via writeOne on the source key
    // (Table, plain object). Errors from a dangling source / missing
    // accessor propagate to the caller.
    const { sourceKey, replaced, newSourceValue } = writeThroughRef(state, cel, value);
    if (replaced) {
      // Wholesale replace via writeOne on the source — recursive
      // handles its own validation, lock checks, and release.
      return writeOne(state, sourceKey, newSourceValue);
    }
    return sourceKey;
  }
  releaseValue(cel.v, cel.tag, state.tagRegistry);
  cel.v = value;
  return key;
};

const fireDynamic = async (state: State): Promise<void> => {
  const indexes = state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;
  if (indexes) await runCascade(state, indexes.dynamicCascade, new Set());
};

export const get: Fn = (state: State, key: Key) => {
  const cel = state.cels.get(key);
  if (!cel) return undefined;
  // Ref cels resolve through the source's slot; normal cels return v.
  // The branch is one property check on the cel.
  return cel.ref ? resolveValue(state, cel) : cel.v;
};

export interface SetOpts {
  /** When set, drain channels synchronously after the cascade returns.
   *  'all' walks every channel to fixed point (handles channel commits
   *  that re-enter the graph). A specific ChannelKey flushes just that
   *  channel. Omit (or 'none') to leave commits on their own clocks. */
  flush?: FlushSpec;
}

export const set: Fn = async (
  state: State, key: Key, value: unknown, opts?: SetOpts,
) => {
  const fired = writeOne(state, key, value);
  await runCascade(state, affectedFor(state, [fired]), new Set([fired]));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const batch: Fn = async (
  state: State, writes: Array<[Key, unknown]>, opts?: SetOpts,
) => {
  // Ref-aware: writes targeting ref cels resolve to the source key,
  // which is what the cascade fires from. When two writes in a batch
  // hit different slots of the same source, writeOne is called
  // sequentially (the accessor's write composes) and only the
  // (deduplicated) source key drives the cascade. v1 makes no
  // ordering guarantee beyond "in array order".
  const firedKeys: Key[] = [];
  const seen = new Set<Key>();
  for (const [k, v] of writes) {
    const fired = writeOne(state, k, v);
    if (!seen.has(fired)) { seen.add(fired); firedKeys.push(fired); }
  }
  await runCascade(state, affectedFor(state, firedKeys), new Set(firedKeys));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

// ============================================================================
// Complete-tier reads/writes — operate on the full {v, f, l} triple.
//
// Use cases: serialization, undo/redo, UI sync that pushes a cel's
// full state from a server payload, or any flow that needs to swap
// formula/lambda alongside (or instead of) the value. The fast tier
// (get/set/batch above) stays unchanged for hot loops.
//
// setCel / setCelBatch are atomic: pre-flight checks (lock, fn xor
// source, compiler resolution, compilation) happen before any state
// mutation. A failing setCel leaves the cel exactly as it was.
//
// Setting f or l requires re-compilation and re-runs precompute (the
// dep set may have shifted, which moves cels between waves /
// downstream sets). setCelBatch precomputes once at the end if any
// cel's topology shifted; setCel precomputes for every f/l change.
// ============================================================================

interface ApplyResult { topoChanged: boolean; }

/** Mutate a single cel's {v, f, l, ref} slots atomically. Pre-flight
 *  runs before any write so a thrown error leaves the cel intact.
 *  Returns whether the topology may have shifted (setCelBatch uses
 *  this to decide whether to re-run precompute once at the end).
 *
 *  Ref-cel rules:
 *    • triple.ref === <CelRef>  installs a ref. Any v in the same
 *                                triple must be undefined / null
 *                                (refs hold no local value); any f/l
 *                                must be cleared in the same triple
 *                                (refs aren't compute cels).
 *    • triple.ref === null      clears any existing ref. Pair with
 *                                v: <value> to convert back to a
 *                                scalar cel atomically.
 *    • A cel that already has cel.ref set refuses bare v writes —
 *                                use input.set (which routes through
 *                                writeThroughRef) for slot writes,
 *                                or pass ref: null + v: ... here to
 *                                rewrite as a scalar. */
const applyTripleAtomic = (
  state: State, key: Key, triple: CelTriple,
): ApplyResult => {
  const cel = state.cels.get(key);
  if (!cel)       throw new Error(`setCel: unknown cel "${key}"`);
  if (cel.locked) throw new Error(`setCel: cel "${key}" is locked`);

  const fInTriple   = "f"   in triple;
  const lInTriple   = "l"   in triple;
  const vInTriple   = "v"   in triple;
  const refInTriple = "ref" in triple;

  // Resolve the post-update f/l/ref values. null means clear; undefined
  // (i.e. field absent) means leave alone.
  const newF   = fInTriple   ? triple.f   : cel.f;
  const newL   = lInTriple   ? triple.l   : cel.l;
  const newRef = refInTriple ? triple.ref : cel.ref;
  const willHaveSource  = newF != null;
  const willHaveRef     = newRef != null;
  const willHaveLambda  = (lInTriple ? newL != null : cel.l !== undefined);

  // Refs are mutually exclusive with f / l on the same cel.
  if (willHaveRef && (willHaveSource || willHaveLambda)) {
    throw new Error(
      `setCel: cel "${key}" cannot be both a ref and a compute cel. ` +
      `Clear f/l in the same triple to install ref.`,
    );
  }

  // Pre-flight: resolve compiler before mutating. Missing compiler
  // aborts with the cel still in its original state.
  let compiler: Compiler | undefined;
  if (willHaveSource) {
    const ck = newL ?? "f";
    compiler = state.fns.get(ck) as Compiler | undefined;
    if (!compiler) {
      throw new Error(`setCel: no compiler at "${ck}" for cel "${key}"`);
    }
  }

  // Reject "set v on a cel that still has a compute path." A lambda
  // cel's v is derived. The only legal pattern is to remove the
  // compute path in the same triple (l: null + f: null + v: 42).
  // Ditto for refs: a ref cel's v is meaningless; setting it requires
  // clearing the ref atomically.
  if (vInTriple && triple.v !== undefined && triple.v !== null) {
    const willHaveCompute = willHaveSource || willHaveLambda;
    if (willHaveCompute) {
      throw new Error(
        `setCel: cannot set v on "${key}" — has a compute path. ` +
        `Clear l/f in the same triple to convert into a value cel.`,
      );
    }
    if (willHaveRef) {
      throw new Error(
        `setCel: cannot set v on "${key}" — is a ref cel. ` +
        `Pass ref: null in the same triple to convert into a value cel, ` +
        `or use input.set to write through the ref's source slot.`,
      );
    }
  }

  // Validate the incoming ref against state — source must exist.
  // Slot range is checked at write time (the source's value may not
  // have materialized yet at hydrate time for cross-segment refs).
  if (refInTriple && newRef) {
    if (!state.cels.has(newRef.source)) {
      throw new Error(
        `setCel: ref source "${newRef.source}" for cel "${key}" not in state.cels`,
      );
    }
  }

  // Mutate. From here, the cel is dirty until we finish.
  let topoChanged = false;
  if (fInTriple || lInTriple) {
    if (cel._dispose) { try { cel._dispose(); } catch { /* swallow */ } }
    cel._dispose = undefined;
    cel._fn = undefined;
    cel._buildEvaluate = undefined;
    if (willHaveSource) {
      cel.f = newF as string;
      cel.l = newL ?? "f";
      compileCelBody(cel, state.fns);
      topoChanged = true;
    } else {
      // Source cleared (newF === null). Cel reverts toward bodyless.
      if (fInTriple) cel.f = undefined;
      if (lInTriple) cel.l = newL == null ? undefined : newL;
      if (lInTriple || fInTriple) topoChanged = true;
    }
  }
  if (refInTriple) {
    if (newRef) {
      // Installing a ref — clear v if the cel still owns one.
      if (cel.v !== undefined && cel.v !== null) {
        releaseValue(cel.v, cel.tag, state.tagRegistry);
        cel.v = undefined;
      }
      cel.ref = newRef;
      topoChanged = true;
    } else {
      // Clearing the ref.
      if (cel.ref !== undefined) topoChanged = true;
      cel.ref = undefined;
    }
  }
  if (vInTriple) {
    // For a ref cel, v writes already errored above unless v is
    // undefined / null. For a normal cel, install the new value.
    releaseValue(cel.v, cel.tag, state.tagRegistry);
    cel.v = triple.v;
  }
  // Final consistency: a cel must not end with both ref and v after the
  // mutation (defensive — the pre-flight already covered every legal
  // path; this catches partial-update bugs early).
  if (cel.ref && cel.v !== undefined && cel.v !== null) {
    cel.v = undefined;
  }
  return { topoChanged };
};

const readTriple = (cel: Cel): CelTriple => {
  const out: CelTriple = { v: cel.v };
  if (cel.f   !== undefined) out.f   = cel.f;
  if (cel.l   !== undefined) out.l   = cel.l;
  if (cel.ref !== undefined) out.ref = cel.ref;
  return out;
};

export const getCel: Fn = (state: State, key: Key): CelTriple | undefined => {
  const cel = state.cels.get(key);
  return cel ? readTriple(cel) : undefined;
};

export const getCelBatch: Fn = (
  state: State, keys: Key[],
): Record<Key, CelTriple> => {
  const out: Record<Key, CelTriple> = {};
  for (const k of keys) {
    const cel = state.cels.get(k);
    if (cel) out[k] = readTriple(cel);
  }
  return out;
};

export const setCel: Fn = async (
  state: State, key: Key, triple: CelTriple, opts?: SetOpts,
) => {
  const { topoChanged } = applyTripleAtomic(state, key, triple);
  if (topoChanged) precompute(state);
  await runCascade(state, affectedFor(state, [key]), new Set([key]));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const setCelBatch: Fn = async (
  state: State, writes: Record<Key, CelTriple>, opts?: SetOpts,
) => {
  const keys = Object.keys(writes);
  if (keys.length === 0) return state;
  let topoChanged = false;
  for (const key of keys) {
    const result = applyTripleAtomic(state, key, writes[key]);
    if (result.topoChanged) topoChanged = true;
  }
  if (topoChanged) precompute(state);
  await runCascade(state, affectedFor(state, keys), new Set(keys));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

// ============================================================================
// registerLambda — runtime lambda registration. Adds a fn (or compiles
// one from source) into state.fns + state.fnMetadata, and optionally
// installs companion schemas/schemaMetadata in the same call.
//
// Atomicity: pre-flight (lock, fn xor source, compiler resolution,
// compilation) runs before any state mutation. A failing
// registerLambda leaves state untouched.
//
// Dispose: a previously-registered fn at the same key has its
// state.fnDispose entry fired (if any) before installation. The new
// dispose comes from the compiler's {fn, dispose} envelope (if used)
// or from args.dispose; compiler-supplied wins.
//
// Schemas: when args.schemas is set, schemas install before the fn,
// so an inputSchema/outputSchema reference into the same call is
// already resolvable.
// ============================================================================

export const registerLambda: Fn = (state: State, args: RegisterLambdaArgs) => {
  // ── Pre-flight ─────────────────────────────────────────────────────────
  if (args.fn !== undefined && args.source !== undefined) {
    throw new Error(`registerLambda: "${args.key}" provides both fn and source.`);
  }
  if (args.fn === undefined && args.source === undefined) {
    throw new Error(`registerLambda: "${args.key}" needs either fn or source.`);
  }
  if (state.fnMetadata.get(args.key)?.locked && state.fns.has(args.key)) {
    throw new Error(`registerLambda: "${args.key}" is locked.`);
  }

  let runtime: Fn;
  let dispose: (() => void) | undefined = args.dispose;
  if (args.fn) {
    runtime = args.fn;
  } else {
    const compilerKey = args.kind ?? "f";
    const compiler = state.fns.get(compilerKey) as Compiler | undefined;
    if (!compiler) {
      throw new Error(
        `registerLambda: "${args.key}" needs compiler at "${compilerKey}", not registered.`,
      );
    }
    const compiled = compiler(args.source!);
    if (typeof compiled === "function") {
      runtime = compiled;
    } else {
      runtime = compiled.fn;
      if (compiled.dispose) dispose = compiled.dispose; // compiler wins
    }
  }
  if (args.extractDeps) (runtime as Fn).extractDeps = args.extractDeps;

  // ── Commit ─────────────────────────────────────────────────────────────
  if (args.schemas) {
    for (const [k, zod] of Object.entries(args.schemas)) state.schemas.set(k, zod);
  }
  if (args.schemaMetadata) {
    for (const [k, meta] of Object.entries(args.schemaMetadata)) {
      state.schemaMetadata.set(k, { ...meta, key: k });
    }
  }

  const prevDispose = state.fnDispose.get(args.key);
  if (prevDispose) {
    try { prevDispose(); } catch { /* swallow */ }
    state.fnDispose.delete(args.key);
  }

  state.fns.set(args.key, runtime);
  const meta: LambdaMetadata = { key: args.key };
  if (args.kind         !== undefined) meta.kind         = args.kind;
  if (args.inputSchema  !== undefined) meta.inputSchema  = args.inputSchema;
  if (args.outputSchema !== undefined) meta.outputSchema = args.outputSchema;
  if (args.arity        !== undefined) meta.arity        = args.arity;
  if (args.source       !== undefined) meta.source       = args.source;
  if (args.locked       !== undefined) meta.locked       = args.locked;
  state.fnMetadata.set(args.key, meta);
  if (dispose) state.fnDispose.set(args.key, dispose);

  return state;
};

export const touch: Fn = async (state: State, opts?: SetOpts) => {
  await fireDynamic(state);
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const consume: Fn = async (state: State, opts?: SetOpts) => {
  await fireDynamic(state);
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

// Standalone drain — exposed so host code can drain channels without
// going through set/batch. Useful when a host orchestrator wants to
// force-commit DOM/persist work outside a set call (e.g. before tearing
// down a state, or in test setup). Defaults to draining every channel
// to fixed point. Returns Promise<void> so async drains can be awaited.
export const drain: Fn = async (state: State, spec?: FlushSpec) => {
  await flushChannels(state, spec ?? "all");
  return state;
};
