import type { Key } from "./index.js";
import type { DehydratedCel } from "./cels.js";
import type { 譜 } from "./譜.js";

/** Segment role. Drives lifecycle (boot vs eager vs explicit-start
 *  vs explicit-open), dehydrate inclusion, and flush protection.
 *  See docs/1-design/3-accepted/00-ontology/segment-classification.md. */
export type SegmentRole = "kernel" | "library" | "application" | "user-space";

export interface 冊 extends 譜 {
  name: string;
  version: string;
  dependencies: Key[];
  /** Required after segment-classification lands. `applyManifestDefaults`
   *  fills in "library" if absent at hydrate time, preserving
   *  back-compat for legacy unclassified manifests. */
  role?: SegmentRole;
  /** Application affinity. REQUIRED on user-space (names parent app);
   *  optional on libraries (tooling visibility, advisory only);
   *  conventionally absent on kernel + application. */
  applications?: Key[];
}

export interface 甲骨 {
  name: Key;
  cels: DehydratedCel[];
}
