import type {
  甲骨, Cel, CompileContext, CompiledEnvelope, Compiler, Fn, State, WasmHandle, WitType,
} from "../types/index.js";
import { isWitPrimitive } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { CSP_WASM_AVAILABLE_KEY } from "./csp.js";
import { readHostImports } from "./host.js";
import { fsOps } from "./file-store.js";
import seed from "./wasm-bytes.json" with { type: "json" };

// wasm-bytes — the "wasm" LockedLambdaCel whose _fn loads a *precompiled*
// WebAssembly module. The sibling to wat/py/quickjs that accepts bytes
// instead of source. Cels reference it as LambdaCel.metadata.kind = "wasm".
//
// Source flow: cel.f (the "source") holds either
//   • base64-encoded wasm bytes (inline), or
//   • "file-store:<path>" — bytes read from the file-store segment.
// → decode → `WebAssembly.instantiate(bytes, imports)` → the chosen
// export wrapped as a Fn. No assembler step: this is essentially
// wat-compiler minus the WAT→bytes pass (which already produced and
// instantiated bytes; this accepts them directly).
//
// The WIT descriptor lives on the cel's metadata, surfaced to the
// compiler through CompileContext (see hydrate/formula.ts):
//   • wasmExport    — which export to expose (else the prefer-"main"
//                     ladder, like wat-compiler).
//   • outputSchema  — composite WIT type → the export's return is kept
//                     in a module-side table and a WasmHandle returned
//                     (mirrors py-compiler main-thread mode). Primitives
//                     pass inline.
//   • imports       — cel key of a pluggable imports provider. Default
//                     imports are { host: readHostImports(state) } (same
//                     as wat); a provider merges WASI / env namespaces
//                     over that. A module needing nothing ignores them.
//
// Host access to the live instance (wasm-host-instance): a provider may
// return either a bare imports object (namespaces → fns) OR an envelope
// { imports, onInstantiate?, dispose? }. After WebAssembly.instantiate,
// onInstantiate(instance, state) fires once — handing the provider the
// live instance (every export + linear memory). This lets a host segment
// drive a multi-export / shared-memory module (call exports over its
// lifetime, read/write memory) and closes the chicken-and-egg where an
// env callback supplied *before* instantiate must read memory that
// exists only *after*. dispose flows to cel._dispose for teardown.
//
// CSP gate: when invoked with state, checks csp.wasm-available. Install
// never fails — the throw fires only when a wasm lambda tries to load.

// Composite WIT types (list / record / variant) keep their value
// module-side as a handle; primitives stay inline. Same rule as
// py-compiler's isCompositeWitType.
const isCompositeWitType = (t: WitType | undefined): boolean =>
  t !== undefined && !isWitPrimitive(t);

// WebAssembly isn't in tsconfig "lib": ["ES2023"]. Reach through
// globalThis with a structural type (csp.ts / wat-compiler.ts do the same).
type WasmInstance = { exports: Record<string, unknown> };
type WasmInstantiateResult = { instance: WasmInstance };
type WasmGlobal = {
  instantiate?: (bytes: Uint8Array, imports: Record<string, unknown>) => Promise<WasmInstantiateResult>;
};
const _wasm = (globalThis as { WebAssembly?: WasmGlobal }).WebAssembly;

// atob is present in browsers, Node 16+, and Bun. Narrow structurally.
const _atob = (globalThis as { atob?: (s: string) => string }).atob;
const decodeBase64 = (b64: string): Uint8Array => {
  if (!_atob) {
    throw new Error(`wasm-bytes: atob is unavailable in this runtime; cannot decode base64 wasm bytes.`);
  }
  const bin = _atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

// "file-store:<path>" → bytes via the file-store segment; otherwise the
// source is treated as base64-encoded wasm.
const FILE_PREFIX = "file-store:";
const resolveBytes = async (source: string): Promise<Uint8Array> => {
  const trimmed = source.trim();
  if (trimmed.startsWith(FILE_PREFIX)) {
    const path = trimmed.slice(FILE_PREFIX.length);
    return (await fsOps.read(path)) as Uint8Array;
  }
  return decodeBase64(trimmed);
};

// A provider may return a bare imports object (namespaces → fns) OR an
// envelope that also carries host-instance hooks.
interface ImportsEnvelope {
  imports: Record<string, unknown>;
  onInstantiate?: (instance: WasmInstance, state: State) => void;
  dispose?: () => void;
}
type ProviderResult = Record<string, unknown> | ImportsEnvelope;

// Envelope iff it has an own `imports` object property. The one ambiguous
// case — a module importing from a namespace literally named "imports" —
// would be misread as an envelope; documented as a reserved namespace.
const isImportsEnvelope = (r: ProviderResult): r is ImportsEnvelope => {
  const o = r as { imports?: unknown };
  return o !== null && typeof o === "object" &&
    typeof o.imports === "object" && o.imports !== null;
};

interface ResolvedImports {
  imports: Record<string, unknown>;
  onInstantiate?: (instance: WasmInstance, state: State) => void;
  dispose?: () => void;
}

// Imports: default { host } (matches wat-compiler — modules that import
// nothing ignore it; WebAssembly only rejects *missing* declared imports,
// not extra ones). A metadata.imports provider cel returns either a bare
// imports object whose namespaces merge over the default, or an envelope
// (see above) whose .imports merge and whose hooks the compiler honors.
const resolveImports = (state: State | undefined, context?: CompileContext): ResolvedImports => {
  const base: Record<string, unknown> = { host: state ? readHostImports(state) : {} };
  if (!state || !context?.imports) return { imports: base };
  const providerCel = state.cels.get(context.imports) as { _fn?: Fn } | undefined;
  const provider = providerCel?._fn;
  if (!provider) {
    throw new Error(
      `wasm-bytes: imports provider cel "${context.imports}" is not registered or has no fn.`,
    );
  }
  const result = provider(state) as ProviderResult;
  if (isImportsEnvelope(result)) {
    return {
      imports: { ...base, ...result.imports },
      onInstantiate: result.onInstantiate,
      dispose: result.dispose,
    };
  }
  return { imports: { ...base, ...result } };
};

// Module-side value table for composite returns (main-thread stand-in
// for a worker's value table). A composite cel's v becomes a WasmHandle
// { kind: "wasm", ref }; wasm-to-js dereferences + releases.
const _handles = new Map<number, unknown>();
let _nextRef = 1;

const wasmBytesLoader: Compiler = (async (
  source: string, state?: State, context?: CompileContext,
): Promise<CompiledEnvelope> => {
  if (state) {
    const wasmAvailable =
      state.cels.get(CSP_WASM_AVAILABLE_KEY)?.v as boolean | undefined;
    if (wasmAvailable === false) {
      throw new Error(
        `wasm-bytes: WebAssembly is unavailable in this environment ` +
        `(csp.wasm-available = false). This app cannot load wasm modules.`,
      );
    }
  }
  if (!_wasm?.instantiate) {
    throw new Error(`wasm-bytes: WebAssembly.instantiate is not available in this runtime.`);
  }

  // 1. Source → bytes (base64 or file-store path).
  const bytes = await resolveBytes(source);
  // Magic-header check: "\0asm". A friendlier failure than the opaque
  // CompileError WebAssembly.instantiate throws on garbage bytes (a
  // common symptom of a bad base64 string or a missing file).
  if (bytes.length < 4 ||
      bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error(
      `wasm-bytes: source did not decode to a wasm module (missing "\\0asm" header). ` +
      `Expected base64 wasm bytes or a "file-store:<path>" reference.`,
    );
  }

  // 2. Bytes → instance, against the resolved imports object. Then hand
  //    the live instance to the provider's onInstantiate hook (if any),
  //    so a host segment can drive a multi-export / shared-memory module.
  const { imports, onInstantiate, dispose } = resolveImports(state, context);
  const { instance } = await _wasm.instantiate(bytes, imports);
  if (onInstantiate && state) onInstantiate(instance, state);

  // 3. Pick the export. Explicit wasmExport wins; else prefer "main";
  //    else the single function export; else throw (ambiguous).
  const fnExports = Object.entries(instance.exports)
    .filter(([, v]) => typeof v === "function") as [string, Fn][];
  if (fnExports.length === 0) {
    throw new Error(`wasm-bytes: module has no function exports.`);
  }
  const want = context?.wasmExport;
  let fn: Fn | null;
  if (want) {
    const hit = fnExports.find(([k]) => k === want);
    if (!hit) {
      const names = fnExports.map(([k]) => k).join(", ");
      throw new Error(
        `wasm-bytes: module has no function export named "${want}" (exports: ${names}).`,
      );
    }
    fn = hit[1];
  } else {
    const main = fnExports.find(([k]) => k === "main");
    fn = main ? main[1] : fnExports.length === 1 ? fnExports[0]![1] : null;
    if (!fn) {
      const names = fnExports.map(([k]) => k).join(", ");
      throw new Error(
        `wasm-bytes: module exports multiple functions (${names}); ` +
        `set metadata.wasmExport to choose one, or name one of them "main".`,
      );
    }
  }

  // 4. WIT marshalling. Primitives pass inline (the export takes/returns
  //    JS numbers / BigInts directly). A composite outputSchema keeps the
  //    raw return module-side and surfaces a WasmHandle, deferring
  //    materialization to the wasm-to-js bridge.
  const composite = isCompositeWitType(context?.outputSchema);
  const rawFn = fn;
  const wrapped: Fn = composite
    ? (...args: unknown[]): WasmHandle => {
        const result = (rawFn as (...a: unknown[]) => unknown)(...args);
        const ref = _nextRef++;
        _handles.set(ref, result);
        return { kind: "wasm", ref, type: context!.outputSchema! };
      }
    : (...args: unknown[]) => (rawFn as (...a: unknown[]) => unknown)(...args);

  // Return an envelope so hydrate stashes bytes on cel._wasm — read by
  // the wasm-to-wat diagnostic and any future worker dispatch. A
  // provider-supplied dispose rides along to cel._dispose (teardown:
  // the host cancels its loop / frees the captured instance when the
  // cel is replaced).
  const envelope: CompiledEnvelope = { fn: wrapped, wasm: bytes };
  if (dispose) envelope.dispose = dispose;
  return envelope;
}) as Compiler;

// Bridges. js-to-wasm is identity (scalars cross cleanly). wasm-to-js
// dereferences + releases a composite handle from the module-side table;
// scalars pass through.
const jsToWasm: Fn = (v: unknown) => v;
const wasmToJs: Fn = (v: unknown) => {
  if (v !== null && typeof v === "object" &&
      (v as WasmHandle).kind === "wasm" &&
      typeof (v as WasmHandle).ref === "number") {
    const ref = (v as WasmHandle).ref;
    const stored = _handles.get(ref);
    _handles.delete(ref);
    return stored;
  }
  return v;
};

export const name = "wasm-bytes" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wasm",       wasmBytesLoader as Fn],
  ["wasm-to-js", wasmToJs],
  ["js-to-wasm", jsToWasm],
]));
