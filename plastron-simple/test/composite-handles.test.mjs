import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, isWasmHandle } from "../dist/index.js";
import { _resetPyWorker } from "../dist/甲骨坑/py-compiler.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

afterAll(async () => {
  await _resetPyWorker();
});

// ── seed: wasm:opaque is reachable ──────────────────────────────────────────

test("wasm:opaque schema cel is seeded with kind='wasm' and a composite wit type", () => {
  const state = createInitialState();
  const cel = state.cels.get("wasm:opaque");
  assert.ok(cel, "wasm:opaque schema cel missing");
  assert.equal(cel.celType, "SchemaCel");
  assert.equal(cel.v.kind, "wasm");
  assert.equal(cel.v.wit.kind, "record");
});

// ── main-thread mode: composite output → handle on formula's cel.v ─────────

test("a py lambda with outputSchema=wasm:opaque (main-thread), called from a formula, returns a handle", { timeout: 60000 }, async () => {
  console.log("loads Pyodide main-thread; ~5-20s first time");

  const state = createInitialState();
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "py-make-dict", celType: "EditableLambdaCel",
        metadata: { key: "py-make-dict", segment: "user", kind: "py", outputSchema: "wasm:opaque" },
        f: "def go():\n    return {'a': 1, 'b': 2}\ngo" },
      // The formula triggers py-make-dict and stores the lambda's
      // return on its own v. With composite outputSchema on the
      // lambda, the wrapper returns a WasmHandle that propagates here.
      { key: "result", celType: "FormulaCel",
        metadata: { key: "result", segment: "user", parser: "f" },
        f: "(py-make-dict)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  const handle = state.cels.get("result").v;
  assert.ok(isWasmHandle(handle), `cel.v should be a WasmHandle, got ${JSON.stringify(handle)}`);
  assert.equal(handle.kind, "py");
  assert.equal(typeof handle.ref, "number");
  assert.equal(handle.type.kind, "record");
});

// ── py-to-js bridge materializes a main-thread handle ──────────────────────

test("py-to-js bridge materializes a main-thread handle to its JS form", { timeout: 60000 }, async () => {
  const state = createInitialState();
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "py-make-dict", celType: "EditableLambdaCel",
        metadata: { key: "py-make-dict", segment: "user", kind: "py", outputSchema: "wasm:opaque" },
        f: "def go():\n    return {'a': 1, 'b': 2}\ngo" },
      { key: "result", celType: "FormulaCel",
        metadata: { key: "result", segment: "user", parser: "f" },
        f: "(py-make-dict)" },
      { key: "as-js", celType: "FormulaCel",
        metadata: { key: "as-js", segment: "user", parser: "f" },
        f: "(py-to-js result)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  // result.v is a handle; as-js.v is the materialized JS form.
  // Pyodide's toJs on a dict returns a Map by default; older versions
  // may return a plain object. Accept either.
  const asJs = state.cels.get("as-js").v;
  if (asJs instanceof Map) {
    assert.equal(asJs.get("a"), 1);
    assert.equal(asJs.get("b"), 2);
  } else {
    assert.deepEqual(asJs, { a: 1, b: 2 });
  }
});

// ── worker mode: composite handle, materialized via to-js message ──────────

test("worker mode: composite returned as handle; bridge materializes via to-js round trip", { timeout: 60000 }, async () => {
  console.log("spawns Pyodide worker; reuses singleton across worker-mode tests");

  const state = createInitialState();
  state.cels.get("py.worker-mode").v = true;
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "py-make-list", celType: "EditableLambdaCel",
        metadata: { key: "py-make-list", segment: "user", kind: "py", outputSchema: "wasm:opaque" },
        f: "def go():\n    return [10, 20, 30]\ngo" },
      { key: "result", celType: "FormulaCel",
        metadata: { key: "result", segment: "user", parser: "f" },
        f: "(py-make-list)" },
      { key: "as-js", celType: "FormulaCel",
        metadata: { key: "as-js", segment: "user", parser: "f" },
        f: "(py-to-js result)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  const handle = state.cels.get("result").v;
  assert.ok(isWasmHandle(handle), "result.v should be a WasmHandle");
  assert.equal(handle.kind, "py");

  const asJs = state.cels.get("as-js").v;
  assert.deepEqual(asJs, [10, 20, 30]);
});

// ── upstream handle flows into downstream py cel without re-marshalling ────

test("worker mode: a handle flows into a downstream py cel and is dereferenced server-side", { timeout: 60000 }, async () => {
  console.log("uses worker; composite stays in py-domain across two py cels");

  const state = createInitialState();
  state.cels.get("py.worker-mode").v = true;
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "py-make-list", celType: "EditableLambdaCel",
        metadata: { key: "py-make-list", segment: "user", kind: "py", outputSchema: "wasm:opaque" },
        f: "def go():\n    return [1, 2, 3, 4]\ngo" },
      { key: "lst", celType: "FormulaCel",
        metadata: { key: "lst", segment: "user", parser: "f" },
        f: "(py-make-list)" },
      { key: "py-sum-list", celType: "EditableLambdaCel",
        metadata: { key: "py-sum-list", segment: "user", kind: "py" },
        f: "def go(lst):\n    return sum(lst)\ngo" },
      { key: "total", celType: "FormulaCel",
        metadata: { key: "total", segment: "user", parser: "f" },
        f: "(py-sum-list lst)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  // lst.v is a WasmHandle. py-sum-list receives the handle as its first
  // arg; the worker dereferences server-side and sums.
  assert.ok(isWasmHandle(state.cels.get("lst").v));
  assert.equal(state.cels.get("total").v, 10);
});

// ── scalar output schemas still produce inline values ──────────────────────

test("a py lambda with a SCALAR outputSchema (wasm:i32) returns an inline value, not a handle", { timeout: 60000 }, async () => {
  const state = createInitialState();
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "py-answer", celType: "EditableLambdaCel",
        metadata: { key: "py-answer", segment: "user", kind: "py", outputSchema: "wasm:i32" },
        f: "def go():\n    return 42\ngo" },
      { key: "out", celType: "FormulaCel",
        metadata: { key: "out", segment: "user", parser: "f" },
        f: "(py-answer)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  // wasm:i32 is a primitive WIT type; isCompositeWitType returns false;
  // wrapper eagerly marshals. out.v is 42, not a handle.
  assert.equal(state.cels.get("out").v, 42);
});
