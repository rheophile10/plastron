import type { Key, State } from "../../../types/index.js";
import { isFireable, kindOf } from "../../../types/index.js";

// ============================================================================
// validateInputKinds — enforce per-input kind tags at hydrate.
//
// A fireable cel may declare `metadata.inputKinds = { name: kind }`
// alongside `metadata.inputMap = { name: source-key }`. When present,
// hydrate checks that the source cel's kindOf matches the declared
// kind. Mismatches are configuration errors — a "wat" lambda expecting
// a wat-domain input but wired to a JS source needs an explicit bridge
// cel between them. The kernel refuses to silently auto-insert one;
// WASM-DOMAIN.md § 6 spells out why (bridges carry real cost in
// future composite/worker territory, hiding them hides perf).
//
// Mismatches are accumulated and thrown together with a per-cel report.
// Cels without inputKinds skip validation entirely — opt-in.
//
// Bridges: source named with the pattern `<from>-to-<to>` is the
// suggestion the error points at when a mismatch is found.
// ============================================================================

interface Mismatch {
  consumer: Key;
  inputName: string;
  expected: Key;
  source: Key;
  actual: Key;
}

const formatMismatch = (m: Mismatch): string => {
  const bridge = `(${m.actual}-to-${m.expected} ${m.source})`;
  return (
    `  - "${m.consumer}".inputs.${m.inputName} expects kind "${m.expected}", ` +
    `but source "${m.source}" is kind "${m.actual}". ` +
    `Insert a bridge cel: ${bridge}`
  );
};

export const validateInputKinds = (state: State): void => {
  const mismatches: Mismatch[] = [];

  for (const cel of state.cels.values()) {
    if (!isFireable(cel)) continue;
    const declared = cel.metadata.inputKinds;
    if (!declared) continue;
    const inputMap = cel.metadata.inputMap;
    if (!inputMap) continue;

    for (const [inputName, expected] of Object.entries(declared)) {
      const ref = inputMap[inputName];
      if (ref === undefined) continue;          // input declared but not wired
      const sources = Array.isArray(ref) ? ref : [ref];
      for (const sourceKey of sources) {
        const sourceCel = state.cels.get(sourceKey);
        if (!sourceCel) continue;               // missing source caught elsewhere
        // ValueCels and other non-fireable cels don't have a kindOf
        // result, but their values are JS-domain by construction —
        // treat them as kind "js" for validation purposes.
        const actual = isFireable(sourceCel) ? kindOf(sourceCel) : "js";
        if (actual !== expected) {
          mismatches.push({
            consumer: cel.metadata.key,
            inputName,
            expected,
            source: sourceKey,
            actual,
          });
        }
      }
    }
  }

  if (mismatches.length === 0) return;
  const lines = mismatches.map(formatMismatch).join("\n");
  throw new Error(
    `hydrate: ${mismatches.length} input-kind mismatch(es). The kernel ` +
    `does not auto-insert bridges; add an explicit bridge cel for each.\n` +
    lines,
  );
};
