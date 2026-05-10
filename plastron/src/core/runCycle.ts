import type { Cel, Fn, Key, State } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, bfsDownstream, type PrecomputedIndexes } from "./precompute.js";
import { releaseValue } from "./hydrate.js";
import { resolveValue } from "./refs.js";
import {
  beginCycle, ensureChannelDrainsWrapped, flushCycleStats, nowNs,
  recordChannelEnqueue, recordFireTiming, recordSkip, recordWaveTiming,
  STATS_CYCLES, STATS_CHANNELS, STATS_FUNCTIONS,
} from "./perf.js";

/** Per-cycle tracking context. Built once at runCycle entry; threaded
 *  through runCascade and fireCel via the optional `perfCtx` parameter.
 *  When undefined, every hook short-circuits and the hot path is
 *  byte-identical to the pre-perf-tracking version. */
interface PerfCtx {
  /** Cels listed in config_performance.v.watchCels. Lookup is hot, so
   *  we materialize the array into a Set once. undefined = no list. */
  watchSet: Set<Key> | undefined;
  trackChannels: boolean;
  /** Current wave being fired — set by runCascade before each wave's
   *  loop, read by fireCel when recording per-cel timing. */
  currentWave: number;
}

// Route a changed cel onto every channel handler. The fast path reads
// cel._channelHandlers — materialized by the optional precompute pass
// from cel.channel + state.channelRegistry. When that cache is absent
// (just after an essential precompute pass invalidated it, before the
// optional pass has repopulated), fall back to resolving channels live
// from cel.channel and the registry. Same answer either way; the fast
// path just avoids the per-fire Array.isArray + Map.get.
//
// NOTE on concurrency: cels in the same wave-level fire in parallel,
// so multiple cels may enqueue onto the same channel within one
// microtask. Channel handlers must keep enqueue re-entrant — typically
// just a Set add or queue push. The current DOM/log/persist designs
// satisfy this trivially.
//
// Perf hook: when `perfCtx?.trackChannels` is true, bump
// state.perfChannels[k].enqueues for each handler that fires.
const enqueueChannels = (cel: Cel, state: State, perfCtx: PerfCtx | undefined): void => {
  const handlers = cel._channelHandlers;
  if (handlers) {
    for (const h of handlers) h.enqueue({ cel, state });
    if (perfCtx?.trackChannels && cel.channel) {
      const keys = Array.isArray(cel.channel) ? cel.channel : [cel.channel];
      for (const k of keys) recordChannelEnqueue(state, k);
    }
    return;
  }
  // Fallback path — cache not yet populated.
  if (!cel.channel) return;
  const keys = Array.isArray(cel.channel) ? cel.channel : [cel.channel];
  for (const k of keys) {
    state.channelRegistry.get(k)?.enqueue({ cel, state });
    if (perfCtx?.trackChannels) recordChannelEnqueue(state, k);
  }
};

// ============================================================================
// runCycle (full cascade) + internal helpers (runCascade, affectedFor)
// for incremental fires used by set/batch/touch/consume.
//
// Two modes for runCascade:
//
//   • Without `changed` (full mode): fires every cel in `affected` and
//     unconditionally writes the output to cel.v. Used by runCycle to
//     boot the graph from scratch.
//
//   • With `changed` (suppression mode): tracks which keys have a
//     changed value within this cycle. A cel fires only if it's
//     dynamic OR at least one of its inputs is in `changed`. After
//     firing, the new output is diff'd against the previous cel.v
//     (via cel._isChanged or reference equality); cel.v is updated
//     and the key added to `changed` only if the diff says different.
//     This skips both the lambda body and downstream propagation when
//     nothing meaningfully changed.
//
// Three nested loops in runCascade:
//
//   for each wave (sequential, user-declared)
//     for each level within wave (sequential, Kahn-derived)
//       for each cel in level — fired concurrently. Sync cels complete
//         inline; async cels return Promises that we Promise.all at
//         the end of the level.
//
// Sync graphs pay no parallelism overhead: fireCel returns void when
// every operation is sync, the level loop never builds a promise array,
// and the level barrier is a single `if` check. Async cels in the same
// level interleave at await points naturally.
//
// Only `runCycle` is registered in coreFns. The helpers are exported
// for direct file imports inside core/, but are NOT re-exported by
// core/index.ts — they're internal to the kernel.
// ============================================================================

const readIndexes = (state: State): PrecomputedIndexes | undefined =>
  state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;

// Fire a single cel: suppression check, build inputs, invoke fn, run
// _isChanged + _diffFn, write cel.v, route to channels. Returns void
// when the entire flow stays synchronous (the common case for sheets +
// pure compute graphs); returns Promise<void> as soon as the fn body,
// _isChanged, or _diffFn yields. Callers either `Promise.all` the
// returned Promises or ignore void returns.
//
// Perf hook: when `perfCtx` is set, time the fn body's wall-clock and
// record into state.perfFunctions / state.perfScratch. Skip-suppression
// hits bump the wave's `skipped` counter. The disabled path (perfCtx
// undefined) is byte-identical to the pre-perf-tracking version.
const fireCel = (
  state: State,
  key: Key,
  suppression: boolean,
  changed: Set<Key> | undefined,
  perfCtx: PerfCtx | undefined,
): void | Promise<void> => {
  const cel = state.cels.get(key);
  if (!cel) return;
  // Ref cels are pass-through nodes. They have no fn body — reads
  // resolve through the source's slot at gather time. We still need
  // to participate in cascade book-keeping (suppression mode adds
  // them to `changed` so downstream cels see them as inputs that
  // shifted, and channels bound to the ref still fire). Skip the
  // fn-dispatch + diff machinery entirely.
  if (cel.ref) {
    if (suppression && changed) {
      // A ref's "changed" signal is whether the source changed in
      // this cycle. The cascade reaches us via the source → ref
      // edge baked into `children` at precompute, so by the time we
      // fire, source already lives in `changed`. Mark ourselves
      // changed so our downstream consumers also re-fire.
      let sourceChanged = cel.dynamic === true;
      if (!sourceChanged && cel.ref) {
        sourceChanged = changed.has(cel.ref.source);
      }
      if (sourceChanged) {
        changed.add(cel.key);
        enqueueChannels(cel, state, perfCtx);
      } else if (perfCtx) {
        recordSkip(state, perfCtx.currentWave);
      }
    } else {
      // Full mode (boot from scratch) — always fire channels so a
      // "paint everything" pass reaches ref cels too.
      enqueueChannels(cel, state, perfCtx);
    }
    return;
  }
  if (!cel.l) return;
  // Per-cel compiled fn (e.g. formula cels) wins over the shared
  // registry lookup — same pattern as cel._isChanged.
  const fn = cel._fn ?? state.fns.get(cel.l);
  if (!fn) return;

  // Suppression mode: skip the lambda when no input changed
  // (dynamic cels always fire — their source is external).
  // Fast path walks _inputEntries (precomputed cel refs); fallback
  // walks cel.inputMap (string keys looked up against `changed`).
  if (suppression) {
    let shouldFire = cel.dynamic === true;
    if (!shouldFire) {
      if (cel._inputEntries) {
        outer: for (const [, cs] of cel._inputEntries) {
          if (cs === undefined) continue;
          if (Array.isArray(cs)) {
            for (const c of cs) {
              if (c && changed!.has(c.key)) { shouldFire = true; break outer; }
            }
          } else if (changed!.has(cs.key)) {
            shouldFire = true; break;
          }
        }
      } else if (cel.inputMap) {
        // Fallback — cache not yet populated.
        outer: for (const ref of Object.values(cel.inputMap)) {
          const refs = Array.isArray(ref) ? ref : [ref];
          for (const k of refs) {
            if (changed!.has(k)) { shouldFire = true; break outer; }
          }
        }
      }
    }
    if (!shouldFire) {
      if (perfCtx) recordSkip(state, perfCtx.currentWave);
      return;
    }
  }

  // Fast path: compiler-supplied closure captures cels directly, so we
  // skip the inputs-object allocation entirely. Built by the optional
  // precompute pass via cel._buildEvaluate.
  const t0 = perfCtx ? nowNs() : 0;
  let fnResult: unknown;
  if (cel._evaluate) {
    fnResult = cel._evaluate();
  } else {
    const inputs: Record<string, unknown> = {};
    if (cel._inputEntries) {
      // Fast: walk pre-resolved cel refs, read .v directly. When an
      // input cel is itself a ref cel (cel.ref set), resolve through
      // the source slot. The branch is one property check — branch-
      // predictable on the no-refs hot path.
      for (const [name, cs] of cel._inputEntries) {
        if (cs === undefined) {
          inputs[name] = undefined;
        } else if (Array.isArray(cs)) {
          inputs[name] = cs.map((c) => (c?.ref ? resolveValue(state, c) : c?.v));
        } else {
          inputs[name] = cs.ref ? resolveValue(state, cs) : cs.v;
        }
      }
    } else if (cel.inputMap) {
      // Fallback — cache not yet populated; resolve refs live.
      for (const [name, refKey] of Object.entries(cel.inputMap)) {
        if (Array.isArray(refKey)) {
          const arr: unknown[] = new Array(refKey.length);
          for (let i = 0; i < refKey.length; i++) {
            const c = state.cels.get(refKey[i]);
            arr[i] = c?.ref ? resolveValue(state, c) : c?.v;
          }
          inputs[name] = arr;
        } else {
          const c = state.cels.get(refKey);
          inputs[name] = c?.ref ? resolveValue(state, c) : c?.v;
        }
      }
    }
    fnResult = fn(inputs);
  }

  if (fnResult instanceof Promise) {
    return fnResult.then((newV) => {
      if (perfCtx) recordFireTiming(state, cel, nowNs() - t0, perfCtx.currentWave, perfCtx.watchSet);
      return finishFire(state, cel, newV, suppression, changed, perfCtx);
    });
  }
  if (perfCtx) recordFireTiming(state, cel, nowNs() - t0, perfCtx.currentWave, perfCtx.watchSet);
  return finishFireSync(state, cel, fnResult, suppression, changed, perfCtx);
};

// Continues fireCel after the fn result is known. Returns void if
// _isChanged / _diffFn are sync; Promise<void> if either yields.
const finishFireSync = (
  state: State, cel: Cel, newV: unknown,
  suppression: boolean, changed: Set<Key> | undefined,
  perfCtx: PerfCtx | undefined,
): void | Promise<void> => {
  if (!suppression) {
    cel.v = newV;
    // Full-mode cascade (boot from scratch) still routes to channels —
    // host code may want a "paint everything" pass at startup.
    enqueueChannels(cel, state, perfCtx);
    return;
  }

  // Output diff: cel.v IS the previous value until we overwrite it.
  // Compare in place — no separate _lastV slot needed.
  // _isChanged is materialized at hydrate from the cel's schema's
  // SchemaMetadata.isChanged. Falsy _isChanged means reference equality.
  if (cel._isChanged) {
    const r = cel._isChanged(cel.v, newV);
    if (r instanceof Promise) {
      return r.then((isCh) => {
        if (!isCh) return;
        return commitChange(state, cel, newV, changed!, perfCtx);
      });
    }
    if (!r) return;
  } else if (cel.v === newV) {
    return;
  }
  return commitChange(state, cel, newV, changed!, perfCtx);
};

// Async wrapper used after the fn body itself yielded a Promise. The
// post-fn logic is identical to the sync path; this just guarantees a
// Promise return so callers can chain off it cleanly.
const finishFire = async (
  state: State, cel: Cel, newV: unknown,
  suppression: boolean, changed: Set<Key> | undefined,
  perfCtx: PerfCtx | undefined,
): Promise<void> => {
  const r = finishFireSync(state, cel, newV, suppression, changed, perfCtx);
  if (r instanceof Promise) await r;
};

// Apply the change: run _diffFn (if any), release the prior value,
// install newV, mark `changed`, route to channels. Returns Promise
// only when _diffFn is async.
const commitChange = (
  state: State, cel: Cel, newV: unknown, changed: Set<Key>,
  perfCtx: PerfCtx | undefined,
): void | Promise<void> => {
  if (cel._diffFn) {
    const d = cel._diffFn(cel.v, newV);
    if (d instanceof Promise) {
      return d.then((diff) => {
        cel._diff = diff;
        releaseValue(cel.v, cel.tag, state.tagRegistry);
        cel.v = newV;
        changed.add(cel.key);
        // Route to channels AFTER cel.v / cel._diff are settled so the
        // channel sees consistent state when it reads them.
        enqueueChannels(cel, state, perfCtx);
      });
    }
    cel._diff = d;
  }
  releaseValue(cel.v, cel.tag, state.tagRegistry);
  cel.v = newV;
  changed.add(cel.key);
  enqueueChannels(cel, state, perfCtx);
};

export const runCascade = async (
  state: State,
  affected: Set<Key>,
  changed?: Set<Key>,
  perfCtx?: PerfCtx,
): Promise<void> => {
  const indexes = readIndexes(state);
  if (!indexes || affected.size === 0) return;

  const suppression = changed !== undefined;

  for (const wave of indexes.sortedWaves) {
    const levels = indexes.waveCascade.get(wave)!;
    for (const level of levels) {
      const waveStartNs = perfCtx ? nowNs() : 0;
      if (perfCtx) {
        perfCtx.currentWave = wave;
      }
      // Fire every affected cel in this level. Collect Promises only
      // when fireCel actually yielded — sync graphs never allocate the
      // promises array.
      let promises: Promise<void>[] | null = null;
      let inFlight = 0;
      for (const key of level) {
        if (!affected.has(key)) continue;
        const r = fireCel(state, key, suppression, changed, perfCtx);
        if (r instanceof Promise) {
          if (!promises) promises = [];
          promises.push(r);
          inFlight++;
        }
      }
      if (promises) await Promise.all(promises);
      if (perfCtx) {
        recordWaveTiming(state, wave, nowNs() - waveStartNs, Math.max(inFlight, 1));
      }
    }
  }
};

// Compute the affected set for an incremental fire: union of the
// dynamic cascade (so volatile cels always refresh) and the downstream
// closure of every written key.
//
// Closures are lazy-memoized in indexes.downstream. Miss → BFS over
// indexes.children, store, return. Hit → reuse. The cache is freshly
// empty after every essential precompute pass (the indexes object is
// reassigned), so stale closures from a reshaped graph cannot leak.
// Hydrate may pre-seed the cache from a segment's optional `downstream`
// field, removing the first-write BFS for known input keys.
export const affectedFor = (state: State, writtenKeys: Key[]): Set<Key> => {
  const affected = new Set<Key>();
  const indexes = readIndexes(state);
  if (!indexes) return affected;
  for (const k of indexes.dynamicCascade) affected.add(k);
  for (const k of writtenKeys) {
    let ds = indexes.downstream.get(k);
    if (!ds) {
      ds = bfsDownstream(k, indexes.children);
      indexes.downstream.set(k, ds);
    }
    for (const c of ds) affected.add(c);
  }
  return affected;
};

export const runCycle: Fn = async (state: State, trigger?: Key | "batch") => {
  const indexes = readIndexes(state);
  if (!indexes) return state;

  // Cycle entry — read config once, decide whether to sample. Disabled
  // path: bumps cycleN and modulo, allocates {config, samplingHit}
  // (V8 escape-elides), short-circuits.
  const { config, samplingHit } = beginCycle(state);

  // Build the per-cycle perf context only when sampling. When undefined,
  // every fireCel / runCascade hot-path branch short-circuits.
  let perfCtx: PerfCtx | undefined;
  if (samplingHit && config) {
    const scratch = state.perfScratch;
    scratch.cycleStartNs = nowNs();
    scratch.trigger = trigger;
    scratch.firedCount = 0;
    scratch.skippedCount = 0;
    scratch.waveStats.clear();
    scratch.watchedCelTimings.clear();

    perfCtx = {
      watchSet: config.watchCels && config.watchCels.length > 0
        ? new Set(config.watchCels)
        : undefined,
      trackChannels: !!config.trackChannels,
      currentWave: 0,
    };

    // Wrap channel drains so completions show up in stats_channels.
    // v1: idempotent and one-shot — no auto-unwrap.
    if (perfCtx.trackChannels) {
      ensureChannelDrainsWrapped(state);
    }
  }

  const all = new Set<Key>();
  for (const levels of indexes.waveCascade.values()) {
    for (const level of levels) {
      for (const k of level) all.add(k);
    }
  }
  // Full mode (no `changed` arg) — every lambda cel fires from scratch.
  await runCascade(state, all, undefined, perfCtx);

  // Cycle exit — flush snapshots when sampled. Direct cel.v mutation,
  // not setCel, so the writes don't re-enter the cascade.
  if (perfCtx && config) {
    if (config.trackCycles || config.trackFunctions || config.trackChannels) {
      flushCycleStats(state);
      // Stats cels with channel bindings need an explicit enqueue —
      // see perf.ts header. Channels not declared on the cels are
      // a no-op.
      const cycCel = state.cels.get(STATS_CYCLES);
      if (cycCel?.channel) enqueueChannels(cycCel, state, perfCtx);
      const fnCel = state.cels.get(STATS_FUNCTIONS);
      if (fnCel?.channel) enqueueChannels(fnCel, state, perfCtx);
      const chCel = state.cels.get(STATS_CHANNELS);
      if (chCel?.channel) enqueueChannels(chCel, state, perfCtx);
    }
  }
  return state;
};
