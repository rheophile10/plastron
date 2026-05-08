import type { Fn, KindHandler } from "../../../plastron/src/index.js";

// ============================================================================
// plastron-eshkol — Eshkol kind handler.
//
// Hosts the Eshkol bytecode VM (a 63-opcode Scheme runtime, compiled
// to WASM via Emscripten) as a plastron lambda kind. A cel's lambda
// metadata declares `kind: "eshkol"` and ships its Scheme source in
// `metadata.source`; at hydrate the kind handler returns a fn that
// evaluates that source against the cel's resolved inputs.
//
// Calling convention:
//   • Inputs are bound via Scheme `let`, so a cel with inputMap
//     `{ x: "heat", y: "thickness" }` evaluates as
//     `(let ((x <heat>) (y <thickness>)) <source>)`.
//   • The user's source is expected to call `(display ...)` to emit
//     its result. The kind handler captures Emscripten stdout, trims
//     it, and returns the parsed value (number / boolean / string).
//   • The VM's session is global — state defined with top-level
//     `define` outside a `let` will leak across cels, so prefer
//     `let` for cel-local bindings. Self-contained one-shot programs
//     are the easy case.
//
// Loading the VM is the host's responsibility:
//   import EshkolVM from "<eshkol>/site/static/eshkol-vm.js";
//   const vm = await EshkolVM({ print, printErr });
//   state.kindRegistry.set("eshkol", createEshkolKind(vm));
//
// In Node, eshkol-vm.js is a CJS module (Emscripten MODULARIZE=1).
// Use `createRequire` from "node:module" if your example is ESM.
// ============================================================================

/** Loose shape of an Emscripten-modularized EshkolVM instance — only
 *  the bits we touch. The full Module surface is much larger. */
export interface EshkolVMModule {
  cwrap: (
    name: string,
    returnType: string | null,
    argTypes: string[],
  ) => (...args: unknown[]) => unknown;
}

export interface EshkolKindOptions {
  /** Resolved EshkolVM module instance. The host must construct it
   *  with `print` / `printErr` callbacks that push into a buffer the
   *  kind handler can read — pass that buffer's reset+read fns here. */
  vm: EshkolVMModule;
  /** Reset the captured stdout buffer to empty. Called before each
   *  evaluation so the next read sees only that call's output. */
  resetOutput: () => void;
  /** Read the captured stdout buffer's current contents. */
  readOutput: () => string;
}

/** Convert a JS value to an Eshkol literal. Handles primitives and
 *  flat arrays; falls back to `'()` for anything else. Strings get
 *  the standard Scheme escape pair. */
const toEshkol = (v: unknown): string => {
  if (v === null || v === undefined) return "'()";
  if (typeof v === "number") {
    if (Number.isFinite(v)) return String(v);
    return "+nan.0";
  }
  if (typeof v === "boolean") return v ? "#t" : "#f";
  if (typeof v === "string") {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (Array.isArray(v)) return `(list ${v.map(toEshkol).join(" ")})`;
  return "'()";
};

/** Best-effort parse of captured stdout back to a JS value. Numbers
 *  and booleans are recognized; everything else stays as the raw
 *  trimmed string so consumers can post-process if they want. */
const fromEshkolOutput = (s: string): unknown => {
  const t = s.trim();
  if (t === "")   return null;
  if (t === "#t") return true;
  if (t === "#f") return false;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (!Number.isNaN(n)) return n;
  }
  return t;
};

/** Build the kind handler. The same handler is shared across every
 *  eshkol-kind cel; per-cel state goes into the closure inside
 *  `compile`. */
export const createEshkolKind = (opts: EshkolKindOptions): KindHandler => {
  const { vm, resetOutput, readOutput } = opts;
  const evalFn = vm.cwrap("repl_eval", "string", ["string"]) as (src: string) => string;

  return {
    compile: ({ meta }) => {
      const source = meta.source ?? "";

      const fn: Fn = (inputs: Record<string, unknown>) => {
        const entries = Object.entries(inputs ?? {});
        const bindings = entries
          .map(([k, v]) => `(${k} ${toEshkol(v)})`)
          .join(" ");
        const wrapped = bindings.length > 0
          ? `(let (${bindings}) ${source})`
          : source;

        resetOutput();
        evalFn(wrapped);
        return fromEshkolOutput(readOutput());
      };

      return { fn };
    },
  };
};

// Helper consumers can use to wire up Module print capture cleanly.
export interface OutputCapture {
  print: (s: string) => void;
  printErr: (s: string) => void;
  reset: () => void;
  read: () => string;
}

/** Build a stdout capture suitable for passing as Emscripten Module
 *  options (`print` / `printErr`). The companion `reset` / `read`
 *  helpers are what `createEshkolKind` consumes. */
export const createOutputCapture = (): OutputCapture => {
  let buf = "";
  return {
    print:    (s) => { buf += s + "\n"; },
    printErr: (s) => { buf += s + "\n"; },
    reset:    ()  => { buf = ""; },
    read:     ()  => buf,
  };
};
