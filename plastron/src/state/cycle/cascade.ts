import type { Key } from "../../common.js";
import type { State } from "../types/index.js";
import type { Cel, IsChanged } from "../types/cel.js";
import type { Cascade, WavedCascade } from "./types.js";
import type { DynamicKeys, DynamicCascade } from "../segments/types/index.js";
import type { TagRegistry } from "../types/tags.js";
import { isTaggedValue } from "../types/tags.js";

// ========================================================================
// Default change predicate — mirrors React's Object.is-based equality.
// Returns true when prev and next differ. Used directly by cels that
// declare a custom isChanged; the cycle's main path goes through
// isCelChanged below, which adds tag-aware comparison.
// ========================================================================

export const defaultIsChanged: IsChanged = (a, b) => !Object.is(a, b);

/** Tag-aware change check used by the cycle and input surface. Order:
 *    1. Per-cel override (cel.isChanged).
 *    2. Same-tag comparator from the tag registry, when both values
 *       carry the same __tag.
 *    3. Fallback to defaultIsChanged (Object.is).
 *  Returns true when the values differ (i.e., propagation should fire). */
export const isCelChanged = (
  cel: Cel,
  prev: unknown,
  next: unknown,
  tags: TagRegistry | undefined,
): boolean => {
  if (cel.isChanged) return cel.isChanged(prev, next);
  if (tags && isTaggedValue(prev) && isTaggedValue(next) && prev.__tag === next.__tag) {
    const proto = tags[prev.__tag];
    if (proto?.comparator) {
      return !proto.comparator(prev.value, next.value);
    }
  }
  return defaultIsChanged(prev, next);
};

/** Free a tagged value's resources via the registered tag protocol.
 *  Errors are swallowed so a misbehaving release can't crash the cycle.
 *  Untagged values and tags without a release entry are no-ops. */
export const releaseValue = (value: unknown, tags: TagRegistry | undefined): void => {
  if (!tags) return;
  if (!isTaggedValue(value)) return;
  const proto = tags[value.__tag];
  if (!proto?.release) return;
  try { proto.release(value.value); } catch { /* swallow */ }
};

// ========================================================================
// mergeCascades — union of two waved cascades, re-sorted by the cel's
// layer (read off cel.layer directly).
// ========================================================================

export const mergeCascades = (
  a: WavedCascade,
  b: WavedCascade,
  state: State,
): WavedCascade => {
  if (a.size === 0) return b;
  if (b.size === 0) return a;

  const cels = state.Cels;
  const result: WavedCascade = new Map();
  const waves = new Set<number>([...a.keys(), ...b.keys()]);
  const sortedWaves = Array.from(waves).sort((x, y) => x - y);

  for (const w of sortedWaves) {
    const layersA = a.get(w) ?? [];
    const layersB = b.get(w) ?? [];

    const allKeys = new Set<Key>();
    for (const layer of layersA) for (const k of layer) allKeys.add(k);
    for (const layer of layersB) for (const k of layer) allKeys.add(k);

    const byLayer = new Map<number, Key[]>();
    for (const k of allKeys) {
      const layerIdx = cels.get(k)?.layer;
      if (layerIdx === undefined) continue;
      if (!byLayer.has(layerIdx)) byLayer.set(layerIdx, []);
      byLayer.get(layerIdx)!.push(k);
    }

    const sortedLayerIdx = Array.from(byLayer.keys()).sort((x, y) => x - y);
    result.set(w, sortedLayerIdx.map(l => byLayer.get(l)!));
  }

  return result;
};

// ========================================================================
// mergeDynamicCascade — fold dynamic cels + their downstreams into a
// cascade. Reads dynamicKeys and dynamicCascade cels directly.
// ========================================================================

export const mergeDynamicCascade = (cascade: WavedCascade, state: State): WavedCascade => {
  const cels = state.Cels;
  const dynamicKeys = cels.get("dynamicKeys")?.v as DynamicKeys | undefined;
  const dynamicCascade = cels.get("dynamicCascade")?.v as DynamicCascade | undefined;

  if (!dynamicKeys || dynamicKeys.size === 0) return cascade;

  const byWave = new Map<number, Map<number, Key[]>>();

  const addKey = (k: Key) => {
    const cel = cels.get(k);
    if (!cel) return;
    const layerIdx = cel.layer;
    const wave = cel.wave ?? 0;
    if (layerIdx === undefined) return;
    let wb = byWave.get(wave);
    if (!wb) { wb = new Map(); byWave.set(wave, wb); }
    let layer = wb.get(layerIdx);
    if (!layer) { layer = []; wb.set(layerIdx, layer); }
    if (!layer.includes(k)) layer.push(k);
  };

  if (dynamicCascade) {
    for (const layer of dynamicCascade) {
      for (const k of layer) addKey(k);
    }
  }
  for (const k of dynamicKeys) addKey(k);

  const dynamicWaved: WavedCascade = new Map();
  const sortedWaves = Array.from(byWave.keys()).sort((x, y) => x - y);
  for (const w of sortedWaves) {
    const layers = byWave.get(w)!;
    const sortedLayerIdx = Array.from(layers.keys()).sort((x, y) => x - y);
    dynamicWaved.set(w, sortedLayerIdx.map(l => layers.get(l)!));
  }

  return mergeCascades(cascade, dynamicWaved, state);
};

// ========================================================================
// buildInitialCascade — every lambda cel in the graph, wave-and-layer
// partitioned, ready to fire through state.cycle once after hydration.
// Runs each lambda from its initial inputs so nothing stays null after
// a fresh hydrate.
//
// Skips non-lambda cels (their values come from hydration already) and
// skips lambda cels that already have a non-null .v (user-supplied
// initial output — respect it).
// ========================================================================

export const buildInitialCascade = (state: State): WavedCascade => {
  const byWave = new Map<number, Map<number, Key[]>>();

  for (const [key, cel] of state.Cels) {
    if (!cel.l) continue;          // skip pure variables / constants
    if (cel.v !== null) continue;  // skip lambdas the user seeded with a value
    const wave = cel.wave ?? 0;
    const layer = cel.layer ?? 0;
    let wb = byWave.get(wave);
    if (!wb) { wb = new Map(); byWave.set(wave, wb); }
    let bucket = wb.get(layer);
    if (!bucket) { bucket = []; wb.set(layer, bucket); }
    bucket.push(key);
  }

  const cascade: WavedCascade = new Map();
  const sortedWaves = Array.from(byWave.keys()).sort((a, b) => a - b);
  for (const w of sortedWaves) {
    const layers = byWave.get(w)!;
    const sortedLayers = Array.from(layers.keys()).sort((a, b) => a - b);
    cascade.set(w, sortedLayers.map(l => layers.get(l)!) as Cascade);
  }
  return cascade;
};
