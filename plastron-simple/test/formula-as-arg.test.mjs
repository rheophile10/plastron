import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState, precompute, precomputeOptional, resolveFn,
} from "../dist/index.js";

// Regression: a FormulaCel referenced as an *argument* (not the head)
// of another formula must produce its computed value, not its compiled
// formula function. The codegen and AST-walk paths both used to emit
// `(c._fn ?? c.v)` uniformly, which incorrectly picked the formula's
// compiled `_fn` for FormulaCels — silently passing the formula function
// where the computed value was expected. Discovered while wiring the
// pictograph example end-to-end after enabling precompute.

const factory = () => {
  class P {
    constructor({ icon }) { this.icon = icon; }
    greet(other) { return `${this.icon}-${other.icon}`; }
  }
  return P;
};
const make = (Cls, icon) => new Cls({ icon });
const greet = (a, b) => a.greet(b);

const buildSeg = () => ({
  name: "user",
  cels: [
    { key: "factory", celType: "ValueCel", metadata: { key: "factory", segment: "user", v: factory } },
    { key: "make",    celType: "ValueCel", metadata: { key: "make",    segment: "user", v: make    } },
    { key: "greet",   celType: "ValueCel", metadata: { key: "greet",   segment: "user", v: greet   } },
    { key: "Cls", celType: "FormulaCel", metadata: { key: "Cls", segment: "user", parser: "f" }, f: "(factory)" },
    { key: "p1",  celType: "FormulaCel", metadata: { key: "p1",  segment: "user", parser: "f" }, f: "(make Cls \"A\")" },
    { key: "p2",  celType: "FormulaCel", metadata: { key: "p2",  segment: "user", parser: "f" }, f: "(make Cls \"B\")" },
    { key: "out", celType: "FormulaCel", metadata: { key: "out", segment: "user", parser: "f" }, f: "(greet p1 p2)" },
  ],
});
const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

test("FormulaCel referenced as arg passes its computed value (codegen path)", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [buildSeg()], [manifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  // Cls.v should be class P (a constructor).
  assert.equal(typeof state.cels.get("Cls").v, "function");
  // p1 / p2 should be instances of that class.
  assert.equal(state.cels.get("p1").v.icon, "A");
  assert.equal(state.cels.get("p2").v.icon, "B");
  // out reads p1 and p2 as args (the regression site).
  assert.equal(state.cels.get("out").v, "A-B");
});

test("FormulaCel referenced as arg passes its computed value (AST-walk path)", async () => {
  // Force the AST-walk fallback by flipping csp.eval-available false.
  const state = createInitialState();
  state.cels.set("csp.eval-available", {
    ...state.cels.get("csp.eval-available"), v: false,
  });
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [buildSeg()], [manifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  assert.equal(state.cels.get("out").v, "A-B");
});

test("LambdaCels passed as args still resolve to their _fn (no regression)", async () => {
  // A LambdaCel registered via registerLambda has v: null and _fn set.
  // When referenced as an arg, args should still see the callable.
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const register = resolveFn(state, "registerLambda");
  const runCycle = resolveFn(state, "runCycle");

  await register(state, { key: "double", source: "(x) => x * 2", kind: "js" });
  // higher-order function: apply(f, x) returns f(x). f should arrive as a function.
  const seg = {
    name: "user",
    cels: [
      { key: "apply", celType: "ValueCel", metadata: { key: "apply", segment: "user", v: (f, x) => f(x) } },
      { key: "x",     celType: "ValueCel", metadata: { key: "x",     segment: "user", v: 21 } },
      { key: "out",   celType: "FormulaCel", metadata: { key: "out", segment: "user", parser: "f" }, f: "(apply double x)" },
    ],
  };
  await hydrate(state, [seg], [{ name: "user", version: "0.0.1", description: "test", dependencies: [] }]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  assert.equal(state.cels.get("out").v, 42);
});
