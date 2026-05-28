import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precompute, precomputeOptional, resolveFn,
} from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// ── seed ─────────────────────────────────────────────────────────────────────

test("quickjs-compiler segment seeds the 'quickjs' compiler cel", () => {
  const state = createInitialState();
  const qjs = state.cels.get("quickjs");
  assert.ok(qjs, "quickjs compiler cel missing");
  assert.equal(qjs.celType, "LockedLambdaCel");
  assert.equal(qjs.locked, true);
});

test("quickjs kind exposes the four status cels and two bridge cels", () => {
  const state = createInitialState();
  for (const key of [
    "load-deps.quickjs", "quickjs.ready", "quickjs.alive", "quickjs.errors",
    "quickjs-to-js", "js-to-quickjs",
  ]) {
    assert.ok(state.cels.get(key), `${key} cel missing`);
  }
});

// ── compile + run via registerLambda ────────────────────────────────────────

// The dead `(t)` param made bun wait on a never-called done-callback —
// a perma-timeout that looked like slow QuickJS. Dropping it lets the test
// run in the documented ~50-200ms. QuickJS coverage stays live (not skipped).
test("a quickjs lambda compiles and runs", { timeout: 60000 }, async () => {
  console.log("loading QuickJS runtime; ~50-200ms first time");

  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "qjs-double",
    kind: "quickjs",
    source: "((x) => x * 2)",
  });

  const fn = resolveFn(state, "qjs-double");
  assert.equal(typeof fn, "function");
  assert.equal(fn(21), 42);
  assert.equal(fn(0), 0);
  assert.equal(fn(-3), -6);
});

test("quickjs lambda receives string args and returns string results", { timeout: 60000 }, async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "qjs-greet",
    kind: "quickjs",
    source: "((name) => `hello, ${name}!`)",
  });
  const fn = resolveFn(state, "qjs-greet");
  assert.equal(fn("world"), "hello, world!");
});

test("quickjs lambda handles multiple args", { timeout: 60000 }, async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "qjs-add",
    kind: "quickjs",
    source: "((a, b, c) => a + b + c)",
  });
  const fn = resolveFn(state, "qjs-add");
  assert.equal(fn(1, 2, 3), 6);
});

// ── source where last expression isn't callable ─────────────────────────────

test("quickjs source without a trailing callable throws a clear error", { timeout: 60000 }, async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await assert.rejects(
    () => register(state, {
      key: "not-callable",
      kind: "quickjs",
      source: "42",
    }),
    /not a function|not a callable/i,
  );
});

// ── host imports ────────────────────────────────────────────────────────────

test("a quickjs lambda can call host.log and host.now", { timeout: 60000 }, async () => {
  console.log("loading QuickJS runtime");

  const state = createInitialState();
  const calls = [];
  state.cels.get("host.log")._fn = (msg) => { calls.push(msg); };
  state.cels.get("host.now")._fn = () => 1234;

  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "qjs-with-host",
    kind: "quickjs",
    source: `
      ((name) => {
        host.log("hello " + name);
        return host.now();
      })
    `,
  });
  const fn = resolveFn(state, "qjs-with-host");
  assert.equal(fn("alice"), 1234);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "hello alice");
});

// ── declarative path + trap-as-value ───────────────────────────────────────

test("a declarative quickjs cel with bad source becomes a CelError; hydrate completes", { timeout: 60000 }, async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const { isCelError } = await import("../dist/index.js");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "broken", celType: "EditableLambdaCel",
        metadata: { key: "broken", segment: "user", kind: "quickjs" },
        f: "this is not valid javascript (((" },
      { key: "ok", celType: "ValueCel",
        metadata: { key: "ok", segment: "user", v: 42 } },
    ],
  }], [baseManifest]);

  assert.ok(isCelError(state.cels.get("broken").v));
  assert.equal(state.cels.get("ok").v, 42);
});

// ── csp gate ────────────────────────────────────────────────────────────────

test("csp.wasm-available = false rejects quickjs compile before runtime load", { timeout: 60000 }, async () => {
  const state = createInitialState();
  state.cels.set("csp.wasm-available", {
    ...state.cels.get("csp.wasm-available"), v: false,
  });
  const register = resolveFn(state, "registerLambda");
  await assert.rejects(
    () => register(state, { key: "x", kind: "quickjs", source: "((x) => x)" }),
    /csp\.wasm-available = false|WebAssembly is unavailable/i,
  );
});

// ── integration: quickjs cel in a formula graph ────────────────────────────

test("a quickjs lambda integrates with the runCycle cascade", { timeout: 60000 }, async () => {
  const state = createInitialState();
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 8 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 7 } },
      { key: "mul", celType: "EditableLambdaCel",
        metadata: { key: "mul", segment: "user", kind: "quickjs" },
        f: "((a, b) => a * b)" },
      { key: "product", celType: "FormulaCel",
        metadata: { key: "product", segment: "user", parser: "f" },
        f: "(mul a b)" },
    ],
  }], [baseManifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  assert.equal(state.cels.get("product").v, 56);
});
