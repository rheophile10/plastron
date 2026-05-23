import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// flush(state, segmentKey, options?) — remove every cel whose
// metadata.segment === segmentKey, fire each cel._dispose, drain
// channels, re-run precompute, drop the manifest entry. Locked cels in
// the "kernel" segment are exempt (internal scaffolding); locked cels
// in other segments DO flush.

const mk = (name, dependencies = []) => ({
  name, version: "0.0.1", description: "test", dependencies,
});

const seedSeg = (name, ...keys) => ({
  name,
  cels: keys.map((k) => ({
    key: k, celType: "ValueCel", metadata: { key: k, segment: name, v: 1 },
  })),
});

test("flush removes every cel in the segment", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const flush   = resolveFn(state, "flush");
  await hydrate(state, [seedSeg("alpha", "a1", "a2"), seedSeg("beta", "b1")], [mk("alpha"), mk("beta")]);

  assert.ok(state.cels.get("a1"));
  assert.ok(state.cels.get("a2"));
  assert.ok(state.cels.get("b1"));

  await flush(state, "alpha");
  assert.equal(state.cels.get("a1"), undefined, "a1 removed");
  assert.equal(state.cels.get("a2"), undefined, "a2 removed");
  assert.ok(state.cels.get("b1"), "beta untouched");
});

test("flush drops the manifest entry from state.segments", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const flush   = resolveFn(state, "flush");
  await hydrate(state, [seedSeg("alpha", "a1")], [mk("alpha")]);
  assert.ok(state.segments.get("alpha"));
  await flush(state, "alpha");
  assert.equal(state.segments.get("alpha"), undefined);
});

test("flush is a no-op on an unknown segment", async () => {
  const state = createInitialState();
  const flush = resolveFn(state, "flush");
  await flush(state, "no-such-segment");
});

test("flush refuses when another loaded segment depends on the target", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const flush   = resolveFn(state, "flush");
  // beta depends on alpha.
  await hydrate(
    state,
    [seedSeg("alpha", "a1"), seedSeg("beta", "b1")],
    [mk("alpha"), mk("beta", ["alpha"])],
  );
  await assert.rejects(
    () => flush(state, "alpha"),
    /dependent segments still loaded.*beta/,
  );
  // Nothing was removed.
  assert.ok(state.cels.get("a1"));
  assert.ok(state.segments.get("alpha"));
});

test("flush with { force: true } drops the segment despite dependents", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const flush   = resolveFn(state, "flush");
  await hydrate(
    state,
    [seedSeg("alpha", "a1"), seedSeg("beta", "b1")],
    [mk("alpha"), mk("beta", ["alpha"])],
  );
  await flush(state, "alpha", { force: true });
  assert.equal(state.cels.get("a1"), undefined);
  assert.equal(state.segments.get("alpha"), undefined);
  // beta's cels survive — host owns the cleanup beyond this point.
  assert.ok(state.cels.get("b1"));
  assert.ok(state.segments.get("beta"));
});

test("flush with { cascade: true } flushes dependents first, leaves-first", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const flush   = resolveFn(state, "flush");
  // chain: gamma depends on beta, beta depends on alpha.
  await hydrate(
    state,
    [seedSeg("alpha", "a1"), seedSeg("beta", "b1"), seedSeg("gamma", "g1")],
    [mk("alpha"), mk("beta", ["alpha"]), mk("gamma", ["beta"])],
  );
  await flush(state, "alpha", { cascade: true });
  assert.equal(state.cels.get("g1"), undefined, "gamma flushed");
  assert.equal(state.cels.get("b1"), undefined, "beta flushed");
  assert.equal(state.cels.get("a1"), undefined, "alpha flushed");
  assert.equal(state.segments.get("alpha"), undefined);
  assert.equal(state.segments.get("beta"), undefined);
  assert.equal(state.segments.get("gamma"), undefined);
});

test("flush fires _dispose on lambda cels before deletion", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const flush    = resolveFn(state, "flush");
  let disposed = 0;
  await register(state, {
    key: "withDispose",
    fn: () => 1,
    dispose: () => { disposed++; },
    segment: "alpha",
  });
  await flush(state, "alpha");
  assert.equal(disposed, 1, "_dispose fired exactly once");
  assert.equal(state.cels.get("withDispose"), undefined);
});

test("flush leaves kernel-segment locked cels alone", async () => {
  const state = createInitialState();
  const flush = resolveFn(state, "flush");
  // Even with { force: true }, the precomputedStates seed survives —
  // it's locked and lives in the "kernel" segment.
  await flush(state, "kernel", { force: true });
  assert.ok(state.cels.get("precomputedStates"), "precomputedStates seed survives");
});
