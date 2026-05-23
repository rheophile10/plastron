import type { Key } from "./index.js";
import type { DehydratedCel } from "./cels.js";
import type { 譜 } from "./譜.js";

export interface 冊 extends 譜 {
  name: string;
  version: string;
  dependencies: Key[];
}

export interface 甲骨 {
  name: Key;
  cels: DehydratedCel[];
}
