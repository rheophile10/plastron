// py-worker — runs INSIDE a WHATWG Worker (Bun, browser, Deno). Owns
// one Pyodide instance plus a small registry of Python callables and a
// value table for composite handles. Main-thread py-compiler talks to
// this via postMessage envelopes.
//
// Protocol (kind discriminator on the envelope):
//
//   main → worker:
//     { kind: "compile", id, source, composite }
//        → reply with { kind: "ok", id, fnRef }
//        `composite` is the cel's outputSchema-derived flag — true
//        means "this lambda's return value should stay as a handle in
//        the worker's table, not eagerly toJs'd."
//     { kind: "call", id, fnRef, args }
//        → reply with { kind: "ok", id, value }   (scalar/eager path)
//          or          { kind: "ok", id, handle: { ref } }   (composite)
//        `args` items may be `{ __handle: true, ref: N }` — the worker
//        dereferences them to PyProxies before calling the Python fn.
//     { kind: "to-js", id, ref } → reply with { kind: "ok", id, value }
//        Materializes a handle to its JS form (PyProxy.toJs). Releases
//        the underlying ref afterwards — handle is one-shot.
//     { kind: "release", fnRef } → no reply; frees the ref
//     { kind: "release-handle", ref } → no reply; frees a value handle
//
//   worker → main:
//     { kind: "ready" } | { kind: "ok", id, ... } | { kind: "error", ... }
//
// Host capabilities (host.log, host.now, host.random) are bound in-
// process inside the worker. v1 doesn't proxy back to the main thread:
// host swapping isn't observable through the worker boundary (a known
// limitation noted in WASM-DOMAIN.md § 4 / 7). Tests that want host
// mocking use main-thread py (py.worker-mode = false).

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

interface HandleArg { __handle: true; ref: number }
const isHandleArg = (v: unknown): v is HandleArg =>
  v !== null && typeof v === "object" &&
  (v as { __handle?: unknown }).__handle === true;

// Structural view of the WorkerGlobalScope `self`. Bun, browser, and
// Deno all expose `self` inside a Worker with addEventListener +
// postMessage; structural typing keeps the kernel's tsconfig free of
// DOM lib types.
interface WorkerSelf {
  addEventListener: (event: "message", h: (e: { data: unknown }) => void) => void;
  postMessage: (msg: unknown) => void;
}
const port = (globalThis as unknown as { self: WorkerSelf }).self;

const main = async (): Promise<void> => {
  const pyodideMod = await import("pyodide");
  const pyodide = await (pyodideMod as unknown as {
    loadPyodide: () => Promise<PyodideAPI>;
  }).loadPyodide();

  // Host bindings — worker-local impls.
  pyodide.globals.set("host", {
    log:    (...args: unknown[]) => { console.log(...args); },
    warn:   (...args: unknown[]) => { console.warn(...args); },
    error:  (...args: unknown[]) => { console.error(...args); },
    now:    () => Date.now(),
    random: () => Math.random(),
  });

  const fns = new Map<number, {
    fn: (...args: unknown[]) => unknown;
    composite: boolean;
  }>();
  let nextFnRef = 1;

  const handles = new Map<number, unknown>();
  let nextHandleRef = 1;

  port.postMessage({ kind: "ready" });

  port.addEventListener("message", (e) => {
    const msg = e.data as {
      kind: string;
      id?: number;
      source?: string;
      fnRef?: number;
      args?: unknown[];
      ref?: number;
      composite?: boolean;
    };
    try {
      switch (msg.kind) {
        case "compile": {
          const pyFn = pyodide.runPython(msg.source!);
          if (typeof pyFn !== "function") {
            throw new Error(
              `py-worker: source's last expression evaluated to ` +
              `${typeof pyFn}, not a callable.`,
            );
          }
          const ref = nextFnRef++;
          fns.set(ref, {
            fn: pyFn as (...a: unknown[]) => unknown,
            composite: msg.composite === true,
          });
          port.postMessage({ kind: "ok", id: msg.id, fnRef: ref });
          return;
        }
        case "call": {
          const entry = fns.get(msg.fnRef!);
          if (!entry) throw new Error(`py-worker: fnRef ${msg.fnRef} not found`);
          const args = (msg.args ?? []).map((a) =>
            isHandleArg(a) ? handles.get(a.ref) : a);
          // Pyodide-in-Bun-Worker may return Promises from PyProxy
          // calls; await defensively. Promise.resolve unwraps either.
          // Errors in async path go through the outer try/catch by
          // chaining .catch to the same handler.
          Promise.resolve(entry.fn(...args))
            .then((result) => {
              if (entry.composite) {
                const ref = nextHandleRef++;
                handles.set(ref, result);
                port.postMessage({ kind: "ok", id: msg.id, handle: { ref } });
              } else {
                let value: unknown;
                if (isPyProxyLike(result)) {
                  value = result.toJs({ depth: -1 });
                  result.destroy?.();
                } else {
                  value = result;
                }
                port.postMessage({ kind: "ok", id: msg.id, value });
              }
            })
            .catch((e: unknown) => {
              const err = e instanceof Error
                ? { message: e.message, stack: e.stack }
                : { message: String(e) };
              port.postMessage({ kind: "error", id: msg.id, ...err });
            });
          return;
        }
        case "to-js": {
          const stored = handles.get(msg.ref!);
          if (stored === undefined) {
            throw new Error(`py-worker: handle ref ${msg.ref} not found`);
          }
          let value: unknown;
          if (isPyProxyLike(stored)) {
            value = stored.toJs({ depth: -1 });
            stored.destroy?.();
          } else {
            value = stored;
          }
          handles.delete(msg.ref!);
          port.postMessage({ kind: "ok", id: msg.id, value });
          return;
        }
        case "release": {
          fns.delete(msg.fnRef!);
          return;
        }
        case "release-handle": {
          const stored = handles.get(msg.ref!);
          if (stored !== undefined && isPyProxyLike(stored)) {
            stored.destroy?.();
          }
          handles.delete(msg.ref!);
          return;
        }
        default:
          throw new Error(`py-worker: unknown message kind ${msg.kind}`);
      }
    } catch (e) {
      const err = e instanceof Error
        ? { message: e.message, stack: e.stack }
        : { message: String(e) };
      port.postMessage({ kind: "error", id: msg.id, ...err });
    }
  });
};

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`py-worker boot failure: ${msg}`);
});
