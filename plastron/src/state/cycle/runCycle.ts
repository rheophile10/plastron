import type { Key, varName } from "../../common.js";
import type { State } from "../types/index.js";
import type { Cel } from "../types/cel.js";
import type { WavedCascade } from "./types.js";
import type { HookSubscription } from "./hooks.js";
import type { TagRegistry } from "../types/tags.js";
import { isCelChanged, releaseValue } from "./cascade.js";
import { fireHook } from "./hooks.js";

// Error capture is now a default segment subscribed to afterLambdaInvoke.
// See src/segments/defaults/errors.ts. The cycle reports errors through
// the hook event payload; this module no longer maintains an error cel
// directly.
//
// Schema validation is now an opt-in kind-handler wrapper. See the
// plastron-schemas extension package for withSchemaValidation. The
// cycle no longer enforces strictTypes inline; the wrapper applies
// per-invocation pre/post validation when its conditions are met.

// ========================================================================
// runCycle — builder for State.cycle. Takes the state object, returns the
// closure that runs one tick of the runtime against state.Cels.
// ========================================================================

export const runCycle = (state: State) => async (cascade: WavedCascade): Promise<void> => {
  if (cascade.size === 0) return;

  const cels = state.Cels;
  const hooks = state._hooks;
  const tags = state._tags;
  const changedKeys = new Set<Key>();
  const sortedWaves = Array.from(cascade.keys()).sort((a, b) => a - b);

  fireHook(hooks, "beforeCycle", { cascade });

  for (const w of sortedWaves) {
    const subCascade = cascade.get(w)!;
    const changedInThisWave = new Set<Key>();

    for (const layer of subCascade) {
      await Promise.all(
        layer.map(async (key) => {
          const cel = cels.get(key);
          if (!cel) return;

          if (!cel.l) {
            changedKeys.add(key);
            changedInThisWave.add(key);
            return;
          }

          const didChange = await runLambdaCel(cel, cels, changedKeys, w, hooks, tags);
          if (didChange) changedInThisWave.add(key);
        })
      );
    }

    fireHook(hooks, "afterWave", {
      waveIndex: w,
      changedKeys: [...changedInThisWave],
    });
  }

  fireHook(hooks, "afterCycle", { allChanges: [...changedKeys] });
};

const runLambdaCel = async (
  cel: Cel,
  cels: Map<Key, Cel>,
  changedKeys: Set<Key>,
  currentWave: number,
  hooks: HookSubscription[] | undefined,
  tags: TagRegistry | undefined,
): Promise<boolean> => {
  const key = cel.key;
  if (!cel.l) return false;

  if (!cel.dynamic && !cel._touched && cel.v !== null) {
    const inputKeys = cel.inputMap
      ? Object.values(cel.inputMap).flat()
      : [];
    const anyInputChanged = inputKeys.some(k => changedKeys.has(k));
    if (!anyInputChanged) return false;
  }
  cel._touched = false;

  const fn = cel._fn;
  if (!fn) {
    const err = new Error(`Lambda missing: ${cel.l}`);
    (err as Error & { code?: string }).code = "MISSING_LAMBDA";
    fireHook(hooks, "afterLambdaInvoke", {
      key, inputs: {}, durationMs: 0, error: err,
    });
    return false;
  }

  const inputs: Record<varName, unknown> = {};
  if (cel._inputRefs) {
    for (const [inputName, ref] of Object.entries(cel._inputRefs)) {
      if (Array.isArray(ref)) {
        inputs[inputName] = ref.map(c => c.v);
      } else {
        inputs[inputName] = (ref as Cel).v;
      }
    }
  }

  if (cel.f !== undefined) inputs.f = cel.f;
  inputs._prev = cel._prev ?? [];

  inputs._read = (k: Key): unknown => {
    const target = cels.get(k);
    if (!target) return undefined;
    const targetWave = target.wave ?? 0;
    if (targetWave >= currentWave && !target.readOnly) {
      throw new Error(
        `_read("${k}"): target wave ${targetWave} must be < caller wave ${currentWave} (or target must be readOnly)`
      );
    }
    return target.v;
  };

  try {
    const prev = cel.v;
    const startedAt = performance.now();
    const result = fn(inputs);
    const finalValue = await Promise.resolve(result);
    const durationMs = performance.now() - startedAt;

    fireHook(hooks, "afterLambdaInvoke", {
      key, inputs, output: finalValue, durationMs,
    });

    const changed = isCelChanged(cel, prev, finalValue, tags);

    if (changed) {
      // Release the prior value's handler-side resources before
      // installing the new one. No-op for untagged values or tags
      // without a release entry.
      releaseValue(prev, tags);

      const depth = cel.prevDepth ?? 0;
      if (depth > 0) {
        // Push finalValue (not prev) so the lambda's _prev[0] on the
        // next run is the most recent past *output*, not the cel.v
        // value that predated the first computation.
        cel._prev = [finalValue, ...(cel._prev ?? [])].slice(0, depth);
      }
      cel.v = finalValue;
      changedKeys.add(key);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Calculation failed for cell ${key}:`, err);
    fireHook(hooks, "afterLambdaInvoke", {
      key, inputs, durationMs: 0, error: err,
    });
    return false;
  }
};
