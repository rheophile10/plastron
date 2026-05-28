import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { computeKernelClosure } from "../dist/kernel/segments.js";

// ============================================================================
// Segment classification — role + applications field, validation rules,
// kernel-closure protection, default fall-through.
// See docs/1-design/3-accepted/00-ontology/segment-classification.md.
// ============================================================================

const bootHydrate = async (segments, manifests) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, segments, manifests);
  return state;
};

const minimalSeg = (name) => ({ name, cels: [] });

test("default role: library when absent in manifest", async () => {
  const state = await bootHydrate(
    [minimalSeg("legacy")],
    [{ name: "legacy", version: "0.0.1", description: "no role declared", dependencies: [] }],
  );
  assert.equal(state.segments.get("legacy")?.role, "library");
});

test("explicit role preserved through hydrate", async () => {
  const state = await bootHydrate(
    [minimalSeg("my-app")],
    [{ name: "my-app", version: "0.0.1", description: "test", dependencies: [], role: "application" }],
  );
  assert.equal(state.segments.get("my-app")?.role, "application");
});

test("kernel manifest declares role:kernel in boot 冊.json", () => {
  const state = createInitialState();
  assert.equal(state.segments.get("kernel")?.role, "kernel");
});

test("user-space without applications throws at validation", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("doc-1")],
      [{ name: "doc-1", version: "0.0.1", description: "missing apps", dependencies: [], role: "user-space" }],
    ),
    /must declare `applications`/,
  );
});

test("user-space with applications targeting non-existent segment throws", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("doc-2")],
      [{
        name: "doc-2", version: "0.0.1", description: "test", dependencies: [], role: "user-space",
        applications: ["never-defined-app"],
      }],
    ),
    /no such segment is installed/,
  );
});

test("user-space with applications targeting a library (wrong role) throws", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("doc-3"), minimalSeg("not-an-app")],
      [
        { name: "not-an-app", version: "0.0.1", description: "test", dependencies: [], role: "library" },
        {
          name: "doc-3", version: "0.0.1", description: "test", dependencies: [], role: "user-space",
          applications: ["not-an-app"],
        },
      ],
    ),
    /role "library", not "application"/,
  );
});

test("library cannot depend on application", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("my-app"), minimalSeg("bad-lib")],
      [
        { name: "my-app", version: "0.0.1", description: "test", dependencies: [], role: "application" },
        { name: "bad-lib", version: "0.0.1", description: "test", dependencies: ["my-app"], role: "library" },
      ],
    ),
    /\(library\) cannot depend on "my-app" \(application\)/,
  );
});

test("application cannot depend on user-space", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("ufo"), minimalSeg("my-app")],
      [
        { name: "ufo", version: "0.0.1", description: "test", dependencies: [], role: "user-space",
          applications: ["my-app"] },
        { name: "my-app", version: "0.0.1", description: "test", dependencies: ["ufo"], role: "application" },
      ],
    ),
    /\(application\) cannot depend on "ufo" \(user-space\)/,
  );
});

test("valid user-space → application → library hydrates without error", async () => {
  const state = await bootHydrate(
    [minimalSeg("my-lib"), minimalSeg("my-app"), minimalSeg("doc-4")],
    [
      { name: "my-lib", version: "0.0.1", description: "test", dependencies: [], role: "library" },
      { name: "my-app", version: "0.0.1", description: "test", dependencies: ["my-lib"], role: "application" },
      { name: "doc-4",  version: "0.0.1", description: "test", dependencies: ["my-app"], role: "user-space",
        applications: ["my-app"] },
    ],
  );
  assert.equal(state.segments.get("doc-4")?.role, "user-space");
  assert.deepEqual(state.segments.get("doc-4")?.applications, ["my-app"]);
});

// ── Kernel-closure protection ──────────────────────────────────────────────

test("computeKernelClosure returns role:kernel + transitive deps", () => {
  const state = createInitialState();
  const closure = computeKernelClosure(state.segments);
  assert.ok(closure.has("kernel"), "kernel itself in closure");
  // kernel depends on csp, cel-error, host, wasm-types, lambda-source,
  // js-compiler, builtins, wat-compiler, py-compiler, quickjs-compiler,
  // file-store — all should be in closure.
  for (const lib of ["csp", "cel-error", "host", "builtins", "js-compiler", "file-store"]) {
    assert.ok(closure.has(lib), `library "${lib}" should be in kernel closure (transitive dep of kernel)`);
  }
});

test("flush refuses any segment in the kernel closure", async () => {
  const state = createInitialState();
  const flush = resolveFn(state, "flush");
  // builtins is a library but is in kernel's dep closure → flush refused.
  await assert.rejects(
    flush(state, "builtins", { force: true }),
    /kernel closure/,
  );
  assert.ok(state.cels.get("+"), "+ cel should still be present");
});

// ── Library applications-tag warning (advisory, not error) ─────────────────

test("library applications-tag mismatch with user-space emits warning, not error", async () => {
  const origWarn = console?.warn;
  let warned = false;
  if (console) {
    console.warn = (msg) => { if (typeof msg === "string" && msg.includes("classification warnings")) warned = true; };
  }
  try {
    await bootHydrate(
      [minimalSeg("notebook-lib"), minimalSeg("sheet-app"), minimalSeg("doc-5")],
      [
        // Library tagged for notebook, but used by spreadsheet user-space.
        { name: "notebook-lib", version: "0.0.1", description: "test", dependencies: [], role: "library",
          applications: ["notebook-app"] },
        { name: "sheet-app", version: "0.0.1", description: "test", dependencies: [], role: "application" },
        { name: "doc-5", version: "0.0.1", description: "test", dependencies: ["notebook-lib"], role: "user-space",
          applications: ["sheet-app"] },
      ],
    );
  } finally {
    if (console && origWarn) console.warn = origWarn;
  }
  assert.ok(warned, "should have emitted a console.warn about classification mismatch");
});
