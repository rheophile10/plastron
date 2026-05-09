import type { Fn, LambdaKey, Segment } from "../../../plastron/src/types/index.js";
import { el, type VNode } from "../../../segments/plastron-dom/src/index.js";
import type { SegmentBundle } from "./segments/counter.js";

// ========================================================================
// Shell — nav menu + view slot.
//
// The shell is hydrated alone at startup. counterTree and weatherTree
// are referenced in inputMap but not yet present in state — that's
// fine: the kernel's runCascade returns `undefined` for missing
// inputMap targets, so the render lambda just shows a "loading" stub
// for the active view until its segment is hydrated.
//
// Nav clicks dispatch `shell:navigateTo` rather than writing
// currentView directly. The dispatcher (defined in main.ts) handles
// "load the segment if not yet, then set currentView." It runs
// outside the cycle, so it's free to call hydrate.
// ========================================================================

const isVNode = (v: unknown): v is VNode =>
  v !== null && typeof v === "object" && "type" in (v as object);

export const buildShellSegment = (): SegmentBundle => {
  const renderShell: Fn = (
    { view, counterTree, weatherTree }: {
      view: string;
      counterTree: unknown;
      weatherTree: unknown;
    },
  ): VNode => {
    const navButton = (key: string, label: string): VNode =>
      el("button", {
        class: view === key ? "active" : "",
        onClick: { dispatch: "shell:navigateTo", payload: key },
      }, label);

    let main: VNode;
    if (view === "counter") {
      main = isVNode(counterTree) ? counterTree : el("p", null, "Loading counter…");
    } else if (view === "weather") {
      main = isVNode(weatherTree) ? weatherTree : el("p", null, "Loading weather…");
    } else {
      main = el("p", null, "Pick a view to load it.");
    }

    return el("div", { class: "app" },
      el("nav", { class: "app-nav" },
        navButton("counter", "Counter"),
        navButton("weather", "Weather"),
      ),
      el("main", { class: "app-main" }, main),
    );
  };

  const segment: Segment = {
    key: "shell",
    cels: [
      { key: "currentView", v: "", segment: "shell" },
      {
        key: "appTree",
        l: "shell:renderShell",
        // counterTree / weatherTree may not exist when the shell
        // hydrates — the kernel tolerates phantom inputMap entries
        // (returns undefined), and once a segment is lazily loaded
        // its tree cel takes its place in the dependency graph.
        inputMap: {
          view: "currentView",
          counterTree: "counterTree",
          weatherTree: "weatherTree",
        },
        segment: "shell",
      },
    ],
  };
  const fns = new Map<LambdaKey, Fn>([["shell:renderShell", renderShell]]);
  return { segment, fns };
};
