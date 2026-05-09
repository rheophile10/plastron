import type { Segment } from "../../../plastron/src/index.js";
import { VNODE_SCHEMA_KEY } from "../../../segments/plastron-dom/src/index.js";
import { CRACK_SCHEMA_KEY } from "./schemas.js";

// ============================================================================
// 卷 (segments) of the rite.
//
// • rules — the augur's decoded rule book, shipped as a lambda whose
//   source JSON the augur kind handler will compile. Lives in its own
//   segment so it can be replaced (e.g. a different temple's book)
//   without disturbing the session.
// • session — heat, thickness, and charge cels; the formula-driven
//   ratio; the augur's omen; and the vnode tree summary. This is what
//   gets burned (焚) when the divination is over.
// ============================================================================

export const rulesSegment: Segment = {
  key: "rules",
  cels: [],
  fnMetaData: {
    augur: {
      key: "augur",
      kind: "augur",
      source: JSON.stringify({
        X: "凶 — calamity, hold the spear",
        Y: "吉 — auspicious, ride at dawn",
      }),
    },
  },
};

export const sessionSegment: Segment = {
  key: "session",
  cels: [
    { key: "heat",      v: 6, segment: "session" },
    { key: "thickness", v: 2, segment: "session" },
    { key: "charge",    v: "shall the king campaign against the Qiāng?", segment: "session" },
    { key: "ratio",     segment: "session", f: "(/ heat thickness)" },
    {
      key: "crack",
      segment: "session",
      l: "buildCrack",
      inputMap: { ratio: "ratio" },
      schema: CRACK_SCHEMA_KEY,
    },
    {
      key: "omen",
      segment: "session",
      l: "augur",
      inputMap: { crack: "crack" },
    },
    {
      key: "appTree",
      segment: "session",
      l: "buildTree",
      inputMap: {
        heat:      "heat",
        thickness: "thickness",
        charge:    "charge",
        crack:     "crack",
        omen:      "omen",
      },
      schema: VNODE_SCHEMA_KEY,
    },
  ],
};
