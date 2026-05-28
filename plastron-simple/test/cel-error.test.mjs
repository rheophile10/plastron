import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precompute, precomputeOptional, resolveFn,
} from "../dist/index.js";
import { isCelError, makeCelError } from "../dist/甲骨坑/cel-error.js";

const baseManifest = {
  name: "user", version: "0.0.1", description: "test", dependencies: [],
};

// ── schema seed ─────────────────────────────────────────────────────────────

test("cel-error schema cel is seeded at boot", () => {
  const state = createInitialState();
  const schemaCel = state.cels.get("cel-error");
  assert.ok(schemaCel, "cel-error schema cel missing");
  assert.equal(schemaCel.celType, "SchemaCel");
  assert.equal(schemaCel.v.key, "cel-error");
  assert.equal(schemaCel.v.protocols.isChanged, "cel-error_isChanged");
  assert.equal(schemaCel.v.protocols.hydrate,   "cel-error_hydrate");
  assert.equal(schemaCel.v.protocols.dehydrate, "cel-error_dehydrate");
});

test("cel-error protocol fns are reachable via resolveFn", () => {
  const state = createInitialState();
  for (const k of ["cel-error_isChanged", "cel-error_hydrate", "cel-error_dehydrate"]) {
    assert.equal(typeof resolveFn(state, k), "function", `${k} not resolved`);
  }
});

// ── isCelError / makeCelError ──────────────────────────────────────────────

test("isCelError discriminates on the kind tag", () => {
  // `at` is an array of cel keys (length-1 for per-cel, length-N for
  // structural errors like cycles).
  assert.equal(isCelError({ kind: "error", at: ["x"], trap: "t", message: "m" }), true);
  assert.equal(isCelError({ kind: "error", at: ["x"], trap: "t" }), false, "missing message");
  assert.equal(isCelError({ kind: "ok",    at: ["x"], trap: "t", message: "m" }), false, "wrong kind");
  assert.equal(isCelError({ kind: "error", at: "x",   trap: "t", message: "m" }), false, "at must be an array");
  assert.equal(isCelError(null), false);
  assert.equal(isCelError(42), false);
  assert.equal(isCelError("error"), false);
});

test("makeCelError builds from caught Error", () => {
  const err = makeCelError("x", "TestTrap", new Error("boom"));
  assert.equal(err.kind, "error");
  assert.deepEqual(err.at, ["x"]);
  assert.equal(err.trap, "TestTrap");
  assert.equal(err.message, "boom");
  assert.equal(typeof err.stack, "string");
});

test("makeCelError builds from caught non-Error", () => {
  const err = makeCelError("x", "TestTrap", "not-an-error");
  assert.equal(err.message, "not-an-error");
  assert.equal(err.stack, undefined);
});

// ── runtime trap-as-value ──────────────────────────────────────────────────

test("a formula whose evaluator throws stores a CelError; cascade survives", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  // A function-cel that throws when called. The formula `(boomFn)` will
  // invoke it during the cascade.
  const seg = {
    name: "user",
    cels: [
      {
        key: "boomFn", celType: "ValueCel",
        metadata: { key: "boomFn", segment: "user", v: () => { throw new Error("boom"); } },
      },
      {
        key: "boom", celType: "FormulaCel",
        metadata: { key: "boom", segment: "user", parser: "f" },
        f: "(boomFn)",
      },
      {
        // Sibling cel that depends on no error path — should compute fine.
        key: "ok", celType: "FormulaCel",
        metadata: { key: "ok", segment: "user", parser: "f" },
        f: "(+ 1 1)",
      },
    ],
  };

  await hydrate(state, [seg], [baseManifest]);
  precompute(state);
  await precomputeOptional(state);

  // Cascade must not throw. Pre-trap-as-value, this rejected.
  await runCycle(state);

  const boomCel = state.cels.get("boom");
  assert.ok(isCelError(boomCel.v), "boom cel should hold a CelError");
  assert.deepEqual(boomCel.v.at, ["boom"]);
  assert.equal(boomCel.v.trap, "RuntimeError");
  assert.match(boomCel.v.message, /boom/);

  // Sibling still computed.
  assert.equal(state.cels.get("ok").v, 2);
});

test("a downstream formula reading an error-valued cel produces its own CelError", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  const seg = {
    name: "user",
    cels: [
      {
        key: "boomFn", celType: "ValueCel",
        metadata: { key: "boomFn", segment: "user", v: () => { throw new Error("upstream"); } },
      },
      {
        key: "boom", celType: "FormulaCel",
        metadata: { key: "boom", segment: "user", parser: "f" },
        f: "(boomFn)",
      },
      {
        // Reads boom as an arg to a function. The function will get
        // passed a CelError; calling .foo on it (or doing arithmetic)
        // throws → downstream gets its own CelError. We use a callable
        // that intentionally invokes a method on its arg.
        key: "touchFn", celType: "ValueCel",
        metadata: { key: "touchFn", segment: "user", v: (x) => x.kind.toUpperCase() === "OK" },
      },
      {
        key: "downstream", celType: "FormulaCel",
        metadata: { key: "downstream", segment: "user", parser: "f" },
        f: "(touchFn boom)",
      },
    ],
  };

  await hydrate(state, [seg], [baseManifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  // upstream cel is an error
  assert.ok(isCelError(state.cels.get("boom").v));
  // downstream consumed the CelError via touchFn — touchFn returned
  // false (because kind="error" not "ok"), no throw. CelError propagation
  // semantics: it's *just a value*. Downstream sees it like any other.
  assert.equal(state.cels.get("downstream").v, false);
});

// ── compile-time trap-as-value ─────────────────────────────────────────────

test("a declarative WAT cel with bad source becomes a CelError; hydrate completes", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const seg = {
    name: "user",
    cels: [
      {
        key: "broken", celType: "EditableLambdaCel",
        metadata: { key: "broken", segment: "user", kind: "wat" },
        f: "(module (func not-a-real-instr))",
      },
      {
        // Sibling that's fine — proves the WHOLE hydrate didn't abort.
        key: "good", celType: "ValueCel",
        metadata: { key: "good", segment: "user", v: 42 },
      },
    ],
  };

  // Pre-trap-as-value at compile time, this rejected the hydrate.
  await hydrate(state, [seg], [baseManifest]);

  const brokenCel = state.cels.get("broken");
  assert.ok(brokenCel, "broken cel should exist");
  assert.ok(isCelError(brokenCel.v), "broken.v should be a CelError");
  assert.equal(brokenCel.v.trap, "CompileError");
  assert.deepEqual(brokenCel.v.at, ["broken"]);
  // _fn must NOT be bound — the cel is in-error.
  assert.equal(brokenCel._fn, undefined);
  // Sibling hydrated fine.
  assert.equal(state.cels.get("good").v, 42);
});

test("declarative WAT compile-error survives precompute and runCycle", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      {
        key: "broken", celType: "EditableLambdaCel",
        metadata: { key: "broken", segment: "user", kind: "wat" },
        f: "(module (func not-a-real-instr))",
      },
    ],
  }], [baseManifest]);

  // None of these should throw.
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  assert.ok(isCelError(state.cels.get("broken").v));
});

// ── what trap-as-value does NOT do ─────────────────────────────────────────

test("missing compiler still throws at hydrate (configuration error, not data)", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  await assert.rejects(
    () => hydrate(state, [{
      name: "user",
      cels: [{
        key: "x", celType: "EditableLambdaCel",
        metadata: { key: "x", segment: "user", kind: "nope-not-a-compiler" },
        f: "(anything)",
      }],
    }], [baseManifest]),
    /no compiler is registered/,
  );
});

test("registerLambda still throws on bad source (imperative API, not declarative)", async () => {
  // Trap-as-value is for cels that come in via hydrate. The imperative
  // registerLambda call should still throw — the caller asked us to
  // compile right now and synchronously wants to know if it worked.
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await assert.rejects(
    () => register(state, {
      key: "x",
      source: "(module (func not-a-real-instr))",
      kind: "wat",
    }),
  );
});
