import type {
  Fn, LambdaKey, LambdaMetadata, SegmentManifest, State,
} from "../../../plastron/src/index.js";
import {
  DRAWING_SCHEMA_KEY, LAYER_SCHEMA_KEY, SCENE_SCHEMA_KEY,
  DRAWING_IS_CHANGED_KEY, LAYER_IS_CHANGED_KEY, SCENE_IS_CHANGED_KEY,
  DRAWING_BYTELENGTH_KEY, LAYER_BYTELENGTH_KEY, SCENE_BYTELENGTH_KEY,
  drawingSchema, layerSchema, sceneSchema,
  drawingIsChanged, layerIsChanged, sceneIsChanged,
  drawingByteLength, layerByteLength, sceneByteLength,
} from "./schemas.js";
import { renderMultiplane } from "./render.js";

// ============================================================================
// segment: plastron-multiplane
//
// B2 — registers schemas + lambdas, owns no channel and no managed cels
// of its own. The host:
//
//   1. Calls installMultiplane(state) BEFORE hydrate so auto-wire
//      materializes _isChanged / _diffFn on Scene / Layer / Drawing
//      cels at hydrate time.
//   2. Hydrates a Scene cel (declaring schema: sceneSchema).
//   3. Calls installCanvas(state, { roots: { main: {
//        cel: <sceneCelKey>, draw: renderMultiplane
//      }}}) to wire the canvas channel.
//
// Multiplane composes with plastron-canvas: multiplane brings the
// shapes + render math, canvas brings the channel + rAF coalescer. The
// two segments are independent — neither imports the other.
//
// Teardown: same shape as plastron-collections. `flush(state,
// PLASTRON_MULTIPLANE_SEGMENT)` only drops the manifest; for a full
// unregister of the schemas + lambdas use `flushMultiplane(state)`.
// ============================================================================

export const PLASTRON_MULTIPLANE_SEGMENT = "plastron-multiplane" as const;
export const RENDER_KEY = "plastronMultiplane:render" as const;

export const plastronMultiplaneManifest: SegmentManifest = {
  segment: PLASTRON_MULTIPLANE_SEGMENT,
  version: "0.0.1",
  description:
    "Multiplane-camera renderer for plastron-canvas — Drawing / Layer / Scene shapes + parallax compositing.",
  provides: {
    schemas: [DRAWING_SCHEMA_KEY, LAYER_SCHEMA_KEY, SCENE_SCHEMA_KEY],
    lambdas: [
      DRAWING_IS_CHANGED_KEY, LAYER_IS_CHANGED_KEY, SCENE_IS_CHANGED_KEY,
      DRAWING_BYTELENGTH_KEY, LAYER_BYTELENGTH_KEY, SCENE_BYTELENGTH_KEY,
      RENDER_KEY,
    ],
    celSegments: [PLASTRON_MULTIPLANE_SEGMENT],
  },
};

export type { Drawing, Layer, Scene, Camera, DrawingImage } from "./types.js";
export {
  DRAWING_SCHEMA_KEY, LAYER_SCHEMA_KEY, SCENE_SCHEMA_KEY,
  DRAWING_IS_CHANGED_KEY, LAYER_IS_CHANGED_KEY, SCENE_IS_CHANGED_KEY,
  DRAWING_BYTELENGTH_KEY, LAYER_BYTELENGTH_KEY, SCENE_BYTELENGTH_KEY,
  drawingSchema, layerSchema, sceneSchema,
  drawingIsChanged, layerIsChanged, sceneIsChanged,
  drawingByteLength, layerByteLength, sceneByteLength,
} from "./schemas.js";
export { renderMultiplane } from "./render.js";

// ── Fn map ─────────────────────────────────────────────────────────────────

const buildFns = (): Map<LambdaKey, Fn> => {
  const fns = new Map<LambdaKey, Fn>();
  fns.set(DRAWING_IS_CHANGED_KEY, drawingIsChanged as unknown as Fn);
  fns.set(LAYER_IS_CHANGED_KEY,   layerIsChanged   as unknown as Fn);
  fns.set(SCENE_IS_CHANGED_KEY,   sceneIsChanged   as unknown as Fn);
  fns.set(DRAWING_BYTELENGTH_KEY, drawingByteLength as unknown as Fn);
  fns.set(LAYER_BYTELENGTH_KEY,   layerByteLength   as unknown as Fn);
  fns.set(SCENE_BYTELENGTH_KEY,   sceneByteLength   as unknown as Fn);
  fns.set(RENDER_KEY,             renderMultiplane  as unknown as Fn);
  return fns;
};

const lockedFn = (state: State, key: LambdaKey): boolean =>
  !!state.fnMetadata.get(key)?.locked && state.fns.has(key);

/** Install plastron-multiplane on a state. Registers the three schemas
 *  + schema metadata + every isChanged / byteLength / render lambda.
 *  Idempotent — schemas already registered are left alone. Locked fns
 *  are never overwritten.
 *
 *  Call BEFORE hydrate so the kernel's auto-wire pass materializes
 *  `_isChanged` on cels declaring sceneSchema / layerSchema /
 *  drawingSchema. */
export const installMultiplane = (state: State): void => {
  // ── Schemas + schema metadata ─────────────────────────────────────────
  if (!state.schemas.has(DRAWING_SCHEMA_KEY)) state.schemas.set(DRAWING_SCHEMA_KEY, drawingSchema);
  if (!state.schemas.has(LAYER_SCHEMA_KEY))   state.schemas.set(LAYER_SCHEMA_KEY,   layerSchema);
  if (!state.schemas.has(SCENE_SCHEMA_KEY))   state.schemas.set(SCENE_SCHEMA_KEY,   sceneSchema);

  if (!state.schemaMetadata.has(DRAWING_SCHEMA_KEY)) {
    state.schemaMetadata.set(DRAWING_SCHEMA_KEY, {
      key: DRAWING_SCHEMA_KEY,
      isChanged: DRAWING_IS_CHANGED_KEY,
      byteLength: DRAWING_BYTELENGTH_KEY,
    });
  }
  if (!state.schemaMetadata.has(LAYER_SCHEMA_KEY)) {
    state.schemaMetadata.set(LAYER_SCHEMA_KEY, {
      key: LAYER_SCHEMA_KEY,
      isChanged: LAYER_IS_CHANGED_KEY,
      byteLength: LAYER_BYTELENGTH_KEY,
    });
  }
  if (!state.schemaMetadata.has(SCENE_SCHEMA_KEY)) {
    state.schemaMetadata.set(SCENE_SCHEMA_KEY, {
      key: SCENE_SCHEMA_KEY,
      isChanged: SCENE_IS_CHANGED_KEY,
      byteLength: SCENE_BYTELENGTH_KEY,
    });
  }

  // ── Fns + fnMetadata via hydrate (same shape as plastron-collections) ──
  const allFns = buildFns();
  const fns = new Map<LambdaKey, Fn>();
  for (const [k, f] of allFns) {
    if (lockedFn(state, k)) continue;
    fns.set(k, f);
  }

  const fnMetaData: Record<LambdaKey, LambdaMetadata> = {};
  const addMeta = (key: LambdaKey, meta: LambdaMetadata): void => {
    if (lockedFn(state, key)) return;
    fnMetaData[key] = meta;
  };
  addMeta(DRAWING_IS_CHANGED_KEY, { key: DRAWING_IS_CHANGED_KEY, kind: "native" });
  addMeta(LAYER_IS_CHANGED_KEY,   { key: LAYER_IS_CHANGED_KEY,   kind: "native" });
  addMeta(SCENE_IS_CHANGED_KEY,   { key: SCENE_IS_CHANGED_KEY,   kind: "native" });
  addMeta(DRAWING_BYTELENGTH_KEY, { key: DRAWING_BYTELENGTH_KEY, kind: "native" });
  addMeta(LAYER_BYTELENGTH_KEY,   { key: LAYER_BYTELENGTH_KEY,   kind: "native" });
  addMeta(SCENE_BYTELENGTH_KEY,   { key: SCENE_BYTELENGTH_KEY,   kind: "native" });
  addMeta(RENDER_KEY,             { key: RENDER_KEY,             kind: "native" });

  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(
    state,
    [{
      key: PLASTRON_MULTIPLANE_SEGMENT,
      cels: [],
      fnMetaData,
      manifest: plastronMultiplaneManifest,
    }],
    [fns],
  );
};

/** Counterpart to installMultiplane. As a B2 segment with no managed
 *  cels, kernel `flush()` only drops the manifest — this helper also
 *  unregisters the schemas + lambdas. Same shape as
 *  `flushCollections` in plastron-collections. */
export const flushMultiplane = async (state: State): Promise<void> => {
  const flush = state.fns.get("flush") as Fn;
  await flush(state, PLASTRON_MULTIPLANE_SEGMENT);

  const provides = plastronMultiplaneManifest.provides!;
  for (const k of provides.schemas ?? []) {
    state.schemas.delete(k);
    state.schemaMetadata.delete(k);
  }
  for (const k of provides.lambdas ?? []) {
    if (state.fnMetadata.get(k)?.locked) continue;
    state.fns.delete(k);
    state.fnMetadata.delete(k);
  }
};
