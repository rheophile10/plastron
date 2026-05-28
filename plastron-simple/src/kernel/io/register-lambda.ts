import type {
  Compiler, ComputeCel, EditableLambdaCel, Fn, LambdaCelMetadata, LockedLambdaCel,
  RegisterLambdaArgs, State,
} from "../../types/index.js";
import { resolveFn } from "../resolve-fn.js";
import { hasHooksOrCache, makeLambdaTrampoline } from "../hooks.js";
import { invalidate } from "../invalidate.js";

// ============================================================================
// registerLambda — runtime lambda registration. Installs a LambdaCel
// under args.key in state.cels with `_fn` populated; the cel registry
// IS the dispatch surface (resolveFn reads cel._fn). Metadata (kind,
// inputSchema, outputSchema) lives on cel.metadata; locked is cel.locked.
//
// Atomicity: pre-flight (lock, fn xor source, compiler resolution,
// compilation) runs before any state mutation. A failing
// registerLambda leaves state untouched.
//
// Dispose: a previously-registered fn at the same key has its
// cel._dispose fired (if any) before installation. The new dispose
// comes from the compiler's {fn, dispose} envelope (if used) or from
// args.dispose; compiler-supplied wins.
//
// Re-register policy: a locked cel at the same key refuses replacement;
// an unlocked LambdaCel is updated in place (preserving the cel
// reference so anything holding it sees the new fn). A non-lambda cel
// at the same key throws — kind changes must go through setCel.
// ============================================================================

export const registerLambda: Fn = async (state: State, args: RegisterLambdaArgs) => {
  // ── Pre-flight ─────────────────────────────────────────────────────────
  if (args.fn !== undefined && args.source !== undefined) {
    throw new Error(`registerLambda: "${args.key}" provides both fn and source.`);
  }
  if (args.fn === undefined && args.source === undefined) {
    throw new Error(`registerLambda: "${args.key}" needs either fn or source.`);
  }
  const existing = state.cels.get(args.key);
  if (existing?.locked) {
    throw new Error(`registerLambda: "${args.key}" is locked.`);
  }
  // After the locked guard, LockedLambdaCel is narrowed out of the
  // union (its `locked: true` is required). Anything left that isn't
  // an EditableLambdaCel is a kind mismatch we won't silently overwrite.
  if (existing && existing.celType !== "EditableLambdaCel") {
    throw new Error(
      `registerLambda: "${args.key}" exists as ${existing.celType} — kind change unsupported.`,
    );
  }

  let runtime: Fn;
  let dispose: (() => void) | undefined = args.dispose;
  if (args.fn) {
    runtime = args.fn;
  } else {
    const compilerKey = args.kind ?? "f";
    const compiler = resolveFn(state, compilerKey) as Compiler | undefined;
    if (!compiler) {
      throw new Error(
        `registerLambda: "${args.key}" needs compiler at "${compilerKey}", not registered.`,
      );
    }
    const compiled = await compiler(args.source!, state);
    if (typeof compiled === "function") {
      runtime = compiled;
    } else {
      runtime = compiled.fn;
      if (compiled.dispose) dispose = compiled.dispose; // compiler wins
    }
  }
  if (args.extractDeps) (runtime as Fn).extractDeps = args.extractDeps;

  // ── Commit ─────────────────────────────────────────────────────────────
  // Fire the previous cel's _dispose before swapping. Same pattern setCel
  // uses (cel-triple.ts ~ applyTripleAtomic) — one source of truth for
  // lambda cleanup, lives on the cel.
  if (existing?._dispose) {
    try { existing._dispose(); } catch { /* swallow */ }
    existing._dispose = undefined;
  }

  const segment = args.segment ?? "default";
  const meta: LambdaCelMetadata = { key: args.key, segment, name: args.key };
  if (args.kind         !== undefined) meta.kind         = args.kind;
  if (args.inputSchema  !== undefined) meta.inputSchema  = args.inputSchema;
  if (args.outputSchema !== undefined) meta.outputSchema = args.outputSchema;

  // Promoting an existing EditableLambdaCel to locked is a celType
  // change (Editable → Locked), so we replace rather than mutate.
  // Otherwise an unlocked re-register updates in place, preserving the
  // cel reference so anything holding it sees the new fn.
  let landed: ComputeCel;
  if (existing && !args.locked) {
    Object.assign(existing.metadata, meta);
    existing._fn = runtime;
    if (dispose) existing._dispose = dispose;
    landed = existing as ComputeCel;
  } else if (args.locked) {
    const cel: LockedLambdaCel = {
      celType: "LockedLambdaCel", metadata: meta, v: null, locked: true, _fn: runtime,
    };
    if (dispose) cel._dispose = dispose;
    state.cels.set(args.key, cel);
    landed = cel as ComputeCel;
  } else {
    const cel: EditableLambdaCel = {
      celType: "EditableLambdaCel", metadata: meta, v: null, _fn: runtime,
    };
    if (dispose) cel._dispose = dispose;
    state.cels.set(args.key, cel);
    landed = cel as ComputeCel;
  }

  // Re-wrap _fn with the hook+memo trampoline when applicable. For
  // in-place updates of an existing EditableLambdaCel, this restores
  // the trampoline that the direct _fn assignment above overwrote.
  if (hasHooksOrCache(landed) && landed._fn) {
    landed._fn = makeLambdaTrampoline(landed._fn, landed, state);
  }

  // Definition-change cache teardown — clear downstream consumers'
  // _memoCache entries that may have captured the old fn's outputs.
  invalidate(state, args.key);

  return state;
};
