import type { Cel, ChannelCel, FireableCel, Fn, Key, State } from "../types/index.js";
import { isFireable } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, bfsDownstream, type PrecomputedIndexes } from "./precompute/index.js";
import { resolveFn } from "./resolve-fn.js";
import { appendError, makeCelError } from "../甲骨坑/cel-error.js";

// Route a changed compute cel onto every channel handler. Fast path
// reads cel._channelHandlers; fallback resolves channels via the
// per-cel ChannelCel._channel.
const enqueueChannels = (cel: FireableCel, state: State): void => {
  const handlers = cel._channelHandlers;
  if (handlers) {
    for (const h of handlers) h.enqueue({ cel, state });
    return;
  }
  const channels = cel.metadata.channel;
  if (!channels || channels.length === 0) return;
  for (const k of channels) {
    const channelCel = state.cels.get(k) as ChannelCel | undefined;
    channelCel?._channel?.enqueue({ cel, state });
  }
};

const readIndexes = (state: State): PrecomputedIndexes | undefined =>
  state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;

const fireCel = (
  state: State,
  key: Key,
  suppression: boolean,
  changed: Set<Key> | undefined,
): void | Promise<void> => {
  const cel = state.cels.get(key);
  if (!cel || !isFireable(cel)) return;
  const fn = cel._fn;
  if (!fn) return;

  if (suppression) {
    let shouldFire = cel.dynamic === true;
    if (!shouldFire) {
      if (cel._inputEntries) {
        outer: for (const [, cs] of cel._inputEntries) {
          if (cs === undefined) continue;
          if (Array.isArray(cs)) {
            for (const c of cs) {
              if (c && changed!.has(c.metadata.key)) { shouldFire = true; break outer; }
            }
          } else if (changed!.has(cs.metadata.key)) {
            shouldFire = true; break;
          }
        }
      } else if (cel.metadata.inputMap) {
        outer: for (const ref of Object.values(cel.metadata.inputMap)) {
          const refs = Array.isArray(ref) ? ref : [ref];
          for (const k of refs) {
            if (changed!.has(k)) { shouldFire = true; break outer; }
          }
        }
      }
    }
    if (!shouldFire) return;
  }

  // Trap-as-value: any throw from _evaluate or the slow-path fn becomes a
  // CelError stored on cel.v. The cascade keeps going; downstream cels
  // see the error value and either propagate it (most ops will NaN /
  // throw / no-op naturally) or detect it via isCelError() and short-
  // circuit. Without this, one buggy formula aborts the whole runCycle,
  // which is hostile to incremental authoring (pictograph hit this).
  let fnResult: unknown;
  try {
    if (cel.celType === "FormulaCel" && cel._evaluate) {
      fnResult = cel._evaluate();
    } else {
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
      } else if (cel.metadata.inputMap) {
        for (const [name, refKey] of Object.entries(cel.metadata.inputMap)) {
          if (Array.isArray(refKey)) {
            const arr: unknown[] = new Array(refKey.length);
            for (let i = 0; i < refKey.length; i++) {
              arr[i] = state.cels.get(refKey[i])?.v;
            }
            inputs[name] = arr;
          } else {
            inputs[name] = state.cels.get(refKey)?.v;
          }
        }
      }
      fnResult = fn(inputs);
    }
  } catch (e) {
    const ce = makeCelError([cel.metadata.key], "RuntimeError", e);
    appendError(state, ce);
    fnResult = ce;
  }

  if (fnResult instanceof Promise) {
    return fnResult.then(
      (newV) => { finishFireSync(state, cel, newV, suppression, changed); },
      (e)    => {
        const ce = makeCelError([cel.metadata.key], "RuntimeError", e);
        appendError(state, ce);
        finishFireSync(state, cel, ce, suppression, changed);
      },
    );
  }
  finishFireSync(state, cel, fnResult, suppression, changed);
};

const finishFireSync = (
  state: State, cel: FireableCel, newV: unknown,
  suppression: boolean, changed: Set<Key> | undefined,
): void => {
  if (!suppression) {
    cel.v = newV;
    enqueueChannels(cel, state);
    return;
  }
  const isChangedKey = cel.schema?.protocols.isChanged;
  const isChanged = isChangedKey ? resolveFn(state, isChangedKey) : undefined;
  if (isChanged) {
    if (!isChanged(cel.v, newV)) return;
  } else if (cel.v === newV) {
    return;
  }
  commitChange(state, cel, newV, changed!);
};

const commitChange = (
  state: State, cel: FireableCel, newV: unknown, changed: Set<Key>,
): void => {
  cel.v = newV;
  changed.add(cel.metadata.key);
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

export const runCycle: Fn = async (state: State) => {
  const indexes = readIndexes(state);
  if (!indexes) return state;

  const all = new Set<Key>();
  for (const levels of indexes.waveCascade.values()) {
    for (const level of levels) {
      for (const k of level) all.add(k);
    }
  }
  await runCascade(state, all, undefined);
  return state;
};

export type { Cel };
