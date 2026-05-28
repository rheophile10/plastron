import type { DehydratedCel, Key, State, 甲骨, 冊 } from "../../../types/index.js";
import { computeKernelClosure } from "../../segments.js";
import { deflateCel } from "./cel.js";

// ============================================================================
// Segment dehydration — two responsibilities:
//
//   • groupCelsBySegment: walk state.cels, deflate each one, group by
//     cel.metadata.segment into 甲骨 records. Segments in the boot
//     kernel-closure are excluded (role:"kernel" + transitive deps).
//     Cels with no segment fall into "default".
//
//   • collectManifests: copy every loaded 冊 from state.segments
//     (except kernel-closure members), then synthesize stub manifests
//     for any segment that has cels in state but no 冊 entry (e.g.,
//     runtime-registered lambdas that landed in "default").
//
// Both accept an optional `only` set to filter to specific segment
// names — used by dehydrate(state, { onlySegments }) so apps can
// emit just their own segment without dumping the entire boot-loaded
// kernel surface.
//
// Kernel-closure exclusion replaces the legacy magic-string check on
// `cel.metadata.segment === "kernel"`. See
// docs/1-design/3-accepted/00-ontology/segment-classification.md
// "Kernel never dehydrated" + "Multi-segment kernel".
// ============================================================================

const observedNonKernelSegments = (
  state: State,
  kernelSet: ReadonlySet<Key>,
  only?: Set<Key>,
): Set<Key> => {
  const observed = new Set<Key>();
  for (const cel of state.cels.values()) {
    const seg = cel.metadata.segment;
    if (!seg || kernelSet.has(seg)) continue;
    if (only && !only.has(seg)) continue;
    observed.add(seg);
  }
  return observed;
};

export const groupCelsBySegment = (
  state: State,
  only?: Set<Key>,
): 甲骨[] => {
  const kernelSet = computeKernelClosure(state.segments);
  const bySegment = new Map<Key, DehydratedCel[]>();
  for (const cel of state.cels.values()) {
    const segKey = cel.metadata.segment ?? "default";
    if (kernelSet.has(segKey)) continue;
    if (only && !only.has(segKey)) continue;
    let bucket = bySegment.get(segKey);
    if (!bucket) { bucket = []; bySegment.set(segKey, bucket); }
    bucket.push(deflateCel(cel, state));
  }
  const segments: 甲骨[] = [];
  for (const [name, cels] of bySegment) segments.push({ name, cels });
  return segments;
};

export const collectManifests = (
  state: State,
  only?: Set<Key>,
): 冊[] => {
  const kernelSet = computeKernelClosure(state.segments);
  const out: 冊[] = [];
  const emitted = new Set<Key>();
  for (const [name, m] of state.segments) {
    if (kernelSet.has(name)) continue;
    if (only && !only.has(name)) continue;
    out.push(m);
    emitted.add(name);
  }
  for (const seg of observedNonKernelSegments(state, kernelSet, only)) {
    if (emitted.has(seg)) continue;
    out.push({ name: seg, version: "0.0.0", dependencies: [], role: "library" });
  }
  return out;
};
