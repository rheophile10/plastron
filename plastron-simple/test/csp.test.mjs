import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precompute, precomputeOptional, resolveFn,
} from "../dist/index.js";

// ── detection ──────────────────────────────────────────────────────────────

test("csp segment seeds csp.eval-available and csp.wasm-available", () => {
  const state = createInitialState();
  assert.ok(state.cels.get("csp.eval-available"), "csp.eval-available cel missing");
  assert.ok(state.cels.get("csp.wasm-available"), "csp.wasm-available cel missing");
});

test("in Node, both capability cels detect true", () => {
  const state = createInitialState();
  assert.equal(state.cels.get("csp.eval-available").v, true);
  assert.equal(state.cels.get("csp.wasm-available").v, true);
});

test("capability cels are locked (no rebinding via setCel)", () => {
  const state = createInitialState();
  assert.equal(state.cels.get("csp.eval-available").locked, true);
  assert.equal(state.cels.get("csp.wasm-available").locked, true);
});

// ── formula path: csp.eval-available = false → AST-walk fallback ──────────

test("forcing csp.eval-available = false makes formula _evaluate work via AST walk", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 7  } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 11 } },
      {
        key: "sum",
        celType: "FormulaCel",
        metadata: { key: "sum", segment: "user", parser: "f" },
        f: "(+ a b)",
      },
    ],
  };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [seg], [manifest]);

  // Mutate the locked cel directly — tests own state, the lock only
  // guards normal write paths (setCel).
  // Replace (not mutate) — the csp seed cels are module-level objects
  // shared across createInitialState() calls; mutating the .v field
  // would leak the override into every subsequent test.
  state.cels.set("csp.eval-available", {
    ...state.cels.get("csp.eval-available"), v: false,
  });
  // Rebuild precompute + the per-cel _evaluate closures so the new
  // cspEvalAvailable boolean is captured by the closure.
  precompute(state);
  await precomputeOptional(state);

  const sumCel = state.cels.get("sum");
  assert.equal(typeof sumCel._evaluate, "function", "_evaluate should still be wired");
  assert.equal(sumCel._evaluate(), 18, "AST-walk path should produce the right answer");
});

test("with csp.eval-available = true (default), formula _evaluate still produces the right answer", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 7  } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 11 } },
      {
        key: "sum",
        celType: "FormulaCel",
        metadata: { key: "sum", segment: "user", parser: "f" },
        f: "(+ a b)",
      },
    ],
  };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [seg], [manifest]);
  await precomputeOptional(state);

  const sumCel = state.cels.get("sum");
  assert.equal(sumCel._evaluate(), 18);
});

// ── js compiler gate ──────────────────────────────────────────────────────

test("forcing csp.eval-available = false makes the JS lambda compiler throw with a CSP-aware message", async () => {
  const state = createInitialState();
  // Replace (not mutate) — the csp seed cels are module-level objects
  // shared across createInitialState() calls; mutating the .v field
  // would leak the override into every subsequent test.
  state.cels.set("csp.eval-available", {
    ...state.cels.get("csp.eval-available"), v: false,
  });
  const register = resolveFn(state, "registerLambda");
  // registerLambda is async (compilers can return Promises for lazy-
  // loaded runtimes); the throw fires inside the awaited compiler call,
  // so this is a rejected Promise rather than a sync throw.
  await assert.rejects(
    () => register(state, { key: "doubler", source: "(x) => x * 2", kind: "js" }),
    /csp\.eval-available = false|unsafe-eval|precompiled bytes/i,
  );
});

test("with csp.eval-available = true, the JS lambda compiler runs and produces a working fn", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "doubler", source: "(x) => x * 2", kind: "js" });
  const doubler = resolveFn(state, "doubler");
  assert.equal(typeof doubler, "function");
  assert.equal(doubler(21), 42);
});
