import type { DehydratedCel, Key, State, 甲骨, 冊 } from "../../../types/index.js";
import { deflateCel } from "./cel.js";

// ============================================================================
// Segment dehydration — two responsibilities:
//
//   • groupCelsBySegment: walk state.cels, deflate each one, group by
//     cel.metadata.segment into 甲骨 records. The "kernel" segment is
//     excluded (its cels are seeded at boot and never dehydrate).
//     Cels with no segment fall into "default".
//
//   • collectManifests: copy every loaded 冊 from state.segments
//     (except "kernel" — re-seeded by createInitialState), then
//     synthesize stub manifests for any segment that has cels in
//     state but no 冊 entry (e.g., runtime-registered lambdas that
//     landed in "default"). Without the stub, the dehydrated
//     {segments, manifests} pair would carry a 甲骨 with no
//     corresponding 冊, and rehydrate would refuse it.
// ============================================================================

const observedNonKernelSegments = (state: State): Set<Key> => {
  const observed = new Set<Key>();
  for (const cel of state.cels.values()) {
    const seg = cel.metadata.segment;
    if (!seg || seg === "kernel") continue;
    observed.add(seg);
  }
  return observed;
};

export const groupCelsBySegment = (state: State): 甲骨[] => {
  const bySegment = new Map<Key, DehydratedCel[]>();
  for (const cel of state.cels.values()) {
    if (cel.metadata.segment === "kernel") continue;
    const segKey = cel.metadata.segment ?? "default";
    let bucket = bySegment.get(segKey);
    if (!bucket) { bucket = []; bySegment.set(segKey, bucket); }
    bucket.push(deflateCel(cel, state));
  }
  const segments: 甲骨[] = [];
  for (const [name, cels] of bySegment) segments.push({ name, cels });
  return segments;
};

export const collectManifests = (state: State): 冊[] => {
  const out: 冊[] = [];
  const emitted = new Set<Key>();
  for (const [name, m] of state.segments) {
    if (name === "kernel") continue;
    out.push(m);
    emitted.add(name);
  }
  for (const seg of observedNonKernelSegments(state)) {
    if (emitted.has(seg)) continue;
    out.push({ name: seg, version: "0.0.0", dependencies: [] });
  }
  return out;
};
