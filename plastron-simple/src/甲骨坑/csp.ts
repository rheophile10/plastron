import type { Cel, ValueCel } from "../types/index.js";

// ============================================================================
// csp — runtime capability probes surfaced as locked cels.
//
// Two booleans, detected once at module load and pinned into the
// kernel state by createInitialState:
//
//   • csp.eval-available — true if `new Function(...)` works. Strict CSP
//     (script-src 'self' without 'unsafe-eval') blocks it. The formula
//     codegen path and the JS lambda compiler both gate on this.
//
//   • csp.wasm-available — true if WebAssembly is reachable and the
//     minimal empty module validates. Future wasm-based compilers gate
//     on this the same way.
//
// Why cels, not module constants: querying the capability from outside
// the formula module (diagnostics UI, tests forcing the fallback path,
// future compilers that decide install-time behavior) only works when
// the value lives in state. Reads go through state.cels just like any
// other configuration; tests overwrite the locked flag via direct
// state.cels mutation when they want to exercise the false-branch.
// ============================================================================

const detectEval = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function("return 1")();
    return true;
  } catch {
    return false;
  }
};

// Minimal valid wasm binary: magic + version, no sections. Validates
// in any conformant runtime. We use WebAssembly.validate (sync) rather
// than .compile (which may be async in strict environments) so the
// probe stays sync — capability cels seed at boot, not in a Promise.
const MINIMAL_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,   // \0asm
  0x01, 0x00, 0x00, 0x00,   // version 1
]);

// WebAssembly isn't in tsconfig "lib": ["ES2023"] — reach through
// globalThis with a structural type so the probe works in both Node
// and browsers without pulling DOM types in.
type WasmGlobal = {
  validate?: (bytes: Uint8Array) => boolean;
};
const _wasm = (globalThis as { WebAssembly?: WasmGlobal }).WebAssembly;

const detectWasm = (): boolean => {
  try {
    if (!_wasm || typeof _wasm.validate !== "function") return false;
    return _wasm.validate(MINIMAL_WASM);
  } catch {
    return false;
  }
};

export const CSP_EVAL_AVAILABLE_KEY = "csp.eval-available" as const;
export const CSP_WASM_AVAILABLE_KEY = "csp.wasm-available" as const;

export const name = "csp" as const;

export const cels: Cel[] = [
  {
    celType: "ValueCel",
    metadata: { key: CSP_EVAL_AVAILABLE_KEY, segment: "csp" },
    v: detectEval(),
    locked: true,
  } satisfies ValueCel,
  {
    celType: "ValueCel",
    metadata: { key: CSP_WASM_AVAILABLE_KEY, segment: "csp" },
    v: detectWasm(),
    locked: true,
  } satisfies ValueCel,
];
