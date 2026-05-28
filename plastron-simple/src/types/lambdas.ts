import type { Key } from "./index.js";
import type { Cel, ComputeCel, ComputeCelMetadata } from "./cels.js";

export type ResolvedInputs = Record<string, Cel | undefined | Array<Cel | undefined>>;

export interface LambdaCelMetadata extends ComputeCelMetadata {
  kind?: string;
  filename?: string;
  inputSchema?: Key;
  outputSchema?: Key;
  /** kind:"wasm" only — which module export to expose as the cel's Fn.
   *  Absent → the compiler's export ladder (prefer "main", else the
   *  single export, else error). See wasm-bytes segment. */
  wasmExport?: string;
  /** kind:"wasm" only — cel key of an imports-provider fn `(state) =>
   *  WebAssembly imports object`. Merged over the default `{ host }`
   *  namespace at instantiate (WASI / env shims). Absent → host only. */
  imports?: Key;
}

export interface EditableLambdaCel extends ComputeCel {
  celType: "EditableLambdaCel";
  metadata: LambdaCelMetadata;
  _compiler?: Recompile;
}

export interface LockedLambdaCel extends ComputeCel {
  celType: "LockedLambdaCel";
  metadata: LambdaCelMetadata;
  locked: true;
}

export type LambdaCel = EditableLambdaCel | LockedLambdaCel;

export interface Fn<_I = unknown, O = unknown> {
  (...args: any[]): O | Promise<O>;
  extractDeps?: (source: string) => Key[];
}

export interface CompiledEnvelope {
  fn: Fn;
  dispose?: () => void;
  buildEvaluate?: (
    inputs: ResolvedInputs,
    cspEvalAvailable: boolean,
  ) => (() => unknown) | Promise<() => unknown>;
  /** Optional wasm bytes produced by the compiler. wat-compiler emits
   *  the wabt binary output here; future javy/rust compilers do the
   *  same. Stored on cel._wasm at hydrate so "Show WAT" diagnostics
   *  (wasm-to-wat) can read it without re-running the compile, and so
   *  a future worker dispatch can transfer the bytes once rather than
   *  recompiling per worker. */
  wasm?: Uint8Array;
}

export type CompiledLambda = Fn | CompiledEnvelope;

/** Per-compile context. Carries cel-level hints the compiler needs to
 *  produce a per-cel-customized wrapper Fn. v1 entry: outputSchema, the
 *  WIT type a wasm-kind cel declares its output as. Compilers that
 *  recognize composite WIT types (py-compiler, future quickjs/wat) can
 *  emit a wrapper that keeps the value in the kind's worker-side table
 *  and returns a WasmHandle on cel.v, deferring the JS materialization
 *  until an explicit bridge cel fires. Compilers that don't care can
 *  ignore the context. */
export interface CompileContext {
  outputSchema?: import("./wit.js").WitType;
  /** kind:"wasm" — the named export the cel exposes (from
   *  metadata.wasmExport). The wasm-bytes compiler selects this export
   *  instead of running its prefer-"main" ladder. */
  wasmExport?: string;
  /** kind:"wasm" — cel key of an imports-provider fn (from
   *  metadata.imports). The wasm-bytes compiler calls it to obtain the
   *  WebAssembly imports object for instantiation. */
  imports?: Key;
}

export interface Compiler extends Fn {
  // `state` is optional so older compilers written before the gate-on-
  // state pattern existed remain assignable. State-aware compilers (e.g.
  // js-compiler reading `csp.eval-available`) accept it; pure ones
  // ignore it. compileCelBody and registerLambda always pass state.
  // `context` is the per-compile hint set (see above). Optional; absent
  // means "compile with no special wrapper behavior" — same as v1.
  (
    source: string,
    state?: import("./state.js").State,
    context?: CompileContext,
  ): CompiledLambda | Promise<CompiledLambda>;
  extractDeps?: (source: string) => Key[];
}

export type Recompile = (source: string) => Fn;
