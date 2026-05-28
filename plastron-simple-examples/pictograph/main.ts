// ============================================================================
// pictograph (象形) — plastron-simple port.
//
// Single source-of-truth file (象形.json) in the canonical dehydrate
// shape: `{ segments, manifests }`. The kernel handles everything
// formerly done by hand here:
//
//   • Multi-line lambda source written as JSON string[] is joined to
//     a single string at inflate time — no preprocessing needed.
//   • Fireable cels with `kind: "js"` compile through the built-in
//     js-compiler segment (formerly the `fn-source` ValueCel pattern
//     with new Function inline).
//   • Fireable cels carrying `schema: "lambda-source"` round-trip
//     their multi-line `f` back to string[] on dehydrate for
//     readability in the .json.
//
// At end-of-run we filter dehydrate output to just the "象形" segment
// via `{ onlySegments: ["象形"] }` so we don't dump the entire kernel
// surface (csp, cel-error, host, wasm-types, js-compiler, builtins,
// wat/py/quickjs compilers) which createInitialState re-seeds anyway.
// ============================================================================

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createInitialState, precompute, precomputeOptional, resolveFn } from "../../plastron-simple/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(here, "象形.json");

const bundle = JSON.parse(await readFile(filePath, "utf8")) as {
  segments: unknown[];
  manifests: unknown[];
};

const 龜甲 = createInitialState();
const hydrate   = resolveFn(龜甲, "hydrate")!;
const runCycle  = resolveFn(龜甲, "runCycle")!;
const setCel    = resolveFn(龜甲, "setCel")!;
const dehydrate = resolveFn(龜甲, "dehydrate")!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
await hydrate(龜甲, bundle.segments as any, bundle.manifests as any);
precompute(龜甲);
await precomputeOptional(龜甲);
await runCycle(龜甲);

const view = (key: string): unknown => 龜甲.cels.get(key)?.v;

console.log("👤      :", view("👤"));
console.log("👦      :", view("👦"));
console.log("👧      :", view("👧"));
console.log("👦👋👧 :", view("👦👋👧"));

// Swap a lambda's source at runtime via setCel — recompiles through
// the js-compiler and re-fires the affected-subset cascade. `result`
// recomputes against the new behaviour.
console.log("\nresult (add):", view("result"));
await setCel(龜甲, "applyFn", { f: "(arr) => arr[0] * arr[1]" });
console.log("result (mul):", view("result"));
// Reset before we dehydrate so the file stays canonical across runs.
await setCel(龜甲, "applyFn", { f: "(arr) => arr[0] + arr[1]" });

// WAT cel: an EditableLambdaCel with `kind: "wat"` compiles its WAT
// source body through the wat-compiler segment at hydrate time. The
// result is a real WebAssembly function called like any other Fn —
// same DAG, different language.
console.log("\nwat-add(3, 4) →", view("wat-result"), "(wat-domain, wasm:i32)");
console.log("wat-result-js  →", view("wat-result-js"), "(after (wat-to-js …) bridge)");

// Python via Pyodide. The py-compiler segment dynamic-imports pyodide
// on the first py-kind compile (~5s cold boot).
console.log("\npy-greet(left, right)        →", JSON.stringify(view("py-greeting")), "(py-domain, eager-marshalled to JS)");
console.log("(py-to-js py-greeting)       →", JSON.stringify(view("py-greeting-js")), "(explicit bridge, js-domain)");
console.log("(js-to-quickjs …)            →", JSON.stringify(view("py-greeting-qjs")), "(explicit bridge, quickjs-domain)");
console.log("(qjs-shout py-greeting-qjs)  →", JSON.stringify(view("qjs-shouted")), "(quickjs sandbox)");

// Composite WIT handles. py-make-pair declares outputSchema = wasm:opaque
// so its return value stays as a WasmHandle pointing into py-domain.
const pairHandle = view("pair-handle");
console.log("\npair-handle             →", JSON.stringify(pairHandle), "(py-domain WasmHandle)");
console.log("py-join-pair(handle)    →", JSON.stringify(view("joined")), "(handle dereferenced inside Python)");

// Show WAT: the wat-compiler segment stashes the compiled wasm bytes on
// cel._wasm. The `wasm-to-wat` utility cel decompiles them back to WAT
// text — useful for inspecting any wasm module.
const watAdd = 龜甲.cels.get("wat-add") as { _wasm?: Uint8Array } | undefined;
if (watAdd?._wasm) {
  const wasmToWat = resolveFn(龜甲, "wasm-to-wat")!;
  const watText = (await wasmToWat(watAdd._wasm)) as string;
  console.log("\n--- (wasm-to-wat wat-add._wasm) ---");
  console.log(watText.trimEnd());
}

// Round-trip: dehydrate filtered to just our segment and write back to
// the same file. The kernel's `lambda-source` sourceDehydrate restores
// the multi-line array form on cels that opted in via metadata.schema.
const dehydrated = dehydrate(龜甲, { onlySegments: ["象形"] }) as {
  segments: unknown[]; manifests: unknown[];
};
await writeFile(filePath, JSON.stringify(dehydrated, null, 2) + "\n", "utf8");

console.log(`\nwrote ${filePath}`);
