import type { 甲骨, Cel, Fn } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./builtins.json" with { type: "json" };

// builtins — the four arithmetic operators +, -, *, / as LockedLambdaCels.
//
// Implementations are variadic; arg coercion via Number() so the slow
// paths agree with codegen's inlined `(Number(a)+Number(b))` shape.
// Edge cases (zero-arg identity, one-arg negation/reciprocal) match the
// original BUILTINS table in kernel/formula.ts that this segment replaces.
//
// formula.ts still recognizes "+", "-", "*", "/" as list heads it can
// inline at codegen time (perf), but the cels here own the authoritative
// runtime fns — slow paths and bare-symbol references resolve through them.

const plus:  Fn = (...args: unknown[]) => args.reduce<number>((a, b) => a + Number(b), 0);
const times: Fn = (...args: unknown[]) => args.reduce<number>((a, b) => a * Number(b), 1);
const minus: Fn = (...args: unknown[]) => {
  if (args.length === 0) return 0;
  if (args.length === 1) return -Number(args[0]);
  return args.slice(1).reduce<number>((a, b) => a - Number(b), Number(args[0]));
};
const divide: Fn = (...args: unknown[]) => {
  if (args.length === 0) return NaN;
  if (args.length === 1) return 1 / Number(args[0]);
  return args.slice(1).reduce<number>((a, b) => a / Number(b), Number(args[0]));
};

export const name = "builtins" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["+", plus],
  ["-", minus],
  ["*", times],
  ["/", divide],
]));
