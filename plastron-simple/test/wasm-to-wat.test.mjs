import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

const SIMPLE_ADD_WAT = `
  (module
    (func (export "main") (param $a i32) (param $b i32) (result i32)
      local.get $a local.get $b i32.add))
`;

// ── seed ─────────────────────────────────────────────────────────────────────

test("wasm-to-wat utility cel is seeded by wat-compiler", () => {
  const state = createInitialState();
  const cel = state.cels.get("wasm-to-wat");
  assert.ok(cel, "wasm-to-wat cel missing");
  assert.equal(cel.celType, "LockedLambdaCel");
  assert.equal(typeof resolveFn(state, "wasm-to-wat"), "function");
});

// ── compiled WAT cels store their bytes on _wasm ───────────────────────────

test("a compiled wat lambda exposes its wasm bytes on cel._wasm", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "adder", source: SIMPLE_ADD_WAT, kind: "wat" });

  // registerLambda doesn't go through compileCelBody (it calls the
  // compiler directly), so it doesn't stash _wasm. Test via the
  // declarative path instead.
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "user",
    cels: [{
      key: "decl-adder",
      celType: "EditableLambdaCel",
      metadata: { key: "decl-adder", segment: "user", kind: "wat" },
      f: SIMPLE_ADD_WAT,
    }],
  }], [baseManifest]);

  const cel = state.cels.get("decl-adder");
  assert.ok(cel._wasm, "cel._wasm should be populated by compileCelBody");
  assert.ok(cel._wasm instanceof Uint8Array, "_wasm must be a Uint8Array");
  // Minimal wasm header check — \0asm + version 1
  assert.equal(cel._wasm[0], 0x00);
  assert.equal(cel._wasm[1], 0x61);
  assert.equal(cel._wasm[2], 0x73);
  assert.equal(cel._wasm[3], 0x6d);
});

// ── wasm-to-wat round-trip ─────────────────────────────────────────────────

test("wasm-to-wat decompiles bytes back into readable WAT", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "user",
    cels: [{
      key: "adder",
      celType: "EditableLambdaCel",
      metadata: { key: "adder", segment: "user", kind: "wat" },
      f: SIMPLE_ADD_WAT,
    }],
  }], [baseManifest]);

  const bytes = state.cels.get("adder")._wasm;
  const wasmToWat = resolveFn(state, "wasm-to-wat");
  const text = await wasmToWat(bytes);

  assert.equal(typeof text, "string", "wasm-to-wat should return a string");
  assert.match(text, /\(module/,  "output should contain (module");
  assert.match(text, /i32\.add/,  "output should reference i32.add");
  assert.match(text, /export/,    "output should reference an export");
});

// ── error path: wasm-to-wat rejects non-Uint8Array input ───────────────────

test("wasm-to-wat throws a clear error when given non-bytes input", async () => {
  const state = createInitialState();
  const wasmToWat = resolveFn(state, "wasm-to-wat");

  await assert.rejects(() => wasmToWat("not bytes"), /expected Uint8Array/);
  await assert.rejects(() => wasmToWat(null),        /expected Uint8Array/);
  await assert.rejects(() => wasmToWat(42),          /expected Uint8Array/);
});
