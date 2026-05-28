// notepad — standalone demo of plastron's `buildNotepad` factory.
//
// buildNotepad returns a self-contained application segment: cels for
// the text value + a FormulaCel view that paints to plastron-dom. We
// hydrate, install the painter, runCycle once, drain — that's it.
// The user types in the <textarea>, plastron-dom's input-binding
// writes `notepad.text` straight from `event.target.value`, the cel
// fires its view, the painter re-paints. No app-side handler code.

import {
  createInitialState, resolveFn, precompute, precomputeOptional,
  createPainter, setPainter, getPainter, buildNotepad,
} from "../../plastron-simple/src/index.js";
import type { Fn } from "../../plastron-simple/src/index.js";

const state = createInitialState();
const r = (k: string) => resolveFn(state, k) as Fn;

const seg = buildNotepad({
  mount: "#notepad",
  text: "Type anything — this textarea is backed by a plastron ValueCel.\n",
});
await r("hydrate")(state, [seg], [{
  name: seg.name, version: seg.version,
  dependencies: seg.dependencies, role: "application",
}]);

precompute(state);
await precomputeOptional(state);

setPainter(state, createPainter(state));
await r("runCycle")(state);
await r("drain")(state, "plastron-dom.paint");
getPainter(state).drain();    // initial paint synchronously

// Expose for debugging — `__plastron.state.cels.get("notepad.text").v` in
// devtools lets you watch the value mutate live.
(window as unknown as { __plastron?: unknown }).__plastron = {
  state, resolveFn: (k: string) => resolveFn(state, k),
};
