import { createInitialState } from "../../../plastron/src/index.js";
import { installDom } from "../../../segments/plastron-dom/src/index.js";
import { installRouter } from "../../../segments/plastron-routes/src/index.js";
import type { Fn } from "../../../plastron/src/types/index.js";
import { buildShellSegment } from "./shell.js";

// ========================================================================
// Hash-based routing + lazy segment loading.
//
// installRouter owns the URL ↔ cel sync, the dynamic-import flow, and
// the active-view selection. The shell only consumes `route:view` and
// renders <a href="#/..."> links; it doesn't know how loading happens.
//
// Refreshing on a deep link (`#/counter`) lazy-loads the counter
// segment from scratch and lands on it. Back/forward navigates between
// previously-visited views without reloading.
// ========================================================================

const state = createInitialState();
const hydrateFn = state.fns.get("hydrate") as Fn;
const runCycle = state.fns.get("runCycle") as Fn;

const shell = buildShellSegment();
hydrateFn(state, [shell.segment], [shell.fns]);

const router = installRouter(state, {
  routes: [
    { pattern: "/", view: "home" },
    {
      pattern: "/counter",
      view: "counter",
      load: () => import("./segments/counter.js").then((m) => m.counterSegment),
    },
    {
      pattern: "/weather",
      view: "weather",
      load: () => import("./segments/weather.js").then((m) => m.weatherSegment),
    },
  ],
  fallback: "home",
});

await runCycle(state);

const handle = installDom(state, {
  roots: { app: { selector: "#root", cel: "appTree" } },
});

await runCycle(state);
handle.channel.drain();

console.log("[plastron-spa-demo] mounted");
(globalThis as { __plastronState?: unknown }).__plastronState = state;
(globalThis as { __plastronRouter?: unknown }).__plastronRouter = router;
