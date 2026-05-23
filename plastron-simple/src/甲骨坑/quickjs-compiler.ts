import type { 甲骨, Cel, Compiler, Fn, State } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { CSP_WASM_AVAILABLE_KEY } from "./csp.js";
import { readHostImports } from "./host.js";
import seed from "./quickjs-compiler.json" with { type: "json" };

// quickjs-compiler — the "quickjs" LockedLambdaCel whose _fn compiles JS
// source into a runtime Fn via quickjs-emscripten. Other cels reference
// it as
//   LambdaCel.metadata.kind = "quickjs"
//
// Source convention: the source's last expression must evaluate to a
// callable. The natural pattern is:
//
//   ((a, b) => a + b)
//
// or with `function`:
//
//   function add(a, b) { return a + b }
//   add
//
// We evaluate the source in the shared VM and hold the resulting
// function handle for the lifetime of the cel.
//
// Substitutes for Javy in v1 (same QuickJS interpreter; npm-native
// distribution). The runtime is dynamic-imported on first compile
// (~1MB wasm) and reused across all quickjs cels — same shared-runtime
// pattern as py-compiler + Pyodide.
//
// v1 — main-thread, no dispose. fnHandles leak when cel.f changes;
// memory is freed when the process exits. v2 with worker isolation
// owns proper teardown.

// Minimal subset of the quickjs-emscripten API we touch. The full
// types pull in extensive QuickJS-related declarations; structural
// narrowing keeps plastron-simple lean. Maps to the actual shape of
// QuickJSContext / QuickJSHandle / QuickJSWASMModule.
interface QuickJSHandle {
  dispose: () => void;
}
interface QuickJSContext {
  evalCode: (code: string, filename?: string) => { value?: QuickJSHandle; error?: QuickJSHandle };
  unwrapResult: (r: { value?: QuickJSHandle; error?: QuickJSHandle }) => QuickJSHandle;
  callFunction: (
    fn: QuickJSHandle, thisVal: QuickJSHandle, ...args: QuickJSHandle[]
  ) => { value?: QuickJSHandle; error?: QuickJSHandle };
  newNumber: (n: number) => QuickJSHandle;
  newString: (s: string) => QuickJSHandle;
  newObject: () => QuickJSHandle;
  newFunction: (
    name: string,
    impl: (...args: QuickJSHandle[]) => QuickJSHandle | void,
  ) => QuickJSHandle;
  setProp: (target: QuickJSHandle, key: string, value: QuickJSHandle) => void;
  dump: (handle: QuickJSHandle) => unknown;
  typeof: (handle: QuickJSHandle) => string;
  global: QuickJSHandle;
  undefined: QuickJSHandle;
  null: QuickJSHandle;
  true: QuickJSHandle;
  false: QuickJSHandle;
}
interface QuickJSModule {
  newContext: () => QuickJSContext;
}

// Lazy-init the runtime + a shared context. One context across all
// quickjs cels — same model as Pyodide's single interpreter, same
// sandbox guarantees (no DOM, no eval, no host APIs unless the host
// segment grants them). Distinct cels' functions live in the same
// global namespace; we don't bother with module-style isolation in v1.
let _ctx: Promise<QuickJSContext> | undefined;
const getCtx = (): Promise<QuickJSContext> => {
  if (!_ctx) {
    _ctx = import("quickjs-emscripten").then(async (m) => {
      const QuickJS = await (m as unknown as {
        getQuickJS: () => Promise<QuickJSModule>;
      }).getQuickJS();
      return QuickJS.newContext();
    });
  }
  return _ctx;
};

// Marshal a JS value into a QuickJSHandle. v1 supports scalars +
// null/undefined; composites (arrays, plain objects) fall through to
// JSON-serialize → newString → JSON.parse inside the VM, which is
// lossy for functions / Dates / typed arrays but covers everyday cases.
const marshalToHandle = (vm: QuickJSContext, v: unknown): QuickJSHandle => {
  if (v === null) return vm.null;
  if (v === undefined) return vm.undefined;
  switch (typeof v) {
    case "number":  return vm.newNumber(v);
    case "string":  return vm.newString(v);
    case "boolean": return v ? vm.true : vm.false;
    default: {
      // Composite fallback. Stringify on the JS side, evaluate
      // JSON.parse inside the VM to get a native QuickJS object.
      const json = JSON.stringify(v);
      const parseResult = vm.evalCode(`JSON.parse(${JSON.stringify(json)})`);
      return vm.unwrapResult(parseResult);
    }
  }
};

// Bind host capabilities (console.log, now, …) into the VM's global
// scope under a `host` object. The VM is a module-level singleton, so
// host bindings persist across compiles; re-binding every compile is
// the simplest way to honor the current state's host swaps (testing,
// per-app capability scoping). Bindings are cheap relative to the
// actual compile work.
const bindHost = (vm: QuickJSContext, state: State): void => {
  const host = readHostImports(state);
  const hostHandle = vm.newObject();
  for (const [name, hostFn] of Object.entries(host)) {
    const wrapped = vm.newFunction(name, (...handles): QuickJSHandle => {
      const args = handles.map((h) => vm.dump(h));
      const result = (hostFn as (...a: unknown[]) => unknown)(...args);
      return marshalToHandle(vm, result);
    });
    vm.setProp(hostHandle, name, wrapped);
    wrapped.dispose();
  }
  vm.setProp(vm.global, "host", hostHandle);
  hostHandle.dispose();
};

const quickjsCompiler: Compiler = (async (source: string, state?: State): Promise<Fn> => {
  if (state) {
    const wasmAvailable =
      state.cels.get(CSP_WASM_AVAILABLE_KEY)?.v as boolean | undefined;
    if (wasmAvailable === false) {
      throw new Error(
        `quickjs-compiler: WebAssembly is unavailable in this environment ` +
        `(csp.wasm-available = false). QuickJS cannot run.`,
      );
    }
  }

  const vm = await getCtx();
  if (state) bindHost(vm, state);

  const evalResult = vm.evalCode(source);
  if (evalResult.error) {
    const errStr = JSON.stringify(vm.dump(evalResult.error));
    evalResult.error.dispose();
    throw new Error(`quickjs-compiler: source evaluation failed: ${errStr}`);
  }
  const fnHandle = vm.unwrapResult(evalResult);
  const t = vm.typeof(fnHandle);
  if (t !== "function") {
    fnHandle.dispose();
    throw new Error(
      `quickjs-compiler: source's last expression evaluated to ${t}, not a function.`,
    );
  }

  // Hold fnHandle for the cel's lifetime. v1 leaks on cel.f change;
  // v2 worker isolation handles teardown via worker termination.
  return ((...args: unknown[]) => {
    const argHandles = args.map((a) => marshalToHandle(vm, a));
    try {
      const callRes = vm.callFunction(fnHandle, vm.undefined, ...argHandles);
      if (callRes.error) {
        const errStr = JSON.stringify(vm.dump(callRes.error));
        callRes.error.dispose();
        throw new Error(`quickjs runtime error: ${errStr}`);
      }
      const resultHandle = vm.unwrapResult(callRes);
      try {
        return vm.dump(resultHandle);
      } finally {
        resultHandle.dispose();
      }
    } finally {
      // Only dispose handles we allocated (newNumber/newString return
      // fresh handles; vm.undefined/null/true/false are shared singletons
      // — disposing them is a runtime-side no-op but be defensive).
      for (const h of argHandles) {
        if (h !== vm.undefined && h !== vm.null && h !== vm.true && h !== vm.false) {
          h.dispose();
        }
      }
    }
  }) as Fn;
}) as Compiler;

// Bridges — v1 identity. The wrapper Fn already converts via vm.dump
// at call boundary, so values arriving at cel.v are already native JS.
// Same future-proofing story as wat-to-js / py-to-js.
const quickjsToJs: Fn = (v) => v;
const jsToQuickjs: Fn = (v) => v;

export const name = "quickjs-compiler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["quickjs",        quickjsCompiler as Fn],
  ["quickjs-to-js",  quickjsToJs],
  ["js-to-quickjs",  jsToQuickjs],
]));
