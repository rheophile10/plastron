import type { Cel, Fn, SegmentManifest, State } from "../../../plastron/src/index.js";
import {
  DRAWING_SCHEMA_KEY, DRAWING_IS_CHANGED_KEY,
  drawingSchema, drawingIsChanged,
} from "./schemas.js";
import { createCanvasChannel, enqueueAllRoots } from "./paint.js";
import type {
  CanvasRoot, CanvasHandle, CanvasChannelHandle,
  InstallCanvasOptions, DrawFn, ResizeMode,
} from "./types.js";

// ============================================================================
// segment: plastron-canvas
//
// Pipeline (per root):
//
//   <user source cel> ──channel=<channelKey>──► canvas channel (rAF)
//
//   The user's cel is stamped with `channel: channelKey` at install time
//   so the kernel routes its value-changes onto the painter channel.
//   The channel reads `cel.v` on each rAF and hands it to the user's
//   `draw(ctx, value)` callback.
//
// No diff/patch machinery — Canvas 2D is immediate-mode and the draw fn
// owns clear+redraw. This makes the segment substantially simpler than
// plastron-dom: no patch cels, no per-root lambda registration, no
// lastApplied closure.
//
// The user's cel is the ONLY thing routed to the channel. Cels declaring
// `schema: drawingSchema` get auto-wired `_isChanged` via the kernel's
// hydrate-time machinery (call installCanvasSchemas BEFORE hydrate so
// the schema is registered when auto-wire runs). Cels without the
// schema fall back to reference equality.
//
// Teardown is `flush(PLASTRON_CANVAS_SEGMENT)`: the painter sentinel cel
// carries a `_dispose` closure that disposes the channel (cancels rAF,
// disconnects ResizeObservers) and removes it from state.channelRegistry.
// ============================================================================

export const PLASTRON_CANVAS_SEGMENT = "plastronCanvas" as const;
export const DEFAULT_CANVAS_CHANNEL_KEY = "plastronCanvas" as const;

/** Manifest for the plastron-canvas segment. Declares the schema and
 *  isChanged lambda it registers, plus its sentinel-cel segment. The
 *  `channels` entry is per-install (set in installCanvas) since the
 *  caller can override `channelKey`. */
export const plastronCanvasManifest: SegmentManifest = {
  segment: PLASTRON_CANVAS_SEGMENT,
  version: "0.0.1",
  description:
    "rAF-batched Canvas 2D painter — bind a cel to a <canvas>, repaint via a user-supplied draw fn.",
  provides: {
    schemas: [DRAWING_SCHEMA_KEY],
    lambdas: [DRAWING_IS_CHANGED_KEY],
    celSegments: [PLASTRON_CANVAS_SEGMENT],
  },
};

export type { CanvasRoot, CanvasHandle, CanvasChannelHandle, InstallCanvasOptions, DrawFn, ResizeMode };
export {
  DRAWING_SCHEMA_KEY, DRAWING_IS_CHANGED_KEY, drawingSchema, drawingIsChanged,
} from "./schemas.js";
export { createCanvasChannel } from "./paint.js";

const painterCelKey = (channelKey: string): string =>
  `__plastronCanvas:painter:${channelKey}`;

/** Register plastron-canvas's schema + isChanged lambda WITHOUT mounting
 *  a channel. Idempotent — safe to call before `hydrate` so a user
 *  segment's cel that declares `schema: drawingSchema` gets auto-wired
 *  with `_isChanged` at hydrate time.
 *
 *  Typical use:
 *
 *    installCanvasSchemas(state);
 *    await hydrate(state, [userSegment], [userFns]);   // auto-wire here
 *    installCanvas(state, { roots: { … } });           // mount channel later
 *
 *  installCanvas calls this internally, so a caller that doesn't need
 *  pre-hydrate registration can skip the explicit call. */
export const installCanvasSchemas = (state: State): void => {
  if (state.schemas.has(DRAWING_SCHEMA_KEY)) return;
  state.schemas.set(DRAWING_SCHEMA_KEY, drawingSchema);
  state.schemaMetadata.set(DRAWING_SCHEMA_KEY, {
    key: DRAWING_SCHEMA_KEY,
    isChanged: DRAWING_IS_CHANGED_KEY,
  });
  state.fns.set(DRAWING_IS_CHANGED_KEY, drawingIsChanged as unknown as Fn);
};

/** Install the plastron-canvas segment on an existing State. Source
 *  cels must already be hydrated. installCanvas:
 *
 *    1. Registers the drawing schema + isChanged lambda (idempotent).
 *    2. Stamps each root's source cel with `channel: <channelKey>` so
 *       the kernel routes changes onto the painter channel.
 *    3. Creates the canvas channel (rAF coalescer + per-root resize
 *       observer) and registers it under `options.channelKey`.
 *    4. Enqueues each root once so the first `handle.channel.drain()`
 *       commits an initial paint.
 *    5. Installs a sentinel cel whose `_dispose` tears down the channel
 *       on `flush(state, PLASTRON_CANVAS_SEGMENT)`.
 *
 *  Multi-install: passing distinct `channelKey`s installs multiple
 *  independent painters on the same state. The manifest's `channels` set
 *  merges across installs, so introspection (`listSegments`,
 *  `findDependents`) sees the full set. Each painter has its own
 *  sentinel cel; teardown is per-channel.
 *
 *  First paint: caller is expected to call `handle.channel.drain()` to
 *  commit the initial frame synchronously, mirroring the plastron-dom
 *  pattern. */
export const installCanvas = (
  state: State,
  options: InstallCanvasOptions,
): CanvasHandle => {
  const roots = options.roots;
  const channelKey = options.channelKey ?? DEFAULT_CANVAS_CHANNEL_KEY;

  if (state.channelRegistry.has(channelKey)) {
    throw new Error(
      `installCanvas: channel "${channelKey}" already registered. ` +
      `Pass options.channelKey to namespace.`,
    );
  }

  for (const [rootKey, root] of Object.entries(roots)) {
    if (!state.cels.has(root.cel)) {
      throw new Error(
        `installCanvas: root "${rootKey}" references cel "${root.cel}" which is not in state. ` +
        `Hydrate source cels before calling installCanvas.`,
      );
    }
    if (!root.selector && !root.element) {
      throw new Error(
        `installCanvas: root "${rootKey}" needs either selector or element.`,
      );
    }
  }

  // Register schema + isChanged (idempotent across installs and pre-hydrate
  // callers).
  installCanvasSchemas(state);

  // Stamp source cels with `channel: channelKey`. The kernel reads this
  // on every value-change and routes to the channel registry. Done
  // imperatively on existing cels rather than via hydrate — there are
  // no new cels to introduce, and the user already chose their schema.
  for (const root of Object.values(roots)) {
    const cel = state.cels.get(root.cel)!;
    // Preserve any existing channel binding. Common case is `undefined`
    // (cel had no channel); we set it to channelKey. Less common: cel
    // already has a string channel; we keep it as a string (kernel
    // dispatches first match) — caller is expected to namespace.
    if (cel.channel === undefined) {
      cel.channel = channelKey;
    } else if (Array.isArray(cel.channel)) {
      if (!cel.channel.includes(channelKey)) cel.channel.push(channelKey);
    } else if (cel.channel !== channelKey) {
      cel.channel = [cel.channel, channelKey];
    }
  }

  // Build the channel + register.
  const channel = createCanvasChannel(state, roots);
  state.channelRegistry.set(channelKey, channel);

  // Per-install manifest merge — same shape as plastron-dom's install.
  // When two installCanvas calls run on one state with different
  // channelKeys, the manifest accumulates both channels so introspection
  // and flush see the full set.
  const existing = state.segments.get(PLASTRON_CANVAS_SEGMENT);
  const existingChannels = existing?.provides?.channels ?? [];
  const mergedChannels = Array.from(new Set([...existingChannels, channelKey]));
  const manifest: SegmentManifest = {
    ...plastronCanvasManifest,
    provides: {
      ...plastronCanvasManifest.provides,
      channels: mergedChannels,
    },
  };
  state.segments.set(PLASTRON_CANVAS_SEGMENT, manifest);

  // Painter sentinel cel. `flush(state, PLASTRON_CANVAS_SEGMENT)` walks
  // cels in this segment, fires `_dispose`, then deletes them. Our
  // dispose tears down the channel and unregisters it.
  const sentinel: Cel = {
    key: painterCelKey(channelKey),
    v: null,
    segment: PLASTRON_CANVAS_SEGMENT,
    _dispose: () => {
      channel.dispose();
      state.channelRegistry.delete(channelKey);
    },
  };
  state.cels.set(sentinel.key, sentinel);

  // Mark every root dirty so the caller's `handle.channel.drain()`
  // commits the first frame. Without this, the channel only paints
  // after the user's cel mutates — the initial value never lands.
  enqueueAllRoots(channel, state, roots);

  return { channel };
};
