import { createInitialState } from "../../../plastron/src/index.js";
import { installDom } from "../../../segments/plastron-dom/src/index.js";
import type { Fn } from "../../../plastron/src/types/index.js";
import { buildShellSegment } from "./shell.js";
import type { SegmentBundle } from "./segments/counter.js";

// ========================================================================
// Lazy segment loading.
//
// At startup only the shell hydrates. Each nav button's onClick is a
// `dispatch: "shell:navigateTo"` — the painter calls navigateTo with
// the segment key as payload. navigateTo:
//
//   1. If the segment isn't loaded yet, dynamically imports its module
//      (Vite emits a separate chunk per dynamic import).
//   2. Hands the SegmentBundle to hydrate. Hydrate adds the cels and
//      re-runs precompute, so the shell's phantom inputMap entries
//      become real dependencies.
//   3. Runs a full runCycle so the new lambdas fire from scratch.
//   4. Calls set("currentView", target) to switch the view.
// ========================================================================

const state = createInitialState();
const hydrateFn = state.fns.get("hydrate") as Fn;
const runCycle = state.fns.get("runCycle") as Fn;
const setFn = state.fns.get("set") as Fn;

const factories: Record<string, () => Promise<SegmentBundle>> = {
  counter: () => import("./segments/counter.js").then((m) => m.counterSegment),
  weather: () => import("./segments/weather.js").then((m) => m.weatherSegment),
};

const loaded = new Set<string>();

const navigateTo: Fn = async (...args: unknown[]) => {
  const [, payload] = args;
  const target = String(payload);
  const factory = factories[target];
  if (!factory) {
    console.error(`[plastron-spa-demo] unknown segment: ${target}`);
    return;
  }
  if (!loaded.has(target)) {
    const seg = await factory();
    hydrateFn(state, [seg.segment], [seg.fns]);
    loaded.add(target);
    await runCycle(state);
    console.log(`[plastron-spa-demo] lazy-loaded segment "${target}"`);
  }
  await setFn(state, "currentView", target);
};

const shell = buildShellSegment();
hydrateFn(state, [shell.segment], [shell.fns, new Map([["shell:navigateTo", navigateTo]])]);

await runCycle(state);

const handle = installDom(state, {
  roots: { app: { selector: "#root", cel: "appTree" } },
});

await runCycle(state);
handle.painter.flushNow();

console.log("[plastron-spa-demo] mounted");
(globalThis as { __plastronState?: unknown }).__plastronState = state;
