// ============================================================================
// segment: plastron-routes
//
// Pipeline:
//
//   window.location.hash ──hashchange──► route:hash (data cel)
//                                            │
//                                            ▼
//                                       route:match (lambda)
//                                            │  channel: "route:loader"
//                                            ▼
//                                       loader handler (async)
//                                            │  dynamic-import → hydrate
//                                            │  → runCycle → set view
//                                            ▼
//                                       route:view (data cel)
//                                            │
//                                            ▼
//                                       app shells / view selectors
//
// Hash-based by design: works on static hosts and file:// URLs without
// server cooperation. History-API mode (clean URLs + click interception)
// is a v2 concern.
//
// Lazy segments: each RouteEntry can carry a `load: () => Promise<{segment,fns}>`.
// The first match for that view triggers the dynamic import + hydrate;
// subsequent matches reuse the loaded bundle. Refresh on a deep link
// (`#/users/42`) lazy-loads the right segment from scratch.
//
// Teardown: state.fns.get("flush")(state, "plastronRoutes") removes the
// router cels, detaches the hashchange listener, and unregisters the
// loader channel.
// ============================================================================

export {
  installRouter,
  plastronRoutesManifest,
  ROUTES_SEGMENT,
  ROUTE_HASH_KEY,
  ROUTE_MATCH_KEY,
  ROUTE_VIEW_KEY,
  ROUTE_MATCH_FN_KEY,
  ROUTE_MATCH_ISCHANGED_KEY,
  ROUTE_LOADER_CHANNEL,
} from "./router.js";

export type {
  InstallRouterOptions,
  RouterHandle,
} from "./router.js";

export {
  compileRoutes,
  matchRoute,
  matchKey,
} from "./match.js";

export type {
  RouteEntry,
  RouteMatch,
  CompiledRoute,
  SegmentBundle,
} from "./match.js";
