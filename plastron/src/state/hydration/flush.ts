import type { Key } from "../../common.js";
import type { State } from "../types/index.js";
import type { SegmentCelsIndex, TagIndex } from "../segments/types/index.js";

// ========================================================================
// flush — remove a segment from State. Reads the segmentCelsIndex off the
// `flushIndex` cel, deletes each owned cel, prunes the `tagIndex` cel,
// and updates the flushIndex cel to drop the segment entry.
//
// Lambdas are not flushed — they live on cel._fn / cel._lambdaMeta
// alongside the cels that use them, and vanish with those cels.
// ========================================================================

export const flush = (state: State, segmentKey: Key): void => {
  const cm = state.Cels;
  const flushIndex = (cm.get("flushIndex")?.v ?? new Map()) as SegmentCelsIndex;
  const celsToRemove = flushIndex.get(segmentKey);

  if (celsToRemove) {
    for (const key of celsToRemove) cm.delete(key);

    const tagIndexCel = cm.get("tagIndex");
    if (tagIndexCel && celsToRemove.size > 0) {
      const tagIndex = (tagIndexCel.v ?? {}) as TagIndex;
      for (const tag of Object.keys(tagIndex)) {
        const pruned = tagIndex[tag].filter(k => !celsToRemove.has(k));
        if (pruned.length === 0) delete tagIndex[tag];
        else tagIndex[tag] = pruned;
      }
      tagIndexCel.v = tagIndex;
    }
  }

  flushIndex.delete(segmentKey);
  const flushIndexCel = cm.get("flushIndex");
  if (flushIndexCel) flushIndexCel.v = flushIndex;
};

// ========================================================================
// Flush-index rebuild — derive the segmentCelsIndex from cel.segment,
// write it into the flushIndex cel.
// ========================================================================

export const rebuildFlushIndex = (state: State): void => {
  const cm = state.Cels;
  const segmentCelsIndex: SegmentCelsIndex = new Map();
  for (const [key, cel] of cm) {
    const seg = cel.segment;
    if (seg === undefined) continue;
    let set = segmentCelsIndex.get(seg);
    if (!set) { set = new Set(); segmentCelsIndex.set(seg, set); }
    set.add(key);
  }
  const cel = cm.get("flushIndex");
  if (cel) cel.v = segmentCelsIndex;
};
