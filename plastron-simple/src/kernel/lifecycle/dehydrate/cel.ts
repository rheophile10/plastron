import type { Cel, CelMetadata, DehydratedCel, State, ValueCel } from "../../../types/index.js";
import { isFireable } from "../../../types/index.js";
import { dehydrateValue } from "./schema.js";

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
    if (c.f       !== undefined) dc.f       = c.f;
  } else if (c.celType === "ValueCel") {
    const wave = (c as ValueCel).wave;
    if (wave !== undefined) dc.wave = wave;
  } else if (c.celType === "CompilerCel") {
    const f = c.f;
    if (f !== undefined) dc.f = f;
  }
  return dc;
};
