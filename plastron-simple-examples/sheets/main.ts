// sheets — standalone demo of plastron-OS's Sheets app.
//
// The app's setup logic (per-cell view cels, table composer, click +
// commit actions, file toolbar integration) is non-trivial. Rather
// than duplicate it, we import the same `buildSheetsApp` +
// `setupFileToolbar` plastron-OS uses, and boot just this one app on a
// page of its own. Bun's bundler pulls in plastron-os/{sheets,
// file-toolbar, doc-binding}.ts as needed.

import {
  createInitialState, resolveFn, precompute, precomputeOptional,
  createPainter, setPainter, getPainter,
} from "../../plastron-simple/src/index.js";
import type { Fn } from "../../plastron-simple/src/index.js";
import { buildSheetsApp }     from "../plastron-os/sheets.ts";
import { setupFileToolbar }   from "../plastron-os/file-toolbar.ts";

const state = createInitialState();
const r = (k: string) => resolveFn(state, k) as Fn;

// Make sheets the "active" app so its mount-gate
// `(if (eq active "sheets") "#app" null)` paints to #app.
await r("set")(state, "os.active", "sheets");

// Stub `os.exit` — clicking the × normally returns to the desktop.
// Standalone has no desktop; make it a no-op so the click doesn't NaN
// the formula graph.
await r("registerLambda")(state, {
  key: "os.exit", kind: "custom", fn: () => {/* no-op */},
});

await setupFileToolbar(state);
await buildSheetsApp(state, {
  rows: 8, cols: 5,
  cells: {
    A1: "Item",   B1: "Qty", C1: "Price", D1: "Total",
    A2: "Widget", B2: "3",   C2: "4",     D2: "=B2*C2",
    A3: "Gadget", B3: "5",   C3: "2",     D3: "=B3*C3",
                                          D4: "=D2+D3",
  },
});

precompute(state);
await precomputeOptional(state);
setPainter(state, createPainter(state));
await r("runCycle")(state);
await r("drain")(state, "plastron-dom.paint");
getPainter(state).drain();

(window as unknown as { __plastron?: unknown }).__plastron = {
  state, resolveFn: (k: string) => resolveFn(state, k),
};
