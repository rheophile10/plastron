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

/** Apply defaults for the segment-classification fields when absent.
 *  Mutates the manifest in place — manifests pass through hydrate once
 *  and live thereafter in state.segments, so in-place is fine. */
export const applyManifestDefaults = (m: 冊): void => {
  if (m.role === undefined) m.role = "library";
  // applications: left undefined when absent. Required on user-space
  // (caught by validation below); optional otherwise.
};

/** Resolve a manifest's role from the local hydrate batch first, then
 *  from already-loaded state.segments. */
const lookupRole = (
  name: Key,
  state: State,
  batch: Map<Key, 冊>,
): Key | undefined => {
  return (batch.get(name) ?? state.segments.get(name))?.role;
};

export const validateManifests = (state: State, manifests: 冊[]): void => {
  if (manifests.length === 0) return;
  for (const m of manifests) applyManifestDefaults(m);

  const batch = new Map<Key, 冊>();
  for (const m of manifests) batch.set(m.name, m);
  const allKnown = new Map(state.segments);
  for (const m of manifests) allKnown.set(m.name, m);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const m of manifests) {
    // Rule 0 (existing): every dep must be installable.
    for (const dep of m.dependencies) {
      if (!allKnown.has(dep)) {
        errors.push(`"${m.name}" needs unknown dependency "${dep}"`);
      }
    }
    // Rule 1: user-space MUST declare applications with ≥1 entry.
    if (m.role === "user-space") {
      if (!m.applications || m.applications.length === 0) {
        errors.push(`"${m.name}" (user-space) must declare \`applications\` with at least one entry`);
      } else {
        // Rule 2: each application entry must resolve to a role:application segment.
        for (const a of m.applications) {
          const ar = lookupRole(a, state, batch);
          if (ar === undefined) {
            errors.push(`"${m.name}" declares application "${a}" but no such segment is installed or in this hydrate batch`);
          } else if (ar !== "application") {
            errors.push(`"${m.name}" declares application "${a}" but that segment has role "${ar}", not "application"`);
          }
        }
      }
    }
    // Rules 3-5: dep direction must respect kernel ← library ← application ← user-space.
    const myRole = m.role!;
    for (const dep of m.dependencies) {
      const depRole = lookupRole(dep, state, batch);
      if (depRole === undefined) continue; // missing-dep error already raised above
      if (myRole === "library" && (depRole === "application" || depRole === "user-space")) {
        errors.push(`"${m.name}" (library) cannot depend on "${dep}" (${depRole}); libraries must be upstream of apps and user data`);
      }
      if (myRole === "application" && depRole === "user-space") {
        errors.push(`"${m.name}" (application) cannot depend on "${dep}" (user-space); apps don't depend on the user data inside them`);
      }
      if (myRole === "kernel" && depRole !== "kernel") {
        errors.push(`"${m.name}" (kernel) can only depend on other kernel segments; "${dep}" has role "${depRole}"`);
      }
    }
    // Library `applications` advisory mismatch check (warning, not error).
    if (m.role === "user-space" && m.applications) {
      for (const dep of m.dependencies) {
        const depManifest = batch.get(dep) ?? state.segments.get(dep);
        if (!depManifest || depManifest.role !== "library") continue;
        if (!depManifest.applications || depManifest.applications.length === 0) continue;
        const overlap = depManifest.applications.some((a) => m.applications!.includes(a));
        if (!overlap) {
          warnings.push(`"${m.name}" depends on library "${dep}" tagged for ${JSON.stringify(depManifest.applications)} but user-space targets ${JSON.stringify(m.applications)}`);
        }
      }
    }
  }

  if (warnings.length > 0) {
    // Best-effort warning surface; no formal logger in plastron-simple yet.
    // eslint-disable-next-line no-console
    console?.warn?.("hydrate: segment classification warnings:\n" + warnings.map((w) => "  - " + w).join("\n"));
  }
  if (errors.length > 0) {
    throw new Error(
      `hydrate: segment validation failed:\n` +
      errors.map((e) => `  - ${e}`).join("\n"),
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
