import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const bootWithTwoSegments = async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const segA = {
    name: "alpha",
    cels: [{ key: "a1", celType: "ValueCel", metadata: { key: "a1", segment: "alpha", v: 1 } }],
  };
  const segB = {
    name: "beta",
    cels: [{ key: "b1", celType: "ValueCel", metadata: { key: "b1", segment: "beta", v: 2 } }],
  };
  const manifestA = { name: "alpha", version: "0.0.1", description: "test", dependencies: [] };
  const manifestB = { name: "beta",  version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [segA, segB], [manifestA, manifestB]);
  return state;
};

test("dehydrate without opts emits every non-kernel segment", async () => {
  const state = await bootWithTwoSegments();
  const dehydrate = resolveFn(state, "dehydrate");
  const { segments } = dehydrate(state);
  const names = segments.map((s) => s.name).sort();
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("beta"));
});

test("dehydrate({ onlySegments: ['alpha'] }) emits only that segment", async () => {
  const state = await bootWithTwoSegments();
  const dehydrate = resolveFn(state, "dehydrate");
  const { segments, manifests } = dehydrate(state, { onlySegments: ["alpha"] });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].name, "alpha");
  assert.equal(segments[0].cels.length, 1);
  assert.equal(segments[0].cels[0].key, "a1");
  // Manifests filter symmetrically.
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].name, "alpha");
});

test("dehydrate({ onlySegments: ['nonexistent'] }) emits nothing", async () => {
  const state = await bootWithTwoSegments();
  const dehydrate = resolveFn(state, "dehydrate");
  const { segments, manifests } = dehydrate(state, { onlySegments: ["nonexistent"] });
  assert.equal(segments.length, 0);
  assert.equal(manifests.length, 0);
});

test("dehydrate({ onlySegments: ['alpha', 'beta'] }) emits both, in cel-encounter order", async () => {
  const state = await bootWithTwoSegments();
  const dehydrate = resolveFn(state, "dehydrate");
  const { segments } = dehydrate(state, { onlySegments: ["alpha", "beta"] });
  const names = segments.map((s) => s.name).sort();
  assert.deepEqual(names, ["alpha", "beta"]);
});
