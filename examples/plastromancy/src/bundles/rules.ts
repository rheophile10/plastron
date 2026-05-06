import type { SegmentBundle } from "../../../../plastron/src/index.js";

// ========================================================================
// rules — the divination rule book, exposed as a module cel for
// inspection and as documentation of what the augur lambda is matching
// against. The augur kind reads its rule from lambda metadata `source`,
// but we also publish the rule book as a cel so devtools and the
// session can display "what rules are in effect."
//
// segment role: schema. Loaded by default. Read-only.
// ========================================================================

export const rulesBundle: SegmentBundle = {
  version: 1,
  key: "rules",
  metadata: {
    role: "schema",
    description: "The divination rule book referenced by augur lambdas.",
  },
  cels: {
    divinationRuleBook: {
      key: "divinationRuleBook",
      segment: "rules",
      readOnly: true,
      authoredBy: "貞人爭",
      generatedAt: "1200 BCE (approx)",
      v: {
        title: "甲骨占卜八式",
        description: "Eight forms of plastron divination, after the lineage of 武丁",
        cases: [
          { pattern: "Y",        omen: "吉",   note: "branching crack — auspicious" },
          { pattern: "X",        omen: "凶",   note: "bisecting crack — ominous" },
          { pattern: "double-Y", omen: "大吉", note: "double bifurcation — great fortune" },
          { pattern: "I",        omen: "未明", note: "single line — indeterminate" },
          { pattern: "indistinct", omen: "未明", note: "no clear pattern" },
        ],
      },
    },
  },
};
