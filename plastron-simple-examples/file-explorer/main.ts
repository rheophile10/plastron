// file-explorer — standalone demo of plastron-OS's file explorer.
//
// The explorer reads `segment-store` (user-spaces saved by other
// apps) + tracks per-file folder placement in its own `fs-tree`
// user-space. Bun's bundler pulls the explorer's setup + the file
// toolbar's setup (it shares the toolbar-actions registry).
//
// Standalone, the file list is empty until you save something from
// another standalone app (notepad / sheets / web-editor) — OPFS is
// shared across same-origin tabs, so files saved at one localhost
// port show up here when the origins match. Tip: use a single port
// for all the example apps (re-export PORT=3003) when experimenting
// with cross-app round-trips.

import {
  createInitialState, resolveFn, precompute, precomputeOptional,
  createPainter, setPainter, getPainter,
} from "../../plastron-simple/src/index.js";
import type { Fn } from "../../plastron-simple/src/index.js";
import { setupFileExplorer } from "../plastron-os/file-explorer.ts";
import { setupFileToolbar }  from "../plastron-os/file-toolbar.ts";

const state = createInitialState();
const r = (k: string) => resolveFn(state, k) as Fn;

await r("set")(state, "os.active", "file-explorer");

// Toolbar shares helper fns the explorer references via dispatches.
// Also no-op the os.exit click target for standalone use.
await r("registerLambda")(state, {
  key: "os.exit", kind: "custom", fn: () => {/* no-op */},
});
await setupFileToolbar(state);
await setupFileExplorer(state);

precompute(state);
await precomputeOptional(state);
setPainter(state, createPainter(state));
await r("runCycle")(state);
await r("drain")(state, "plastron-dom.paint");
getPainter(state).drain();

(window as unknown as { __plastron?: unknown }).__plastron = {
  state, resolveFn: (k: string) => resolveFn(state, k),
};
