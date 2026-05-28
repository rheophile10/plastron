import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precompute, precomputeOptional, resolveFn } from "../dist/index.js";

// ============================================================================
// Execution hooks + L1 memo cache — see docs/EXECUTION-HOOKS.md.
//
// Tests use inline minimal SchemaCels marked memoSafe: true on the
// hot-path inputs, since js-common-schema isn't in the kernel boot
// manifests by default. The pattern in these tests is also the
// recommended pattern for any author wanting per-app schemas: just
// declare the SchemaCel with memoSafe true (or false) per the value
// kind's natural ref-eq soundness.
// ============================================================================

const memoSafeNumberSchema = {
  key: "test-number",
  celType: "SchemaCel",
  metadata: { key: "test-number", segment: "test-schemas" },
  v: {
    key: "test-number",
    zod: { type: "number" },
    protocols: {},
    memoSafe: true,
  },
};

const memoSafeStringSchema = {
  key: "test-string",
  celType: "SchemaCel",
  metadata: { key: "test-string", segment: "test-schemas" },
  v: {
    key: "test-string",
    zod: { type: "string" },
    protocols: {},
    memoSafe: true,
  },
};

const nonMemoSafeObjectSchema = {
  key: "test-object",
  celType: "SchemaCel",
  metadata: { key: "test-object", segment: "test-schemas" },
  v: {
    key: "test-object",
    zod: { type: "object" },
    protocols: {},
    // memoSafe omitted ⇒ false ⇒ caching refused for cels reading this
  },
};

const baseSchemaSegment = {
  name: "test-schemas",
  cels: [memoSafeNumberSchema, memoSafeStringSchema, nonMemoSafeObjectSchema],
};
const baseSchemaManifest = {
  name: "test-schemas", version: "0.0.1", description: "test", dependencies: [],
};

const boot = async (extraSegments = [], extraManifests = []) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(
    state,
    [baseSchemaSegment, ...extraSegments],
    [baseSchemaManifest, ...extraManifests],
  );
  precompute(state);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

// ── L1 cache on FormulaCel ─────────────────────────────────────────────────

test("L1 cache: FormulaCel hits cache when inputs unchanged across runCycles", async () => {
  let fnCalls = 0;
  const counterFn = (a, b) => { fnCalls++; return a + b; };
  const state = await boot(
    [{
      name: "user",
      cels: [
        { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", schema: "test-number", v: 2 } },
        { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", schema: "test-number", v: 3 } },
        {
          key: "add",
          celType: "LockedLambdaCel",
          metadata: { key: "add", segment: "user", kind: "native" },
          locked: true,
        },
        {
          key: "sum",
          celType: "FormulaCel",
          metadata: {
            key: "sum", segment: "user", parser: "f",
            inputMap: { a: "a", b: "b" },
            memo: { maxEntries: 16 },
          },
          f: "(add a b)",
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas"] }],
  );
  // Wire the locked-lambda impl by direct cel mutation (test bypass for
  // not having a code-seed for this segment).
  state.cels.get("add")._fn = counterFn;
  // Re-run cycle now that the impl is wired (initial boot fired the
  // formula before _fn was present, yielding a CelError).
  await resolveFn(state, "runCycle")(state);
  const callsAfterFirstCycle = fnCalls;
  assert.equal(state.cels.get("sum").v, 5, "initial sum should be 5");

  // Re-fire the cascade with same inputs — should hit cache, fnCalls
  // shouldn't increase.
  await resolveFn(state, "runCycle")(state);
  assert.equal(fnCalls, callsAfterFirstCycle, "cache hit: counterFn should NOT be called again");

  // Change a; cache miss, counter increments by exactly 1
  await resolveFn(state, "set")(state, "a", 10);
  assert.equal(fnCalls, callsAfterFirstCycle + 1, "cache miss after input change: one new call");
  assert.equal(state.cels.get("sum").v, 13);
});

test("L1 cache: cel._memoCache populated after eligible cel hydrates with metadata.memo", async () => {
  const state = await boot(
    [{
      name: "user",
      cels: [
        { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", schema: "test-number", v: 1 } },
        { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", schema: "test-number", v: 2 } },
        {
          key: "sum",
          celType: "FormulaCel",
          metadata: {
            key: "sum", segment: "user", parser: "f",
            inputMap: { a: "a", b: "b" },
            memo: { maxEntries: 8 },
          },
          f: "(+ a b)",
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas", "builtins"] }],
  );
  const cel = state.cels.get("sum");
  assert.ok(cel._memoCache, "FormulaCel with memo metadata should have _memoCache populated");
  assert.equal(typeof cel._memoCache.get, "function");
});

// ── Pre-fn short-circuit ───────────────────────────────────────────────────

test("Pre-fn short-circuit: setting acc.output skips _fn", async () => {
  let realFnCalls = 0;
  let preFnCalls = 0;
  const state = await boot(
    [{
      name: "user",
      cels: [
        { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", schema: "test-number", v: 5 } },
        // The pre-fn that supplies cached output
        {
          key: "shortCircuit",
          celType: "LockedLambdaCel",
          metadata: { key: "shortCircuit", segment: "user", kind: "native" },
          locked: true,
        },
        // The real expensive fn
        {
          key: "expensive",
          celType: "LockedLambdaCel",
          metadata: { key: "expensive", segment: "user", kind: "native" },
          locked: true,
        },
        {
          key: "result",
          celType: "FormulaCel",
          metadata: {
            key: "result", segment: "user", parser: "f",
            inputMap: { a: "a" },
            preFns: ["shortCircuit"],
          },
          f: "(expensive a)",
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas"] }],
  );
  state.cels.get("expensive")._fn = (a) => { realFnCalls++; return a * 100; };
  state.cels.get("shortCircuit")._fn = (acc) => {
    preFnCalls++;
    return { ...acc, output: 999 };
  };
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("result").v, 999, "pre-fn output wins");
  assert.equal(preFnCalls, 1, "pre-fn ran");
  assert.equal(realFnCalls, 0, "expensive fn was short-circuited");
});

// ── Post-fn transform ──────────────────────────────────────────────────────

test("Post-fn: transforms output and observes timing", async () => {
  let spans = [];
  const state = await boot(
    [{
      name: "user",
      cels: [
        { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", schema: "test-number", v: 5 } },
        { key: "double", celType: "LockedLambdaCel", metadata: { key: "double", segment: "user", kind: "native" }, locked: true },
        { key: "perfRecorder", celType: "LockedLambdaCel", metadata: { key: "perfRecorder", segment: "user", kind: "native" }, locked: true },
        {
          key: "doubled",
          celType: "FormulaCel",
          metadata: {
            key: "doubled", segment: "user", parser: "f",
            inputMap: { a: "a" },
            postFns: ["perfRecorder"],
          },
          f: "(double a)",
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas"] }],
  );
  state.cels.get("double")._fn = (a) => a * 2;
  state.cels.get("perfRecorder")._fn = (acc) => {
    spans.push({
      cel: acc.celKey,
      elapsedMs: (acc.endTimestamp ?? 0) - acc.startTimestamp,
      output: acc.output,
    });
    return { ...acc, output: acc.output + 1000 };  // transform: add 1000
  };
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("doubled").v, 1010, "post-fn transform applied (5*2 + 1000)");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].cel, "doubled");
  assert.ok(spans[0].elapsedMs >= 0);
});

// ── LambdaCel trampoline (call-driven memo) ────────────────────────────────

test("LambdaCel L1 cache: same args hit cache across calls", async () => {
  let inner = 0;
  const state = await boot(
    [{
      name: "user",
      cels: [
        {
          key: "expensiveLambda",
          celType: "EditableLambdaCel",
          metadata: {
            key: "expensiveLambda", segment: "user", kind: "native",
            inputMap: { _self: "expensiveLambda" },  // dummy so eligibility passes
            memo: { maxEntries: 8 },
          },
          locked: false,
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas"] }],
  );
  // For LambdaCel memo, eligibility wants memoSafe inputs. Our inputMap
  // self-references; the cel needs a memoSafe schema. Mark via mutation
  // (test simplification; real code declares it on the schema).
  state.cels.get("expensiveLambda").schema = { key: "self", zod: {}, protocols: {}, memoSafe: true };
  // Reinstall trampoline now that the schema is in place (boot install
  // ran before this test mutation).
  const { hasHooksOrCache, makeLambdaTrampoline } = await import("../dist/kernel/hooks.js");
  const { makeMemoCache } = await import("../dist/kernel/memo-cache.js");
  const cel = state.cels.get("expensiveLambda");
  cel._memoCache = makeMemoCache(8);
  const original = (n) => { inner++; return n * n; };
  cel._fn = makeLambdaTrampoline(original, cel, state);

  assert.equal(cel._fn(7), 49);
  assert.equal(cel._fn(7), 49, "same arg hits cache");
  assert.equal(cel._fn(7), 49, "still hitting cache");
  assert.equal(inner, 1, "inner fn called only once");

  assert.equal(cel._fn(8), 64, "new arg, fn fires");
  assert.equal(inner, 2);
});

// ── Eligibility refusal ────────────────────────────────────────────────────

test("Eligibility: dynamic cel with memo metadata refuses cache (logs error, no _memoCache)", async () => {
  const state = await boot(
    [{
      name: "user",
      cels: [
        { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", schema: "test-number", v: 1 } },
        {
          key: "tick",
          celType: "FormulaCel",
          metadata: {
            key: "tick", segment: "user", parser: "f",
            inputMap: { a: "a" },
            memo: { maxEntries: 4 },
          },
          dynamic: true,
          f: "(+ a 1)",
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas", "builtins"] }],
  );
  const cel = state.cels.get("tick");
  assert.equal(cel._memoCache, undefined, "dynamic cel must not get a cache");
});

test("Eligibility: non-memoSafe input schema refuses cache", async () => {
  const state = await boot(
    [{
      name: "user",
      cels: [
        // The "obj" input uses test-object schema, which is NOT memoSafe.
        { key: "obj", celType: "ValueCel", metadata: { key: "obj", segment: "user", schema: "test-object", v: { x: 1 } } },
        { key: "noop", celType: "LockedLambdaCel", metadata: { key: "noop", segment: "user", kind: "native" }, locked: true },
        {
          key: "view",
          celType: "FormulaCel",
          metadata: {
            key: "view", segment: "user", parser: "f",
            inputMap: { obj: "obj" },
            memo: { maxEntries: 4 },
          },
          f: "(noop obj)",
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas"] }],
  );
  state.cels.get("noop")._fn = (o) => o;
  const cel = state.cels.get("view");
  assert.equal(cel._memoCache, undefined, "non-memoSafe input → no cache");
});

// ── Invalidate on definition change ────────────────────────────────────────

test("invalidate: re-registering a lambda clears downstream FormulaCel _memoCache", async () => {
  let calls = 0;
  const state = await boot(
    [{
      name: "user",
      cels: [
        { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", schema: "test-number", v: 5 } },
        // EditableLambdaCel so register can replace it.
        { key: "track", celType: "EditableLambdaCel", metadata: { key: "track", segment: "user", kind: "native" } },
        {
          key: "y",
          celType: "FormulaCel",
          metadata: {
            key: "y", segment: "user", parser: "f",
            inputMap: { a: "a" },
            memo: { maxEntries: 8 },
          },
          f: "(track a)",
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas"] }],
  );
  // Initial registration via registerLambda (so trampolining applies).
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "track", fn: (a) => { calls++; return a; }, kind: "native" });
  await resolveFn(state, "runCycle")(state);
  const baseline = calls;
  // Same inputs → cache hit
  await resolveFn(state, "runCycle")(state);
  assert.equal(calls, baseline, "cache hit, no new call");

  // Re-register `track` with a different fn — invalidate() in
  // registerLambda clears y's _memoCache.
  await register(state, { key: "track", fn: (a) => { calls++; return a + 100; }, kind: "native" });
  // y's cache is now empty; next fire reruns
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("y").v, 105, "downstream cel re-fired with new lambda body");
});

// ── LRU eviction ───────────────────────────────────────────────────────────

test("LRU: cache evicts oldest entry past maxEntries", async () => {
  const { LruMemoCache } = await import("../dist/kernel/memo-cache.js");
  const cache = new LruMemoCache(3);
  cache.set([1], "a");
  cache.set([2], "b");
  cache.set([3], "c");
  assert.equal(cache.size, 3);
  assert.equal(cache.get([1]).value, "a");  // touch 1 → newest
  cache.set([4], "d");                       // evicts 2 (oldest after touch)
  assert.equal(cache.get([1]).value, "a");
  assert.equal(cache.get([2]), undefined, "2 should have been evicted");
  assert.equal(cache.get([3]).value, "c");
  assert.equal(cache.get([4]).value, "d");
});

// ── Sample userland L2 strategy via hooks ──────────────────────────────────

test("Userland sqlite-l2 stub: pre-fn cache lookup + post-fn write-through", async () => {
  // Stand-in for SQLite — just a Map. Real userland would call bun:sqlite.
  const l2Store = new Map();
  let realFnCalls = 0;
  const state = await boot(
    [{
      name: "user",
      cels: [
        { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", schema: "test-number", v: 7 } },
        { key: "expensiveImpl", celType: "LockedLambdaCel", metadata: { key: "expensiveImpl", segment: "user", kind: "native" }, locked: true },
        { key: "l2_check", celType: "LockedLambdaCel", metadata: { key: "l2_check", segment: "user", kind: "native" }, locked: true },
        { key: "l2_store", celType: "LockedLambdaCel", metadata: { key: "l2_store", segment: "user", kind: "native" }, locked: true },
        {
          key: "result",
          celType: "FormulaCel",
          metadata: {
            key: "result", segment: "user", parser: "f",
            inputMap: { a: "a" },
            preFns: ["l2_check"],
            postFns: ["l2_store"],
          },
          f: "(expensiveImpl a)",
        },
      ],
    }],
    [{ name: "user", version: "0.0.1", description: "test", dependencies: ["test-schemas"] }],
  );
  state.cels.get("expensiveImpl")._fn = (n) => { realFnCalls++; return n * n; };
  state.cels.get("l2_check")._fn = (acc) => {
    const key = `${acc.celKey}:${JSON.stringify(acc.inputs)}`;
    if (l2Store.has(key)) return { ...acc, output: l2Store.get(key), "l2.hit": true };
    return acc;
  };
  state.cels.get("l2_store")._fn = (acc) => {
    if (acc["l2.hit"] || acc.error) return acc;
    const key = `${acc.celKey}:${JSON.stringify(acc.inputs)}`;
    l2Store.set(key, acc.output);
    return acc;
  };

  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("result").v, 49);
  assert.equal(realFnCalls, 1, "first call ran the fn");
  assert.equal(l2Store.size, 1, "post-fn stored result in l2");

  // Re-fire — pre-fn finds it in l2, real fn skipped
  await resolveFn(state, "runCycle")(state);
  assert.equal(realFnCalls, 1, "second call: pre-fn short-circuited from l2");
  assert.equal(state.cels.get("result").v, 49);
});
