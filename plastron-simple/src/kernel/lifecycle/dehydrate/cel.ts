import type { Cel, CelMetadata, DehydratedCel, State, ValueCel } from "../../../types/index.js";
import { isFireable } from "../../../types/index.js";
import { resolveFn } from "../../resolve-fn.js";
import { dehydrateValue } from "./schema.js";

// Run cel.schema?.protocols.sourceDehydrate on a fireable cel's `f`
// string. Symmetric with dehydrateValue (which acts on cel.v). Used by
// the built-in `lambda-source` schema to split multi-line source back
// into a string[] for readable .json output. Falls through on miss:
// no schema, no sourceDehydrate protocol, or the protocol fn cel
// hasn't been hydrated yet.
const dehydrateSource = (
  cel: Cel,
  f: string,
  state: State,
): string | string[] => {
  const fnKey = cel.schema?.protocols.sourceDehydrate;
  if (!fnKey) return f;
  const fn = resolveFn(state, fnKey);
  if (!fn) return f;
  return fn(f) as string | string[];
};

// Cel → DehydratedCel. Narrows on celType to pick up kind-specific
// fields (wave, dynamic, f). Locked is on BaseCel so it's always
// readable.
export const deflateCel = (c: Cel, state: State): DehydratedCel => {
  const metadata: CelMetadata = { ...c.metadata };
  const v = dehydrateValue(c, state);
  if (v !== undefined) metadata.v = v;
  const dc: DehydratedCel = { key: metadata.key, celType: c.celType, metadata };
  if (c.locked !== undefined) dc.locked = c.locked;
  if (isFireable(c)) {
    if (c.wave    !== undefined) dc.wave    = c.wave;
    if (c.dynamic !== undefined) dc.dynamic = c.dynamic;
    if (c.f       !== undefined) dc.f       = dehydrateSource(c, c.f, state);
  } else if (c.celType === "ValueCel") {
    const wave = (c as ValueCel).wave;
    if (wave !== undefined) dc.wave = wave;
  } else if (c.celType === "CompilerCel") {
    const f = c.f;
    if (f !== undefined) dc.f = f;
  }
  return dc;
};
