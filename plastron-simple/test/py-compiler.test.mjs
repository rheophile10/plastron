import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState, precompute, precomputeOptional, resolveFn,
} from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// ── seed: compiler + status + bridge cels ──────────────────────────────────

test("py-compiler segment seeds the 'py' compiler cel", () => {
  const state = createInitialState();
  const py = state.cels.get("py");
  assert.ok(py, "py compiler cel missing");
  assert.equal(py.celType, "LockedLambdaCel");
  assert.equal(py.locked, true);
});

test("py kind exposes the four status cels", () => {
  const state = createInitialState();
  for (const key of ["load-deps.py", "py.ready", "py.alive", "py.errors"]) {
    assert.ok(state.cels.get(key), `status cel ${key} missing`);
  }
});

test("py kind exposes the py-to-js and js-to-py bridge cels", () => {
  const state = createInitialState();
  for (const key of ["py-to-js", "js-to-py"]) {
    const cel = state.cels.get(key);
    assert.ok(cel, `${key} bridge cel missing`);
    assert.equal(cel.celType, "LockedLambdaCel");
  }
});

// ── compile + run: this is slow (Pyodide boots) ─────────────────────────────

test("a Python lambda compiles via Pyodide and produces correct output", async (t) => {
  // Skip this test if pyodide can't be loaded (e.g., restricted CI env).
  // It takes ~5s on a warm boot, ~20s cold.
  t.diagnostic("loading Pyodide; this can take 5-20s the first time");

  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "py-double",
    kind: "py",
    source: [
      "def double(x):",
      "    return x * 2",
      "double",
    ].join("\n"),
  });

  const fn = resolveFn(state, "py-double");
  assert.equal(typeof fn, "function");
  assert.equal(fn(21), 42);
  assert.equal(fn(-3), -6);
});

test("Python source without a trailing callable expression throws a clear error", async (t) => {
  t.diagnostic("loading Pyodide; this can take 5-20s the first time");

  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  // No bare-name expression after the def — runPython returns None.
  await assert.rejects(
    () => register(state, {
      key: "no-callable",
      kind: "py",
      source: "def f(x):\n    return x",
    }),
    /did not produce a callable|not a callable/i,
  );
});

// ── declarative py lambda via hydrate (trap-as-value path) ─────────────────

test("a declarative py cel with bad Python source becomes a CelError; hydrate completes", async (t) => {
  t.diagnostic("loading Pyodide; this can take 5-20s the first time");

  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const seg = {
    name: "user",
    cels: [
      {
        key: "broken", celType: "EditableLambdaCel",
        metadata: { key: "broken", segment: "user", kind: "py" },
        f: "def f(:\n    not_valid_python",
      },
      {
        key: "sibling", celType: "ValueCel",
        metadata: { key: "sibling", segment: "user", v: 42 },
      },
    ],
  };
  // Hydrate must NOT throw — the syntax error becomes a CelError on
  // `broken.v`. (Imported via dist barrel since it lives in 甲骨坑/.)
  await hydrate(state, [seg], [baseManifest]);

  const { isCelError } = await import("../dist/index.js");
  const brokenCel = state.cels.get("broken");
  assert.ok(brokenCel, "broken cel should exist");
  assert.ok(isCelError(brokenCel.v), "broken.v should be a CelError");
  assert.equal(brokenCel.v.trap, "CompileError");
  assert.equal(state.cels.get("sibling").v, 42);
});

// ── csp gate ────────────────────────────────────────────────────────────────

test("forcing csp.wasm-available = false makes the py compiler throw before touching Pyodide", async () => {
  const state = createInitialState();
  state.cels.set("csp.wasm-available", {
    ...state.cels.get("csp.wasm-available"), v: false,
  });
  const register = resolveFn(state, "registerLambda");
  // The throw must fire BEFORE the lazy pyodide import — no slow boot
  // wasted when wasm is unavailable.
  await assert.rejects(
    () => register(state, {
      key: "should-fail",
      kind: "py",
      source: "def f(x):\n    return x\nf",
    }),
    /csp\.wasm-available = false|WebAssembly is unavailable/i,
  );
});
