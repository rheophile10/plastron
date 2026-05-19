import {
  createInitialState, precomputeOptional,
  type Fn,
} from "../../../plastron/src/index.js";
import {
  installCanvas, installCanvasSchemas,
} from "../../../segments/plastron-canvas/src/index.js";
import {
  installMultiplane, renderMultiplane,
} from "../../../segments/plastron-multiplane/src/index.js";
import {
  installDom, installDomSchemas,
} from "../../../segments/plastron-dom/src/index.js";
import { demoFns, demoSegment } from "./cels.js";
import { uiFns, uiSegment } from "./ui.js";

// ============================================================================
// Multiplane demo boot.
//
// One State; four segments composed:
//
//   • multiplane-demo  — value + lambda cels (frame, lighting, scene, …)
//   • plastron-canvas  — channel that paints `scene` into <canvas#scene>
//   • plastron-multiplane — schemas + renderMultiplane (the draw fn)
//   • multiplane-demo:ui  — controlTree + devtoolsTree
//   • plastron-dom     — channel that paints both tree cels into the
//                        side panel + devtools div
//
// Two channels (`plastronCanvas` and `plastronDom`) on one State. Each
// has its own rAF scheduler. The animation loop just writes
// performance.now() to `frame` while `playing` is true.
// ============================================================================

const main = async (): Promise<void> => {
  const state = createInitialState();

  // Register schemas BEFORE hydrate so auto-wire materializes _isChanged
  // on cels declaring them. The demo doesn't actually declare any
  // multiplane schemas (scene rebuilds via reference inequality), but
  // installMultiplane also registers the renderMultiplane lambda for
  // introspection; calling early is cheap and idempotent.
  installCanvasSchemas(state);
  installMultiplane(state);
  installDomSchemas(state);

  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const set = state.fns.get("set") as Fn;

  // Hydrate the demo's value/lambda cels + the UI's tree cels + all
  // associated fns in one call.
  await hydrate(
    state,
    [demoSegment, uiSegment],
    [demoFns, uiFns],
  );

  // First cycle fires every lambda once — scene, controlTree,
  // devtoolsTree all materialize their initial values.
  await runCycle(state);

  // Gate the codegen fast path. Cheap; reduces per-fire work for the
  // remaining session.
  await precomputeOptional(state);

  // Mount the canvas painter: scene → <canvas#scene>, using
  // renderMultiplane as the draw fn. installCanvas stamps the scene
  // cel with channel: "plastronCanvas" and marks the root dirty so
  // the first drain() commits the initial frame.
  const canvasHandle = installCanvas(state, {
    roots: {
      main: {
        selector: "#scene",
        cel: "scene",
        draw: renderMultiplane,
      },
    },
  });

  // Mount the DOM painter for the side panel + devtools div. Two roots
  // share one painter channel; the channel's enqueue routes by patch
  // cel key (installDom builds one per root).
  const domHandle = installDom(state, {
    roots: {
      controls: { selector: "#controls", cel: "controlTree" },
      devtools: { selector: "#devtools", cel: "devtoolsTree" },
    },
  });

  // Second cycle so the dom channel sees the patch cels (created by
  // installDom) compute their first patches against `null` lastApplied,
  // and so any dynamic cels fire.
  await runCycle(state);

  // Force initial paints synchronously so the first visible frame
  // doesn't flash empty.
  canvasHandle.channel.drain();
  domHandle.channel.drain();

  // ── Animation loop ─────────────────────────────────────────────────
  //
  // While `playing` is true, write performance.now() to `frame`. The
  // cascade fires camera → scene; canvas channel paints. Pausing flips
  // the cel; the loop continues but skips the write.
  //
  // Setting `scrubFrame` to a non-null value via the UI's range input
  // overrides `frame` in `effectiveFrame`, freezing the camera even
  // while the loop continues to tick `frame`. Releasing the scrub
  // (resetScrub) sets scrubFrame back to null and resumes auto-pan.
  let lastFrame = performance.now();
  const tick = (now: number): void => {
    const playing = !!state.cels.get("playing")?.v;
    if (playing) {
      // Use real elapsed time (instead of `now`) so pausing doesn't
      // skip the camera ahead by the pause duration.
      const elapsed = now - lastFrame;
      const cur = (state.cels.get("frame")?.v as number | undefined) ?? 0;
      void set(state, "frame", cur + elapsed);
    }
    lastFrame = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Devtools handle for the browser console.
  (globalThis as { __plastronState?: unknown }).__plastronState = state;
  // eslint-disable-next-line no-console
  console.log("[multiplane-demo] mounted");
};

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
});
