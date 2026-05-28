import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precompute, precomputeOptional, resolveFn } from "../dist/index.js";

// FormulaCelMetadata.parser is the renamed slot that used to be
// `metadata.compiler`. These tests cover the new contract check, the
// migration helper, and the happy path.

const bootWithCel = async (cel) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = { name: "user", cels: [
    { key: "x", celType: "ValueCel", metadata: { key: "x", segment: "user", v: 2 } },
    { key: "y", celType: "ValueCel", metadata: { key: "y", segment: "user", v: 3 } },
    cel,
  ] };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [seg], [manifest]);
  return state;
};

test("FormulaCel with explicit parser:'f' hydrates and computes", async () => {
  const state = await bootWithCel({
    key: "sum",
    celType: "FormulaCel",
    metadata: { key: "sum", segment: "user", parser: "f" },
    f: "(+ x y)",
  });
  precompute(state);
  await precomputeOptional(state);
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.equal(state.cels.get("sum")?.v, 5);
  assert.equal(state.cels.get("sum")?.metadata.parser, "f");
});

test("FormulaCel whose parser emits a bare Fn (no buildEvaluate) throws at hydrate", async () => {
  // Register a parser-shaped compiler that returns a bare function
  // — i.e. a CompiledLambda but not a CompiledEnvelope. This is the
  // exact misuse the new contract check is designed to surface.
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "bad-parser",
    fn: (_source) => () => 42,
    kind: "custom",
  });

  const hydrate = resolveFn(state, "hydrate");
  const seg = { name: "user", cels: [
    { key: "x", celType: "ValueCel", metadata: { key: "x", segment: "user", v: 1 } },
    {
      key: "broken",
      celType: "FormulaCel",
      metadata: { key: "broken", segment: "user", parser: "bad-parser" },
      f: "(+ x 1)",
    },
  ] };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await assert.rejects(
    () => hydrate(state, [seg], [manifest]),
    /FormulaCel "broken" uses parser "bad-parser".*CompiledEnvelope.*buildEvaluate/s,
  );
});

test("legacy metadata.compiler is migrated to metadata.parser on hydrate", async () => {
  const state = await bootWithCel({
    key: "sum",
    celType: "FormulaCel",
    // Old field name; migration helper should rewrite this to `parser`.
    metadata: { key: "sum", segment: "user", compiler: "f" },
    f: "(+ x y)",
  });
  precompute(state);
  await precomputeOptional(state);
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  const sumCel = state.cels.get("sum");
  assert.equal(sumCel?.v, 5, "migrated cel still computes");
  assert.equal(sumCel?.metadata.parser, "f", "parser slot populated from legacy compiler");
  assert.equal(sumCel?.metadata.compiler, undefined, "legacy compiler slot removed");
});
