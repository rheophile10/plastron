// web-editor — standalone demo of plastron's `buildWebEditor` factory.
//
// Live-editable mini-app: a textarea for the spec + a preview pane.
// Edits parse into cels each tick — so the right side hydrates "live"
// from whatever you typed on the left. COUNTER_EXAMPLE is the default;
// WEATHER_EXAMPLE is also exported if you want to swap.
//
// Like the notepad demo, the factory produces a self-contained
// segment; we hydrate + paint, no app-side handler code.

import {
  createInitialState, resolveFn, precompute, precomputeOptional,
  createPainter, setPainter, getPainter,
  buildWebEditor, installWebEditorActions,
  COUNTER_EXAMPLE,
  // WEATHER_EXAMPLE,   // ← swap to try the other built-in example
} from "../../plastron-simple/src/index.js";
import type { Fn } from "../../plastron-simple/src/index.js";

const state = createInitialState();
const r = (k: string) => resolveFn(state, k) as Fn;

await installWebEditorActions(state);

const seg = buildWebEditor({ mount: "#webedit", source: COUNTER_EXAMPLE });
await r("hydrate")(state, [seg], [{
  name: seg.name, version: seg.version,
  dependencies: seg.dependencies, role: "application",
}]);

precompute(state);
await precomputeOptional(state);

setPainter(state, createPainter(state));
await r("runCycle")(state);
await r("drain")(state, "plastron-dom.paint");
getPainter(state).drain();

(window as unknown as { __plastron?: unknown }).__plastron = {
  state, resolveFn: (k: string) => resolveFn(state, k),
};
