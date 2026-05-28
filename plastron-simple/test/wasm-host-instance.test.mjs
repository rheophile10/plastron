import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// Hand-encoded module (the wat compiler can't emit bytes for an
// env-importing module it can't itself instantiate):
//
//   (module
//     (import "env" "peek" (func $peek (result i32)))
//     (memory (export "memory") 1)
//     (func (export "init")          i32.const 0  i32.const 42  i32.store)
//     (func (export "tick") (result i32)  call $peek))
//
// init writes 42 to memory[0]; tick calls the imported env.peek, which
// (host-side) reads memory[0] through the captured instance — exercising
// multi-export + shared memory + the pre/post-instantiate timing.
const MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,                   // \0asm v1
  0x01, 0x08, 0x02, 0x60, 0x00, 0x01, 0x7f, 0x60, 0x00, 0x00,       // types: ()->i32, ()->()
  0x02, 0x0c, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x04, 0x70, 0x65, 0x65, 0x6b, 0x00, 0x00, // import env.peek : t0
  0x03, 0x03, 0x02, 0x01, 0x00,                                     // funcs: init=t1, tick=t0
  0x05, 0x03, 0x01, 0x00, 0x01,                                     // memory min=1
  0x07, 0x18, 0x03,                                                 // exports (3):
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,           //   "memory" mem 0
    0x04, 0x69, 0x6e, 0x69, 0x74, 0x00, 0x01,                       //   "init"   func 1
    0x04, 0x74, 0x69, 0x63, 0x6b, 0x00, 0x02,                       //   "tick"   func 2
  0x0a, 0x10, 0x02,                                                 // code (2 bodies):
    0x09, 0x00, 0x41, 0x00, 0x41, 0x2a, 0x36, 0x02, 0x00, 0x0b,     //   init: store 42 @0
    0x04, 0x00, 0x10, 0x00, 0x0b,                                   //   tick: call $peek
]);
const B64 = Buffer.from(MODULE).toString("base64");

// ── onInstantiate hands over the live instance ───────────────────────────────

test("onInstantiate hands the host the live instance; an env callback reads memory init wrote", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");

  let captured = null;
  let onInstantiateCalls = 0;
  const mem = { view: null };
  await register(state, {
    key: "host-provider",
    fn: () => ({
      // env.peek reads memory through a holder wired post-instantiate —
      // the chicken-and-egg the hook resolves.
      imports: { env: { peek: () => mem.view.getInt32(0, true) } },
      onInstantiate: (instance) => {
        onInstantiateCalls++;
        captured = instance;
        mem.view = new DataView(instance.exports.memory.buffer);
      },
    }),
  });

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "doomish", celType: "EditableLambdaCel",
        metadata: { key: "doomish", segment: "user", kind: "wasm",
                    wasmExport: "init", imports: "host-provider" },
        f: B64 },
    ],
  }], [baseManifest]);

  assert.equal(onInstantiateCalls, 1, "onInstantiate should fire exactly once");
  assert.ok(captured, "host should have captured the instance");
  assert.equal(typeof captured.exports.init, "function");
  assert.equal(typeof captured.exports.tick, "function");
  assert.ok(captured.exports.memory?.buffer instanceof ArrayBuffer, "memory export reachable");

  // The host drives the instance directly: multiple exports + live memory.
  captured.exports.init();                       // memory[0] = 42
  assert.equal(captured.exports.tick(), 42);     // tick → env.peek → reads memory[0]
});

// ── backward compat: a bare imports object still works ───────────────────────

test("a bare-object provider (today's shape) still satisfies imports", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  await register(state, { key: "bare-provider", fn: () => ({ env: { peek: () => 7 } }) });
  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "tickcel", celType: "EditableLambdaCel",
        metadata: { key: "tickcel", segment: "user", kind: "wasm",
                    wasmExport: "tick", imports: "bare-provider" },
        f: B64 },
      { key: "out", celType: "FormulaCel",
        metadata: { key: "out", segment: "user", parser: "f" }, f: "(tickcel)" },
    ],
  }], [baseManifest]);
  await runCycle(state);

  assert.equal(state.cels.get("out").v, 7, "bare provider's env.peek should still be wired");
});

// ── dispose rides to cel._dispose ────────────────────────────────────────────

test("a provider-supplied dispose lands on cel._dispose for teardown", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");

  let disposed = false;
  await register(state, { key: "disp-provider", fn: () => ({
    imports: { env: { peek: () => 0 } },
    dispose: () => { disposed = true; },
  }) });
  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "dcel", celType: "EditableLambdaCel",
        metadata: { key: "dcel", segment: "user", kind: "wasm",
                    wasmExport: "init", imports: "disp-provider" },
        f: B64 },
    ],
  }], [baseManifest]);

  const dcel = state.cels.get("dcel");
  assert.equal(typeof dcel._dispose, "function", "provider dispose should land on cel._dispose");
  dcel._dispose();
  assert.equal(disposed, true);
});

// ── round-trip: bytes + descriptor only; no instance in the JSON ─────────────

test("the cel still dehydrates as bytes + descriptor; no runtime instance leaks into JSON", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");
  const dehydrate = resolveFn(state, "dehydrate");

  await register(state, { key: "p", fn: () => ({
    imports: { env: { peek: () => 0 } }, onInstantiate: () => {},
  }) });
  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "c", celType: "EditableLambdaCel",
        metadata: { key: "c", segment: "user", kind: "wasm", wasmExport: "init", imports: "p" },
        f: B64 },
    ],
  }], [baseManifest]);

  const dumped = dehydrate(state, { onlySegments: ["user"] });
  const cel = dumped.segments.find((s) => s.name === "user").cels.find((c) => c.key === "c");
  assert.equal(cel.f, B64);
  assert.equal(cel.metadata.kind, "wasm");
  assert.equal(cel.metadata.imports, "p");
  assert.equal(/"exports"|"onInstantiate"|WebAssembly/.test(JSON.stringify(dumped)), false,
    "no runtime artifacts serialized");
});
