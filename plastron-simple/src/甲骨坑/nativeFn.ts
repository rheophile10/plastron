import type { 甲骨, Cel, Fn } from "../types/index.js";
import { inflateCel } from "../kernel/lifecycle/index.js";

// Inflate a JSON segment catalog and bind native fn implementations by
// cel key. The JSON declares cell shape (key, celType, metadata, locked);
// the fnMap supplies the runtime `_fn` for each lambda cel. Symmetric
// with js-common-schema's installer pattern, but produces a Cel[] suitable
// for boot-time seeding (no state to write into yet).
export const bindNativeFns = (
  seed: 甲骨,
  fnMap: Map<string, Fn>,
): Cel[] => {
  const out: Cel[] = [];
  for (const dc of seed.cels) {
    // inflateCel is now pure construct — no compile pass — so these
    // cels (which never carry an `f` source body anyway) inflate
    // cleanly without any compiler-registry needing to exist yet.
    const cel = inflateCel(dc);
    const fn = fnMap.get(dc.key);
    if (fn && (cel.celType === "LockedLambdaCel" || cel.celType === "EditableLambdaCel")) {
      cel._fn = fn;
    }
    out.push(cel);
  }
  return out;
};
