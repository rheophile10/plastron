import type { Compiler, Fn } from "../../../plastron/src/index.js";
import type { Crack } from "./schemas.js";

// ============================================================================
// 體 (augur) compiler — the rule-book interpreter.
//
// A lambda with `kind: "augur"` carries its rule book as JSON in
// LambdaMetadata.source: an object mapping crack pattern → omen text.
// At hydrate, the compiler at state.fns.get("augur") parses the rules
// once and returns a closure that looks up the pattern from its
// single input "crack".
//
// Demonstrates the compiler-as-Fn convention: a host-supplied
// compiler that turns JSON-shaped declarative metadata into a runtime
// fn. No code is shipped — only the rules — and the augur reads them.
// ============================================================================

interface AugurInputs {
  crack: Crack | null;
}

export const augurCompiler: Compiler = (source: string) => {
  const rules = JSON.parse(source ?? "{}") as Record<string, string>;
  const fn: Fn = (inputs: AugurInputs) => {
    const pattern = inputs.crack?.pattern;
    if (pattern === undefined) return "(no crack)";
    return rules[pattern] ?? `(no omen for ${pattern})`;
  };
  return fn;
};
