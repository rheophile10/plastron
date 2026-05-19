import type { Fn, LambdaKey, Segment, State } from "../../../plastron/src/index.js";
import {
  el, cx, onClick, bindNumber, type VNode,
} from "../../../segments/plastron-dom/src/index.js";
import type { PaletteKey } from "./art.js";

// ============================================================================
// plastron-dom-rendered demo UI.
//
// Two tree cels:
//
//   controlTree   the side panel (play/pause, day-cycle radios, scrub
//                 slider, reset button). Re-renders on every input
//                 change.
//   devtoolsTree  a live readout of demo cel values. Re-renders every
//                 frame (driven by inputMap over frame + scrubFrame +
//                 lighting + playing).
//
// Both mount into their own DOM roots via installDom with distinct root
// keys. Same painter channel; one rAF per frame.
//
// The pitch lands here twice: the canvas is multiplane-driven by cels,
// AND the UI chrome is plastron-dom-driven by the SAME cel graph. One
// State, two paint channels (canvas + dom).
// ============================================================================

const DAY_CYCLE_ORDER: readonly PaletteKey[] = ["dawn", "noon", "evening", "night"];

// ── Control panel ──────────────────────────────────────────────────────────

interface ControlInputs {
  lighting: PaletteKey;
  playing: boolean;
  scrubFrame: number | null;
  frame: number;
}

const SCRUB_MAX = 30_000; // ms — slider window width

const renderControls: Fn = (inputs: ControlInputs): VNode => {
  const { lighting, playing, scrubFrame, frame } = inputs;
  const sliderValue = scrubFrame !== null ? scrubFrame : frame % SCRUB_MAX;

  const lightingButtons = DAY_CYCLE_ORDER.map((k) =>
    el("button", {
      class: cx(lighting === k && "active"),
      onClick: onClick("demo:setLighting", k),
    }, label(k)),
  );

  return el("div", null,
    el("div", { class: "row" },
      el("h2", null, "Playback"),
      el("button", {
        onClick: onClick("demo:togglePlaying"),
      }, playing ? "⏸ Pause auto-pan" : "▶ Play auto-pan"),
    ),

    el("div", { class: "row" },
      el("h2", null, "Day cycle"),
      el("div", { class: "palette-grid" }, ...lightingButtons),
    ),

    el("div", { class: "row" },
      el("h2", null, "Scrub frame"),
      el("input", {
        type: "range",
        min: "0",
        max: String(SCRUB_MAX),
        step: "16",
        value: String(sliderValue),
        onInput: bindNumber("scrubFrame"),
      }),
      el("button", {
        onClick: onClick("demo:resetScrub"),
      }, "↻ Release scrub"),
    ),
  );
};

// ── Devtools panel ─────────────────────────────────────────────────────────

interface DevtoolsInputs {
  frame: number;
  scrubFrame: number | null;
  lighting: PaletteKey;
  playing: boolean;
  effectiveFrame: number;
}

const renderDevtools: Fn = (inputs: DevtoolsInputs): VNode => {
  const { frame, scrubFrame, lighting, playing, effectiveFrame } = inputs;
  const row = (k: string, v: string): VNode =>
    el("div", { class: "row" },
      el("span", { class: "k" }, k),
      el("span", { class: "v" }, v),
    );
  return el("div", null,
    el("h2", null, "Live cel graph"),
    row("frame",          String(frame)),
    row("scrubFrame",     scrubFrame === null ? "null" : String(scrubFrame)),
    row("effectiveFrame", String(effectiveFrame)),
    row("playing",        playing ? "true" : "false"),
    row("lighting",       lighting),
  );
};

// ── Segment + fn map ────────────────────────────────────────────────────────

export const UI_SEGMENT = "multiplane-demo:ui" as const;

export const uiSegment: Segment = {
  key: UI_SEGMENT,
  cels: [
    {
      key: "controlTree",
      segment: UI_SEGMENT,
      l: "renderControls",
      inputMap: {
        lighting: "lighting",
        playing: "playing",
        scrubFrame: "scrubFrame",
        frame: "frame",
      },
    },
    {
      key: "devtoolsTree",
      segment: UI_SEGMENT,
      l: "renderDevtools",
      inputMap: {
        frame: "frame",
        scrubFrame: "scrubFrame",
        lighting: "lighting",
        playing: "playing",
        effectiveFrame: "effectiveFrame",
      },
    },
  ],
  fnMetaData: {
    renderControls: { key: "renderControls", kind: "native" },
    renderDevtools: { key: "renderDevtools", kind: "native" },
  },
};

export const uiFns: Map<LambdaKey, Fn> = new Map<LambdaKey, Fn>([
  ["renderControls", renderControls],
  ["renderDevtools", renderDevtools],
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

const LABELS: Record<PaletteKey, string> = {
  dawn:    "🌅 Dawn",
  noon:    "☀️ Noon",
  evening: "🌇 Evening",
  night:   "🌙 Night",
};

function label(k: PaletteKey): string {
  return LABELS[k];
}

// Suppress no-unused-vars for `state` typings — used in future
// dispatch lambdas registered by callers.
export type { State };
