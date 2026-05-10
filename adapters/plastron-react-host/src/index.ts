// ========================================================================
// plastron-react-host — React utilities for embedding plastron in a
// React app via host containment.
//
// This package is a *consumer-side adapter*, not a plastron segment: it
// doesn't extend plastron's data model, register anything in plastron's
// registries, or own any cels. It ships only React utilities that
// compose with an already-hydrated plastron state. Hence it lives under
// `adapters/` rather than `segments/`, and there is no SegmentManifest
// export.
//
// Three pieces:
//
//   • <PlastronHost />     React component owning a single ref'd div;
//                          plastron-dom paints inside; React never
//                          reconciles the painted tree.
//   • useReactSink()       React state mirror of a plastron channel —
//                          plastron → React.
//   • useReactSource()     Register a React state setter as a plastron
//                          Fn — React → plastron (pull semantics).
// ========================================================================

export { PlastronHost } from "./PlastronHost.js";
export type { PlastronHostProps } from "./PlastronHost.js";

export { useReactSink } from "./useReactSink.js";
export { useReactSource } from "./useReactSource.js";
