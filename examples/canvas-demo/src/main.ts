import {
  createInitialState, precomputeOptional,
  type Fn, type Segment,
} from "../../../plastron/src/index.js";
import {
  installCanvas, installCanvasSchemas,
} from "../../../segments/plastron-canvas/src/index.js";

// ============================================================================
// plastron-canvas smoke — bouncing circle.
//
// Two cels:
//
//   t        value cel (number) — current animation time in ms.
//   scene    lambda cel — derives the circle's screen position from t.
//
// The canvas channel is bound to `scene`. installCanvas stamps it with
// `channel: "plastronCanvas"` and the kernel routes its changes onto
// the painter. On each rAF the host writes `performance.now()` to `t`,
// the cascade fires the scene lambda, the painter sees a value-change
// and runs the user's `draw` fn on the next frame.
//
// No diff/patch machinery — Canvas 2D is immediate-mode. The draw fn
// clears + redraws each call.
// ============================================================================

interface Scene {
  x: number; y: number; r: number;
  color: string;
  width: number; height: number;
}

const W = 400;
const H = 300;

const buildScene: Fn = ({ t }: { t: number }): Scene => {
  // Bouncing motion via two sine waves out of phase.
  const x = W / 2 + Math.sin(t / 700) * (W / 2 - 32);
  const y = H / 2 + Math.cos(t / 500) * (H / 2 - 32);
  return { x, y, r: 24, color: "#4c6ef5", width: W, height: H };
};

const drawScene = (ctx: CanvasRenderingContext2D, data: unknown): void => {
  const scene = data as Scene | null;
  if (!scene) return;

  // The canvas channel sized the backing store to CSS-pixel rect × DPR.
  // We draw in CSS-pixel coordinates by scaling the context once per
  // frame so the math in buildScene stays simple.
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Background.
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, scene.width, scene.height);

  // Circle.
  ctx.beginPath();
  ctx.arc(scene.x, scene.y, scene.r, 0, Math.PI * 2);
  ctx.fillStyle = scene.color;
  ctx.fill();
};

const sceneSegment: Segment = {
  key: "canvas-demo",
  cels: [
    { key: "t", v: 0, segment: "canvas-demo" },
    {
      key: "scene",
      segment: "canvas-demo",
      l: "buildScene",
      inputMap: { t: "t" },
    },
  ],
  fnMetaData: {
    buildScene: { key: "buildScene", kind: "native" },
  },
};

const main = async (): Promise<void> => {
  const state = createInitialState();

  // Register the plastron-canvas schema before hydrate so anyone declaring
  // `schema: drawingSchema` on a source cel gets auto-wired isChanged.
  // The demo doesn't actually declare that schema — the scene lambda
  // returns a fresh object each tick, so reference inequality is enough
  // — but the call is idempotent and good hygiene.
  installCanvasSchemas(state);

  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const set = state.fns.get("set") as Fn;

  await hydrate(state, [sceneSegment], [
    new Map<string, Fn>([["buildScene", buildScene]]),
  ]);
  await runCycle(state);
  await precomputeOptional(state);

  // Mount the painter. installCanvas stamps the source cel with
  // `channel: "plastronCanvas"`, registers the channel, and marks each
  // root dirty so the first `drain()` commits the initial frame.
  const handle = installCanvas(state, {
    roots: {
      main: {
        selector: "#scene",
        cel: "scene",
        draw: drawScene,
      },
    },
  });

  // Force the initial paint synchronously so there's no blank-frame flash
  // before the rAF loop kicks in.
  handle.channel.drain();

  // Drive the animation: write `performance.now()` to `t` on each rAF.
  // The cascade fires the scene lambda, the canvas channel sees the
  // value-change, schedules its own rAF flush. One paint per frame.
  const tick = (now: number): void => {
    void set(state, "t", now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Devtools handle for poking at the state in the browser console.
  (globalThis as { __plastronState?: unknown }).__plastronState = state;
  // eslint-disable-next-line no-console
  console.log("[canvas-demo] mounted");
};

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
});
