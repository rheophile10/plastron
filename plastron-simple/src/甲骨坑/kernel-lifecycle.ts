import type { 甲骨, Cel, Fn } from "../types/index.js";
import { runCycle } from "../kernel/runCycle.js";
import { hydrate, dehydrate, flush } from "../kernel/lifecycle/index.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./kernel-lifecycle.json" with { type: "json" };

export const name = "kernel-lifecycle" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["runCycle",  runCycle],
  ["hydrate",   hydrate],
  ["dehydrate", dehydrate],
  ["flush",     flush],
]));
