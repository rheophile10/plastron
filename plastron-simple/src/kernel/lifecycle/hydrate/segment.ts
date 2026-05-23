import type { FireableCel, Key, State, 甲骨, 冊 } from "../../../types/index.js";
import { isFireable } from "../../../types/index.js";
import { appendError, makeCelError } from "../../../甲骨坑/cel-error.js";
import { disposeCel, inflateCel } from "./cel.js";
import { compileCelBody } from "./formula.js";

// ============================================================================
// Segment hydration — three responsibilities:
//
//   • validateManifests: every 冊.dependencies entry must be satisfied
//     either by an already-loaded manifest in state.segments or by a
//     peer in this same hydrate batch. Throws on miss; state stays
//     untouched.
//
//   • inflateAllCels: build live cels from every incoming DehydratedCel.
//     Pure construct, no compile. Fireable cels with `f` get their body
//     attached but `_fn` is left unset. Locked cels are skipped; other
//     existing cels are disposed before being replaced.
//
//   • compileFireable: Kahn-topo sort over the just-inflated fireable
//     cels with `f`, edge = "this cel's compiler key is also a cel in
//     this batch". Each cel compiles only after the cel it names as its
//     compiler has compiled — so a source-defined compiler shipped in
//     the same batch as the cels that use it Just Works.
// ============================================================================

export const validateManifests = (state: State, manifests: 冊[]): void => {
  if (manifests.length === 0) return;
  const allKnown = new Map(state.segments);
  for (const m of manifests) allKnown.set(m.name, m);

  const missing: Array<{ segment: Key; needs: Key }> = [];
  for (const m of manifests) {
    for (const dep of m.dependencies) {
      if (!allKnown.has(dep)) missing.push({ segment: m.name, needs: dep });
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `hydrate: unsatisfied segment dependencies:\n` +
      missing.map((m) => `  - "${m.segment}" needs "${m.needs}"`).join("\n"),
    );
  }
};

export const inflateAllCels = (state: State, segments: 甲骨[]): void => {
  for (const seg of segments) {
    for (const dc of seg.cels) {
      const existing = state.cels.get(dc.key);
      if (existing?.locked) continue;
      if (existing) disposeCel(existing, state);
      state.cels.set(dc.key, inflateCel(dc));
    }
  }
};

const compilerKeyOf = (cel: FireableCel): Key =>
  cel.celType === "FormulaCel"
    ? cel.metadata.parser ?? "f"
    : cel.metadata.kind ?? "f";

export const compileFireable = async (state: State, segments: 甲骨[]): Promise<void> => {
  // Gather the just-inflated cels that need compiling. EditableLambdaCels
  // with a bound _compiler skip the registry path entirely; include them
  // in the batch anyway so topo order is preserved if any peer depends
  // on their compiled _fn.
  const batchKeys = new Set<Key>();
  for (const seg of segments) {
    for (const dc of seg.cels) {
      if (dc.f === undefined) continue;
      const cel = state.cels.get(dc.key);
      if (!cel || !isFireable(cel) || cel._fn) continue;
      batchKeys.add(cel.metadata.key);
    }
  }
  if (batchKeys.size === 0) return;

  // Edges: cel → its compiler, but only when the compiler is itself a
  // member of this batch (i.e. not already installed and compiled).
  // Compilers already in state.cels with _fn (or CompilerCel.v) need
  // no edge — resolveFn will find them at compile time.
  const upstream = new Map<Key, Set<Key>>();
  for (const key of batchKeys) {
    const cel = state.cels.get(key) as FireableCel;
    const compilerKey = compilerKeyOf(cel);
    const deps = new Set<Key>();
    if (batchKeys.has(compilerKey)) deps.add(compilerKey);
    upstream.set(key, deps);
  }

  const remaining = new Set(batchKeys);
  while (remaining.size > 0) {
    const ready: FireableCel[] = [];
    for (const k of remaining) {
      const deps = upstream.get(k)!;
      let satisfied = true;
      for (const d of deps) {
        if (remaining.has(d)) { satisfied = false; break; }
      }
      if (satisfied) ready.push(state.cels.get(k) as FireableCel);
    }
    if (ready.length === 0) {
      const cycle = [...remaining];
      const msg = `hydrate: compiler-dependency cycle among: ${cycle.join(", ")}`;
      appendError(state, makeCelError(cycle, "CompilerDependencyCycle", new Error(msg)));
      throw new Error(msg);
    }
    // Parallel within a topo layer: the layer barrier guarantees no
    // cel in `ready` depends on another cel in `ready`, so async
    // compilers (lazy-loaded runtimes) can interleave while sync ones
    // resolve immediately. Promise.all preserves the layer boundary.
    await Promise.all(ready.map((cel) => compileCelBody(cel, state)));
    for (const cel of ready) remaining.delete(cel.metadata.key);
  }
};

// Convenience alias preserved for back-compat — `installCels` now does
// the inflate + topo-compile two-step. Callers that previously expected
// inflate-and-compile in one shot keep working.
export const installCels = async (state: State, segments: 甲骨[]): Promise<void> => {
  inflateAllCels(state, segments);
  await compileFireable(state, segments);
};
