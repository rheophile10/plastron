import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// ── seed ─────────────────────────────────────────────────────────────────────

const HOST_KEYS = ["host.log", "host.warn", "host.error", "host.now", "host.random"];

test("host segment seeds the capability cels", () => {
  const state = createInitialState();
  for (const key of HOST_KEYS) {
    const cel = state.cels.get(key);
    assert.ok(cel, `${key} cel missing`);
    assert.equal(cel.celType, "LockedLambdaCel");
    assert.equal(cel.locked, true);
    assert.equal(typeof resolveFn(state, key), "function");
  }
});

test("host.now and host.random produce live values", () => {
  const state = createInitialState();
  const now = resolveFn(state, "host.now");
  const random = resolveFn(state, "host.random");

  const t = now();
  assert.equal(typeof t, "number");
  assert.ok(t > 0);

  const r = random();
  assert.equal(typeof r, "number");
  assert.ok(r >= 0 && r < 1);
});

// ── WAT modules importing from host ─────────────────────────────────────────

test("a WAT module can import host.log and call it during execution", async () => {
  const state = createInitialState();
  // Swap host.log for a spy so we can observe the call without touching
  // stdout. Direct mutation is fine in tests — `locked` guards setCel,
  // not internal access.
  const calls = [];
  state.cels.get("host.log")._fn = (n) => { calls.push(n); };

  const hydrate = resolveFn(state, "hydrate");
  // WAT module that imports host.log, calls it with the input, then
  // returns the input + 1.
  const src = `
    (module
      (import "host" "log" (func $log (param i32)))
      (func (export "main") (param $x i32) (result i32)
        local.get $x
        call $log
        local.get $x
        i32.const 1
        i32.add))
  `;
  await hydrate(state, [{
    name: "user",
    cels: [{
      key: "log-and-inc", celType: "EditableLambdaCel",
      metadata: { key: "log-and-inc", segment: "user", kind: "wat" },
      f: src,
    }],
  }], [baseManifest]);

  const fn = state.cels.get("log-and-inc")._fn;
  assert.equal(fn(41), 42);
  assert.deepEqual(calls, [41], "host.log should have received the argument");
});

test("a WAT module without imports continues to compile against the host bindings", async () => {
  // Backwards-compat: existing WAT cels that don't use any host capabilities
  // still work after the wat-compiler started threading host imports.
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "user",
    cels: [{
      key: "add", celType: "EditableLambdaCel",
      metadata: { key: "add", segment: "user", kind: "wat" },
      f: "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
         "local.get $a local.get $b i32.add))",
    }],
  }], [baseManifest]);
  assert.equal(state.cels.get("add")._fn(3, 4), 7);
});

// ── Python lambdas using host ──────────────────────────────────────────────

test("a Python lambda can call host.log and host.now via the JS bridge", async (t) => {
  t.diagnostic("loading Pyodide; this can take 5-20s the first time");

  const state = createInitialState();
  const calls = [];
  state.cels.get("host.log")._fn = (msg) => { calls.push(msg); };
  state.cels.get("host.now")._fn = () => 1234567890;

  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "py-with-host",
    kind: "py",
    source: [
      "def go(name):",
      "    host.log(f'hello, {name}!')",
      "    return host.now()",
      "go",
    ].join("\n"),
  });

  const fn = resolveFn(state, "py-with-host");
  const result = fn("world");
  assert.equal(result, 1234567890);
  assert.equal(calls.length, 1, "host.log should have been called");
  // Pyodide's f-string output arrives as a Python str → JS string via
  // the bridge.
  assert.equal(String(calls[0]), "hello, world!");
});

// ── readHostImports fallback ───────────────────────────────────────────────

test("readHostImports falls back to default fns when host cels are missing", async () => {
  // Build a state, then DELETE host cels — simulates a stripped-down
  // segment composition where the host segment wasn't installed.
  const state = createInitialState();
  for (const key of HOST_KEYS) state.cels.delete(key);

  // WAT compile should still succeed using built-in fallbacks. We don't
  // assert exact console output here — just that the compile doesn't
  // crash.
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "user",
    cels: [{
      key: "no-host-add", celType: "EditableLambdaCel",
      metadata: { key: "no-host-add", segment: "user", kind: "wat" },
      f: "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
         "local.get $a local.get $b i32.add))",
    }],
  }], [baseManifest]);

  assert.equal(state.cels.get("no-host-add")._fn(2, 5), 7);
});
