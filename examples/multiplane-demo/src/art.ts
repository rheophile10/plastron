// ============================================================================
// Procedural layer art — 4 layers × 4 day-cycle palettes.
//
// The HN demo ships without external asset downloads (single-file index.html
// has to be self-contained), so each layer is painted into an offscreen
// HTMLCanvasElement at boot and on lighting change. The canvases are passed
// directly to plastron-multiplane as `Drawing.lineArt` (drawImage accepts
// HTMLCanvasElement, so no createImageBitmap round-trip is needed).
//
// Layers (back to front, z descending):
//
//   sky        z=80  gradient backdrop + sun/moon disc
//   mountains  z=40  three peak ranges with atmospheric haze
//   hills      z=15  rolling sine-wave hills (mid foreground)
//   branches   z=2   silhouette branches in from the bottom corners
//
// Stylized. Not Disney-grade. The demo is about the cel graph + parallax
// math, not the artwork — anyone can swap in painted PNGs as Drawing.lineArt
// without changing a line of plastron code.
// ============================================================================

export type PaletteKey = "dawn" | "noon" | "evening" | "night";

export interface Palette {
  skyTop:      string;
  skyBottom:   string;
  sun:         string;
  sunGlow:     string;
  mountainFar: string;
  mountainMid: string;
  mountainNear:string;
  hillBack:    string;
  hillFront:   string;
  branch:      string;
  leaf:        string;
}

export const PALETTES: Record<PaletteKey, Palette> = {
  dawn: {
    skyTop:       "#ffd9b3",
    skyBottom:    "#ff9580",
    sun:          "#fff5d4",
    sunGlow:      "rgba(255, 220, 140, 0.4)",
    mountainFar:  "#a8b0c8",
    mountainMid:  "#8088a0",
    mountainNear: "#5a6080",
    hillBack:     "#6a8868",
    hillFront:    "#3e5a3c",
    branch:       "#1f1f2e",
    leaf:         "#2a3a30",
  },
  noon: {
    skyTop:       "#67aee0",
    skyBottom:    "#b8d4e6",
    sun:          "#fffacd",
    sunGlow:      "rgba(255, 250, 200, 0.3)",
    mountainFar:  "#9aaec6",
    mountainMid:  "#6a87a4",
    mountainNear: "#48637e",
    hillBack:     "#7aa872",
    hillFront:    "#406040",
    branch:       "#1a1a28",
    leaf:         "#1f3525",
  },
  evening: {
    skyTop:       "#ff6b35",
    skyBottom:    "#5c1a36",
    sun:          "#ffaa66",
    sunGlow:      "rgba(255, 100, 50, 0.4)",
    mountainFar:  "#6a4870",
    mountainMid:  "#4a3050",
    mountainNear: "#2c1c38",
    hillBack:     "#3a4a3a",
    hillFront:    "#1f2a22",
    branch:       "#0c0a16",
    leaf:         "#181820",
  },
  night: {
    skyTop:       "#080d2e",
    skyBottom:    "#161b3f",
    sun:          "#e8e8f0",
    sunGlow:      "rgba(180, 200, 240, 0.18)",
    mountainFar:  "#252d4e",
    mountainMid:  "#1a223e",
    mountainNear: "#0e1428",
    hillBack:     "#1c2e22",
    hillFront:    "#0e1a13",
    branch:       "#040410",
    leaf:         "#0a1a13",
  },
};

const makeCanvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

export const paintSky = (w: number, h: number, pal: Palette): HTMLCanvasElement => {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d")!;

  // Vertical gradient.
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, pal.skyTop);
  g.addColorStop(1, pal.skyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Sun/moon disc — placed up-right, with a radial glow.
  const sunX = w * 0.72;
  const sunY = h * 0.28;
  const sunR = Math.min(w, h) * 0.06;

  const glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.8, sunX, sunY, sunR * 4);
  glow.addColorStop(0, pal.sunGlow);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(sunX - sunR * 4, sunY - sunR * 4, sunR * 8, sunR * 8);

  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
  ctx.fillStyle = pal.sun;
  ctx.fill();

  return c;
};

const drawPeaks = (
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  baseY: number, peakHeight: number, peakCount: number,
  seed: number,
  color: string,
): void => {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, baseY);
  for (let i = 0; i <= peakCount; i++) {
    const x = (w * i) / peakCount;
    const phase = i * 1.7 + seed;
    const y = baseY - peakHeight * (0.6 + 0.4 * Math.abs(Math.sin(phase)));
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
};

export const paintMountains = (w: number, h: number, pal: Palette): HTMLCanvasElement => {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d")!;
  // Three ranges, back to front. Each is darker and lower-peaked.
  drawPeaks(ctx, w, h, h * 0.55, h * 0.30, 7,  0.4, pal.mountainFar);
  drawPeaks(ctx, w, h, h * 0.68, h * 0.22, 9,  1.7, pal.mountainMid);
  drawPeaks(ctx, w, h, h * 0.80, h * 0.16, 11, 3.1, pal.mountainNear);
  return c;
};

const drawHillBand = (
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  baseY: number, amplitude: number, period: number, phase: number,
  color: string,
): void => {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, baseY);
  for (let x = 0; x <= w; x += 4) {
    const y = baseY - amplitude * Math.sin(x / period + phase);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
};

export const paintHills = (w: number, h: number, pal: Palette): HTMLCanvasElement => {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d")!;
  // Two bands of rolling hills.
  drawHillBand(ctx, w, h, h * 0.78, h * 0.06, 110, 0.5, pal.hillBack);
  drawHillBand(ctx, w, h, h * 0.88, h * 0.05,  90, 2.1, pal.hillFront);
  return c;
};

const drawBranch = (
  ctx: CanvasRenderingContext2D,
  startX: number, startY: number,
  angle: number, length: number, thickness: number,
  depth: number,
  color: string,
): void => {
  if (depth <= 0 || length < 4) return;
  const endX = startX + Math.cos(angle) * length;
  const endY = startY + Math.sin(angle) * length;
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  // Branch out: two children at narrower angles, ~70% length.
  drawBranch(ctx, endX, endY, angle - 0.45, length * 0.7, thickness * 0.7, depth - 1, color);
  drawBranch(ctx, endX, endY, angle + 0.55, length * 0.65, thickness * 0.7, depth - 1, color);
  // Leafy dot at the tip when small enough.
  if (depth <= 1) {
    ctx.beginPath();
    ctx.arc(endX, endY, thickness * 1.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
};

export const paintBranches = (w: number, h: number, pal: Palette): HTMLCanvasElement => {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d")!;

  // Left-side trunk reaches up + right.
  drawBranch(ctx, w * 0.05, h * 1.05, -Math.PI / 2.3, h * 0.45, 14, 5, pal.branch);
  // Right-side trunk reaches up + left.
  drawBranch(ctx, w * 0.95, h * 1.05, -Math.PI / 1.85, h * 0.40, 12, 5, pal.branch);

  // Leaf-color overlay — paint small darker dots on top to suggest foliage.
  // Reuse the branch geometry by re-walking with the leaf color and depth-1.
  drawBranch(ctx, w * 0.05, h * 1.05, -Math.PI / 2.3, h * 0.45, 6,  4, pal.leaf);
  drawBranch(ctx, w * 0.95, h * 1.05, -Math.PI / 1.85, h * 0.40, 5,  4, pal.leaf);

  return c;
};

export interface LayerCanvases {
  sky:       HTMLCanvasElement;
  mountains: HTMLCanvasElement;
  hills:     HTMLCanvasElement;
  branches:  HTMLCanvasElement;
}

/** Paint all four offscreen canvases for a given palette. Cheap enough
 *  to run on every palette switch (~few ms total for 1200×750 layers). */
export const buildLayers = (w: number, h: number, pal: Palette): LayerCanvases => ({
  sky:       paintSky      (w, h, pal),
  mountains: paintMountains(w, h, pal),
  hills:     paintHills    (w, h, pal),
  branches:  paintBranches (w, h, pal),
});
