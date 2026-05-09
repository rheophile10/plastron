import type { Cel, Fn, Key, State } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./precompute.js";
import { releaseValue } from "./hydrate.js";

// Route a changed cel onto every channel resolved at precompute time.
// _channelHandlers is materialized from cel.channel + state.channelRegistry
// when precompute runs (at hydrate end and flush end), so the hot path
// is a single property read + tight for loop — no Array.isArray check,
// no Map.get per channel.
//
// NOTE on concurrency: cels in the same wave-level fire in parallel,
// so multiple cels may enqueue onto the same channel within one
// microtask. Channel handlers must keep enqueue re-entrant — typically
// just a Set add or queue push. The current DOM/log/persist designs
// satisfy this trivially.
const enqueueChannels = (cel: Cel, state: State): void => {
  const handlers = cel._channelHandlers;
  if (!handlers) return;
  for (const h of handlers) h.enqueue({ cel, state });
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
const fireCel = (
  state: State,
  key: Key,
  suppression: boolean,
  changed: Set<Key> | undefined,
): void | Promise<void> => {
  const cel = state.cels.get(key);
  if (!cel || !cel.l) return;
  // Per-cel compiled fn (e.g. formula cels) wins over the shared
  // registry lookup — same pattern as cel._isChanged.
  const fn = cel._fn ?? state.fns.get(cel.l);
  if (!fn) return;

  // Suppression mode: skip the lambda when no input changed
  // (dynamic cels always fire — their source is external).
  // Walks _inputEntries (precomputed cel refs) instead of inputMap
  // strings, avoiding Map.get per input on the suppression check too.
  if (suppression) {
    let shouldFire = cel.dynamic === true;
    if (!shouldFire && cel._inputEntries) {
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
    }
    if (!shouldFire) return;
  }

  const inputs: Record<string, unknown> = {};
  if (cel._inputEntries) {
    for (const [name, cs] of cel._inputEntries) {
      if (cs === undefined) {
        inputs[name] = undefined;
      } else if (Array.isArray(cs)) {
        inputs[name] = cs.map((c) => c?.v);
      } else {
        inputs[name] = cs.v;
      }
    }
  }

  const fnResult = fn(inputs);
  if (fnResult instanceof Promise) {
    return fnResult.then((newV) => finishFire(state, cel, newV, suppression, changed));
  }
  return finishFireSync(state, cel, fnResult, suppression, changed);
};

// Continues fireCel after the fn result is known. Returns void if
// _isChanged / _diffFn are sync; Promise<void> if either yields.
const finishFireSync = (
  state: State, cel: Cel, newV: unknown,
  suppression: boolean, changed: Set<Key> | undefined,
): void | Promise<void> => {
  if (!suppression) {
    cel.v = newV;
    // Full-mode cascade (boot from scratch) still routes to channels —
    // host code may want a "paint everything" pass at startup.
    enqueueChannels(cel, state);
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
        return commitChange(state, cel, newV, changed!);
      });
    }
    if (!r) return;
  } else if (cel.v === newV) {
    return;
  }
  return commitChange(state, cel, newV, changed!);
};

// Async wrapper used after the fn body itself yielded a Promise. The
// post-fn logic is identical to the sync path; this just guarantees a
// Promise return so callers can chain off it cleanly.
const finishFire = async (
  state: State, cel: Cel, newV: unknown,
  suppression: boolean, changed: Set<Key> | undefined,
): Promise<void> => {
  const r = finishFireSync(state, cel, newV, suppression, changed);
  if (r instanceof Promise) await r;
};

// Apply the change: run _diffFn (if any), release the prior value,
// install newV, mark `changed`, route to channels. Returns Promise
// only when _diffFn is async.
const commitChange = (
  state: State, cel: Cel, newV: unknown, changed: Set<Key>,
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
        enqueueChannels(cel, state);
      });
    }
    cel._diff = d;
  }
  releaseValue(cel.v, cel.tag, state.tagRegistry);
  cel.v = newV;
  changed.add(cel.key);
  enqueueChannels(cel, state);
};

export const runCascade = async (
  state: State,
  affected: Set<Key>,
  changed?: Set<Key>,
): Promise<void> => {
  const indexes = readIndexes(state);
  if (!indexes || affected.size === 0) return;

  const suppression = changed !== undefined;

  for (const wave of indexes.sortedWaves) {
    const levels = indexes.waveCascade.get(wave)!;
    for (const level of levels) {
      // Fire every affected cel in this level. Collect Promises only
      // when fireCel actually yielded — sync graphs never allocate the
      // promises array.
      let promises: Promise<void>[] | null = null;
      for (const key of level) {
        if (!affected.has(key)) continue;
        const r = fireCel(state, key, suppression, changed);
        if (r instanceof Promise) {
          if (!promises) promises = [];
          promises.push(r);
        }
      }
      if (promises) await Promise.all(promises);
    }
  }
};

// Compute the affected set for an incremental fire: union of the
// dynamic cascade (so volatile cels always refresh) and the downstream
// closure of every written key.
export const affectedFor = (state: State, writtenKeys: Key[]): Set<Key> => {
  const affected = new Set<Key>();
  const indexes = readIndexes(state);
  if (!indexes) return affected;
  for (const k of indexes.dynamicCascade) affected.add(k);
  for (const k of writtenKeys) {
    const ds = indexes.downstream.get(k);
    if (ds) for (const c of ds) affected.add(c);
  }
  return affected;
};

export const runCycle: Fn = async (state: State) => {
  const indexes = readIndexes(state);
  if (!indexes) return state;

  const all = new Set<Key>();
  for (const levels of indexes.waveCascade.values()) {
    for (const level of levels) {
      for (const k of level) all.add(k);
    }
  }
  // Full mode (no `changed` arg) — every lambda cel fires from scratch.
  await runCascade(state, all);
  return state;
};
