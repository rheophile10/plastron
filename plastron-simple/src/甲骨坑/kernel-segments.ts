import type { 甲骨, Cel, Fn } from "../types/index.js";
import { findDependents, getSegmentManifest, listSegments } from "../kernel/segments.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./kernel-segments.json" with { type: "json" };

export const name = "kernel-segments" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["getSegmentManifest", getSegmentManifest as Fn],
  ["listSegments",       listSegments       as Fn],
  ["findDependents",     findDependents     as Fn],
]));
