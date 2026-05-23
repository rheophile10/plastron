// ============================================================================
// pictograph (象形) — plastron-simple port.
//
// Loads a dehydrated 甲骨 from JSON, materializes any cel marked
// `metadata.kind: "fn-source"` into a live JS function via the kernel's
// built-in "js" compiler, then hydrates into a fresh State.
//
// Mirrors examples/pictograph for plastron, with the new cel-shape:
//   • function-valued cels are ValueCels whose `metadata.v` carries the
//     source string (loader compiles before hydrate).
//   • formula cels are FormulaCels whose `f` is an S-expression that
//     references function cels by key.
//
// After boot, demonstrates a runtime function-cel swap: setting
// `applyFn` to a new function fires the affected-subset cascade and
// `result` recomputes against the new behaviour. The dehydrated form
// is written to 甲骨.json at the end so the round-trip is observable.
// ============================================================================

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { 甲骨, 冊 } from "../../plastron-simple/src/index.js";
import { createInitialState, precompute, precomputeOptional, resolveFn } from "../../plastron-simple/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const segmentPath = resolve(here, "龜甲.json");
const outPath     = resolve(here, "甲骨.json");

const joinLines = (v: unknown): string | undefined =>
  Array.isArray(v) ? v.join("\n") : (typeof v === "string" ? v : undefined);

const segment = JSON.parse(await readFile(segmentPath, "utf8")) as 甲骨;

const 龜甲 = createInitialState();
const hydrate   = resolveFn(龜甲, "hydrate")!;
const runCycle  = resolveFn(龜甲, "runCycle")!;
const set       = resolveFn(龜甲, "set")!;
const dehydrate = resolveFn(龜甲, "dehydrate")!;

// Materialize fn-source cels. JSON carries the body as metadata.v
// (string or string[]); the loader replaces it with a live JS function
// before hydrate. `kind: "fn-source"` is the marker convention. (The
// kernel ships a "js" compiler segment, but it isn't loaded by
// createInitialState yet — boot only iterates seedManifests, not their
// 甲骨坑 deps — so we keep new Function inline for now.)
//
// Separately: cel.f bodies (formula source, lambda source) follow the
// same "string OR string[] for readability" convention. The loader
// collapses any `f` array into a single \n-joined string before hydrate
// sees it — this lets WAT modules (and any other multi-line source)
// stay readable in the .甲 file.
for (const dc of segment.cels) {
  const md = dc.metadata as Record<string, unknown>;
  if (md.kind === "fn-source") {
    const src = joinLines(md.v);
    if (src !== undefined) md.v = new Function(`return (${src})`)();
  }
  const dcLoose = dc as unknown as Record<string, unknown>;
  if (Array.isArray(dcLoose.f)) {
    dcLoose.f = joinLines(dcLoose.f);
  }
}

const manifest: 冊 = { name: "象形", version: "0.0.1", dependencies: [] };
await hydrate(龜甲, [segment], [manifest]);
precompute(龜甲);
await precomputeOptional(龜甲);
await runCycle(龜甲);

// Read live cels directly — no need to dehydrate just to display.
const view = (key: string): unknown => 龜甲.cels.get(key)?.v;

console.log("👤      :", view("👤"));
console.log("👦      :", view("👦"));
console.log("👧      :", view("👧"));
console.log("👦👋👧 :", view("👦👋👧"));

// Swap a function cel at runtime via `set` — the cel's value IS a JS
// function held in cel.v. Writing a new function fires the affected-
// subset cascade and `result` recomputes against the new behaviour.
console.log("\nresult (add):", view("result"));
await set(龜甲, "applyFn", (arr: number[]) => arr[0] * arr[1]);
console.log("result (mul):", view("result"));

// WAT cel: an EditableLambdaCel with `kind: "wat"` compiles its WAT
// source body through the kernel's wat-compiler segment at hydrate
// time. The result is a real WebAssembly function called like any
// other Fn — same DAG, different language.
//
// `wat-result` carries `outputSchema: "wasm:i32"` — declares it as a
// wat-domain value. `wat-result-js` reads it through the explicit
// `(wat-to-js ...)` bridge cel — v1 scalars are JS-equivalent so this
// is identity, but the DAG node is real and future composite values
// (strings, lists) will marshal through here once worker isolation
// lands. Both observably equal 7.
console.log("\nwat-add(3, 4) →", view("wat-result"), "(wat-domain, wasm:i32)");
console.log("wat-result-js  →", view("wat-result-js"), "(after (wat-to-js …) bridge)");

// Python via Pyodide. The py-compiler segment dynamic-imports pyodide
// on the first py-kind compile (~5s cold boot).
//
// The result flows through explicit (py-to-js …) and (js-to-quickjs …)
// bridge cels before reaching qjs-shout. For scalars (a string) the
// bridges are identity, but the DAG nodes are visible — diagnostics
// can count kind transitions, and the same shape works when composite
// handles arrive on either side.
console.log("\npy-greet(left, right)        →", JSON.stringify(view("py-greeting")), "(py-domain, eager-marshalled to JS)");
console.log("(py-to-js py-greeting)       →", JSON.stringify(view("py-greeting-js")), "(explicit bridge, js-domain)");
console.log("(js-to-quickjs …)            →", JSON.stringify(view("py-greeting-qjs")), "(explicit bridge, quickjs-domain)");
console.log("(qjs-shout py-greeting-qjs)  →", JSON.stringify(view("qjs-shouted")), "(quickjs sandbox)");

// Composite WIT handles. `py-make-pair` declares outputSchema = wasm:opaque
// (composite WIT type), so its return value stays as a WasmHandle pointing
// into py-domain — Python dict NOT marshalled to JS. `py-join-pair`
// consumes the handle; the wrapper dereferences server-side and Python
// works with the original dict. The cell value showing as a handle here
// proves the optimization: pair-handle.v is { kind: "py", ref: N, type }
// rather than a materialized JS Map.
const pairHandle = view("pair-handle");
console.log("\npair-handle             →", JSON.stringify(pairHandle), "(py-domain WasmHandle)");
console.log("py-join-pair(handle)    →", JSON.stringify(view("joined")), "(handle dereferenced inside Python)");

// Show WAT: the wat-compiler segment stashes the compiled wasm bytes on
// cel._wasm. The `wasm-to-wat` utility cel decompiles them back to WAT
// text — useful for inspecting any wasm module, especially compiled-
// from-other-source kinds (Javy, Rust) when they land.
// `_wasm` lives on ComputeCels (the fireable kinds); narrow off the
// Cel union before reading.
const watAdd = 龜甲.cels.get("wat-add") as { _wasm?: Uint8Array } | undefined;
if (watAdd?._wasm) {
  const wasmToWat = resolveFn(龜甲, "wasm-to-wat")!;
  const watText = (await wasmToWat(watAdd._wasm)) as string;
  console.log("\n--- (wasm-to-wat wat-add._wasm) ---");
  console.log(watText.trimEnd());
}

// Round-trip: dehydrate to JSON. Functions become their .toString()
// source via the replacer so the file stays serializable.
const dehydrated = dehydrate(龜甲) as { segments: 甲骨[]; manifests: 冊[] };
const fnReplacer = (_k: string, v: unknown): unknown =>
  typeof v === "function" ? v.toString() : v;
await writeFile(outPath, JSON.stringify(dehydrated, fnReplacer, 2) + "\n", "utf8");

console.log(`\nwrote ${outPath}`);
