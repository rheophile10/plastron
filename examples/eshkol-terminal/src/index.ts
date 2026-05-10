// ============================================================================
// EXAMPLE — Eshkol from a terminal.
//
// Hydrates a small reactive graph whose lambda cels run Eshkol code
// through the bytecode VM (eshkol-vm.wasm). Demonstrates:
//
//   • plastron-eshkol's compiler registered at state.fns.get("eshkol")
//   • Inputs marshaled into Scheme `let` bindings
//   • A formula cel feeding two Eshkol cels
//   • Automatic differentiation in WASM (∂(x²)/∂x at a chosen x)
//
// HOW TO RUN:
//   cd examples/eshkol-terminal && npm install && npm start
// ============================================================================

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import {
  createEshkolCompiler,
  createOutputCapture,
  type EshkolVMModule,
} from "../../../segments/plastron-eshkol/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const eshkolVmJs = resolve(here, "../../../../eshkol/site/static/eshkol-vm.js");

// eshkol-vm.js is an Emscripten CJS module. From an ESM file we load
// it via createRequire and let it find its sibling .wasm by absolute
// path (locateFile). The same eshkol/ checkout lives at ../eshkol/
// next to the plastron repo.
const require = createRequire(import.meta.url);
const EshkolVM = require(eshkolVmJs) as
  (opts: Record<string, unknown>) => Promise<EshkolVMModule>;

const capture = createOutputCapture();
const vm = await EshkolVM({
  print:    capture.print,
  printErr: capture.printErr,
  // Resolve the .wasm sibling relative to the .js file path.
  locateFile: (path: string) =>
    path.endsWith(".wasm") ? resolve(here, "../../../../eshkol/site/static/", path) : path,
});

// Smoke-test the VM independently of plastron — confirms wiring before
// the kernel touches it.
capture.reset();
const evalFn = vm.cwrap("repl_eval", "string", ["string"]) as (src: string) => string;
evalFn("(display (+ 1 2 3))");
console.log(`[smoke] (display (+ 1 2 3)) → ${capture.read().trim()}`);

// ============================================================================
// Build the reactive graph.
//
//   • cel "x"            — number, default 3
//   • cel "square"       — Eshkol cel that evaluates (display (* x x))
//   • cel "derivAtX"     — Eshkol cel that evaluates the AD primitive
//                          (display (derivative (lambda (t) (* t t)) x))
//
// Each lambda's metadata declares kind: "eshkol" so hydrate auto-
// compiles the source via the compiler registered at state.fns.get("eshkol").
// ============================================================================

const state = createInitialState();
state.fns.set("eshkol", createEshkolCompiler({
  vm,
  resetOutput: capture.reset,
  readOutput:  capture.read,
}));

const segment: Segment = {
  key: "eshkol-demo",
  cels: [
    { key: "x",          v: 3, segment: "eshkol-demo" },
    {
      key: "square",
      segment: "eshkol-demo",
      l: "esk:square",
      inputMap: { x: "x" },
    },
    {
      key: "derivAtX",
      segment: "eshkol-demo",
      l: "esk:derivAtX",
      inputMap: { x: "x" },
    },
  ],
  fnMetaData: {
    "esk:square": {
      key:    "esk:square",
      kind:   "eshkol",
      source: "(display (* x x))",
    },
    "esk:derivAtX": {
      key:    "esk:derivAtX",
      kind:   "eshkol",
      source: "(display (derivative (lambda (t) (* t t)) x))",
    },
  },
};

const hydrate  = state.fns.get("hydrate")  as Fn;
const runCycle = state.fns.get("runCycle") as Fn;
const set      = state.fns.get("set")      as Fn;

hydrate(state, [segment], [new Map()]);
await runCycle(state);

const show = (label: string, st: State): void => {
  console.log(label);
  console.log(`  x        = ${st.cels.get("x")?.v}`);
  console.log(`  square   = ${st.cels.get("square")?.v}`);
  console.log(`  ∂(t²)/∂t = ${st.cels.get("derivAtX")?.v}`);
};

show("\nfirst cycle", state);

await set(state, "x", 5);
show("\nafter set(x=5)", state);

await set(state, "x", 10);
show("\nafter set(x=10)", state);

console.log("\ndone.");
