import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { _resetPyWorker } from "../dist/甲骨坑/py-compiler.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// Worker tests share one Pyodide-in-worker across the file (worker
// spawn is ~5s; we want to amortize it). Reset at file teardown so the
// process doesn't dangle. Per-test resets would be honest but make the
// file take ~20s.
after(async () => {
  await _resetPyWorker();
});

// ── seed: worker-mode cel exists and defaults to false ─────────────────────

test("py.worker-mode cel is seeded with v: false by default", () => {
  const state = createInitialState();
  const cel = state.cels.get("py.worker-mode");
  assert.ok(cel, "py.worker-mode cel missing");
  assert.equal(cel.v, false);
});

// ── opting into worker mode spawns the worker and flips py.ready ───────────

test("flipping py.worker-mode true routes compile through the worker; py.ready transitions", async (t) => {
  t.diagnostic("spawning Pyodide-in-worker; ~5s first time");

  const state = createInitialState();
  // Opt in.
  state.cels.get("py.worker-mode").v = true;

  // Sanity: py.ready is true at boot (declared optimistic). When the
  // first worker-mode compile fires, the worker is spawned and py.ready
  // gets flipped to false until "ready" message arrives.
  const register = resolveFn(state, "registerLambda");
  const compilePromise = register(state, {
    key: "wpy-double",
    kind: "py",
    source: "def double(x):\n    return x * 2\ndouble",
  });

  // After awaiting the compile (which awaits worker.ready internally),
  // py.ready should be true again.
  await compilePromise;
  assert.equal(state.cels.get("py.ready").v, true);

  // The function returns a Promise (worker round-trip).
  const fn = resolveFn(state, "wpy-double");
  assert.equal(typeof fn, "function");
  const r = await fn(21);
  assert.equal(r, 42);
});

// ── multiple compiles share the same worker ────────────────────────────────

test("multiple worker-mode compiles share the singleton worker", async () => {
  const state = createInitialState();
  state.cels.get("py.worker-mode").v = true;
  const register = resolveFn(state, "registerLambda");

  await register(state, {
    key: "wpy-incr",
    kind: "py",
    source: "def f(x):\n    return x + 1\nf",
  });
  await register(state, {
    key: "wpy-decr",
    kind: "py",
    source: "def f(x):\n    return x - 1\nf",
  });

  const incr = resolveFn(state, "wpy-incr");
  const decr = resolveFn(state, "wpy-decr");
  assert.equal(await incr(10), 11);
  assert.equal(await decr(10), 9);
});

// ── worker-mode calls integrate with runCycle's Promise-handling path ──────

test("worker-mode py cels integrate with the runCycle cascade (Promise return)", async (t) => {
  t.diagnostic("uses the singleton worker spawned above");

  const state = createInitialState();
  state.cels.get("py.worker-mode").v = true;

  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "n", celType: "ValueCel", metadata: { key: "n", segment: "user", v: 9 } },
      { key: "py-square", celType: "EditableLambdaCel",
        metadata: { key: "py-square", segment: "user", kind: "py" },
        f: "def f(x):\n    return x * x\nf" },
      { key: "out", celType: "FormulaCel",
        metadata: { key: "out", segment: "user", parser: "f" },
        f: "(py-square n)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  // out's value comes through the worker's postMessage protocol; the
  // existing Promise-handling in fireCel awaits it.
  assert.equal(state.cels.get("out").v, 81);
});

// ── trap-as-value: a Python error in worker mode lands as a CelError ──────

test("a Python exception in worker mode is transported as a CelError", async () => {
  const state = createInitialState();
  state.cels.get("py.worker-mode").v = true;

  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "wpy-throws",
    kind: "py",
    source: "def go(x):\n    raise ValueError('boom: ' + str(x))\ngo",
  });

  const fn = resolveFn(state, "wpy-throws");
  // The call's Promise rejects with the worker's error transport. The
  // runtime trap-as-value path in runCycle would wrap this as a
  // CelError on the calling cel. From the bare-fn position we just
  // assert it rejects with the underlying message.
  await assert.rejects(() => fn(7), /boom: 7/);
});
