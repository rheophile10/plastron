import type { Key } from "./index.js";

export interface 譜 {
  key?: Key;
  name?: string;
  description?: string;
  [k: string]: unknown;
}
