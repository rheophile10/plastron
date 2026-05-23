import type { 甲骨, Cel, Compiler, Fn, State } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { CSP_EVAL_AVAILABLE_KEY } from "./csp.js";
import seed from "./js-compiler.json" with { type: "json" };

// js-compiler — the "js" LockedLambdaCel whose _fn is the live JS
// compiler. Other cels reference it by key as
//   LambdaCel.metadata.kind = "js" (lambda compile dispatch)
//
// FormulaCels cannot use "js" as their parser: the JS compiler emits
// a bare Fn rather than a CompiledEnvelope with buildEvaluate, which
// the hydrate-time contract check in compileCelBody rejects. Formula
// parsers must produce a CompiledEnvelope (see the default "f").
//
// Today the body uses `new Function(...)` to evaluate JS source into
// a runtime fn — placeholder for a real JS-to-wasm pipeline. Replacing
// the body of `jsCompiler` is the only change required to swap to
// wasm; the cel address and contract stay the same.
//
// CSP gate: when invoked with state, the compiler reads
// `csp.eval-available` and refuses up front when false. The install
// itself never fails — refusing to install would brick the segment in
// strict-CSP browsers even for apps with zero JS lambdas. The throw
// only fires at the moment a JS lambda actually tries to compile.

const jsCompiler: Compiler = ((source: string, state?: State): Fn => {
  if (state) {
    const cspEvalAvailable =
      state.cels.get(CSP_EVAL_AVAILABLE_KEY)?.v as boolean | undefined;
    if (cspEvalAvailable === false) {
      throw new Error(
        `js-compiler: \`new Function\` is blocked in this environment ` +
        `(csp.eval-available = false). This app requires \`unsafe-eval\` ` +
        `in its CSP for JS lambda compilation, or must ship precompiled bytes.`,
      );
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(`"use strict"; return (${source});`);
  const fn = factory();
  if (typeof fn !== "function") {
    throw new Error(
      `js-compiler: source did not evaluate to a function: ${source.slice(0, 80)}`,
    );
  }
  return fn as Fn;
}) as Compiler;

export const name = "js-compiler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["js", jsCompiler],
]));
