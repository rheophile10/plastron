import type { Cel, Fn, Key, State } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./precompute.js";
import { releaseValue } from "./hydrate.js";

// If `v` is a Promise, await it; otherwise return it directly. Lets a
// fully-sync cascade run without microtask yields, while still tolerating
// async fns transparently.
const settle = async <T,>(v: T | Promise<T>): Promise<T> =>
  v instanceof Promise ? await v : v;

// Route a changed cel onto every channel listed in cel.channel. Channel
// reads cel.v / cel._diff itself — kernel doesn't pre-decide which one
// matters. No-op if no channel binding or no handler registered.
const enqueueChannels = (cel: Cel, state: State): void => {
  if (!cel.channel) return;
  const keys = Array.isArray(cel.channel) ? cel.channel : [cel.channel];
  for (const k of keys) {
    state.channelRegistry.get(k)?.enqueue({ cel, state });
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
// Only `runCycle` is registered in coreFns. The helpers are exported
// for direct file imports inside core/, but are NOT re-exported by
// core/index.ts — they're internal to the kernel.
// ============================================================================

const readIndexes = (state: State): PrecomputedIndexes | undefined =>
  state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;

export const runCascade = async (
  state: State,
  affected: Set<Key>,
  changed?: Set<Key>,
): Promise<void> => {
  const indexes = readIndexes(state);
  if (!indexes || affected.size === 0) return;

  const cels = state.cels;
  const fns = state.fns;
  const suppression = changed !== undefined;
  const waves = [...indexes.waveCascade.keys()].sort((a, b) => a - b);

  for (const wave of waves) {
    for (const key of indexes.waveCascade.get(wave)!) {
      if (!affected.has(key)) continue;
      const cel = cels.get(key);
      if (!cel || !cel.l) continue;
      // Per-cel compiled fn (e.g. formula cels) wins over the shared
      // registry lookup — same pattern as cel._isChanged.
      const fn = cel._fn ?? fns.get(cel.l);
      if (!fn) continue;

      // Suppression mode: skip the lambda when no input changed
      // (dynamic cels always fire — their source is external).
      if (suppression) {
        let shouldFire = cel.dynamic === true;
        if (!shouldFire && cel.inputMap) {
          for (const ref of Object.values(cel.inputMap)) {
            const refs = Array.isArray(ref) ? ref : [ref];
            for (const k of refs) {
              if (changed!.has(k)) { shouldFire = true; break; }
            }
            if (shouldFire) break;
          }
        }
        if (!shouldFire) continue;
      }

      const inputs: Record<string, unknown> = {};
      if (cel.inputMap) {
        for (const [name, ref] of Object.entries(cel.inputMap)) {
          inputs[name] = Array.isArray(ref)
            ? ref.map((k) => cels.get(k)?.v)
            : cels.get(ref)?.v;
        }
      }
      const newV = await settle(fn(inputs));

      if (!suppression) {
        cel.v = newV;
        // Full-mode cascade (boot from scratch) still routes to channels
        // — host code may want a "paint everything" pass at startup.
        enqueueChannels(cel, state);
        continue;
      }

      // Output diff: cel.v IS the previous value until we overwrite
      // it. Compare in place — no separate _lastV slot needed.
      // _isChanged is materialized at hydrate from the cel's schema's
      // SchemaMetadata.isChanged. No fallback to tag — change detection
      // is a schema concern, not a value-protocol concern. Falsy
      // _isChanged means reference equality.
      const isChanged = cel._isChanged
        ? !!(await settle(cel._isChanged(cel.v, newV)))
        : cel.v !== newV;
      if (isChanged) {
        // If the schema declares a diff fn, run it on (prev, next)
        // before overwriting cel.v. Diff result lives on cel._diff
        // for downstream consumers (DOM painters, audit log, sync).
        if (cel._diffFn) {
          cel._diff = await settle(cel._diffFn(cel.v, newV));
        }
        releaseValue(cel.v, cel.tag, state.tagRegistry);
        cel.v = newV;
        changed!.add(key);
        // Route to channels AFTER cel.v / cel._diff are settled so the
        // channel sees consistent state when it reads them.
        enqueueChannels(cel, state);
      }
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
  for (const keys of indexes.waveCascade.values()) {
    for (const k of keys) all.add(k);
  }
  // Full mode (no `changed` arg) — every lambda cel fires from scratch.
  await runCascade(state, all);
  return state;
};
