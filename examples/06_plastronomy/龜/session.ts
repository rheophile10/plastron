// ============================================================================
// 龜/session — the divination-session plastron.
//
// Cels:
//   cyclicalDate     (變)  — the sexagenary date
//   diviner          (變)  — the diviner's name
//   king             (固)  — the king (read-only)
//   charge           (變)  — the king's question
//   heat             (變)  — how hot the brand pressed
//   thickness        (變)  — the plastron's thickness at the crack
//   preface          (刻)  — formula: date : diviner 貞,
//   geometry         (刻)  — lambda: reads crack geometry from heat + thickness
//   omen             (刻)  — formula: full inscription
//   prognostication  (刻)  — lambda: reads auspicious/inauspicious from geometry
// ============================================================================

import type { DehydratedCel } from "../../../plastron/src/state/index.js";

export const sessionCels: Record<string, DehydratedCel> = {
  cyclicalDate: { segment: "session", v: "癸卯 (guǐ mǎo — 40th day)" },
  diviner:      { segment: "session", v: "貞人爭 (Diviner Zhēng)" },
  king:         { segment: "session", v: "武丁 (Wǔ Dīng)", readOnly: true },
  charge:       { segment: "session", v: "今日雨？ (Will it rain today?)" },

  heat:      { segment: "session", v: 6 },
  thickness: { segment: "session", v: 2 },

  preface: {
    segment: "session",
    f: "@cyclicalDate |> concat(': ') |> concat(@diviner) |> concat(' 貞, ')",
  },

  geometry: {
    segment: "session",
    l: "crackGeometry",
    inputMap: { heat: "heat", thickness: "thickness" },
  },

  omen: {
    segment: "session",
    f: "@preface |> concat('王 ') |> concat(@king) |> concat(' 問：') |> concat(@charge)",
  },

  prognostication: {
    segment: "session",
    l: "readOmen",
    inputMap: { geometry: "geometry", charge: "charge" },
  },

  // The 展示 display scroll: gathers the four derived cels into one
  // multi-line string. The orchestrator 察's sessionReport, not this.
  omenReport: {
    segment: "session",
    l: "omenReport",
    inputMap: {
      preface: "preface",
      omen: "omen",
      geometry: "geometry",
      prognostication: "prognostication",
    },
  },

  // A writeable label the orchestrator 刻s before each display.
  reportLabel: {
    segment: "session",
    v: "Session opens",
  },

  // The full printable block: heading "— label —" on top of the omen
  // scroll. Re-fires every time reportLabel changes, so the orchestrator
  // writes the label and reads this cel.
  sessionReport: {
    segment: "session",
    l: "sessionReport",
    inputMap: { label: "reportLabel", body: "omenReport" },
  },
};
