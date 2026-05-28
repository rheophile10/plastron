import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState } from "../dist/index.js";

// The kind-status convention: every kind segment exposes four cels at
// well-known keys. The values are trivial for main-thread compilers
// (js, wat) — load-deps and ready are true at boot, alive is always
// true, errors is []. Worker-backed kinds (py later) drive the same keys
// through real lifecycle events. This test pins the contract.

const STATUS_KEYS = (k) => [
  `load-deps.${k}`,
  `${k}.ready`,
  `${k}.alive`,
  `${k}.errors`,
];

for (const kind of ["js", "wat"]) {
  test(`${kind} kind segment exposes the four status cels`, () => {
    const state = createInitialState();
    for (const key of STATUS_KEYS(kind)) {
      const cel = state.cels.get(key);
      assert.ok(cel, `status cel ${key} missing`);
      assert.equal(cel.celType, "ValueCel", `${key} should be a ValueCel`);
    }
  });

  test(`${kind} status cels declare schemas via metadata.schema`, () => {
    const state = createInitialState();
    // metadata.schema is the key of the SchemaCel that *would* be
    // attached if its segment is installed. js-common-schema (which
    // defines "boolean" / "array") isn't in the default seed today —
    // its key namespace collides with core fns (`set`, `map`). So
    // resolveSchemas leaves cel.schema = undefined at runtime; the
    // metadata.schema string survives as the declared contract,
    // documentation for any host that opts the schemas in later.
    assert.equal(state.cels.get(`load-deps.${kind}`).metadata.schema, "boolean");
    assert.equal(state.cels.get(`${kind}.ready`).metadata.schema,    "boolean");
    assert.equal(state.cels.get(`${kind}.alive`).metadata.schema,    "boolean");
    assert.equal(state.cels.get(`${kind}.errors`).metadata.schema,   "array");
  });

  test(`${kind} status cels seed with expected default values`, () => {
    const state = createInitialState();
    assert.equal(state.cels.get(`load-deps.${kind}`).v, true);
    assert.equal(state.cels.get(`${kind}.ready`).v,    true);
    assert.equal(state.cels.get(`${kind}.alive`).v,    true);
    assert.deepEqual(state.cels.get(`${kind}.errors`).v, []);
  });
}

// ── inflateCel fix: SchemaCels in seed JSON put their value at the
//    dehydrated-cel top level (richer than nesting under metadata).
//    Inflate now reads dc.v ?? metadata.v so this round-trips. Tested
//    via cel-error, since js-common-schema isn't in the seed manifests
//    today (namespace collision with core `set`/`map` fns).

test("cel-error SchemaCel inflates with its full schema body", () => {
  const state = createInitialState();
  const errSchema = state.cels.get("cel-error");
  assert.equal(errSchema.celType, "SchemaCel");
  assert.equal(errSchema.v.key, "cel-error");
  assert.equal(errSchema.v.zod.type, "object");
  assert.equal(errSchema.v.protocols.isChanged, "cel-error_isChanged");
});
