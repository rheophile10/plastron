import type {
  CompileContext, CompiledLambda, Compiler, FireableCel, Key, Schema,
  State, WitType,
} from "../../../types/index.js";
import { resolveFn } from "../../resolve-fn.js";
import { appendError, makeCelError } from "../../../甲骨坑/cel-error.js";
import { COMPILE_CACHE_KEY } from "../../../甲骨坑/kernel-internal.js";

// Resolve a cel's metadata.outputSchema → WitType, when the schema is
// wasm-kind. Returns undefined for missing schema, non-wasm schema
// (Zod), or a wasm-kind schema with no wit type set. Compilers that
// honor composite WIT output schemas (py-compiler, future quickjs/wat)
// read this through CompileContext to decide handle-vs-marshal.
const resolveOutputWitType = (cel: FireableCel, state: State): WitType | undefined => {
  const md = cel.metadata as { outputSchema?: Key };
  const schemaKey = md.outputSchema;
  if (!schemaKey) return undefined;
  const schemaCel = state.cels.get(schemaKey);
  if (!schemaCel) return undefined;
  const schema = schemaCel.v as Schema | undefined;
  if (!schema || schema.kind !== "wasm" || !schema.wit) return undefined;
  return schema.wit;
};

// Formula hydration — compile a fireable cel's source body (cel.f)
// into the runtime closure stored on cel._fn / cel._buildEvaluate.
//
// Compiler-key dispatch is celType-narrowed:
//   FormulaCel        → metadata.parser (defaults to "f"; names the
//                       parser/compiler cel that turns the formula
//                       source into a CompiledEnvelope)
//   EditableLambdaCel → metadata.kind   (the source language tag
//                       doubles as the compiler key)
//   LockedLambdaCel   → never has source (no compile pass needed)
const resolveCompilerKey = (cel: FireableCel): Key => {
  if (cel.celType === "FormulaCel") return cel.metadata.parser ?? "f";
  return cel.metadata.kind ?? "f";
};

const writeBackCompilerKey = (cel: FireableCel, key: Key): void => {
  if (cel.celType === "FormulaCel") cel.metadata.parser = key;
  else cel.metadata.kind = key;
};

export const compileCelBody = async (cel: FireableCel, state: State): Promise<void> => {
  if (cel.f === undefined) return;

  // EditableLambdaCel._compiler is a bound Recompile fn — an editor
  // surface installs it to skip the cel-registry lookup on source
  // edits. Recompile returns Fn directly (no envelope), so dispose /
  // buildEvaluate are intentionally unavailable on this path; the
  // editor owns those concerns itself if it cares. Stays sync — the
  // async story is for registry-path compilers that need lazy-loaded
  // runtimes (Javy, wabt.js, Pyodide); those don't fit Recompile.
  if (cel.celType === "EditableLambdaCel" && cel._compiler) {
    cel._fn = cel._compiler(cel.f);
    return;
  }

  const compilerKey = resolveCompilerKey(cel);
  const compiler = resolveFn(state, compilerKey) as Compiler | undefined;
  if (!compiler) {
    // Configuration error — the segment authoring is wrong, not the
    // cel's content. Still throws so the developer sees it during boot
    // rather than getting a silent CelError per cel. Log too so the
    // host can enumerate every missing-compiler hit if there are
    // several.
    const msg =
      `Cel "${cel.metadata.key}" has source but no compiler is registered ` +
      `at cel key "${compilerKey}".`;
    appendError(state, makeCelError([cel.metadata.key], "MissingCompilerError", new Error(msg)));
    throw new Error(msg);
  }

  // Per-compile context: cel-level hints that affect the compiled
  // wrapper. outputSchema lets composite-wasm compilers (py with
  // worker, future kinds) build a wrapper that returns a WasmHandle
  // instead of eagerly marshalling. Two cels with the same source but
  // different outputSchemas need separate envelopes, so the cache key
  // includes a stable serialization of the context.
  const outputSchema = resolveOutputWitType(cel, state);
  const context: CompileContext = outputSchema ? { outputSchema } : {};
  const ctxKey = outputSchema ? `|${JSON.stringify(outputSchema)}` : "";

  // Compile cache lookup. Same (kind, source, context) triple → same
  // envelope. The cache stores *Promises*: two cels in the same topo
  // layer with identical source would otherwise both miss, both invoke
  // the compiler, and one overwrites the other in the cache — defeating
  // the dedupe. With promise caching, the second cel awaits the first's
  // in-flight compile. On rejection we evict so a retry isn't stuck on
  // a permanently-rejected promise.
  const cache = state.cels.get(COMPILE_CACHE_KEY)?.v as
    | Map<string, Promise<CompiledLambda>>
    | undefined;
  const cacheKey = `${compilerKey}:${cel.f}${ctxKey}`;

  let compiledP: Promise<CompiledLambda> | undefined = cache?.get(cacheKey);
  if (compiledP === undefined && cache) {
    compiledP = (async (): Promise<CompiledLambda> => {
      try {
        return (await compiler(cel.f, state, context)) as CompiledLambda;
      } catch (e) {
        // Evict so the next compile attempt (e.g., after the author
        // fixes the source) starts fresh.
        cache.delete(cacheKey);
        throw e;
      }
    })();
    cache.set(cacheKey, compiledP);
  } else if (compiledP === undefined) {
    // No cache cel installed — fall through to direct invocation.
    compiledP = Promise.resolve(compiler(cel.f, state, context)) as Promise<CompiledLambda>;
  }

  // Trap-as-value at compile time. If the compiler throws (bad WAT
  // syntax, malformed JS, missing import, …) the cel's v becomes a
  // CelError and the cel skips fn-binding — it stays in-error for the
  // life of the hydrate. Downstream cels see the error value at fire
  // time and propagate. Without this, one bad cel aborts hydrate of the
  // entire segment, which is hostile to incremental authoring.
  //
  // Note: a missing compiler (above) still throws — that's a setup
  // mistake, not data corruption. Same for "parser doesn't emit an
  // envelope" below — it's a configuration / contract issue. We only
  // catch errors thrown *from inside the compiler* on actual sources.
  let compiled: CompiledLambda;
  try {
    compiled = await compiledP;
  } catch (e) {
    const ce = makeCelError([cel.metadata.key], "CompileError", e);
    appendError(state, ce);
    cel.v = ce;
    return;
  }

  // FormulaCel contract: the parser must emit a CompiledEnvelope that
  // carries buildEvaluate. The formula fast path in runCycle relies on
  // it; a bare Fn (or an envelope without buildEvaluate) means the cel
  // would silently fall off the fast path. Catch it here instead.
  if (cel.celType === "FormulaCel") {
    if (typeof compiled === "function" || !compiled.buildEvaluate) {
      throw new Error(
        `FormulaCel "${cel.metadata.key}" uses parser "${compilerKey}", ` +
        `but that parser does not emit a CompiledEnvelope with ` +
        `buildEvaluate. Use a formula-shaped parser (e.g. the default "f").`,
      );
    }
  }
  if (typeof compiled === "function") {
    cel._fn = compiled;
  } else {
    cel._fn = compiled.fn;
    if (compiled.dispose)        cel._dispose       = compiled.dispose;
    if (compiled.buildEvaluate)  cel._buildEvaluate = compiled.buildEvaluate;
    if (compiled.wasm)           cel._wasm          = compiled.wasm;
  }
  writeBackCompilerKey(cel, compilerKey);
  // Auto-populate inputMap only for compilers that supply extractDeps
  // (formula parsers). Lambda compilers (js, py, wat, quickjs) have
  // no source-level introspection — leaving inputMap undefined keeps
  // the lambda out of the cascade unless the author explicitly opts
  // in via metadata.inputMap or dynamic. Otherwise empty-inputMap
  // lambdas would fire on every cycle with an empty inputs object,
  // and kinds that take positional args (Python) would fail when
  // handed a stray `{}`.
  if (compiler.extractDeps) {
    if (!cel.metadata.inputMap) cel.metadata.inputMap = {};
    for (const dep of compiler.extractDeps(cel.f)) {
      if (!(dep in cel.metadata.inputMap)) cel.metadata.inputMap[dep] = dep;
    }
  }
};
