import type { 甲骨, Cel, CompiledEnvelope, Compiler, Fn, State } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { CSP_WASM_AVAILABLE_KEY } from "./csp.js";
import { readHostImports } from "./host.js";
import seed from "./wat-compiler.json" with { type: "json" };

// wat-compiler — the "wat" LockedLambdaCel whose _fn is the WebAssembly
// text-format compiler. Other cels reference it as
//   LambdaCel.metadata.kind = "wat"
//
// Source flow: WAT text → wabt.js `parseWat` → wasm bytes →
// `WebAssembly.instantiate` → exported function as Fn. The wabt module
// is dynamic-imported on first compile (~600KB); apps that don't use
// WAT pay nothing.
//
// v1 (this file): main-thread, JS-canonical. The returned Fn takes JS
// numbers/typed-arrays and returns whatever the wasm export returns
// (i32/f64 unwrap to JS number, i64 to BigInt). No memory marshalling
// for strings/objects — authors using strings hand-roll their own
// ptr+length convention. The host imports object is empty.
//
// Convention for which export to call: prefer `main`; if absent, use
// the single function export; multiple unnamed exports throw.
//
// CSP gate: when invoked with state, checks `csp.wasm-available`. The
// install itself never fails — the throw fires only when a WAT lambda
// actually tries to compile.

// wabt's types — kept structural so verbatimModuleSyntax + the CJS
// package's `export = wabt` shape don't fight each other. We import
// dynamically; this type matches what wabt 1.0.39 exposes.
interface WabtModule {
  parseWat: (filename: string, buffer: string | Uint8Array, options?: Record<string, boolean>) => WabtModuleHandle;
  readWasm: (buffer: Uint8Array, options?: Record<string, boolean>) => WabtModuleHandle;
}
interface WabtModuleHandle {
  toBinary: (options: Record<string, boolean>) => { buffer: Uint8Array; log: string };
  toText:   (options: Record<string, boolean>) => string;
  destroy:  () => void;
}

// Lazy-init wabt. Module-level singleton because the wabt instance is
// stateless and reusing it avoids re-instantiating the parser wasm on
// every compile.
let _wabt: Promise<WabtModule> | undefined;
const getWabt = (): Promise<WabtModule> => {
  if (!_wabt) {
    _wabt = import("wabt").then((m) => (m.default as () => Promise<WabtModule>)());
  }
  return _wabt;
};

// WebAssembly isn't in tsconfig "lib": ["ES2023"]. Reach through
// globalThis with a structural type so this works in both Node and
// browsers without pulling DOM types in. csp.ts does the same.
type WasmInstantiateResult = { instance: { exports: Record<string, unknown> } };
type WasmGlobal = {
  instantiate?: (bytes: Uint8Array, imports: Record<string, unknown>) => Promise<WasmInstantiateResult>;
};
const _wasm = (globalThis as { WebAssembly?: WasmGlobal }).WebAssembly;

const watCompiler: Compiler = (async (source: string, state?: State): Promise<CompiledEnvelope> => {
  if (state) {
    const wasmAvailable =
      state.cels.get(CSP_WASM_AVAILABLE_KEY)?.v as boolean | undefined;
    if (wasmAvailable === false) {
      throw new Error(
        `wat-compiler: WebAssembly is unavailable in this environment ` +
        `(csp.wasm-available = false). This app cannot compile WAT lambdas.`,
      );
    }
  }
  if (!_wasm?.instantiate) {
    throw new Error(`wat-compiler: WebAssembly.instantiate is not available in this runtime.`);
  }

  // 1. WAT text → wasm bytes via wabt.
  const wabt = await getWabt();
  const mod = wabt.parseWat("inline.wat", source, {
    multi_value: true,
    bulk_memory: true,
    sign_extension: true,
    sat_float_to_int: true,
  });
  let bytes: Uint8Array;
  try {
    bytes = mod.toBinary({}).buffer;
  } finally {
    mod.destroy();
  }

  // 2. Bytes → instance. Pass the host segment's capabilities as the
  //    "host" import namespace — wat modules opting in declare
  //    (import "host" "log" ...) etc. Without state, fall back to a
  //    minimal default (testing seam; production callers always pass
  //    state so the host overrides win).
  const hostImports = state ? readHostImports(state) : {};
  const { instance } = await _wasm.instantiate(bytes, { host: hostImports });

  // 3. Pick the function to expose. Prefer `main`; otherwise, if there's
  //    exactly one function export, use it; otherwise throw — ambiguous.
  const fnExports = Object.entries(instance.exports)
    .filter(([, v]) => typeof v === "function") as [string, Fn][];
  if (fnExports.length === 0) {
    throw new Error(`wat-compiler: module has no function exports.`);
  }
  const main = fnExports.find(([k]) => k === "main");
  const fn = main ? main[1]
    : fnExports.length === 1 ? fnExports[0]![1]
    : null;
  if (!fn) {
    const names = fnExports.map(([k]) => k).join(", ");
    throw new Error(
      `wat-compiler: module exports multiple functions (${names}); ` +
      `name one of them "main" or restrict the module to a single export.`,
    );
  }
  // Return a CompiledEnvelope so hydrate stashes the wasm bytes on
  // cel._wasm. Read by wasm-to-wat for the "Show WAT" diagnostic and
  // by future worker dispatch.
  return { fn, wasm: bytes };
}) as Compiler;

// wasm-to-wat — render any wasm module's bytes as its WAT text form.
// Useful for inspecting wat cels' compiled output (round-trip canonical
// form) and, more interestingly, for inspecting Javy / Rust-compiled
// wasm produced by other kinds. Apps build whatever UI they want on
// top; the cel just returns the text.
const wasmToWat: Fn = async (bytes: unknown): Promise<string> => {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(
      `wasm-to-wat: expected Uint8Array of wasm bytes, got ${typeof bytes}.`,
    );
  }
  const wabt = await getWabt();
  const mod = wabt.readWasm(bytes, { readDebugNames: true });
  try {
    // foldExprs gives a readable nested layout; inlineExport keeps the
    // (export "main" ...) inline with the func — both are the defaults
    // wabt's own wasm2wat CLI uses.
    return mod.toText({ foldExprs: true, inlineExport: true });
  } finally {
    mod.destroy();
  }
};

// Bridge fns — v1 identity. Scalars (i32/u32/f32/f64) survive a JS
// round trip cleanly without marshalling; WebAssembly's number type
// coercion makes JS numbers acceptable to wasm imports directly. For
// composite types and worker-based wat instances, both bridges become
// real marshalling calls into the kind worker's toJs/fromJs protocol.
// The function shape stays the same so call sites (formulas using
// `(wat-to-js x)` or `(js-to-wat x)`) don't change as composites land.
const watToJs:  Fn = (v: unknown) => v;
const jsToWat:  Fn = (v: unknown) => v;

export const name = "wat-compiler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wat",         watCompiler as Fn],
  ["wat-to-js",   watToJs],
  ["js-to-wat",   jsToWat],
  ["wasm-to-wat", wasmToWat],
]));
