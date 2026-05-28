import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { unzipBytes } from "../dist/甲骨坑/archive/zip.js";

// segment-archive — tiered + whole-workspace export/import as a role-foldered
// .zip (the .甲 archive), over dehydrate/hydrate + the zero-dep zip core. The
// kernel closure is always excluded; deps resolve against the booted kernel.

const lib = {
  name: "mathlib", version: "1.0.0", dependencies: [], role: "library",
  cels: [{ key: "math.pi", celType: "ValueCel", metadata: { key: "math.pi", segment: "mathlib" }, v: 3.14 }],
};
const app = {
  name: "calc", version: "1.0.0", dependencies: ["mathlib"], role: "application",
  cels: [{ key: "calc.title", celType: "ValueCel", metadata: { key: "calc.title", segment: "calc" }, v: "Calculator" }],
};
const doc1 = {
  name: "doc1", version: "1.0.0", dependencies: ["calc"], role: "user-space", applications: ["calc"],
  cels: [{ key: "doc1.data", celType: "ValueCel", metadata: { key: "doc1.data", segment: "doc1" }, v: [1, 2, 3] }],
};
const doc2 = {
  name: "doc2", version: "1.0.0", dependencies: ["calc"], role: "user-space", applications: ["calc"],
  cels: [{ key: "doc2.note", celType: "ValueCel", metadata: { key: "doc2.note", segment: "doc2" }, v: "hello" }],
};
const manifest = (s) => ({ name: s.name, version: s.version, dependencies: s.dependencies, role: s.role, applications: s.applications });

// A workspace state: kernel + a library + an application + two user-spaces.
const bootWorkspace = async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [lib, app, doc1, doc2], [lib, app, doc1, doc2].map(manifest));
  return state;
};
const op = (state, k) => resolveFn(state, k);
const paths = async (bytes) => (await unzipBytes(bytes)).map((e) => e.path).sort();

test("export-all packs every non-kernel segment into role folders; kernel excluded", async () => {
  const a = await bootWorkspace();
  const bytes = await op(a, "segment-archive.export-all")(a);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b); // "PK" — a real zip

  const p = await paths(bytes);
  assert.ok(p.includes("plastron.index.json"));
  assert.ok(p.includes("libraries/mathlib@1.0.0/segment.json"));
  assert.ok(p.includes("applications/calc@1.0.0/segment.json"));
  assert.ok(p.includes("user/doc1@1.0.0/segment.json"));
  assert.ok(p.includes("user/doc2@1.0.0/segment.json"));
  // Boot segments (kernel closure: builtins, sheet, plastron-dom, …) are NOT packed.
  assert.ok(!p.some((x) => x.includes("builtins")), "builtins (bundled) excluded");
  assert.ok(!p.some((x) => x.includes("plastron-dom")), "kernel-closure libs excluded");
});

test("export-all → import into a fresh kernel restores segments + cel values", async () => {
  const a = await bootWorkspace();
  const bytes = await op(a, "segment-archive.export-all")(a);

  const b = createInitialState();
  assert.equal(b.segments.has("calc"), false, "fresh kernel has none of the workspace");
  await op(b, "segment-archive.import")(b, bytes);

  for (const n of ["mathlib", "calc", "doc1", "doc2"]) assert.ok(b.segments.has(n), `${n} loaded`);
  assert.equal(b.cels.get("math.pi").v, 3.14);
  assert.equal(b.cels.get("calc.title").v, "Calculator");
  assert.deepEqual(b.cels.get("doc1.data").v, [1, 2, 3]);
  assert.equal(b.cels.get("doc2.note").v, "hello");
});

test("export-library packs just the library (self-contained)", async () => {
  const a = await bootWorkspace();
  const bytes = await op(a, "segment-archive.export-library")(a, "mathlib");
  const p = await paths(bytes);
  assert.deepEqual(p.filter((x) => x.endsWith("segment.json")), ["libraries/mathlib@1.0.0/segment.json"]);

  const c = createInitialState();
  await op(c, "segment-archive.import")(c, bytes);
  assert.ok(c.segments.has("mathlib"));
  assert.equal(c.segments.has("calc"), false, "library export carries no app");
});

test("export-application packs the app + its library deps (runnable)", async () => {
  const a = await bootWorkspace();
  const bytes = await op(a, "segment-archive.export-application")(a, "calc");
  const p = (await paths(bytes)).filter((x) => x.endsWith("segment.json")).sort();
  assert.deepEqual(p, ["applications/calc@1.0.0/segment.json", "libraries/mathlib@1.0.0/segment.json"]);
  assert.ok(!p.some((x) => x.includes("doc")), "app export carries no user documents");

  const d = createInitialState();
  await op(d, "segment-archive.import")(d, bytes);
  assert.ok(d.segments.has("calc") && d.segments.has("mathlib"));
});

test("export-user packs only the user-space; the app is referenced, present on import", async () => {
  const a = await bootWorkspace();
  const userBytes = await op(a, "segment-archive.export-user")(a, "doc1");
  const p = (await paths(userBytes)).filter((x) => x.endsWith("segment.json"));
  assert.deepEqual(p, ["user/doc1@1.0.0/segment.json"], "only the user-space is packed");

  // Import requires the app present first (it would be bundled in a real app).
  const appBytes = await op(a, "segment-archive.export-application")(a, "calc");
  const e = createInitialState();
  await op(e, "segment-archive.import")(e, appBytes); // calc + mathlib
  await op(e, "segment-archive.import")(e, userBytes); // doc1, dep on calc resolves
  assert.deepEqual(e.cels.get("doc1.data").v, [1, 2, 3]);
});

test("import onlyRoles filters which roles are hydrated", async () => {
  const a = await bootWorkspace();
  const bytes = await op(a, "segment-archive.export-all")(a);

  const f = createInitialState();
  await op(f, "segment-archive.import")(f, bytes, { onlyRoles: ["library"] });
  assert.ok(f.segments.has("mathlib"), "library imported");
  assert.equal(f.segments.has("calc"), false, "application skipped by onlyRoles");
  assert.equal(f.segments.has("doc1"), false, "user-space skipped by onlyRoles");
});
