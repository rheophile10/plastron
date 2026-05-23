import type {
  Cel, CelBody, FireableCel, Fn, Key, State,
} from "../../types/index.js";
import { isFireable } from "../../types/index.js";
import { PRECOMPUTED_STATES_KEY, precompute, type PrecomputedIndexes } from "../precompute/index.js";
import { compileCelBody } from "../lifecycle/hydrate/formula.js";
import { affectedFor, runCascade } from "../runCycle.js";
import { flushChannels, type SetOpts } from "./flush-channels.js";

// ============================================================================
// Complete-tier reads/writes — operate on the {v, f} body.
//
// Use cases: serialization, undo/redo, UI sync that pushes a cel's
// full state from a server payload, or any flow that needs to swap
// the formula alongside (or instead of) the value. The fast tier
// (get/set/batch in get-set.ts) stays unchanged for hot loops.
//
// setCel / setCelBatch are atomic: pre-flight checks (lock, kind,
// compiler resolution, compilation) happen before any state mutation.
// A failing setCel leaves the cel exactly as it was.
//
// Setting f requires re-compilation and re-runs precompute (the dep
// set may have shifted, which moves cels between waves / downstream
// sets). setCelBatch precomputes once at the end if any cel's topology
// shifted; setCel precomputes for every f change.
//
// Compiler selection lives on the cel's metadata (FormulaCel.compiler
// / LambdaCel.kind) and is not part of the body; swap it by
// constructing a new cel.
// ============================================================================

interface ApplyResult { topoChanged: boolean; }

const applyBodyAtomic = async (
  state: State, key: Key, body: CelBody,
): Promise<ApplyResult> => {
  const cel = state.cels.get(key);
  if (!cel)       throw new Error(`setCel: unknown cel "${key}"`);
  if (cel.locked) throw new Error(`setCel: cel "${key}" is locked`);

  const fInBody = "f" in body;
  const vInBody = "v" in body;

  // FormulaCel: v is derived from f. Allow f mutations (recompile);
  // refuse any v mutation, including v: null/undefined.
  if (cel.celType === "FormulaCel" && vInBody) {
    throw new Error(
      `setCel: FormulaCel "${key}" — its value is computed from f and cannot be set directly.`,
    );
  }

  if (fInBody && !isFireable(cel)) {
    throw new Error(
      `setCel: cannot set f on "${key}" — ${cel.celType} is not a fireable cel`,
    );
  }

  // Value-only writes don't need compute-cel narrowing.
  if (!fInBody) {
    if (vInBody) cel.v = body.v;
    // SchemaCel.v carries the Schema struct itself; ChannelCel.v carries
    // the DehydratedChannel descriptor. Both are baked into precompute
    // caches (cel.schema, ccel._channel), so a v swap must re-run
    // precompute to refresh those.
    const needsRebuild =
      vInBody && (cel.celType === "SchemaCel" || cel.celType === "ChannelCel");
    return { topoChanged: needsRebuild };
  }

  // From here we know cel is a fireable kind (FormulaCel | LambdaCel).
  const fcel = cel as FireableCel;

  const newF = body.f;
  if (newF == null) {
    // Clearing f on a fireable cel would change its kind to ValueCel —
    // not modeled via setCel today.
    throw new Error(`setCel: cannot clear f on "${key}" — kind change unsupported`);
  }

  if (vInBody && body.v !== undefined && body.v !== null) {
    throw new Error(
      `setCel: cannot set v on "${key}" — has a compute path.`,
    );
  }

  if (fcel._dispose) { try { fcel._dispose(); } catch { /* swallow */ } }
  fcel._dispose = undefined;
  fcel._fn = undefined;
  fcel._buildEvaluate = undefined;
  fcel.f = newF;
  await compileCelBody(fcel, state);
  if (vInBody) fcel.v = body.v;
  return { topoChanged: true };
};

const readBody = (cel: Cel): CelBody => {
  const out: CelBody = { v: cel.v };
  if (isFireable(cel) && cel.f !== undefined) out.f = cel.f;
  return out;
};

// Lambda/schema fan-out: changing the source of a LambdaCel (or the v
// of a SchemaCel) invalidates everything that references it, even
// when the reference isn't in inputMap. precompute's lambdaUsage /
// schemaUsage carry that inverse map; expand the seed set so the
// cascade actually re-fires those dependents.
const expandUsageSeeds = (state: State, keys: Key[]): Key[] => {
  const indexes = state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;
  if (!indexes) return keys;
  const { lambdaUsage, schemaUsage } = indexes;
  if (lambdaUsage.size === 0 && schemaUsage.size === 0) return keys;
  const out = new Set<Key>(keys);
  for (const k of keys) {
    const lu = lambdaUsage.get(k); if (lu) for (const u of lu) out.add(u);
    const su = schemaUsage.get(k); if (su) for (const u of su) out.add(u);
  }
  return [...out];
};

export const getCel: Fn = (state: State, key: Key): CelBody | undefined => {
  const cel = state.cels.get(key);
  return cel ? readBody(cel) : undefined;
};

export const getCelBatch: Fn = (
  state: State, keys: Key[],
): Record<Key, CelBody> => {
  const out: Record<Key, CelBody> = {};
  for (const k of keys) {
    const cel = state.cels.get(k);
    if (cel) out[k] = readBody(cel);
  }
  return out;
};

export const setCel: Fn = async (
  state: State, key: Key, body: CelBody, opts?: SetOpts,
) => {
  const { topoChanged } = await applyBodyAtomic(state, key, body);
  if (topoChanged) precompute(state);
  const seeds = expandUsageSeeds(state, [key]);
  await runCascade(state, affectedFor(state, seeds), new Set(seeds));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const setCelBatch: Fn = async (
  state: State, writes: Record<Key, CelBody>, opts?: SetOpts,
) => {
  const keys = Object.keys(writes);
  if (keys.length === 0) return state;
  let topoChanged = false;
  for (const key of keys) {
    const result = await applyBodyAtomic(state, key, writes[key]);
    if (result.topoChanged) topoChanged = true;
  }
  if (topoChanged) precompute(state);
  const seeds = expandUsageSeeds(state, keys);
  await runCascade(state, affectedFor(state, seeds), new Set(seeds));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};
