// ============================================================================
// EXAMPLE 07 — Navigation-driven segment swapping.
//
// HOW TO RUN:
//   npx vite-node examples/07_navigation/index.ts
//
// WHAT THIS DEMONSTRATES:
//   The default "state" segment exposes `state.flush` as a cel
//   (state_flush) whose .v is the live function. A lambda can reference
//   it via inputMap and call it from inside a cycle.
//
//   Here we build route-style navigation: a `currentRoute` variable, a
//   route registry, and a `navigate` lambda that runs on every route
//   change — flushing the previously-active route's segment. The
//   orchestrator hydrates the new segment afterward.
//
//   Why not call state.hydrate from inside the lambda too? Because
//   hydrate internally fires a priming cycle, which would re-enter the
//   same lambda — nested re-entrancy. Sync operations (flush) are safe
//   inside lambdas; async ones (hydrate) belong on the caller side. The
//   `state_hydrate` cel is still there for patterns where you can
//   guarantee non-re-entrant use.
//
//   prevDepth: 1 lets the lambda see its previous output via _prev[0]
//   so it knows which route segment to burn.
// ============================================================================

import { runtime } from "../../plastron/src/index.js";
import type {
  DehydratedCel, LambdaMetadata, FnRegistry,
} from "../../plastron/src/state/index.js";

// ============================================================================
// Route registry. Each entry is a Record<Key, DehydratedCel> for one
// route's segment. Different routes → different segment names, so they
// can be flushed independently.
// ============================================================================

const routes: Record<string, Record<string, DehydratedCel>> = {
  home: {
    home_title: { segment: "route_home", v: "Welcome home" },
    home_body:  { segment: "route_home", v: "The kitchen is warm, the kettle is on." },
  },
  settings: {
    settings_title: { segment: "route_settings", v: "Settings" },
    settings_theme: { segment: "route_settings", v: "dark" },
    settings_lang:  { segment: "route_settings", v: "en-US" },
  },
  profile: {
    profile_name:  { segment: "route_profile", v: "Ian" },
    profile_bio:   { segment: "route_profile", v: "Builds turtles, carves cracks." },
    profile_count: { segment: "route_profile", v: 3 },
  },
};

// ============================================================================
// Navigation segment. The `navigate` lambda flushes the old route's
// segment via state_flush (imported as a cel from the default "state"
// segment).
// ============================================================================

const nav: Record<string, DehydratedCel> = {
  currentRoute: { segment: "navigation", v: "home" },

  navigate: {
    segment: "navigation",
    l: "navigate",
    inputMap: {
      route: "currentRoute",
      flush: "state_flush",    // from the default "state" segment
    },
    prevDepth: 1,               // remember the previously-active route
  },
};

// ============================================================================
// The navigate lambda. Pure side-effect: flushes the previous route's
// segment. Returns the current route, which becomes _prev[0] on the
// next run.
// ============================================================================

type FlushFn = (segmentKey: string) => void;

const navigate = (
  { route, flush, _prev }:
  { route: string; flush: FlushFn; _prev: unknown[] },
): string => {
  const previous = _prev[0] as string | undefined;
  if (previous && previous !== route) {
    flush(`route_${previous}`);
  }
  return route;
};

const lambdaMeta: Record<string, LambdaMetadata> = {
  navigate: {
    key: "navigate",
    description: "On route change, flush the previously-active route segment.",
    inputSchema:  "object",
    outputSchema: "string",
    arity:        2,
    prevMinDepth: 1,
    source:       navigate.toString(),
  },
};

const fnRegistry: FnRegistry = { navigate };

// ============================================================================
// Boot the runtime with just the navigation segment, then explicitly
// hydrate the initial route. Pairing "set currentRoute" + "hydrate
// newRoute" is the orchestrator's job; the graph handles flushing.
// ============================================================================

const rt = await runtime([nav], [lambdaMeta], fnRegistry);
await rt.hydrate([routes.home], [], {}, { upsert: true });

const changeRoute = async (newRoute: keyof typeof routes) => {
  // Writing to currentRoute triggers navigate → flush(old segment).
  await rt.input!.set("currentRoute", newRoute);
  // Orchestrator hydrates the new segment.
  await rt.hydrate([routes[newRoute]], [], {}, { upsert: true });
};

const routeKeys = {
  home:     ["home_title", "home_body"],
  settings: ["settings_title", "settings_theme", "settings_lang"],
  profile:  ["profile_name", "profile_bio", "profile_count"],
};

const show = (label: string) => {
  console.log(`\n--- ${label} ---`);
  console.log(`  currentRoute: ${rt.input!.get("currentRoute")}`);
  for (const keys of Object.values(routeKeys)) {
    for (const k of keys) {
      const v = rt.input!.get(k);
      if (v !== undefined) console.log(`  ${k.padEnd(16)} = ${JSON.stringify(v)}`);
    }
  }
};

show("After boot (home loaded)");

await changeRoute("settings");
show("After navigating to settings");

await changeRoute("profile");
show("After navigating to profile");

await changeRoute("home");
show("Back to home");

// ============================================================================
// TAKEAWAY
//
// * The "state" and "input" default segments expose the runtime's own
//   methods as cel values. Lambdas that inputMap to them can invoke the
//   methods from inside a cycle.
// * Sync side effects (flush, set, touch) are safe. Async ones that
//   themselves fire cycles (hydrate, consume) risk re-entrancy — better
//   invoked from the orchestrator.
// * Segment naming is your friend: one segment per route means one
//   state.flush call wipes a whole page's worth of cels at once.
// ============================================================================
