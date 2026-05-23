import type { 甲骨, Cel, Fn } from "../types/index.js";
import {
  get, set, update, batch, getCel, setCel, getCelBatch, setCelBatch,
  touch, consume, drain, registerLambda,
} from "../kernel/io/index.js";
import { compileFormula, extractDeps } from "../kernel/formula.js";
import { clearErrors } from "./cel-error.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./kernel-io.json" with { type: "json" };

// Default formula compiler: S-expression source → CompiledLambda.
// Unlocked so hosts can swap formula languages by registering a
// replacement at "f" (with a matching .extractDeps) via hydrate's
// fn maps. extractDeps is consulted at compile time to auto-wire
// cel.inputMap from the formula body.
const formulaFn: Fn = (src: string) => compileFormula(src);
formulaFn.extractDeps = extractDeps;

export const name = "kernel-io" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["get",            get],
  ["set",            set],
  ["update",         update],
  ["batch",          batch],
  ["getCel",         getCel],
  ["setCel",         setCel],
  ["getCelBatch",    getCelBatch],
  ["setCelBatch",    setCelBatch],
  ["touch",          touch],
  ["consume",        consume],
  ["drain",          drain],
  ["registerLambda", registerLambda],
  ["clearErrors",    clearErrors],
  ["f",              formulaFn],
]));
