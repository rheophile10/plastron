// ============================================================================
// segments-introspect-demo — exercise the manifest API end-to-end.
//
//   1. Boot a fresh state. Inspect the bootstrap "core" manifest.
//   2. Hydrate two stub segments — a fake "plastron-collections"
//      (no deps) and a fake "plastron-gpu" (depends on collections).
//   3. listSegments() → walk what's loaded.
//   4. findDependents("plastron-collections") → ["plastron-gpu"]
//   5. Try to flush "plastron-collections" → catches the "dependent
//      segments still loaded" error.
//   6. Flush "plastron-collections" with { cascade: true } → tears
//      down "plastron-gpu" first, then "plastron-collections".
//   7. Re-hydrate, then try to load "plastron-gpu" before
//      "plastron-collections" → catches the missing-dep error.
//
// The "plastron-collections" and "plastron-gpu" segments here are
// stubs — they exist only to demonstrate the manifest pipeline. Once
// the real packages ship (see notes/tasks/task-consolidation-helpers
// and task-webgpu-backend), the manifest shapes used here are exactly
// what those packages will export.
// ============================================================================

import type { Fn, Segment, SegmentManifest } from "../../../plastron/src/index.js";
import {
  createInitialState, listSegments, findDependents,
} from "../../../plastron/src/index.js";

const collectionsManifest: SegmentManifest = {
  segment: "plastron-collections",
  version: "1.0.0",
  description: "(stub) consolidation primitives — Column, Table, Matrix.",
  provides: {
    celSegments: ["plastron-collections"],
    lambdas: ["columnSum", "matmul"],
  },
};

const gpuManifest: SegmentManifest = {
  segment: "plastron-gpu",
  version: "0.3.1",
  description: "(stub) WebGPU compute backend.",
  dependsOn: [{ segment: "plastron-collections", semver: "^1.0" }],
  provides: {
    celSegments: ["plastron-gpu"],
    lambdas: ["matmulGpu"],
  },
};

const collectionsSegment: Segment = {
  key: "plastron-collections",
  cels: [
    { key: "stub_collections_marker", v: "loaded", segment: "plastron-collections" },
  ],
  manifest: collectionsManifest,
};

const gpuSegment: Segment = {
  key: "plastron-gpu",
  cels: [
    { key: "stub_gpu_marker", v: "loaded", segment: "plastron-gpu" },
  ],
  manifest: gpuManifest,
};

const fmt = (m: SegmentManifest): string =>
  `${m.segment}@${m.version}` +
  (m.dependsOn?.length
    ? ` (deps: ${m.dependsOn.map((d) => d.segment + (d.semver ? "@" + d.semver : "")).join(", ")})`
    : "");

const state = createInitialState();
const hydrate = state.fns.get("hydrate") as Fn;
const flush   = state.fns.get("flush")   as Fn;

console.log("[1] bootstrap manifests:");
for (const m of listSegments(state)) console.log("    -", fmt(m));

console.log("\n[2] hydrating plastron-collections + plastron-gpu");
hydrate(state, [collectionsSegment, gpuSegment], []);

console.log("\n[3] listSegments():");
for (const m of listSegments(state)) console.log("    -", fmt(m));

console.log("\n[4] findDependents('plastron-collections'):",
  findDependents(state, "plastron-collections"));

console.log("\n[5] flush('plastron-collections') WITHOUT cascade — should throw:");
try {
  await flush(state, "plastron-collections");
  console.log("    !! UNEXPECTED: flush did not throw");
} catch (e) {
  console.log("    caught:", (e as Error).message.split("\n")[0]);
}

console.log("\n[6] flush('plastron-collections', { cascade: true }):");
await flush(state, "plastron-collections", { cascade: true });
console.log("    after cascade flush:");
for (const m of listSegments(state)) console.log("    -", fmt(m));

console.log("\n[7] re-hydrate gpu BEFORE collections — should throw:");
try {
  hydrate(state, [gpuSegment], []);
  console.log("    !! UNEXPECTED: hydrate did not throw");
} catch (e) {
  console.log("    caught:", (e as Error).message.split("\n").join("\n            "));
}

console.log("\n[8] hydrate collections THEN gpu — succeeds:");
hydrate(state, [collectionsSegment], []);
hydrate(state, [gpuSegment], []);
for (const m of listSegments(state)) console.log("    -", fmt(m));

console.log("\n[9] force flush of collections — drops dependents-check:");
await flush(state, "plastron-collections", { force: true });
console.log("    after force flush:");
for (const m of listSegments(state)) console.log("    -", fmt(m));

console.log("\n[10] round-trip: dehydrate → hydrate into a fresh state.");
// Re-load both to give dehydrate something to emit.
hydrate(state, [collectionsSegment], []);
const dehydrate = state.fns.get("dehydrate") as Fn;
const emitted = dehydrate(state) as Segment[];
console.log("    emitted segments + manifests:");
for (const seg of emitted) {
  console.log(`    - ${seg.key}` +
              (seg.manifest ? ` (manifest: ${fmt(seg.manifest)})` : " (no manifest)"));
}
const fresh = createInitialState();
const freshHydrate = fresh.fns.get("hydrate") as Fn;
freshHydrate(fresh, emitted, []);
console.log("    fresh state listSegments():");
for (const m of listSegments(fresh)) console.log("    -", fmt(m));
