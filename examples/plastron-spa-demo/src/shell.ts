import type { Fn, LambdaKey, Segment } from "../../../plastron/src/types/index.js";
import { el, type VNode } from "../../../segments/plastron-dom/src/index.js";
import type { SegmentBundle } from "./segments/counter.js";

// ========================================================================
// Shell — nav links + view slot.
//
// The shell is hydrated alone at startup. counterTree and weatherTree
// are referenced in inputMap but not yet present in state — that's
// fine: the kernel returns `undefined` for missing inputMap targets,
// so the render lambda just shows a "loading" stub for the active
// view until plastron-routes lazy-loads the matching segment.
//
// Nav uses plain `<a href="#/...">` anchors — clicks update
// window.location.hash, the router's hashchange listener writes
// route:hash, the route:match lambda recomputes, the loader channel
// dynamically imports the segment and finally sets route:view.
//
// `view` is the active view key from route:view (set by the router
// after loading completes).
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
    const navLink = (path: string, key: string, label: string): VNode =>
      el("a", {
        class: view === key ? "active" : "",
        href: `#${path}`,
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
        navLink("/counter", "counter", "Counter"),
        navLink("/weather", "weather", "Weather"),
      ),
      el("main", { class: "app-main" }, main),
    );
  };

  const segment: Segment = {
    key: "shell",
    cels: [
      {
        key: "appTree",
        l: "shell:renderShell",
        // counterTree / weatherTree may not exist when the shell
        // hydrates — the kernel tolerates phantom inputMap entries
        // (returns undefined), and once the router lazy-loads a
        // segment its tree cel takes its place. route:view is
        // installed by installRouter; at first render before the
        // router is installed it's also undefined, which the render
        // lambda handles via the else branch.
        inputMap: {
          view: "route:view",
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
