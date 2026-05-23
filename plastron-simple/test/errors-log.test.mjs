import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { isCelError } from "../dist/甲骨坑/cel-error.js";

// State-level error log. Every trap (compile, runtime, cycle,
// missing-compiler, compiler-cycle) appends a CelError to the cel at
// key "errors" — in addition to landing on cel.v (per-cel traps) or
// throwing (structural traps). Hosts get O(1) enumeration; structural
// errors that no single cel owns get a home with at: Key[] naming
// every participant.

const baseManifest = {
  name: "user", version: "0.0.1", description: "test", dependencies: [],
};

const log = (state) => state.cels.get("errors").v;

test("errors log cel is seeded at boot: locked ValueCel with v: []", () => {
  const state = createInitialState();
  const cel = state.cels.get("errors");
  assert.ok(cel, "errors cel missing");
  assert.equal(cel.celType, "ValueCel");
  assert.equal(cel.locked, true);
  assert.equal(cel.metadata.segment, "kernel");
  assert.ok(Array.isArray(cel.v));
  assert.equal(cel.v.length, 0);
});

test("a runtime trap appends a CelError to the log", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");
  await hydrate(state, [{
    name: "user",
    cels: [
      {
        key: "boomFn", celType: "ValueCel",
        metadata: { key: "boomFn", segment: "user", v: () => { throw new Error("boom"); } },
      },
      {
        key: "boom", celType: "FormulaCel",
        metadata: { key: "boom", segment: "user", parser: "f" },
        f: "(boomFn)",
      },
    ],
  }], [baseManifest]);
  await runCycle(state);

  assert.equal(log(state).length, 1, "one runtime trap → one log entry");
  const entry = log(state)[0];
  assert.ok(isCelError(entry));
  assert.equal(entry.trap, "RuntimeError");
  assert.deepEqual(entry.at, ["boom"]);
  assert.match(entry.message, /boom/);
});

test("a compile trap appends a CelError to the log", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "user",
    cels: [
      {
        key: "broken", celType: "EditableLambdaCel",
        metadata: { key: "broken", segment: "user", kind: "wat" },
        f: "(module (func not-a-real-instr))",
      },
    ],
  }], [baseManifest]);

  assert.equal(log(state).length, 1, "compile trap appended");
  const entry = log(state)[0];
  assert.equal(entry.trap, "CompileError");
  assert.deepEqual(entry.at, ["broken"]);
});

test("a dependency cycle appends a CelError with at: every participant, then throws", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await assert.rejects(
    () => hydrate(state, [{
      name: "user",
      cels: [
        { key: "a", celType: "FormulaCel",
          metadata: { key: "a", segment: "user", parser: "f" },
          f: "(+ b 1)" },
        { key: "b", celType: "FormulaCel",
          metadata: { key: "b", segment: "user", parser: "f" },
          f: "(+ a 1)" },
      ],
    }], [baseManifest]),
    /[Cc]ycle/,
  );
  // The log persists even though hydrate threw — host can read it.
  assert.equal(log(state).length, 1);
  const entry = log(state)[0];
  assert.equal(entry.trap, "CycleError");
  assert.equal(entry.at.length, 2, "both cels in the cycle named");
  assert.ok(entry.at.includes("a") && entry.at.includes("b"));
});

test("a missing compiler appends a CelError, then throws", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await assert.rejects(
    () => hydrate(state, [{
      name: "user",
      cels: [{
        key: "x", celType: "EditableLambdaCel",
        metadata: { key: "x", segment: "user", kind: "nope-not-a-compiler" },
        f: "(anything)",
      }],
    }], [baseManifest]),
    /no compiler is registered/,
  );
  assert.equal(log(state).length, 1);
  const entry = log(state)[0];
  assert.equal(entry.trap, "MissingCompilerError");
  assert.deepEqual(entry.at, ["x"]);
});

test("multiple runtime traps in one cycle accumulate in order", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");
  await hydrate(state, [{
    name: "user",
    cels: [
      {
        key: "boomFn", celType: "ValueCel",
        metadata: { key: "boomFn", segment: "user", v: (label) => { throw new Error(`fail-${label}`); } },
      },
      {
        key: "first", celType: "FormulaCel",
        metadata: { key: "first", segment: "user", parser: "f" },
        f: "(boomFn 1)",
      },
      {
        key: "second", celType: "FormulaCel",
        metadata: { key: "second", segment: "user", parser: "f" },
        f: "(boomFn 2)",
      },
    ],
  }], [baseManifest]);
  await runCycle(state);

  // Both cels traps land; log carries both.
  const entries = log(state).filter((e) => e.trap === "RuntimeError");
  assert.equal(entries.length, 2);
  const atKeys = entries.flatMap((e) => e.at);
  assert.ok(atKeys.includes("first") && atKeys.includes("second"));
});

test("a compiler-dependency cycle appends with at: every participant, then throws", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  // Two compiler cels naming each other as their compiler — the topo
  // sort in compileFireable can't make progress, throws with both keys.
  await assert.rejects(
    () => hydrate(state, [{
      name: "user",
      cels: [
        {
          key: "compA", celType: "EditableLambdaCel",
          metadata: { key: "compA", segment: "user", kind: "compB" },
          f: "source-a",
        },
        {
          key: "compB", celType: "EditableLambdaCel",
          metadata: { key: "compB", segment: "user", kind: "compA" },
          f: "source-b",
        },
      ],
    }], [baseManifest]),
    /compiler-dependency cycle/,
  );
  const entry = log(state).find((e) => e.trap === "CompilerDependencyCycle");
  assert.ok(entry, "compiler-cycle entry recorded");
  assert.equal(entry.at.length, 2);
  assert.ok(entry.at.includes("compA") && entry.at.includes("compB"));
});

test("each createInitialState gets a fresh empty log (no cross-state leak)", () => {
  const a = createInitialState();
  const b = createInitialState();
  a.cels.get("errors").v.push({ kind: "error", at: ["x"], trap: "T", message: "m" });
  assert.equal(log(a).length, 1);
  assert.equal(log(b).length, 0, "second state's log is independent");
});

test("clearErrors empties a populated log", async () => {
  const state = createInitialState();
  const hydrate     = resolveFn(state, "hydrate");
  const runCycle    = resolveFn(state, "runCycle");
  const clearErrors = resolveFn(state, "clearErrors");
  await hydrate(state, [{
    name: "user",
    cels: [
      {
        key: "boomFn", celType: "ValueCel",
        metadata: { key: "boomFn", segment: "user", v: () => { throw new Error("boom"); } },
      },
      {
        key: "boom", celType: "FormulaCel",
        metadata: { key: "boom", segment: "user", parser: "f" },
        f: "(boomFn)",
      },
    ],
  }], [baseManifest]);
  await runCycle(state);
  assert.equal(log(state).length, 1, "trap recorded");

  await clearErrors(state);
  assert.equal(log(state).length, 0, "log emptied");
});

test("clearErrors on an already-empty log is a no-op", async () => {
  const state = createInitialState();
  const clearErrors = resolveFn(state, "clearErrors");
  await clearErrors(state);
  assert.equal(log(state).length, 0);
});

test("after clearErrors, subsequent traps still append (array reference preserved)", async () => {
  const state = createInitialState();
  const hydrate     = resolveFn(state, "hydrate");
  const runCycle    = resolveFn(state, "runCycle");
  const clearErrors = resolveFn(state, "clearErrors");
  await hydrate(state, [{
    name: "user",
    cels: [
      {
        key: "boomFn", celType: "ValueCel",
        metadata: { key: "boomFn", segment: "user", v: () => { throw new Error("boom"); } },
      },
      {
        key: "boom", celType: "FormulaCel",
        metadata: { key: "boom", segment: "user", parser: "f" },
        f: "(boomFn)",
      },
    ],
  }], [baseManifest]);

  // The log holds the array reference; appendError pushes into it.
  // Verify clearErrors mutates in place (length = 0) rather than
  // reassigning, so any host that captured the reference still sees
  // the live state.
  const arrRef = log(state);
  await runCycle(state);
  assert.equal(arrRef.length, 1);
  await clearErrors(state);
  assert.equal(arrRef.length, 0, "same array reference, now empty");
  await runCycle(state);
  assert.equal(arrRef.length, 1, "new traps land in the same array");
});

test("dehydrate excludes the errors log (it's in the kernel segment)", async () => {
  const state = createInitialState();
  const dehydrate = resolveFn(state, "dehydrate");
  const { segments, manifests } = await dehydrate(state);
  for (const m of manifests) assert.notEqual(m.name, "kernel");
  for (const s of segments)  assert.notEqual(s.name, "kernel");
});
