import type {
  LambdaKindHandler, KindContext, CompiledLambda,
} from "../../../../plastron/src/index.js";
import type { TaggedValue } from "../../../../plastron/src/index.js";
import type { CrackValue } from "../tags/crack.js";

// ========================================================================
// kind: augur
//
// A custom lambda kind that interprets a small declarative rule book.
// Source on the lambda metadata is JSON-encoded:
//
//   {
//     cases: [
//       { pattern: "Y",  omen: "吉",  note: "branching — auspicious" },
//       { pattern: "X",  omen: "凶",  note: "bisecting — ominous" },
//       …
//     ],
//     default: { omen: "未明", note: "the bone is silent" }
//   }
//
// At runtime the lambda receives `inputs.crack` (a tagged "crack" value)
// and returns an omen reading. Demonstrates plastron's lambda-kind
// extension point — no native Fn is required to register the lambda;
// the source string IS the lambda.
// ========================================================================

export interface AugurCase {
  pattern: CrackValue["pattern"];
  omen: string;
  note: string;
}

export interface AugurRuleBook {
  cases: AugurCase[];
  default: { omen: string; note: string };
}

export interface OmenReading {
  omen: string;
  note: string;
  /** Pattern that matched (or "default" when no rule matched). */
  matched: string;
}

export const augurKind: LambdaKindHandler = {
  key: "augur",
  prepare(ctx: KindContext): CompiledLambda {
    const source = ctx.meta?.source;
    if (!source) {
      // No rule book yet — return an empty stub. The cycle will surface
      // "Lambda missing" via the errors segment if invoked.
      return {};
    }

    let rule: AugurRuleBook;
    try {
      rule = JSON.parse(source) as AugurRuleBook;
    } catch (e) {
      throw new Error(
        `augur lambda "${ctx.cel.key}" has unparseable source: ${(e as Error).message}`
      );
    }

    return {
      fn: (inputs: Record<string, unknown>) => {
        const crack = inputs.crack as TaggedValue<CrackValue> | undefined;
        const pattern = crack?.value?.pattern;

        if (pattern) {
          for (const c of rule.cases) {
            if (c.pattern === pattern) {
              return { omen: c.omen, note: c.note, matched: pattern } as OmenReading;
            }
          }
        }
        return {
          omen: rule.default.omen,
          note: rule.default.note,
          matched: "default",
        } as OmenReading;
      },
    };
  },
};
