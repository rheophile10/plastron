import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ── always-on input join ──────────────────────────────────────────────────

test("inflate joins string[] in DehydratedCel.f into a single string (no schema needed)", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = {
    name: "user",
    cels: [
      {
        key: "lines",
        celType: "EditableLambdaCel",
        metadata: { key: "lines", segment: "user", kind: "js" },
        // No schema declared — array form still works on the input side.
        f: ["(x) => {", "  return x * 3;", "}"],
      },
    ],
  };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [seg], [manifest]);

  const cel = state.cels.get("lines");
  assert.equal(typeof cel.f, "string", "live cel.f is a single string");
  assert.equal(cel.f, "(x) => {\n  return x * 3;\n}");
  assert.equal(typeof cel._fn, "function", "js compiler produced an _fn");
  assert.equal(cel._fn(4), 12, "compiled fn behaves like the source");
});

// ── opt-in dehydrate split ────────────────────────────────────────────────

test("schema: 'lambda-source' splits multi-line f back into string[] on dehydrate", async () => {
  const state = createInitialState();
  const hydrate   = resolveFn(state, "hydrate");
  const dehydrate = resolveFn(state, "dehydrate");
  const seg = {
    name: "user",
    cels: [
      {
        key: "multi",
        celType: "EditableLambdaCel",
        metadata: {
          key: "multi", segment: "user", kind: "js", schema: "lambda-source",
        },
        f: ["(x) => {", "  return x + 1;", "}"],
      },
    ],
  };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [seg], [manifest]);

  const { segments } = dehydrate(state, { onlySegments: ["user"] });
  const out = segments[0].cels.find((c) => c.key === "multi");
  assert.ok(Array.isArray(out.f), "dehydrated f should be an array");
  assert.deepEqual(out.f, ["(x) => {", "  return x + 1;", "}"]);
});

test("single-line f stays a plain string even with the lambda-source schema", async () => {
  const state = createInitialState();
  const hydrate   = resolveFn(state, "hydrate");
  const dehydrate = resolveFn(state, "dehydrate");
  const seg = {
    name: "user",
    cels: [
      {
        key: "oneline",
        celType: "EditableLambdaCel",
        metadata: {
          key: "oneline", segment: "user", kind: "js", schema: "lambda-source",
        },
        f: "(x) => x * 2",
      },
    ],
  };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [seg], [manifest]);

  const { segments } = dehydrate(state, { onlySegments: ["user"] });
  const out = segments[0].cels.find((c) => c.key === "oneline");
  assert.equal(typeof out.f, "string");
  assert.equal(out.f, "(x) => x * 2");
});

test("cels without the lambda-source schema dehydrate f as a plain string regardless of line count", async () => {
  const state = createInitialState();
  const hydrate   = resolveFn(state, "hydrate");
  const dehydrate = resolveFn(state, "dehydrate");
  const seg = {
    name: "user",
    cels: [
      {
        key: "noopt",
        celType: "EditableLambdaCel",
        metadata: { key: "noopt", segment: "user", kind: "js" },
        // Authored as array → joined on hydrate. No opt-in schema, so
        // dehydrate leaves it joined.
        f: ["(x) => {", "  return x;", "}"],
      },
    ],
  };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [seg], [manifest]);

  const { segments } = dehydrate(state, { onlySegments: ["user"] });
  const out = segments[0].cels.find((c) => c.key === "noopt");
  assert.equal(typeof out.f, "string", "no schema = plain string out");
  assert.ok(out.f.includes("\n"), "but the joined form preserves newlines");
});

// ── round-trip ────────────────────────────────────────────────────────────

test("array → live → array round-trip is identity for opt-in cels", async () => {
  const original = ["(x) => {", "  const y = x + 1;", "  return y * 2;", "}"];

  const s1 = createInitialState();
  const hydrate1   = resolveFn(s1, "hydrate");
  const dehydrate1 = resolveFn(s1, "dehydrate");
  const seg1 = {
    name: "user",
    cels: [
      {
        key: "rt",
        celType: "EditableLambdaCel",
        metadata: {
          key: "rt", segment: "user", kind: "js", schema: "lambda-source",
        },
        f: original,
      },
    ],
  };
  const manifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate1(s1, [seg1], [manifest]);
  const dehydrated = dehydrate1(s1, { onlySegments: ["user"] });

  // Re-hydrate into a fresh state and verify the round-tripped cel is
  // functionally identical.
  const s2 = createInitialState();
  const hydrate2 = resolveFn(s2, "hydrate");
  await hydrate2(s2, dehydrated.segments, dehydrated.manifests);

  const cel = s2.cels.get("rt");
  assert.equal(cel._fn(3), 8);
  // And the array form survived through both directions.
  assert.deepEqual(dehydrated.segments[0].cels.find((c) => c.key === "rt").f, original);
});
