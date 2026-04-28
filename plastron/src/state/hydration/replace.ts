import type { Key } from "../../common.js";
import type { State } from "../types/index.js";
import type { Cel } from "../types/cel.js";
import type { Fn, LambdaKey, LambdaMetadata } from "../../lambdas/types/lambda.js";
import type { DehydratedCel, FnRegistry } from "./types.js";
import type { DownstreamTopology } from "../segments/types/index.js";
import type { WavedCascade } from "../cycle/types.js";
import { defaultFns, defaultMetadata } from "../../lambdas/index.js";
import { precompute } from "./precompute.js";
import { rebuildFlushIndex } from "./flush.js";
import { runCycle, mergeCascades } from "../cycle/index.js";

// ========================================================================
// replaceCels — atomically swap one or more cels in an existing State,
// rewire the dependency graph, and re-fire the affected cascade.
//
// Distinct from hydrate({...}, {upsert: true}): hydrate only appends to
// caches (children, _inputRefs). It cannot remove an upstream link or
// switch a cel's role — a value cel that becomes a formula, or a
// formula whose deps changed, leaves stale wiring behind. replaceCels
// rebuilds wiring from scratch so a cel can switch role freely.
//
// Cycle detection comes from precompute's Kahn pass — if a replacement
// introduces a cycle, precompute throws. The cel map's children arrays
// will already have been rewired by then; treat such failures as
// "rebuild the runtime from scratch" rather than recoverable.
//
// Cost: O(N) over state.Cels for the rewire pass, plus precompute and
// the post-replacement cascade. Linear in graph size — fine for sub-
// thousand-cel sheets, worth scoping if you ever push much past that.
// ========================================================================

export const replaceCels = async (
  state: State,
  cels: Record<Key, DehydratedCel>[],
  lambdas: Record<Key, LambdaMetadata>[] = [],
  fnRegistry: FnRegistry = {},
): Promise<State> => {
  const cm = state.Cels;

  const celEntries: Array<[Key, DehydratedCel]> = [];
  for (const rec of cels) {
    for (const [key, dc] of Object.entries(rec)) celEntries.push([key, dc]);
  }
  const metaEntries: Array<[Key, LambdaMetadata]> = [];
  for (const rec of lambdas) {
    for (const [key, dl] of Object.entries(rec)) metaEntries.push([key, dl]);
  }

  for (const [key] of celEntries) validateKey(key, "cel");
  for (const [key] of metaEntries) validateKey(key, "lambda");

  const callMeta: Record<LambdaKey, LambdaMetadata> = {};
  for (const [key, meta] of metaEntries) callMeta[key] = { ...meta, key };

  const resolveFn = (key: LambdaKey): Fn | undefined => {
    if (defaultFns[key]) return defaultFns[key];
    if (fnRegistry[key]) return fnRegistry[key];
    for (const cel of cm.values()) {
      if (cel.l === key && cel._fn) return cel._fn;
    }
    return undefined;
  };

  const resolveMeta = (key: LambdaKey): LambdaMetadata | undefined => {
    if (defaultMetadata[key]) return defaultMetadata[key];
    if (callMeta[key]) return callMeta[key];
    for (const cel of cm.values()) {
      if (cel.l === key && cel._lambdaMeta) return cel._lambdaMeta;
    }
    return undefined;
  };

  // Install replacements in-place when the cel already exists, so any
  // other cel's cached _inputRefs pointer to it remains valid (the
  // identity is preserved; only the contents change).
  const replacedKeys: Key[] = [];
  for (const [key, dc] of celEntries) {
    const existing = cm.get(key);
    if (existing) mutateCel(existing, dc);
    else cm.set(key, inflateCel(key, dc));
    replacedKeys.push(key);
  }

  expandFormulasFor(cm, replacedKeys, resolveFn);
  rewire(cm, resolveFn, resolveMeta);
  validateInitialValues(cm, replacedKeys);

  rebuildFlushIndex(state);
  precompute(state);

  // Reattach the cycle runner. Hydrate does the same — a fresh closure
  // is harmless and matches the post-hydrate invariant.
  state.cycle = runCycle(state);

  // Fire the cascade for every replaced key plus their downstream
  // closures, so the new values propagate through the graph.
  const downstreamIndex = cm.get("downstreamTopology")?.v as DownstreamTopology | undefined;
  if (downstreamIndex && state.cycle) {
    let combined: WavedCascade = new Map();
    for (const key of replacedKeys) {
      const sub = downstreamIndex.get(key);
      if (sub) combined = mergeCascades(combined, sub, state);
    }
    if (combined.size > 0) await state.cycle(combined);
  }

  return state;
};

// ------------------------------------------------------------------------

const validateKey = (key: Key, kind: "cel" | "lambda"): void => {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(`Invalid ${kind} key: must be a non-empty string (got ${JSON.stringify(key)}).`);
  }
  if (/\s/.test(key)) {
    throw new Error(`Invalid ${kind} key "${key}": must not contain whitespace.`);
  }
};

const inflateCel = (key: Key, dc: DehydratedCel): Cel => {
  const cel: Cel = {
    key,
    segment: dc.segment,
    v: dc.v ?? null,
    children: dc.children ? [...dc.children] : [],
  };
  copyOptionalFields(cel, dc);
  return cel;
};

// In-place reset: clear every role + computed field, then copy the new
// dehydrated fields. Preserves cel object identity so downstream
// _inputRefs pointers stay valid.
const mutateCel = (cel: Cel, dc: DehydratedCel): void => {
  cel.segment = dc.segment;
  cel.v = dc.v ?? null;
  delete cel.l;
  delete cel.inputMap;
  delete cel.f;
  delete cel.dynamic;
  delete cel.wave;
  delete cel.prevDepth;
  delete cel.tags;
  delete cel.name;
  delete cel.description;
  delete cel.metadata;
  delete cel.schema;
  delete cel.readOnly;
  delete cel._fn;
  delete cel._lambdaMeta;
  delete cel._inputRefs;
  delete cel._prev;
  delete cel._touched;
  delete cel.layer;
  cel.children = dc.children ? [...dc.children] : [];
  copyOptionalFields(cel, dc);
};

const copyOptionalFields = (cel: Cel, dc: DehydratedCel): void => {
  if (dc.schema !== undefined)      cel.schema = dc.schema;
  if (dc.readOnly !== undefined)    cel.readOnly = dc.readOnly;
  if (dc.l !== undefined)           cel.l = dc.l;
  if (dc.inputMap !== undefined)    cel.inputMap = { ...dc.inputMap };
  if (dc.f !== undefined)           cel.f = dc.f;
  if (dc.dynamic !== undefined)     cel.dynamic = dc.dynamic;
  if (dc.wave !== undefined)        cel.wave = dc.wave;
  if (dc.prevDepth !== undefined)   cel.prevDepth = dc.prevDepth;
  if (dc.tags !== undefined)        cel.tags = [...dc.tags];
  if (dc.name !== undefined)        cel.name = dc.name;
  if (dc.description !== undefined) cel.description = dc.description;
  if (dc.metadata !== undefined)    cel.metadata = dc.metadata;
};

const expandFormulasFor = (
  cm: Map<Key, Cel>,
  keys: Key[],
  resolveFn: (key: LambdaKey) => Fn | undefined,
): void => {
  const recalcCfg = cm.get("config_recalculation")?.v as { formulaParser?: string } | undefined;
  const parserKey = recalcCfg?.formulaParser ?? "f";

  for (const key of keys) {
    const cel = cm.get(key);
    if (!cel || !cel.f) continue;
    if (cel.l && cel.l !== parserKey) {
      throw new Error(`Cel "${key}" has both cel.f and cel.l — they are mutually exclusive.`);
    }
    const parser = resolveFn(parserKey);
    if (!parser) {
      throw new Error(`Cel "${key}" has cel.f but formula parser "${parserKey}" is not registered.`);
    }

    cel.l = parserKey;
    const deps = parser.extractDeps ? parser.extractDeps(cel.f) : [];

    cel.inputMap = cel.inputMap ?? {};
    for (const dep of deps) {
      if (!cm.has(dep)) {
        throw new Error(`Cel "${key}" formula references unknown cel "${dep}".`);
      }
      const field = `__dep_${dep}`;
      if (!(field in cel.inputMap)) cel.inputMap[field] = dep;
    }
  }
};

// Whole-graph rewire: clear children + _inputRefs everywhere, then
// rebuild from each cel's current inputMap. Idempotent.
const rewire = (
  cm: Map<Key, Cel>,
  resolveFn: (key: LambdaKey) => Fn | undefined,
  resolveMeta: (key: LambdaKey) => LambdaMetadata | undefined,
): void => {
  for (const cel of cm.values()) {
    cel.children = [];
    delete cel._inputRefs;
  }

  for (const [key, cel] of cm) {
    if (!cel.inputMap) continue;
    for (const keyOrKeys of Object.values(cel.inputMap)) {
      const upstreams = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const upstream of upstreams) {
        const upCel = cm.get(upstream);
        if (upCel && !upCel.children.includes(key)) upCel.children.push(key);
      }
    }
  }

  for (const cel of cm.values()) {
    if (!cel.l) continue;
    const fn = resolveFn(cel.l);
    if (fn) cel._fn = fn;
    const meta = resolveMeta(cel.l);
    if (meta) cel._lambdaMeta = meta;

    if (cel.inputMap) {
      const refs: Record<string, Cel | Cel[]> = {};
      for (const [varName, keyOrKeys] of Object.entries(cel.inputMap)) {
        if (Array.isArray(keyOrKeys)) {
          const list: Cel[] = [];
          for (const k of keyOrKeys) {
            const c = cm.get(k);
            if (c) list.push(c);
          }
          refs[varName] = list;
        } else {
          const inputCel = cm.get(keyOrKeys);
          if (inputCel) refs[varName] = inputCel;
        }
      }
      cel._inputRefs = refs;
    }
  }
};

const validateInitialValues = (cm: Map<Key, Cel>, keys: Key[]): void => {
  const schemasCel = cm.get("config_schemas");
  const schemas = (schemasCel?.v ?? {}) as Record<string, { zod: { safeParse: (x: unknown) => { success: boolean; error?: { message: string } } } }>;

  for (const key of keys) {
    const cel = cm.get(key);
    if (!cel?.schema) continue;
    if (cel.v === null || cel.v === undefined) continue;
    const schema = schemas[cel.schema];
    if (!schema) continue;
    const result = schema.zod.safeParse(cel.v);
    if (!result.success) {
      throw new Error(
        `Initial value for cel "${key}" fails schema "${cel.schema}": ${result.error?.message ?? ""}`
      );
    }
  }
};
