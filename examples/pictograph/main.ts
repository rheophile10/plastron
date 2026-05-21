// ============================================================================
// pictograph (象形) — load a dehydrated segment from segment.json, hydrate it
// into a fresh plastron 龜甲, runCycle, then dehydrate the resulting
// 龜甲 to 甲骨.json.
//
// Only dependency is plastron core. Functions live entirely inside cels:
// any cel with `tag: "fn"` carries a JS source string (or string[]) in
// its v, which this loader materializes into a real function via
// `new Function(...)` before hydrate sees the segment. Computed cels
// use formula syntax (`cel.f`) — the formula compiler calls the head
// function positionally and auto-wires emoji symbol refs into inputMap
// at hydrate time. No glue lambdas needed.
//
// Convention: `string` fields anywhere in the segment may be expressed
// as `string[]` for readability — joinLines() collapses them with "\n"
// before further processing.
// ============================================================================

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Fn, Segment } from "../../plastron/src/index.js";
import { createInitialState, precomputeOptional } from "../../plastron/src/index.js";

// there are segments that already handle archiving but for now we use this. 

const here = dirname(fileURLToPath(import.meta.url));
const segmentPath = resolve(here, "龜甲.json");
const outPath     = resolve(here, "甲骨.json");

const joinLines = (v: unknown): string | undefined =>
  Array.isArray(v) ? v.join("\n") : (typeof v === "string" ? v : undefined);

const raw = JSON.parse(await readFile(segmentPath, "utf8")) as Segment & {
  manifest?: { description?: string | string[] };
};
if (raw.manifest?.description !== undefined) {
  raw.manifest.description = joinLines(raw.manifest.description);
}
for (const cel of raw.cels ?? []) {
  if (cel.tag !== "fn") continue;
  const src = joinLines(cel.v);
  if (src !== undefined) cel.v = new Function(`return (${src})`)();
}
const segment = raw as Segment;

// initialize a plastron

const 龜甲 = createInitialState();
await (龜甲.fns.get("hydrate")  as Fn)(龜甲, [segment], []);
await (龜甲.fns.get("runCycle") as Fn)(龜甲);
await precomputeOptional(龜甲);
await (龜甲.fns.get("runCycle") as Fn)(龜甲);

const 甲骨 = (龜甲.fns.get("dehydrate") as Fn)(龜甲) as Segment[];
// Functions (live fn cels, class values) round-trip as their .toString()
// source; without this they collapse to undefined and the cel loses v.
const fnReplacer = (_k: string, v: unknown): unknown =>
  typeof v === "function" ? v.toString() : v;
await writeFile(outPath, JSON.stringify(甲骨, fnReplacer, 2) + "\n", "utf8");

const pict = 甲骨.find((s) => s.key === "象形");
const view = (key: string): unknown =>
  pict?.cels.find((c) => c.key === key)?.v;

console.log("👤      :", view("👤"));
console.log("👦      :", view("👦"));
console.log("👧      :", view("👧"));
console.log("👦👋👧 :", view("👦👋👧"));
console.log(`\nwrote ${outPath}`);
