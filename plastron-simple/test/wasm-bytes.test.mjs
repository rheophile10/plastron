import { test, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Isolate file-store writes under a unique prefix in whatever root the
// segment chose (see file-store.test.mjs for the import-order caveat).
process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs";

const { createInitialState, resolveFn, isWasmHandle } = await import("../dist/index.js");

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
const toB64 = (bytes) => Buffer.from(bytes).toString("base64");

// Real wasm bytes, produced by the shipped `wat` compiler: calling its
// _fn directly returns the { fn, wasm } envelope, so we get the binary
// without hand-encoding. This is the "wat-compiler already produces
// bytes; wasm-bytes accepts them" relationship, exercised.
const watBytes = async (state, watSource) => {
  const wat = resolveFn(state, "wat");
  const env = await wat(watSource, state);
  return env.wasm;
};

const ADD_WAT = `
  (module (func (export "add") (param $a i32) (param $b i32) (result i32)
    local.get $a local.get $b i32.add))`;

// main + helper: the wat compiler picks "main" and returns bytes that
// still carry BOTH exports — perfect for testing explicit export choice.
const MAIN_HELPER_WAT = `
  (module
    (func (export "helper") (result i32) i32.const 99)
    (func (export "main")   (result i32) i32.const 42))`;

const GO7_WAT = `(module (func (export "go") (result i32) i32.const 7))`;
const ANSWER_WAT = `(module (func (export "main") (result i32) i32.const 1234))`;

// Hand-encoded module that imports (func env.bump (result i32)) and
// exports main = bump() + 1. Built by hand because the wat compiler
// can't return bytes for a module it can't itself instantiate (it only
// supplies the "host" namespace, not "env").
const ENV_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,             // \0asm, version 1
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,                   // type sec: () -> i32
  0x02, 0x0c, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x04, 0x62, 0x75, 0x6d, 0x70, 0x00, 0x00, // import "env" "bump" func t0
  0x03, 0x02, 0x01, 0x00,                                     // func sec: 1 func, type 0
  0x07, 0x08, 0x01, 0x04, 0x6d, 0x61, 0x69, 0x6e, 0x00, 0x01, // export "main" -> func idx 1
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x10, 0x00, 0x41, 0x01, 0x6a, 0x0b, // code: call 0; i32.const 1; i32.add; end
]);

let B64_ADD, B64_MAIN_HELPER, B64_GO7, B64_ANSWER;
const B64_ENV = toB64(ENV_MODULE);

beforeAll(async () => {
  const s = createInitialState();
  B64_ADD         = toB64(await watBytes(s, ADD_WAT));
  B64_MAIN_HELPER = toB64(await watBytes(s, MAIN_HELPER_WAT));
  B64_GO7         = toB64(await watBytes(s, GO7_WAT));
  B64_ANSWER      = toB64(await watBytes(s, ANSWER_WAT));
});

// ── boot ──────────────────────────────────────────────────────────────────

test("wasm-bytes segment seeds the 'wasm' loader cel + status cels + bridges", () => {
  const state = createInitialState();
  const wasm = state.cels.get("wasm");
  assert.ok(wasm, "wasm loader cel missing");
  assert.equal(wasm.locked, true, "wasm loader cel should be locked");
  assert.equal(state.cels.get("wasm.ready").v, true);
  assert.equal(state.cels.get("wasm.alive").v, true);
  assert.equal(state.cels.get("load-deps.wasm").v, true);
  assert.ok(state.cels.get("wasm-to-js"), "wasm-to-js bridge missing");
  assert.ok(state.cels.get("js-to-wasm"), "js-to-wasm bridge missing");
  assert.equal(typeof resolveFn(state, "wasm"), "function");
});

// ── inline base64 bytes, no imports (registerLambda) ────────────────────────

test("base64 wasm bytes load into a callable Fn via registerLambda (single export ladder)", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "adder", source: B64_ADD, kind: "wasm" });

  const adder = resolveFn(state, "adder");
  assert.equal(typeof adder, "function");
  assert.equal(adder(2, 3), 5);
  assert.equal(adder(-1, 1), 0);
  assert.equal(adder(2147483647, 1), -2147483648); // i32 wrap, like the wat path
});

test("garbage (non-wasm) base64 fails with a friendly header message", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await assert.rejects(
    () => register(state, { key: "junk", source: toB64(new Uint8Array([1, 2, 3, 4])), kind: "wasm" }),
    /\\0asm|did not decode to a wasm module/i,
  );
});

// ── metadata.wasmExport selects a non-default export (declarative) ───────────

test("metadata.wasmExport picks a named export; absent → prefer 'main'", async () => {
  const state = createInitialState();
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "pick-helper", celType: "EditableLambdaCel",
        metadata: { key: "pick-helper", segment: "user", kind: "wasm", wasmExport: "helper" },
        f: B64_MAIN_HELPER },
      { key: "helper-out", celType: "FormulaCel",
        metadata: { key: "helper-out", segment: "user", parser: "f" },
        f: "(pick-helper)" },

      { key: "pick-default", celType: "EditableLambdaCel",
        metadata: { key: "pick-default", segment: "user", kind: "wasm" },
        f: B64_MAIN_HELPER },
      { key: "default-out", celType: "FormulaCel",
        metadata: { key: "default-out", segment: "user", parser: "f" },
        f: "(pick-default)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  assert.equal(state.cels.get("helper-out").v, 99, "wasmExport:'helper' should call the helper export");
  assert.equal(state.cels.get("default-out").v, 42, "no wasmExport should fall back to 'main'");
});

test("metadata.wasmExport naming a missing export traps as a CelError", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "nope", celType: "EditableLambdaCel",
        metadata: { key: "nope", segment: "user", kind: "wasm", wasmExport: "ghost" },
        f: B64_MAIN_HELPER },
    ],
  }], [baseManifest]);
  // Compile error becomes a CelError on cel.v (hydrate doesn't abort).
  const v = state.cels.get("nope").v;
  assert.ok(v && v.kind === "error", `expected a CelError, got ${JSON.stringify(v)}`);
  assert.match(String(v.message), /no function export named "ghost"/i);
});

// ── composite outputSchema → WasmHandle, materialized by wasm-to-js ──────────

test("composite outputSchema yields a WasmHandle; wasm-to-js materializes it", async () => {
  const state = createInitialState();
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "make", celType: "EditableLambdaCel",
        metadata: { key: "make", segment: "user", kind: "wasm",
                    wasmExport: "go", outputSchema: "wasm:opaque" },
        f: B64_GO7 },
      { key: "result", celType: "FormulaCel",
        metadata: { key: "result", segment: "user", parser: "f" },
        f: "(make)" },
      { key: "asjs", celType: "FormulaCel",
        metadata: { key: "asjs", segment: "user", parser: "f" },
        f: "(wasm-to-js result)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  const handle = state.cels.get("result").v;
  assert.ok(isWasmHandle(handle), `result.v should be a WasmHandle, got ${JSON.stringify(handle)}`);
  assert.equal(handle.kind, "wasm");
  assert.equal(typeof handle.ref, "number");
  assert.equal(state.cels.get("asjs").v, 7, "wasm-to-js should dereference the handle to its raw value");
});

// ── pluggable imports provider (env namespace) ───────────────────────────────

test("a metadata.imports provider supplies an 'env' namespace the module imports", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  // The provider returns a WebAssembly imports object; its namespaces
  // merge over the default { host }.
  await register(state, { key: "env-provider", fn: () => ({ env: { bump: () => 7 } }) });

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "env-main", celType: "EditableLambdaCel",
        metadata: { key: "env-main", segment: "user", kind: "wasm", imports: "env-provider" },
        f: B64_ENV },
      { key: "env-out", celType: "FormulaCel",
        metadata: { key: "env-out", segment: "user", parser: "f" },
        f: "(env-main)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  assert.equal(state.cels.get("env-out").v, 8, "main should call env.bump() (7) + 1");
});

test("a module needing the same import with no provider traps (LinkError)", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  // No imports provider → only { host } is supplied; the module's
  // (import "env" "bump") is unsatisfied, so instantiate rejects.
  await assert.rejects(
    () => register(state, { key: "env-unmet", source: B64_ENV, kind: "wasm" }),
  );
});

// ── file-store:<path> source ─────────────────────────────────────────────────

const TEST_PREFIX = `__wasm-bytes-${process.pid}-${Date.now().toString(36)}`;
let activeRoot;
afterAll(async () => {
  if (activeRoot) await fs.rm(path.resolve(activeRoot, TEST_PREFIX), { recursive: true, force: true });
});

test("wasm bytes load from a 'file-store:<path>' reference", async () => {
  const state = createInitialState();
  activeRoot = state.cels.get("file-store.root").v;
  const relPath = `${TEST_PREFIX}/add.wasm`;

  // Stage the bytes in the file store, then load them through the kind.
  await resolveFn(state, "fs.write")(relPath, await watBytes(state, ADD_WAT));

  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "fs-adder", source: `file-store:${relPath}`, kind: "wasm" });

  const adder = resolveFn(state, "fs-adder");
  assert.equal(adder(40, 2), 42);
});

// ── dehydrate / hydrate round-trip — .甲 portability ─────────────────────────

test("a kind:'wasm' cel round-trips through dehydrate → hydrate (bytes are JSON)", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");

  await hydrate(stateA, [{
    name: "user",
    cels: [
      { key: "answer", celType: "EditableLambdaCel",
        metadata: { key: "answer", segment: "user", kind: "wasm" },
        f: B64_ANSWER },
      { key: "out", celType: "FormulaCel",
        metadata: { key: "out", segment: "user", parser: "f" },
        f: "(answer)" },
    ],
  }], [baseManifest]);

  const dumped = dehydrate(stateA, { onlySegments: ["user"] });
  // The serialized cel carries the bytes in f and the kind in metadata.
  const userSeg = dumped.segments.find((s) => s.name === "user");
  const answerCel = userSeg.cels.find((c) => c.key === "answer");
  assert.equal(answerCel.metadata.kind, "wasm");
  assert.equal(answerCel.f, B64_ANSWER);
  assert.equal(JSON.stringify(dumped).length > 0, true);

  const stateB = createInitialState();
  const hydrateB  = resolveFn(stateB, "hydrate");
  const runCycleB = resolveFn(stateB, "runCycle");
  await hydrateB(stateB, dumped.segments, dumped.manifests);
  await runCycleB(stateB);

  assert.equal(state_get(stateB, "out"), 1234, "re-hydrated wasm cel should still compute");
});

const state_get = (state, key) => state.cels.get(key).v;

// ── CSP gate ─────────────────────────────────────────────────────────────────

test("csp.wasm-available = false makes the wasm loader refuse with a CSP-aware message", async () => {
  const state = createInitialState();
  state.cels.set("csp.wasm-available", { ...state.cels.get("csp.wasm-available"), v: false });
  const register = resolveFn(state, "registerLambda");
  await assert.rejects(
    () => register(state, { key: "blocked", source: B64_ADD, kind: "wasm" }),
    /csp\.wasm-available = false|WebAssembly is unavailable/i,
  );
});
