import type { Key } from "../../common.js";
import type { State } from "../types/index.js";
import type { Cel } from "../types/cel.js";
import type { Fn, LambdaKey, LambdaMetadata } from "../../lambdas/types/lambda.js";
import type { SchemaRecords } from "../../schemas/types/schema.js";
import type { DehydratedCel, FnRegistry, HydrateOptions } from "./types.js";
import type { TagIndex } from "../segments/types/index.js";
import { flush, rebuildFlushIndex } from "./flush.js";
import { defaultCells } from "../segments/index.js";
import { defaultFns, defaultMetadata } from "../../lambdas/index.js";
import { defaultSchemas } from "../../schemas/index.js";
import { precompute } from "./precompute.js";
import { buildInitialCascade, runCycle } from "../cycle/index.js";

type CelMap = Map<Key, Cel>;

// ========================================================================
// hydrate — merge a batch of cels + lambda metadata into a State.
//
// With no existing State, starts from a bootstrapped one (all reserved
// cels injected, default schemas merged into config_schemas.v). With an
// existing State, upserts per options.upsert.
//
// Runs precompute at the end, so the returned State is cycle-ready.
// ========================================================================

const bootstrap = (): State => {
  const Cels = new Map<Key, Cel>();
  const state: State = {
    Cels,
    flush: (segmentKey) => flush(state, segmentKey),
    hydrate: (moreCels, moreLambdas, moreFnRegistry, options) =>
      hydrate(moreCels, moreLambdas ?? [], moreFnRegistry ?? {}, state, options),
  };
  for (const cel of defaultCells) Cels.set(cel.key, cel);

  const schemasCel = Cels.get("config_schemas");
  if (schemasCel) {
    schemasCel.v = { ...defaultSchemas } satisfies SchemaRecords;
  }

  // Populate "state" segment method cels with references that close
  // over this state. Lambdas can inputMap to these and invoke them.
  Cels.get("state_hydrate")!.v = state.hydrate;
  Cels.get("state_flush")!.v   = state.flush;

  return state;
};

export const hydrate = async (
  cels: Record<Key, DehydratedCel>[],
  lambdas: Record<Key, LambdaMetadata>[],
  fnRegistry: FnRegistry,
  existing?: State,
  options?: HydrateOptions,
): Promise<State> => {
  const upsert = options?.upsert === true;
  const state = existing ?? bootstrap();
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

  if (!upsert) {
    for (const [key] of celEntries) {
      if (cm.has(key)) {
        throw new Error(`Cel key "${key}" already exists (use upsert: true to overwrite).`);
      }
    }
  }

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

  const newCelKeys: Key[] = [];
  for (const [key, dc] of celEntries) {
    cm.set(key, inflateCel(key, dc));
    newCelKeys.push(key);
  }

  expandFormulaCels(cm, newCelKeys, resolveFn);
  autoWireChildren(cm, newCelKeys);
  hydrateReferences(cm, newCelKeys, resolveFn, resolveMeta);
  validatePrevDepth(cm, newCelKeys);
  validateInitialValues(cm, newCelKeys);
  mergeTagIndex(cm, newCelKeys);
  rebuildFlushIndex(state);

  // Cycle-ready: populate index cels + stamp layer/wave on every cel.
  precompute(state);

  // Attach the cycle runner and fire one priming cycle over every
  // lambda cel that's still null, so the returned State is fully
  // computed from its hydrated inputs. Order falls out of the cascade
  // (topologically layered) — callers don't have to think about it.
  state.cycle = runCycle(state);
  const initial = buildInitialCascade(state);
  if (initial.size > 0) await state.cycle(initial);

  return state;
};

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
  return cel;
};

// Formula cels — cel.f → auto-wire inputMap + children via the parser's
// extractDeps property attached to the parser fn.
const expandFormulaCels = (
  cm: CelMap,
  newKeys: Key[],
  resolveFn: (key: LambdaKey) => Fn | undefined,
): void => {
  const recalcCfg = cm.get("config_recalculation")?.v as { formulaParser?: string } | undefined;
  const parserKey = recalcCfg?.formulaParser ?? "f";
  const parser = resolveFn(parserKey);

  for (const key of newKeys) {
    const cel = cm.get(key);
    if (!cel || !cel.f) continue;
    if (cel.l) {
      throw new Error(`Cel "${key}" has both cel.f and cel.l — they are mutually exclusive.`);
    }
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

    for (const dep of deps) {
      const depCel = cm.get(dep);
      if (depCel && !depCel.children.includes(key)) {
        depCel.children.push(key);
      }
    }
  }
};

// Auto-wire cel.children from cel.inputMap. Idempotent.
const autoWireChildren = (cm: CelMap, newKeys: Key[]): void => {
  for (const key of newKeys) {
    const cel = cm.get(key);
    if (!cel?.inputMap) continue;
    for (const keyOrKeys of Object.values(cel.inputMap)) {
      const upstreams = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const upstream of upstreams) {
        const upCel = cm.get(upstream);
        if (upCel && !upCel.children.includes(key)) {
          upCel.children.push(key);
        }
      }
    }
  }
};

const validatePrevDepth = (cm: CelMap, newKeys: Key[]): void => {
  for (const key of newKeys) {
    const cel = cm.get(key);
    if (!cel?.l) continue;
    const prevMinDepth = cel._lambdaMeta?.prevMinDepth;
    if (!prevMinDepth) continue;
    const depth = cel.prevDepth ?? 0;
    if (depth < prevMinDepth) {
      throw new Error(
        `Cel "${key}" uses lambda "${cel.l}" which requires prevDepth >= ${prevMinDepth}, ` +
        `but cel.prevDepth is ${depth}.`
      );
    }
  }
};

const validateInitialValues = (cm: CelMap, newKeys: Key[]): void => {
  const schemasCel = cm.get("config_schemas");
  const schemas = (schemasCel?.v ?? {}) as SchemaRecords;

  for (const key of newKeys) {
    const cel = cm.get(key);
    if (!cel?.schema) continue;
    if (cel.v === null || cel.v === undefined) continue;
    const schema = schemas[cel.schema];
    if (!schema) continue;
    const result = schema.zod.safeParse(cel.v);
    if (!result.success) {
      throw new Error(
        `Initial value for cel "${key}" fails schema "${cel.schema}": ${result.error.message}`
      );
    }
  }
};

const hydrateReferences = (
  cm: CelMap,
  newKeys: Key[],
  resolveFn: (key: LambdaKey) => Fn | undefined,
  resolveMeta: (key: LambdaKey) => LambdaMetadata | undefined,
): void => {
  for (const key of newKeys) {
    const cel = cm.get(key);
    if (!cel?.l) continue;

    const fn = resolveFn(cel.l);
    if (fn) cel._fn = fn;

    const meta = resolveMeta(cel.l);
    if (meta) cel._lambdaMeta = meta;

    if (cel.inputMap) {
      const refs: Record<string, Cel | Cel[]> = {};
      for (const [varName, keyOrKeys] of Object.entries(cel.inputMap)) {
        if (Array.isArray(keyOrKeys)) {
          const celList: Cel[] = [];
          for (const k of keyOrKeys) {
            const c = cm.get(k);
            if (c) celList.push(c);
          }
          refs[varName] = celList;
        } else {
          const inputCel = cm.get(keyOrKeys);
          if (inputCel) refs[varName] = inputCel;
        }
      }
      cel._inputRefs = refs;
    }
  }
};

const mergeTagIndex = (cm: CelMap, newKeys: Key[]): void => {
  const tagIndexCel = cm.get("tagIndex");
  if (!tagIndexCel) return;
  const tagIndex = (tagIndexCel.v ?? {}) as TagIndex;

  for (const key of newKeys) {
    const cel = cm.get(key);
    if (!cel?.tags) continue;
    for (const tag of cel.tags) {
      const list = tagIndex[tag] ?? (tagIndex[tag] = []);
      if (!list.includes(key)) list.push(key);
    }
  }
  tagIndexCel.v = tagIndex;
};
