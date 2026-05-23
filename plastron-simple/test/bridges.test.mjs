import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState, precompute, precomputeOptional, resolveFn,
} from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// ── seed ────────────────────────────────────────────────────────────────────

test("wat-compiler segment seeds the wat-to-js and js-to-wat bridge cels", () => {
  const state = createInitialState();
  const watToJs  = state.cels.get("wat-to-js");
  const jsToWat  = state.cels.get("js-to-wat");
  assert.ok(watToJs, "wat-to-js bridge cel missing");
  assert.ok(jsToWat, "js-to-wat bridge cel missing");
  assert.equal(watToJs.celType, "LockedLambdaCel");
  assert.equal(jsToWat.celType, "LockedLambdaCel");
  assert.equal(watToJs.locked, true);
  assert.equal(jsToWat.locked, true);
});

test("bridge cels are reachable via resolveFn", () => {
  const state = createInitialState();
  assert.equal(typeof resolveFn(state, "wat-to-js"), "function");
  assert.equal(typeof resolveFn(state, "js-to-wat"), "function");
});

// ── v1 identity behavior for scalars ────────────────────────────────────────

test("bridges are identity for scalars (i32/f64 numbers)", () => {
  const state = createInitialState();
  const watToJs = resolveFn(state, "wat-to-js");
  const jsToWat = resolveFn(state, "js-to-wat");
  // i32 boundary cases
  assert.equal(watToJs(42),                42);
  assert.equal(watToJs(-2147483648),       -2147483648);
  assert.equal(jsToWat(2147483647),        2147483647);
  // f64
  assert.equal(watToJs(3.14159),           3.14159);
  // boolean as 0/1 (wasm's bool ABI)
  assert.equal(jsToWat(true),              true);  // identity; coercion is the call site's job
});

// ── bridges in formulas ────────────────────────────────────────────────────

test("a formula can call wat-to-js as an explicit bridge", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  const seg = {
    name: "user",
    cels: [
      // Pretend this is the wat-domain output of some wat lambda.
      { key: "raw",  celType: "ValueCel",
        metadata: { key: "raw", segment: "user", schema: "wasm:i32", v: 42 } },
      // Explicit bridge from wat-domain to JS-domain.
      { key: "bridged", celType: "FormulaCel",
        metadata: { key: "bridged", segment: "user", parser: "f" },
        f: "(wat-to-js raw)" },
    ],
  };

  await hydrate(state, [seg], [baseManifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  // v1 scalars: identity. The bridge cel fires; its v matches the source's v.
  assert.equal(state.cels.get("bridged").v, 42);
});

test("js-to-wat round-trips through a formula", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  const seg = {
    name: "user",
    cels: [
      { key: "x", celType: "ValueCel",
        metadata: { key: "x", segment: "user", v: 7 } },
      { key: "rounded", celType: "FormulaCel",
        metadata: { key: "rounded", segment: "user", parser: "f" },
        f: "(wat-to-js (js-to-wat x))" },
    ],
  };

  await hydrate(state, [seg], [baseManifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  assert.equal(state.cels.get("rounded").v, 7);
});

// ── DAG visibility: a bridge cel auto-wires its source into inputMap ────────

test("a bridge call in a formula adds the source to the formula's inputMap", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const seg = {
    name: "user",
    cels: [
      { key: "src", celType: "ValueCel",
        metadata: { key: "src", segment: "user", v: 99 } },
      { key: "bridged", celType: "FormulaCel",
        metadata: { key: "bridged", segment: "user", parser: "f" },
        f: "(wat-to-js src)" },
    ],
  };
  await hydrate(state, [seg], [baseManifest]);

  // extractDeps wires `wat-to-js` and `src` into the formula's inputMap.
  // The bridge cel becomes a real DAG edge — diagnostics can count it,
  // change propagation goes through it, future per-kind precompute can
  // group on it.
  const bridged = state.cels.get("bridged");
  assert.ok(bridged.metadata.inputMap, "inputMap should be populated by extractDeps");
  assert.equal(bridged.metadata.inputMap["wat-to-js"], "wat-to-js");
  assert.equal(bridged.metadata.inputMap["src"], "src");
});

// ── pictograph integration: wat-result-js carries the bridged value ────────

test("pictograph-shape: wat-add → wat-result (wasm:i32) → (wat-to-js …) → wat-result-js", async () => {
  // Reproduces the pictograph's wat-add cascade exactly.
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 3 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 4 } },
      { key: "wat-add", celType: "EditableLambdaCel",
        metadata: { key: "wat-add", segment: "user", kind: "wat", outputSchema: "wasm:i32" },
        f: '(module (func (export "main") (param $a i32) (param $b i32) (result i32) ' +
           'local.get $a local.get $b i32.add))' },
      { key: "wat-result", celType: "FormulaCel",
        metadata: { key: "wat-result", segment: "user", parser: "f", outputSchema: "wasm:i32" },
        f: "(wat-add a b)" },
      { key: "wat-result-js", celType: "FormulaCel",
        metadata: { key: "wat-result-js", segment: "user", parser: "f" },
        f: "(wat-to-js wat-result)" },
    ],
  };

  await hydrate(state, [seg], [baseManifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  assert.equal(state.cels.get("wat-result").v,    7, "wat-result");
  assert.equal(state.cels.get("wat-result-js").v, 7, "wat-result-js via bridge");
});
