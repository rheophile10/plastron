import type { Key } from "../../common.js";
import type { State } from "../types/index.js";
import type { WavedCascade, Input } from "./types.js";
import type { RecalculationMode, RecalculationConfig, DownstreamTopology } from "../segments/types/index.js";
import { defaultIsChanged, mergeCascades, mergeDynamicCascade } from "./cascade.js";

// ========================================================================
// makeInput — the write surface attached to State. Holds the pending buffer
// (used in manual mode) and implements set / batch / touch / consume.
// Automatic mode calls state.cycle immediately; manual mode queues into
// input.buffer until the caller invokes consume().
// ========================================================================

export const makeInput = (state: State): Input => {
  const api: Input = {
    buffer: new Map() as WavedCascade,

    get(key: Key): unknown {
      return state.Cels.get(key)?.v;
    },

    async set(key: Key, value: unknown): Promise<void> {
      const cascade = cellValueWrite(state, key, value);
      if (cascade.size === 0) return;
      await route(cascade);
    },

    async batch(writes: Array<[Key, unknown]>): Promise<void> {
      let merged: WavedCascade = new Map();
      for (const [key, value] of writes) {
        const cascade = cellValueWrite(state, key, value);
        merged = mergeCascades(merged, cascade, state);
      }
      if (merged.size === 0) return;
      await route(merged);
    },

    async touch(key: Key): Promise<void> {
      const cascade = touchCascade(state, key);
      if (cascade.size === 0) return;
      await route(cascade);
    },

    async consume(): Promise<void> {
      if (api.buffer.size === 0) return;
      const next = api.buffer;
      api.buffer = new Map();
      await state.cycle!(next);
    },
  };

  const readMode = (): RecalculationMode => {
    const cfg = state.Cels.get("config_recalculation");
    if (!cfg) return "automatic";
    return (cfg.v as RecalculationConfig).mode;
  };

  const route = async (cascade: WavedCascade): Promise<void> => {
    if (readMode() === "automatic") {
      await state.cycle!(cascade);
    } else {
      api.buffer = mergeCascades(api.buffer, cascade, state);
    }
  };

  return api;
};

// ========================================================================
// cellValueWrite — primitive for variable writes. Returns an empty
// cascade when the write is a no-op (isChanged said false).
// ========================================================================

const cellValueWrite = (state: State, key: Key, value: unknown): WavedCascade => {
  const cels = state.Cels;
  const cel = cels.get(key);
  if (!cel) throw Error(`Key not found in state: ${key}`);
  if (cel.readOnly) throw Error(`Cel "${key}" is read-only`);
  if (cel.l) throw Error(`Cel "${key}" is a lambda — cannot write directly`);

  const isChanged = cel.isChanged ?? defaultIsChanged;
  if (!isChanged(cel.v, value)) return new Map();

  const downstreamTopology = cels.get("downstreamTopology")?.v as DownstreamTopology | undefined;
  const downstream = downstreamTopology?.get(key);
  if (!downstream) throw Error(`Key not in downstream topology index: ${key}`);

  cel.v = value;
  return mergeDynamicCascade(downstream, state);
};

// ========================================================================
// touchCascade — force-fire cascade for a cel. Sets cel._touched so
// runCycle bypasses input-pruning for that one cel.
// ========================================================================

const touchCascade = (state: State, key: Key): WavedCascade => {
  const cels = state.Cels;
  const cel = cels.get(key);
  if (!cel) throw Error(`Key not found in state: ${key}`);

  const downstreamTopology = cels.get("downstreamTopology")?.v as DownstreamTopology | undefined;
  const downstream = downstreamTopology?.get(key);
  if (!downstream) throw Error(`Key not in downstream topology index: ${key}`);

  cel._touched = true;
  return mergeDynamicCascade(downstream, state);
};
