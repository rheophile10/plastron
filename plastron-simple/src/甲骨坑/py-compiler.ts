import type {
  甲骨, Cel, CompileContext, Compiler, Fn, Key, State, WasmHandle, WitType,
} from "../types/index.js";
import { isWitPrimitive } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { CSP_WASM_AVAILABLE_KEY } from "./csp.js";
import { readHostImports } from "./host.js";
import seed from "./py-compiler.json" with { type: "json" };

// Composite WIT types (list / record / variant) tell us the cel's
// value should stay as a handle into the kind's worker / runtime,
// rather than being eagerly marshalled to a JS value. Primitives stay
// inline.
const isCompositeWitType = (t: WitType | undefined): boolean =>
  t !== undefined && !isWitPrimitive(t);

// py-compiler — the "py" LockedLambdaCel whose _fn compiles Python source
// into a runtime Fn via Pyodide. Other cels reference it as
//   LambdaCel.metadata.kind = "py"
//
// Source convention: the source must be valid Python that, when run,
// leaves a callable as the value of its last expression. The natural
// pattern is a `def` followed by the bare name:
//
//   def double(x):
//       return x * 2
//   double
//
// pyodide.runPython returns the value of the source's last expression,
// which becomes the Fn we expose.
//
// Two modes — main-thread (default) and worker-isolated. Selected by
// the `py.worker-mode` boolean cel:
//
//   • py.worker-mode = false  (default): in-process Pyodide. Compiles
//     and calls are sync after lazy-load. Host fns swap freely from
//     state.cels (tests use this). Compatible with all existing
//     tests / pictograph.
//
//   • py.worker-mode = true: spawns a Node worker_threads worker (one
//     per process), loads Pyodide there. Compiles and calls become
//     postMessage round-trips returning Promises. CPU isolation: a
//     runaway lambda doesn't freeze main. py.ready actually transitions
//     false → true. Worker-side host impls are baked in (no late
//     swapping — Phase 4 may add async proxies back to main).
//
// Pyodide is heavy (~6MB on disk, ~5s boot). The runtime is dynamic-
// imported on first compile in either mode.

// Minimal subset of the Pyodide API we touch. Full pyodide.d.ts pulls
// in extensive web-platform types we don't want, so we type-narrow at
// the boundary.
interface PyProxyLike {
  toJs: (options?: { depth?: number }) => unknown;
  destroy?: () => void;
}
interface PyodideAPI {
  runPython: (code: string) => unknown;
  toPy: (v: unknown) => unknown;
  globals: { set: (name: string, value: unknown) => void };
}
const isPyProxyLike = (v: unknown): v is PyProxyLike =>
  v !== null && typeof v === "object" &&
  typeof (v as { toJs?: unknown }).toJs === "function";

// ── main-thread mode ────────────────────────────────────────────────────────

let _pyodide: Promise<PyodideAPI> | undefined;
const getPyodide = (): Promise<PyodideAPI> => {
  if (!_pyodide) {
    _pyodide = import("pyodide").then(
      (m) => (m as unknown as {
        loadPyodide: (opts?: Record<string, unknown>) => Promise<PyodideAPI>;
      }).loadPyodide(),
    );
  }
  return _pyodide;
};

// Module-level handle table for main-thread mode. Composite py cels'
// values are stored here, keyed by ref; the WasmHandle on cel.v
// points back via { kind: "py", ref }. The py-to-js bridge reads from
// this map (or sends a to-js message to the worker, in worker mode).
const _mainHandles = new Map<number, unknown>();
let _nextMainHandleRef = 1;

/** Resolve handle args back to their stored PyProxies before calling
 *  Python. Symmetric with the worker-side resolver. */
const dereferenceHandles = (args: unknown[]): unknown[] =>
  args.map((a) => {
    if (a !== null && typeof a === "object" &&
        (a as WasmHandle).kind === "py" &&
        typeof (a as WasmHandle).ref === "number") {
      return _mainHandles.get((a as WasmHandle).ref);
    }
    return a;
  });

const compileMainThread = async (source: string, state?: State, context?: CompileContext): Promise<Fn> => {
  const py = await getPyodide();
  if (state) py.globals.set("host", readHostImports(state));
  const pyFn = py.runPython(source);
  if (pyFn === null || pyFn === undefined) {
    throw new Error(
      `py-compiler: source did not produce a callable. The last ` +
      `expression must evaluate to a function (e.g. a bare ` +
      `function name after a 'def').`,
    );
  }
  if (typeof pyFn !== "function") {
    throw new Error(
      `py-compiler: source's last expression evaluated to a ` +
      `${typeof pyFn}, not a callable.`,
    );
  }
  const composite = isCompositeWitType(context?.outputSchema);
  return ((...args: unknown[]) => {
    const deref = dereferenceHandles(args);
    const result = (pyFn as (...a: unknown[]) => unknown)(...deref);
    if (composite) {
      // Keep the result alive in the main-thread handle table.
      // cel.v becomes a WasmHandle the bridge can dereference later.
      const ref = _nextMainHandleRef++;
      _mainHandles.set(ref, result);
      const handle: WasmHandle = {
        kind: "py",
        ref,
        type: context!.outputSchema!,
      };
      return handle;
    }
    if (isPyProxyLike(result)) {
      const js = result.toJs({ depth: -1 });
      result.destroy?.();
      return js;
    }
    return result;
  }) as Fn;
};

// ── worker mode (Node worker_threads) ──────────────────────────────────────

// Structural Worker type — covers both node:worker_threads.Worker and
// browser Worker. We only use postMessage + on("message"|"error") +
// terminate.
interface WorkerLike {
  postMessage: (msg: unknown) => void;
  on?: (event: string, handler: (data: unknown) => void) => void;
  addEventListener?: (event: string, handler: (e: { data?: unknown }) => void) => void;
  terminate: () => Promise<void> | number;
}

interface PyWorkerHandle {
  worker: WorkerLike;
  /** Resolves once the worker's first "ready" message arrives. */
  ready: Promise<void>;
  /** Pending request map. Reqs send an id; responses match. */
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
  nextId: number;
  /** Optional state hook the worker uses to flip py.ready / push to
   *  py.errors when it sees worker events. Set by spawnWorker via a
   *  closure over the spawning state. */
}

let _workerHandle: PyWorkerHandle | undefined;

const isNode = (() => {
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return typeof g.process?.versions?.node === "string";
})();

const spawnWorker = async (state: State | undefined): Promise<PyWorkerHandle> => {
  if (!isNode) {
    throw new Error(
      `py-compiler (worker-mode): browser Worker spawn isn't wired in v1. ` +
      `Run with py.worker-mode = false in browser, or run in Node.`,
    );
  }
  const { Worker } = await import("node:worker_threads");
  const { fileURLToPath } = await import("node:url");
  // The compiled worker file is the sibling py-worker.js (tsc output).
  // import.meta.url points at the running py-compiler.js in dist/.
  const workerPath = fileURLToPath(new URL("./py-worker.js", import.meta.url));
  const worker = new Worker(workerPath) as unknown as WorkerLike;

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let resolveReady: () => void;
  let rejectReady: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });

  const handleMessage = (raw: unknown) => {
    const msg = raw as Record<string, unknown> & { kind?: string; id?: number };
    if (msg.kind === "ready") {
      if (state) {
        const readyCel = state.cels.get("py.ready");
        if (readyCel) readyCel.v = true;
      }
      resolveReady();
      return;
    }
    if (msg.id === undefined) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.kind === "ok") {
      // Resolve with the WHOLE message (minus kind/id) so callers can
      // distinguish scalar (`{ value }` or `{ fnRef }`) from composite
      // (`{ handle: { ref } }`) responses.
      slot.resolve(msg);
    } else if (msg.kind === "error") {
      const err = new Error((msg.message as string | undefined) ?? "py-worker error");
      if (msg.stack) err.stack = msg.stack as string;
      slot.reject(err);
    }
  };

  // Node worker_threads uses on("message"); browser Workers use
  // addEventListener("message", e => e.data).
  if (worker.on) {
    worker.on("message", handleMessage);
    worker.on("error", (e: unknown) => {
      // Worker died catastrophically. Reject every pending request,
      // mark py.alive false, surface a CelError on py.errors.
      if (state) {
        const alive = state.cels.get("py.alive");
        if (alive) alive.v = false;
      }
      const err = e instanceof Error ? e : new Error(String(e));
      for (const slot of pending.values()) slot.reject(err);
      pending.clear();
      rejectReady(err);
    });
  } else if (worker.addEventListener) {
    worker.addEventListener("message", (e) => handleMessage(e.data));
  }

  // Reset py.ready to false at spawn (worker is booting Pyodide).
  if (state) {
    const readyCel = state.cels.get("py.ready");
    if (readyCel) readyCel.v = false;
  }

  return { worker, ready, pending, nextId: 1 };
};

const getWorker = async (state: State | undefined): Promise<PyWorkerHandle> => {
  if (!_workerHandle) _workerHandle = await spawnWorker(state);
  await _workerHandle.ready;
  return _workerHandle;
};

const workerRequest = (
  handle: PyWorkerHandle,
  msg: { kind: string; [k: string]: unknown },
): Promise<unknown> => {
  const id = handle.nextId++;
  const fullMsg = { ...msg, id };
  return new Promise((resolve, reject) => {
    handle.pending.set(id, { resolve, reject });
    handle.worker.postMessage(fullMsg);
  });
};

const compileWorker = async (source: string, state?: State, context?: CompileContext): Promise<Fn> => {
  const handle = await getWorker(state);
  const composite = isCompositeWitType(context?.outputSchema);
  const compileReply = (await workerRequest(
    handle,
    { kind: "compile", source, composite },
  )) as { fnRef: number };
  const fnRef = compileReply.fnRef;
  return (async (...args: unknown[]): Promise<unknown> => {
    // Args may include WasmHandles from upstream py cels. Translate
    // them to the worker's wire form { __handle: true, ref: N }; the
    // worker dereferences before calling Python.
    const wireArgs = args.map((a) => {
      if (a !== null && typeof a === "object" &&
          (a as WasmHandle).kind === "py" &&
          typeof (a as WasmHandle).ref === "number") {
        return { __handle: true, ref: (a as WasmHandle).ref };
      }
      return a;
    });
    const reply = (await workerRequest(
      handle,
      { kind: "call", fnRef, args: wireArgs },
    )) as { value?: unknown; handle?: { ref: number } };
    if (composite) {
      // The worker returned a handle; lift to a WasmHandle so cel.v
      // carries kind/type for downstream consumers and bridges.
      if (!reply.handle) {
        throw new Error("py-worker: composite call returned no handle");
      }
      const wh: WasmHandle = {
        kind: "py",
        ref: reply.handle.ref,
        type: context!.outputSchema!,
      };
      return wh;
    }
    return reply.value;
  }) as Fn;
};

// Materialize a worker-side handle into JS. Used by the py-to-js
// bridge when the handle came from worker-mode py-compile. Module-
// scoped so the bridge doesn't need to thread state through (it has
// the WasmHandle and reaches into the singleton worker).
const materializeWorkerHandle = async (ref: number): Promise<unknown> => {
  if (!_workerHandle) {
    throw new Error("py-to-js: worker not spawned; can't materialize handle");
  }
  const reply = (await workerRequest(
    _workerHandle,
    { kind: "to-js", ref },
  )) as { value?: unknown };
  return reply.value;
};

// ── dispatcher: worker-mode flag decides which path ─────────────────────────

const pyCompiler: Compiler = (async (
  source: string, state?: State, context?: CompileContext,
): Promise<Fn> => {
  if (state) {
    const wasmAvailable =
      state.cels.get(CSP_WASM_AVAILABLE_KEY)?.v as boolean | undefined;
    if (wasmAvailable === false) {
      throw new Error(
        `py-compiler: WebAssembly is unavailable in this environment ` +
        `(csp.wasm-available = false). Pyodide cannot run.`,
      );
    }
  }
  const workerMode = state?.cels.get("py.worker-mode")?.v === true;
  return workerMode
    ? compileWorker(source, state, context)
    : compileMainThread(source, state, context);
}) as Compiler;

// ── bridges ─────────────────────────────────────────────────────────────────

const pyToJs: Fn = async (v: unknown): Promise<unknown> => {
  if (v === null || v === undefined) return v;
  // WasmHandle: ask the storage owner (main-thread map or worker
  // table) to materialize and release.
  const wh = v as Partial<WasmHandle>;
  if (wh.kind === "py" && typeof wh.ref === "number") {
    if (_workerHandle) {
      return materializeWorkerHandle(wh.ref);
    }
    const stored = _mainHandles.get(wh.ref);
    _mainHandles.delete(wh.ref);
    if (stored !== null && stored !== undefined &&
        typeof (stored as { toJs?: unknown }).toJs === "function") {
      const maybeProxy = stored as { toJs: (opts?: { depth?: number }) => unknown; destroy?: () => void };
      const js = maybeProxy.toJs({ depth: -1 });
      maybeProxy.destroy?.();
      return js;
    }
    return stored;
  }
  // Legacy fall-through: a raw PyProxy ended up on cel.v (this is the
  // non-composite path's behavior pre-B4; we keep it working).
  const maybeProxy = v as { toJs?: (opts?: { depth?: number }) => unknown; destroy?: () => void };
  if (typeof maybeProxy.toJs === "function") {
    const js = maybeProxy.toJs({ depth: -1 });
    maybeProxy.destroy?.();
    return js;
  }
  return v;
};

const jsToPy: Fn = async (v: unknown) => {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean" || t === "bigint") return v;
  const py = await getPyodide();
  return py.toPy(v);
};

// Test hook: terminate the worker (if any) and reset state. Allows
// integration tests to spawn a fresh worker per test case if they need
// to. Not exposed from the public package entry — internal to py-
// compiler.
export const _resetPyWorker = async (): Promise<void> => {
  if (!_workerHandle) return;
  try { await _workerHandle.worker.terminate(); } catch { /* swallow */ }
  _workerHandle = undefined;
};

// Re-export the worker-mode key as a constant for state-reading code.
export const PY_WORKER_MODE_KEY: Key = "py.worker-mode";

export const name = "py-compiler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["py",        pyCompiler as Fn],
  ["py-to-js",  pyToJs],
  ["js-to-py",  jsToPy],
]));
