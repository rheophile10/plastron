import type { KindHandler } from "../../../plastron/src/index.js";
import type { Crack } from "./schemas.js";

// ============================================================================
// 體 (augur) kind — the rule-book interpreter.
//
// A lambda of kind "augur" carries its rule book as JSON in
// LambdaMetadata.source: an object mapping crack pattern → omen text.
// At hydrate, the kind handler parses the rules once and returns a
// closure that looks up the pattern from its single input "crack".
//
// Demonstrates kindRegistry: a host-supplied lambda compiler that
// turns JSON-shaped declarative metadata into a runtime fn. No code
// is shipped — only the rules — and the augur reads them.
// ============================================================================

interface AugurInputs {
  crack: Crack | null;
}

export const augurKind: KindHandler = {
  compile: ({ meta }) => {
    const rules = JSON.parse(meta.source ?? "{}") as Record<string, string>;
    return {
      fn: (inputs: AugurInputs) => {
        const pattern = inputs.crack?.pattern;
        if (pattern === undefined) return "(no crack)";
        return rules[pattern] ?? `(no omen for ${pattern})`;
      },
    };
  },
};
