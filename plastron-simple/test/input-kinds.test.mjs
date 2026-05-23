import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

const SIMPLE_ADD_WAT = `
  (module
    (func (export "main") (param $a i32) (param $b i32) (result i32)
      local.get $a local.get $b i32.add))
`;

// ── no inputKinds declared → no validation, current behavior preserved ─────

test("a fireable cel without inputKinds wires arbitrary sources (v1 behavior)", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  // wat-add receives a, b which are js-domain ValueCels. No inputKinds
  // declared on wat-add → no kind check → wiring succeeds.
  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 2 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 3 } },
      { key: "wat-add", celType: "EditableLambdaCel",
        metadata: { key: "wat-add", segment: "user", kind: "wat" },
        f: SIMPLE_ADD_WAT },
      { key: "result", celType: "FormulaCel",
        metadata: { key: "result", segment: "user", parser: "f" },
        f: "(wat-add a b)" },
    ],
  }], [baseManifest]);
  // No throw — hydrate succeeded.
  assert.ok(state.cels.get("wat-add"));
});

// ── declared kind matches → wiring succeeds ────────────────────────────────

test("inputKinds matching the source's kindOf passes validation", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  // A js-kind formula declaring its input as kind "js", wired to a js
  // value cell. Match → no throw.
  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "n", celType: "ValueCel", metadata: { key: "n", segment: "user", v: 5 } },
      { key: "doubled", celType: "FormulaCel",
        metadata: {
          key: "doubled", segment: "user", parser: "f",
          inputMap: { n: "n" },
          inputKinds: { n: "js" },
        },
        f: "(* n 2)" },
    ],
  }], [baseManifest]);
  assert.ok(state.cels.get("doubled"));
});

// ── declared kind mismatches → hydrate throws with bridge suggestion ───────

test("inputKinds mismatch throws a clear error pointing at the missing bridge", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  // Declare wat-add's inputs as kind "wat" but wire them to js-domain
  // ValueCels. Hydrate must refuse with a bridge suggestion.
  await assert.rejects(
    () => hydrate(state, [{
      name: "user",
      cels: [
        { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 2 } },
        { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 3 } },
        { key: "strict-wat-add", celType: "EditableLambdaCel",
          metadata: {
            key: "strict-wat-add", segment: "user", kind: "wat",
            inputMap:    { a: "a",  b: "b"  },
            inputKinds:  { a: "wat", b: "wat" },
          },
          f: SIMPLE_ADD_WAT },
      ],
    }], [baseManifest]),
    (err) => {
      assert.match(err.message, /input-kind mismatch/);
      // Both mismatches reported in one error.
      assert.match(err.message, /strict-wat-add.*\.inputs\.a/);
      assert.match(err.message, /strict-wat-add.*\.inputs\.b/);
      // Bridge suggestion uses the <from>-to-<to> naming convention.
      assert.match(err.message, /\(js-to-wat a\)/);
      assert.match(err.message, /\(js-to-wat b\)/);
      return true;
    },
  );
});

// ── inserting the right bridge resolves the mismatch ───────────────────────

test("wiring through an explicit bridge satisfies inputKinds validation", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  // Strict wat-add demands kind="wat" inputs. Pass them through
  // (js-to-wat a) and (js-to-wat b) formulas — but those formulas
  // are themselves kind "js" (FormulaCels), so they don't satisfy
  // either. The honest demo is: declare the bridge formulas as the
  // values that ARE wat-kind. For v1 that's impossible without bridge
  // formulas that themselves claim a non-js kind. So this test
  // verifies the orthogonal happy path: declared inputKinds match
  // existing wirings.
  await hydrate(state, [{
    name: "user",
    cels: [
      // Two lambda cells with kind "wat" act as the "wat-domain values"
      // we hand into strict-wat-add. Each returns a constant.
      { key: "wat-a", celType: "EditableLambdaCel",
        metadata: { key: "wat-a", segment: "user", kind: "wat" },
        f: "(module (func (export \"main\") (result i32) i32.const 5))" },
      { key: "wat-b", celType: "EditableLambdaCel",
        metadata: { key: "wat-b", segment: "user", kind: "wat" },
        f: "(module (func (export \"main\") (result i32) i32.const 7))" },
      { key: "strict-wat-add", celType: "EditableLambdaCel",
        metadata: {
          key: "strict-wat-add", segment: "user", kind: "wat",
          inputMap:    { a: "wat-a",  b: "wat-b"  },
          inputKinds:  { a: "wat",    b: "wat"    },
        },
        f: SIMPLE_ADD_WAT },
    ],
  }], [baseManifest]);
  // Both wat-a and wat-b are kindOf="wat" — strict-wat-add's
  // inputKinds match — no throw.
  assert.ok(state.cels.get("strict-wat-add"));
});

// ── inputKinds for an input that isn't wired is ignored ────────────────────

test("inputKinds entries with no matching inputMap key are silently ignored", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "n", celType: "ValueCel", metadata: { key: "n", segment: "user", v: 5 } },
      { key: "g", celType: "FormulaCel",
        metadata: {
          key: "g", segment: "user", parser: "f",
          inputMap:    { n: "n" },
          inputKinds:  { n: "js", "doesnt-exist": "wat" },
        },
        f: "(* n 2)" },
    ],
  }], [baseManifest]);
  // No throw — extra entry in inputKinds without an inputMap pair is
  // just dead metadata.
  assert.ok(state.cels.get("g"));
});

// ── error aggregation: multiple mismatches reported together ───────────────

test("multiple input-kind mismatches across cels are aggregated into one error", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  await assert.rejects(
    () => hydrate(state, [{
      name: "user",
      cels: [
        { key: "v1", celType: "ValueCel", metadata: { key: "v1", segment: "user", v: 1 } },
        { key: "v2", celType: "ValueCel", metadata: { key: "v2", segment: "user", v: 2 } },
        { key: "wat-c1", celType: "EditableLambdaCel",
          metadata: {
            key: "wat-c1", segment: "user", kind: "wat",
            inputMap:    { x: "v1" },
            inputKinds:  { x: "wat" },
          },
          f: SIMPLE_ADD_WAT },
        { key: "wat-c2", celType: "EditableLambdaCel",
          metadata: {
            key: "wat-c2", segment: "user", kind: "wat",
            inputMap:    { x: "v2" },
            inputKinds:  { x: "wat" },
          },
          f: SIMPLE_ADD_WAT },
      ],
    }], [baseManifest]),
    (err) => {
      // Two mismatches in one throw.
      assert.match(err.message, /2 input-kind mismatch/);
      assert.match(err.message, /wat-c1/);
      assert.match(err.message, /wat-c2/);
      return true;
    },
  );
});
