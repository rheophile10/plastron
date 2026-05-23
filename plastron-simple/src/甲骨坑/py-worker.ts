// py-worker — runs INSIDE a Node worker_threads worker (or a browser
// Worker). Owns one Pyodide instance, plus a small registry of Python
// callables AND a value table for composite handles. Main-thread
// py-compiler talks to this via postMessage envelopes.
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
// process inside the worker. v1 doesn't proxy back to the main thread.

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

interface PortLike {
  postMessage: (msg: unknown) => void;
  on: (event: "message", handler: (msg: unknown) => void) => void;
}

const getParentPort = async (): Promise<PortLike> => {
  const wt = await import("node:worker_threads");
  if (!wt.parentPort) {
    throw new Error("py-worker: parentPort missing — must run in a Worker");
  }
  return wt.parentPort as PortLike;
};

interface HandleArg { __handle: true; ref: number }
const isHandleArg = (v: unknown): v is HandleArg =>
  v !== null && typeof v === "object" &&
  (v as { __handle?: unknown }).__handle === true;

const main = async (): Promise<void> => {
  const port = await getParentPort();
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

  // Function registry — keyed by fnRef. compose with the value-table
  // below: a Python fn lives here, its results (when composite) live in
  // the value table.
  const fns = new Map<number, {
    fn: (...args: unknown[]) => unknown;
    composite: boolean;
  }>();
  let nextFnRef = 1;

  // Composite value table. Each entry is a PyProxy (or any Python
  // object Pyodide returns) we're holding so bridges and downstream
  // py cels can use it without re-marshalling.
  const handles = new Map<number, unknown>();
  let nextHandleRef = 1;

  port.postMessage({ kind: "ready" });

  port.on("message", (raw: unknown) => {
    const msg = raw as {
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
          // Dereference any handle args back to their stored PyProxies.
          const args = (msg.args ?? []).map((a) =>
            isHandleArg(a) ? handles.get(a.ref) : a);
          const result = entry.fn(...args);
          if (entry.composite) {
            // Keep the result in the value table; return a handle. The
            // result might be a PyProxy or a native value — either way
            // we store as-is. The bridge will materialize on demand.
            const ref = nextHandleRef++;
            handles.set(ref, result);
            port.postMessage({ kind: "ok", id: msg.id, handle: { ref } });
          } else {
            // Eager marshal: convert PyProxy to JS, return the value.
            let value: unknown;
            if (isPyProxyLike(result)) {
              value = result.toJs({ depth: -1 });
              result.destroy?.();
            } else {
              value = result;
            }
            port.postMessage({ kind: "ok", id: msg.id, value });
          }
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
          // to-js is one-shot: free the handle after materialization.
          // Bridges that want to materialize twice should call the
          // underlying py fn twice.
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
