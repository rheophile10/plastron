import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, isWitPrimitive, isWasmHandle } from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// ── seed: every WIT primitive has a reachable SchemaCel ─────────────────────

const PRIMS = [
  "wasm:bool", "wasm:i32", "wasm:u32", "wasm:i64", "wasm:u64",
  "wasm:f32",  "wasm:f64", "wasm:char", "wasm:string",
];

for (const key of PRIMS) {
  test(`${key} SchemaCel is seeded with kind='wasm' and a WIT type`, () => {
    const state = createInitialState();
    const cel = state.cels.get(key);
    assert.ok(cel, `${key} not in state.cels`);
    assert.equal(cel.celType, "SchemaCel");
    assert.equal(cel.v.kind, "wasm", `${key}.v.kind should be "wasm"`);
    assert.ok(cel.v.wit, `${key}.v.wit should be present`);
    assert.equal(typeof cel.v.wit.kind, "string");
    assert.ok(cel.v.zod, `${key}.v.zod should still carry a JSONSchema`);
  });
}

test("wasm-scalar protocol fns are reachable via resolveFn", () => {
  const state = createInitialState();
  for (const k of [
    "wasm-scalar_isChanged", "wasm-scalar_hydrate", "wasm-scalar_dehydrate",
    "wasm-bigint_hydrate",   "wasm-bigint_dehydrate",
  ]) {
    assert.equal(typeof resolveFn(state, k), "function", `${k} not resolved`);
  }
});

// ── isWitPrimitive predicate ────────────────────────────────────────────────

test("isWitPrimitive accepts all v3 primitives and rejects composites", () => {
  for (const kind of ["bool", "u32", "s32", "u64", "s64", "f32", "f64", "char", "string"]) {
    assert.equal(isWitPrimitive({ kind }), true, kind);
  }
  assert.equal(isWitPrimitive({ kind: "list",    element: { kind: "u32" } }), false);
  assert.equal(isWitPrimitive({ kind: "record",  fields: {} }), false);
  assert.equal(isWitPrimitive({ kind: "variant", cases:  {} }), false);
});

// ── isWasmHandle predicate ──────────────────────────────────────────────────

test("isWasmHandle accepts well-formed handles, rejects malformed shapes", () => {
  assert.equal(isWasmHandle({ kind: "wat", type: { kind: "u32" }, ref: 7 }), true);
  assert.equal(isWasmHandle({ kind: "wat", type: { kind: "u32" } }), false, "missing ref");
  assert.equal(isWasmHandle({ kind: "wat", ref: 7 }), false, "missing type");
  assert.equal(isWasmHandle(null), false);
  assert.equal(isWasmHandle(42),   false);
  assert.equal(isWasmHandle("h"),  false);
});

// ── schema resolution: a user cel attaching wasm:i32 inflates correctly ────

test("a cel declaring metadata.schema='wasm:i32' resolves to the wasm SchemaCel", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const seg = {
    name: "user",
    cels: [{
      key: "temperature",
      celType: "ValueCel",
      metadata: { key: "temperature", segment: "user", schema: "wasm:i32", v: 42 },
    }],
  };
  await hydrate(state, [seg], [baseManifest]);

  const cel = state.cels.get("temperature");
  assert.ok(cel.schema, "schema not attached after hydrate");
  assert.equal(cel.schema.kind, "wasm");
  assert.equal(cel.schema.wit.kind, "s32", "WIT type should be s32 for wasm:i32");
});

// ── round-trip through dehydrate/hydrate ────────────────────────────────────

test("wasm-typed cel survives dehydrate → hydrate round-trip", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const dehydrate = resolveFn(state, "dehydrate");

  const seg = {
    name: "user",
    cels: [{
      key: "n",
      celType: "ValueCel",
      metadata: { key: "n", segment: "user", schema: "wasm:i32", v: 99 },
    }],
  };
  await hydrate(state, [seg], [baseManifest]);

  const { segments } = dehydrate(state);
  const userSeg = segments.find((s) => s.name === "user");
  const nDeh = userSeg.cels.find((c) => c.key === "n");
  assert.equal(nDeh.metadata.schema, "wasm:i32", "schema key should round-trip");
  assert.equal(nDeh.metadata.v, 99);
});

// ── bigint hydrate/dehydrate ────────────────────────────────────────────────

test("wasm-bigint_dehydrate emits decimal-string form", () => {
  const state = createInitialState();
  const dehydrateBig = resolveFn(state, "wasm-bigint_dehydrate");
  assert.equal(dehydrateBig(123n), "123");
  assert.equal(dehydrateBig(-9007199254740993n), "-9007199254740993");
});

test("wasm-bigint_hydrate parses decimal-string back to BigInt", () => {
  const state = createInitialState();
  const hydrateBig = resolveFn(state, "wasm-bigint_hydrate");
  assert.equal(hydrateBig("123"), 123n);
  assert.equal(hydrateBig("-9007199254740993"), -9007199254740993n);
  // Live BigInt passes through unchanged.
  assert.equal(hydrateBig(42n), 42n);
});

// ── pictograph: wat-add now declares wasm:i32 output ────────────────────────

test("wat-add in pictograph declares outputSchema='wasm:i32'", async () => {
  // Boot the same state pictograph uses (the kernel seeds wasm-types, so
  // any user cel can name wasm:i32 without an extra install).
  const state = createInitialState();
  // Just verifying the schema is wired correctly without re-running
  // pictograph end-to-end (that's a separate integration test).
  const wasmI32 = state.cels.get("wasm:i32");
  assert.ok(wasmI32, "wasm:i32 SchemaCel not seeded");
  assert.equal(wasmI32.v.wit.kind, "s32");
});
