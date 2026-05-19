import type { ChannelHandler, Key } from "../../../plastron/src/index.js";

// ============================================================================
// Public types for plastron-canvas.
//
// Shape mirrors plastron-dom's surface (InstallDomOptions, DomHandle) so the
// host learns one pattern. The differences:
//
//   • No patch cel / diff machinery — Canvas 2D is immediate-mode. The
//     channel reads `cel.v` on each flush and hands it to the user's
//     `draw` fn. The draw fn does whatever drawing it wants.
//   • The user's source cel is stamped with `channel: channelKey` at
//     install time. No intermediate cel is allocated.
//   • `resize` strategy is a knob — most users want device-pixel-ratio
//     scaling so canvas pixels match CSS pixels on hi-DPI displays.
// ============================================================================

/** User-supplied draw function. Called inside rAF with the canvas's 2D
 *  context and the bound cel's current value. The draw fn is fully
 *  responsible for clearing / compositing — plastron-canvas doesn't
 *  touch the context except to hand it over. */
export type DrawFn = (
  ctx: CanvasRenderingContext2D,
  data: unknown,
) => void;

export type ResizeMode =
  /** Backing store sized to CSS-pixel rect × devicePixelRatio. Standard
   *  hi-DPI handling — the canvas observes its own bounding rect. */
  | "device-pixel-ratio"
  /** Honor the canvas's own width/height HTML attributes. No
   *  observation. Use for fixed-size demos and snapshot rendering. */
  | "fixed"
  /** Same as device-pixel-ratio but observes the canvas's parent
   *  element instead of the canvas. Use when the canvas itself has
   *  `display: contents` or otherwise lacks a layout box. */
  | "container";

export interface CanvasRoot {
  /** CSS selector for the <canvas> element. Either `selector` or
   *  `element` must be set; `element` wins if both are. */
  selector?: string;
  /** Pre-resolved <canvas> element. Wins over `selector`. Useful when
   *  the canvas is created imperatively (not via plastron-dom). */
  element?: HTMLCanvasElement;
  /** Cel key whose value drives the canvas repaints. The cel is
   *  stamped with `channel: <channelKey>` at install time so the
   *  kernel routes its changes onto this painter. */
  cel: Key;
  /** Draw fn run inside rAF whenever the cel changes. */
  draw: DrawFn;
  /** Resize strategy. Default: `"device-pixel-ratio"`. */
  resize?: ResizeMode;
}

export interface InstallCanvasOptions {
  /** Map from a stable root key (your choice) to mount target + cel +
   *  draw fn. */
  roots: Record<string, CanvasRoot>;
  /** Channel key under which to register this painter. Default
   *  `"plastronCanvas"`. Pass distinct keys when installing multiple
   *  canvas painters in the same state. */
  channelKey?: string;
}

/** Channel-handler alias for plastron-canvas. Same shape as
 *  ChannelHandler today; the alias exists so future canvas-specific
 *  additions land in one named type. */
export type CanvasChannelHandle = ChannelHandler;

export interface CanvasHandle {
  /** The painter channel. `handle.channel.drain()` forces a synchronous
   *  paint and is the canonical way to commit the initial frame. */
  channel: CanvasChannelHandle;
}
