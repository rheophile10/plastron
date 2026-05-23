import type { Fn, Key, State } from "../types/index.js";

// resolveFn — look up a runtime Fn by cel key.
//
// Replaces the old state.fns.get(key) pattern. With the registry-on-cels
// design, the fn lives on the cel itself:
//   • Fireable cels (Formula + Lambda variants) carry it on cel._fn
//     after compileCelBody runs (or after a native seed pre-populates it).
//   • CompilerCel carries its Compiler (which IS a Fn) directly on cel.v.
//
// Returns undefined when the key is unknown or the cel kind doesn't
// carry a callable — call sites decide whether to throw or skip.
export const resolveFn = (state: State, key: Key): Fn | undefined => {
  const cel = state.cels.get(key);
  if (!cel) return undefined;
  const fromCompute = (cel as { _fn?: Fn })._fn;
  if (fromCompute) return fromCompute;
  if (cel.celType === "CompilerCel") return cel.v as Fn;
  return undefined;
};
