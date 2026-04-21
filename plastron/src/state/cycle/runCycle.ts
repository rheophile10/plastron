import type { Key, varName } from "../../common.js";
import type { State } from "../types/index.js";
import type { Cel } from "../types/cel.js";
import type { WavedCascade } from "./types.js";
import type { SchemaRecords } from "../../schemas/types/schema.js";
import type {
  RecalculationConfig, ChangeIndexConfig, ChangeIndices,
  Errors, ErrorInfo,
} from "../segments/types/index.js";
import { defaultIsChanged } from "./cascade.js";

// ========================================================================
// Error tracking — maintains the reserved `errors` cel inline during the
// cycle.
// ========================================================================

const setError = (cels: Map<Key, Cel>, key: Key, err: unknown, code: string, inputs: Record<string, unknown>): void => {
  const errorsCel = cels.get("errors");
  if (!errorsCel) return;
  const map = (errorsCel.v ?? {}) as Errors;
  const info: ErrorInfo = {
    error: String(err),
    at: Date.now(),
    inputs,
    ...(code !== "*" && { code }),
  };
  map[key] = info;
  errorsCel.v = map;
};

const clearError = (cels: Map<Key, Cel>, key: Key): void => {
  const errorsCel = cels.get("errors");
  if (!errorsCel) return;
  const map = (errorsCel.v ?? {}) as Errors;
  if (key in map) {
    delete map[key];
    errorsCel.v = map;
  }
};

// ========================================================================
// runCycle — builder for State.cycle. Takes the state object, returns the
// closure that runs one tick of the runtime against state.Cels.
// ========================================================================

export const runCycle = (state: State) => async (cascade: WavedCascade): Promise<void> => {
  if (cascade.size === 0) return;

  const cels = state.Cels;
  const changedKeys = new Set<Key>();
  const sortedWaves = Array.from(cascade.keys()).sort((a, b) => a - b);

  resetChangeIndices(cels);

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

          const didChange = await runLambdaCel(cel, cels, changedKeys, w);
          if (didChange) changedInThisWave.add(key);
        })
      );
    }

    appendChangeIndicesForWave(w, changedInThisWave, cels);
  }
};

const resetChangeIndices = (cels: Map<Key, Cel>): void => {
  const configCel = cels.get("changeIndexConfig");
  const indicesCel = cels.get("changeIndices");
  if (!configCel || !indicesCel) return;

  const config = (configCel.v ?? {}) as ChangeIndexConfig;
  const result: ChangeIndices = {};
  for (const name of Object.keys(config)) {
    result[name] = [];
  }
  indicesCel.v = result;
};

const appendChangeIndicesForWave = (wave: number, changedInWave: Set<Key>, cels: Map<Key, Cel>): void => {
  const configCel = cels.get("changeIndexConfig");
  const indicesCel = cels.get("changeIndices");
  if (!configCel || !indicesCel) return;

  const config = (configCel.v ?? {}) as ChangeIndexConfig;
  const indices = (indicesCel.v ?? {}) as ChangeIndices;

  for (const [indexName, tagList] of Object.entries(config)) {
    const keys: Key[] = [];
    for (const key of changedInWave) {
      const cel = cels.get(key);
      if (!cel) continue;
      if (tagList.length === 0) {
        keys.push(key);
      } else if (cel.tags?.some(t => tagList.includes(t))) {
        keys.push(key);
      }
    }
    const arr = indices[indexName] ?? [];
    while (arr.length <= wave) arr.push([]);
    arr[wave] = keys;
    indices[indexName] = arr;
  }

  indicesCel.v = indices;
};

const runLambdaCel = async (
  cel: Cel,
  cels: Map<Key, Cel>,
  changedKeys: Set<Key>,
  currentWave: number,
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
    setError(cels, key, `Lambda missing: ${cel.l}`, "MISSING_LAMBDA", {});
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
    // TODO: extract strict-mode input/output validation into a helper
    //       validate(schemaKey, value, state): boolean (or throw-on-fail)
    //       so the cycle loop stops depending on zod directly. Useful
    //       if we ever want to swap out the schema library, and would
    //       give callers an ad-hoc validate() hook they can call outside
    //       a cycle too.
    const recalcCfg = (cels.get("config_recalculation")?.v ?? {}) as RecalculationConfig;
    const strict = recalcCfg.strictTypes === true;
    const schemas = strict
      ? ((cels.get("config_schemas")?.v ?? {}) as SchemaRecords)
      : undefined;
    const meta = cel._lambdaMeta;

    if (strict && meta?.inputSchema && schemas) {
      const inSchema = schemas[meta.inputSchema];
      if (inSchema) {
        const parsed = inSchema.zod.safeParse(inputs);
        if (!parsed.success) {
          throw new Error(
            `Input for lambda "${cel.l}" fails schema "${meta.inputSchema}": ${parsed.error.message}`
          );
        }
      }
    }

    const prev = cel.v;
    const result = fn(inputs);
    const finalValue = await Promise.resolve(result);

    if (strict && meta?.outputSchema && schemas) {
      const outSchema = schemas[meta.outputSchema];
      if (outSchema) {
        const parsed = outSchema.zod.safeParse(finalValue);
        if (!parsed.success) {
          throw new Error(
            `Output of lambda "${cel.l}" fails schema "${meta.outputSchema}": ${parsed.error.message}`
          );
        }
      }
    }

    clearError(cels, key);

    const outputIsChanged = cel.isChanged ?? defaultIsChanged;
    const changed = outputIsChanged(prev, finalValue);

    if (changed) {
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
    const errorCode = (err instanceof Error && "code" in err)
      ? String((err as any).code)
      : "*";
    console.error(`Calculation failed for cell ${key}:`, err);
    setError(cels, key, err, errorCode, inputs);
    return false;
  }
};
