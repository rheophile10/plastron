// ============================================================================
// 龜/ancestors — the lineage plastron. A second segment, so we can
// demonstrate flushing only the session while the ancestor catalog
// survives.
//
// Read-only cels; the king's forebears and their ritual weights.
// ============================================================================

import type { DehydratedCel } from "../../../plastron/src/state/index.js";

export const ancestorsCels: Record<string, DehydratedCel> = {
  ancestor_tai_jia: { segment: "ancestors", v: { name: "太甲 (Tài Jiǎ)",   weight: 5 }, readOnly: true },
  ancestor_wu_ding: { segment: "ancestors", v: { name: "武丁 (Wǔ Dīng)",  weight: 8 }, readOnly: true },
  ancestor_zu_jia:  { segment: "ancestors", v: { name: "祖甲 (Zǔ Jiǎ)",   weight: 6 }, readOnly: true },

  // Lineage scroll: reads all three ancestor cels as an array input and
  // renders a formatted display string.
  ancestor_report: {
    segment: "ancestors",
    l: "ancestorReport",
    inputMap: {
      ancestors: ["ancestor_tai_jia", "ancestor_wu_ding", "ancestor_zu_jia"],
    },
  },
};
