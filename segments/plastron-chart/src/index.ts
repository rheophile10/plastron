import { el, when, type VNode } from "../../plastron-dom/src/index.js";

// ========================================================================
// segment: plastron-chart
//
// A pure-VNode bar chart rendered as positioned HTML divs. No canvas,
// no SVG (the plastron-dom painter uses `createElement`, not
// `createElementNS`, so SVG would lose its namespace), no charting lib
// — just an `el(...)` tree the painter can apply.
//
// `barChart(opts)` returns a single VNode. Pass it as the value of a
// tree cel (or compose it inside a larger render lambda) and it
// participates in plastron-dom's diff/patch cycle like any other
// element.
//
// Per-bar color overrides come through `opts.highlight` — a map from
// label to fill color (case-insensitive). That's how the host
// highlights "Canada" in red without the chart needing to know what
// Canada is.
// ========================================================================

export interface BarDatum {
  label: string;
  value: number;
}

export interface BarChartOptions {
  data: BarDatum[];
  /** Outer width / height in pixels. Defaults: 720 × 360. */
  width?: number;
  height?: number;
  /** Chart title text rendered above the plot area. */
  title?: string;
  /** Y-axis label rendered rotated on the left. */
  yLabel?: string;
  /** Default bar fill color. */
  barColor?: string;
  /** Per-label fill override. Keys are matched case-insensitively
   *  against datum labels; first match wins. */
  highlight?: Record<string, string>;
  /** When true, the value is rendered above each bar. */
  showValues?: boolean;
}

interface Layout {
  W: number; H: number;
  padL: number; padR: number; padT: number; padB: number;
  innerW: number; innerH: number;
  niceMax: number;
  ticks: number[];
}

const DEFAULT_W = 720;
const DEFAULT_H = 360;
const DEFAULT_BAR = "#4c6ef5";
const PAD_L = 64;
const PAD_R = 16;
const PAD_T = 36;
const PAD_B = 96;

const layout = (opts: BarChartOptions): Layout => {
  const W = opts.width ?? DEFAULT_W;
  const H = opts.height ?? DEFAULT_H;
  const max = opts.data.reduce((m, d) => d.value > m ? d.value : m, 0);
  const niceMax = niceCeil(max);
  return {
    W, H,
    padL: PAD_L, padR: PAD_R, padT: PAD_T, padB: PAD_B,
    innerW: W - PAD_L - PAD_R,
    innerH: H - PAD_T - PAD_B,
    niceMax,
    ticks: ticksFor(niceMax, 5),
  };
};

/** Round up to a "nice" axis maximum: 1·10^k, 2·10^k, 5·10^k. */
const niceCeil = (n: number): number => {
  if (!isFinite(n) || n <= 0) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const norm = n / base;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * base;
};

const ticksFor = (niceMax: number, count: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push((niceMax / count) * i);
  return out;
};

/** Compact tick formatter: 1.2k / 3.4M / 56B. */
const formatTick = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e9) return strip(n / 1e9) + "B";
  if (a >= 1e6) return strip(n / 1e6) + "M";
  if (a >= 1e3) return strip(n / 1e3) + "k";
  return strip(n);
};

const strip = (n: number): string => {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/** Resolve a per-bar color from the highlight map (case-insensitive). */
const colorFor = (
  label: string,
  defaultColor: string,
  highlight: Record<string, string> | undefined,
): string => {
  if (!highlight) return defaultColor;
  const lower = label.toLowerCase();
  for (const [k, v] of Object.entries(highlight)) {
    if (k.toLowerCase() === lower) return v;
  }
  return defaultColor;
};

const px = (n: number): string => `${n}px`;

export const barChart = (opts: BarChartOptions): VNode => {
  const lay = layout(opts);
  const barColor = opts.barColor ?? DEFAULT_BAR;
  const denom = lay.niceMax === 0 ? 1 : lay.niceMax;

  const n = opts.data.length;
  const slot = n === 0 ? lay.innerW : lay.innerW / n;
  const barW = Math.max(1, slot * 0.72);

  // ---- gridlines + y-axis tick labels --------------------------------
  const gridChildren: VNode[] = [];
  for (const t of lay.ticks) {
    const y = lay.padT + lay.innerH - (t / denom) * lay.innerH;
    gridChildren.push(el("div", {
      class: "pc-grid",
      style: {
        position: "absolute",
        left: px(lay.padL),
        top: px(y),
        width: px(lay.innerW),
        height: "1px",
        background: "#e5e7eb",
      },
    }));
    gridChildren.push(el("div", {
      class: "pc-tick",
      style: {
        position: "absolute",
        left: "0",
        top: px(y - 8),
        width: px(lay.padL - 8),
        "text-align": "right",
        "font-size": "11px",
        color: "#475569",
        "font-family": "system-ui, sans-serif",
      },
    }, formatTick(t)));
  }

  // ---- bars + x-axis labels ------------------------------------------
  const barChildren: VNode[] = opts.data.map((d, i) => {
    const cx = lay.padL + i * slot + slot / 2;
    const x = cx - barW / 2;
    const h = (d.value / denom) * lay.innerH;
    const y = lay.padT + lay.innerH - h;
    const fill = colorFor(d.label, barColor, opts.highlight);

    const bar = el("div", {
      class: "pc-bar",
      title: `${d.label}: ${d.value.toLocaleString()}`,
      style: {
        position: "absolute",
        left: px(x),
        top: px(y),
        width: px(barW),
        height: px(Math.max(0, h)),
        background: fill,
      },
    });

    // Diagonally rotated x-axis label, anchored to the bottom-right
    // corner of its slot so long labels rotate down-and-to-the-left
    // without overflowing into the next bar.
    const labelW = 110;
    const label = el("div", {
      class: "pc-xlabel",
      style: {
        position: "absolute",
        left: px(cx - labelW),
        top: px(lay.padT + lay.innerH + 6),
        width: px(labelW),
        "text-align": "right",
        "font-size": "11px",
        color: "#1f2937",
        "font-family": "system-ui, sans-serif",
        "white-space": "nowrap",
        "transform-origin": "100% 0%",
        transform: "rotate(-55deg)",
      },
    }, d.label);

    return el("div", null,
      bar,
      label,
      when(opts.showValues, () => el("div", {
        class: "pc-value",
        style: {
          position: "absolute",
          left: px(cx - 30),
          top: px(y - 16),
          width: "60px",
          "text-align": "center",
          "font-size": "10px",
          color: "#1f2937",
          "font-family": "system-ui, sans-serif",
        },
      }, formatTick(d.value))),
    );
  });

  // ---- axes (left + bottom) ------------------------------------------
  const axes: VNode[] = [
    el("div", {
      class: "pc-axis-x",
      style: {
        position: "absolute",
        left: px(lay.padL),
        top: px(lay.padT + lay.innerH),
        width: px(lay.innerW),
        height: "1px",
        background: "#94a3b8",
      },
    }),
    el("div", {
      class: "pc-axis-y",
      style: {
        position: "absolute",
        left: px(lay.padL),
        top: px(lay.padT),
        width: "1px",
        height: px(lay.innerH),
        background: "#94a3b8",
      },
    }),
  ];

  // ---- decorations (title + y-axis label) ----------------------------
  const titleNode = when(opts.title, () => el("div", {
    class: "pc-title",
    style: {
      position: "absolute",
      left: "0",
      top: "8px",
      width: px(lay.W),
      "text-align": "center",
      "font-size": "14px",
      "font-weight": "600",
      color: "#0f172a",
      "font-family": "system-ui, sans-serif",
    },
  }, opts.title!));

  const yLabelNode = when(opts.yLabel, () => el("div", {
    class: "pc-ylabel",
    style: {
      position: "absolute",
      left: px(0),
      top: px(lay.padT + lay.innerH / 2),
      width: "1px",
      height: "1px",
      "font-size": "12px",
      color: "#475569",
      "font-family": "system-ui, sans-serif",
      "white-space": "nowrap",
      transform: "rotate(-90deg) translate(-50%, -50%)",
      "transform-origin": "0 0",
    },
  }, opts.yLabel!));

  return el("div", {
    class: "pc-chart",
    style: {
      position: "relative",
      width: px(lay.W),
      height: px(lay.H),
      "box-sizing": "border-box",
    },
  },
    titleNode,
    yLabelNode,
    ...gridChildren,
    ...axes,
    ...barChildren,
  );
};

export type { VNode };
