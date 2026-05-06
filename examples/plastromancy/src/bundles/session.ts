import type { SegmentBundle } from "../../../../plastron/src/index.js";
import { tagged } from "../../../../plastron/src/index.js";
import type { CrackValue } from "../tags/crack.js";
import { sessionChiselMeta } from "../lambdas/chisels.js";

// ========================================================================
// session — the writeable divination session. Charges, heat, thickness,
// the heat-induced crack, the augur's reading, and the inscription.
//
// Demonstrates:
//   • formula DSL — preface and inscription
//   • native chisel — carveCrack
//   • custom kind (augur) — readOmen
//   • imports — the augur lambda imports divinationRuleBook (load order)
//   • tagged values — crackGeometry returns tagged("crack", {...})
//   • provenance — charge / cyclicalDate carry authoredBy + generatedAt
// ========================================================================

const augurRuleSource = JSON.stringify({
  cases: [
    { pattern: "Y",        omen: "吉",   note: "branching — auspicious" },
    { pattern: "X",        omen: "凶",   note: "bisecting — ominous" },
    { pattern: "double-Y", omen: "大吉", note: "double bifurcation — great fortune" },
    { pattern: "I",        omen: "未明", note: "single line — indeterminate" },
    { pattern: "indistinct", omen: "未明", note: "no clear pattern" },
  ],
  default: { omen: "未明", note: "the bone is silent" },
});

export const sessionBundle: SegmentBundle = {
  version: 1,
  key: "session",
  metadata: {
    role: "code",
    description: "The active divination session — writeable charges, heat, crack, omen.",
    dependsOnSegments: ["rules"],
  },
  cels: {
    cyclicalDate: {
      key: "cyclicalDate", segment: "session",
      v: "癸卯 (guǐ mǎo — 40th day)",
      authoredBy: "貞人爭", generatedAt: "1200 BCE (approx)",
    },
    diviner: {
      key: "diviner", segment: "session",
      v: "貞人爭 (Diviner Zhēng)",
    },
    king: {
      key: "king", segment: "session",
      v: "武丁 (Wǔ Dīng)", readOnly: true,
    },
    charge: {
      key: "charge", segment: "session",
      v: "今日雨？ (Will it rain today?)",
      authoredBy: "武丁", generatedAt: "1200 BCE",
    },
    heat:      { key: "heat",      segment: "session", v: 6 },
    thickness: { key: "thickness", segment: "session", v: 2 },

    // Native chisel — heat + thickness → tagged("crack", {…})
    crackGeometry: {
      key: "crackGeometry", segment: "session",
      l: "carveCrack",
      inputMap: { heat: "heat", thickness: "thickness" },
    },

    // Augur kind — reads the rule book from lambda metadata source.
    // Imports the rule-book cel so its module loads before this lambda.
    omen: {
      key: "omen", segment: "session",
      l: "readOmen",
      kind: "augur",
      inputMap: { crack: "crackGeometry" },
      imports: ["divinationRuleBook"],
    },

    // Formula DSL — auto-extracts deps via `@` references.
    preface: {
      key: "preface", segment: "session",
      f: "@cyclicalDate |> concat(': ') |> concat(@diviner) |> concat(' 貞, ')",
    },

    // Native chisel renders a one-line omen summary.
    omenReport: {
      key: "omenReport", segment: "session",
      l: "renderOmen",
      inputMap: { omen: "omen", crack: "crackGeometry" },
    },

    inscription: {
      key: "inscription", segment: "session",
      f: "@preface |> concat('王 ') |> concat(@king) |> concat(' 問：') |> concat(@charge) |> concat('  →  ') |> concat(@omenReport)",
    },

    sessionLabel: {
      key: "sessionLabel", segment: "session",
      v: "Session opens",
    },
    sessionReport: {
      key: "sessionReport", segment: "session",
      l: "renderSession",
      inputMap: { label: "sessionLabel", inscription: "inscription" },
    },

    // A pre-seeded crack value, demonstrating that a cel may carry a
    // tagged value directly. The carveCrack lambda overwrites it on
    // first compute; the comparator keeps spurious cascades suppressed
    // when patterns happen to match.
    seedCrack: {
      key: "seedCrack", segment: "session",
      v: tagged<CrackValue>("crack", {
        pattern: "indistinct",
        intensity: 0,
        notes: ["initial state, unfired"],
      }),
    },
  },
  lambdas: {
    readOmen: {
      key: "readOmen",
      kind: "augur",
      description: "Augur lambda — matches the crack pattern against the rule book.",
      source: augurRuleSource,
    },
    ...sessionChiselMeta,
  },
};
