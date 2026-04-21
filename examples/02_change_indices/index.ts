// ============================================================================
// EXAMPLE 02 — Tags, changeIndices, and a wave-deferred aggregator.
//
// HOW TO RUN (from /home/ian/projects/plastron):
//   npx vite-node examples/02_change_indices.ts
//
// WHAT THIS FILE DOES:
//   Simulates a small app with three "render-tagged" panels and one
//   "audit-tagged" bookkeeping cel. A wave-1 aggregator cel reads the
//   `changeIndices` reserved cel directly (via inputMap) and logs what
//   changed in wave 0 — once per cycle, in batch.
//
// WHAT TO LOOK FOR:
//   * `tags` on cels so they participate in named indices.
//   * `changeIndexConfig.v` mapping index names to tag lists.
//   * A `wave: 1` cel that reads `changeIndices` as a normal inputMap
//     entry — runs after all wave-0 cels finish.
//   * `changeIndices[name]` is Key[][] — outer index = wave number.
//   * isChanged pruning: a write producing the SAME downstream output
//     does NOT cause the cel to appear in any changeIndex.
// ============================================================================

import { runtime } from "../../plastron/src/index.js";
import type {
  DehydratedCel, LambdaMetadata, FnRegistry, Cel, Key,
  ChangeIndexConfig, ChangeIndices,
} from "../../plastron/src/state/index.js";

// ============================================================================
// STEP 1 — Cel factories (dehydrated form).
// ============================================================================

const SEG = "demo";

const variable = (key: string, v: unknown, children: Key[] = []): DehydratedCel => ({
  key, segment: SEG, v, children,
});

const calculated = (
  key: string,
  lambdaKey: string,
  inputMap: Record<string, Key | Key[]>,
  children: Key[] = [],
  extra: Partial<DehydratedCel> = {},
): DehydratedCel => ({
  key, segment: SEG, children,
  l: lambdaKey, inputMap,
  ...extra,
});

// ============================================================================
// STEP 2 — Define the graph.
// ============================================================================

const cels: DehydratedCel[] = [
  variable("user_name",   "Alice",   ["header_html"]),
  variable("counter",     0,         ["counter_html"]),
  variable("page_title",  "Home",    ["title_html"]),
  variable("last_action", "start",   ["action_log"]),

  calculated("header_html",  "renderHeader",  { name: "user_name" },   [], { tags: ["render"] }),
  calculated("counter_html", "renderCounter", { n: "counter" },        [], { tags: ["render"] }),
  calculated("title_html",   "renderTitle",   { title: "page_title" }, [], { tags: ["render"] }),

  calculated("action_log",   "stampAction",   { action: "last_action" }, [], { tags: ["audit"] }),

  calculated(
    "apply_changes",
    "applyChanges",
    { ci: "changeIndices" },
    [],
    { wave: 1 },
  ),
];

// Pack the cel list into a Record for hydrate.
const celRec: Record<string, DehydratedCel> = {};
for (const c of cels) celRec[c.key] = c;

// ============================================================================
// STEP 3 — Define lambdas.
// ============================================================================

const renderHeader  = ({ name }: { name: string })    => `<h1>Hi, ${name}</h1>`;
const renderCounter = ({ n }: { n: number })          => `<div>Count: ${n}</div>`;
const renderTitle   = ({ title }: { title: string })  => `<title>${title}</title>`;
const stampAction   = ({ action }: { action: string }) => `[${new Date(0).toISOString()}] action=${action}`;
const applyChanges  = ({ ci }: { ci: ChangeIndices }) => {
  const render = ci?.render?.[0] ?? [];
  const audit  = ci?.audit?.[0]  ?? [];

  if (render.length === 0 && audit.length === 0) {
    console.log("  [aggregator] nothing changed this cycle");
    return { ok: true, flushed: 0 };
  }

  if (render.length > 0) console.log(`  [aggregator] render panels: ${render.join(", ")}`);
  if (audit.length  > 0) console.log(`  [aggregator] audit entries:  ${audit.join(", ")}`);
  return { ok: true, flushed: render.length + audit.length };
};

const lambdaMeta: Record<string, LambdaMetadata> = {
  renderHeader:  { key: "renderHeader",  source: renderHeader.toString() },
  renderCounter: { key: "renderCounter", source: renderCounter.toString() },
  renderTitle:   { key: "renderTitle",   source: renderTitle.toString() },
  stampAction:   { key: "stampAction",   source: stampAction.toString() },
  applyChanges:  { key: "applyChanges",  source: applyChanges.toString() },
};

const fnRegistry: FnRegistry = {
  renderHeader, renderCounter, renderTitle, stampAction, applyChanges,
};

// ============================================================================
// STEP 4 — Hydrate + configure changeIndexConfig on the rt.
// ============================================================================

// runtime() hydrates + wires + primes in one call. Afterwards we mutate
// the changeIndexConfig cel's v to enable the named indices; the next
// cycle picks up the new config automatically.
const rt = await runtime([celRec], [lambdaMeta], fnRegistry);

const changeConfig: ChangeIndexConfig = {
  render: ["render"],
  audit: ["audit"],
};
rt.Cels.get("changeIndexConfig")!.v = changeConfig;

// ============================================================================
// STEP 5 — Prime the graph.
// ============================================================================

console.log("--- Priming the graph (first recalc) ---");
await rt.input!.batch([
  ["user_name", "Bob"],
  ["counter", 1],
  ["page_title", "Dashboard"],
  ["last_action", "boot"],
]);

const show = (label: string) => {
  console.log(`\n--- ${label} ---`);
  for (const key of ["user_name", "counter", "page_title", "last_action",
                     "header_html", "counter_html", "title_html", "action_log",
                     "changeIndices", "apply_changes"]) {
    console.log(`  ${key.padEnd(14)} = ${JSON.stringify(rt.input!.get(key))}`);
  }
};

show("After priming");

console.log("\n--- set(counter, 2) ---");
await rt.input!.set("counter", 2);

console.log("\n--- set(last_action, 'save') ---");
await rt.input!.set("last_action", "save");

console.log("\n--- No-op: set(counter, 2) when counter is already 2 ---");
await rt.input!.set("counter", 2);
console.log("  (no aggregator output — cascade was empty)");

console.log("\n--- Batch: counter=5, user_name='Carol', last_action='logout' ---");
await rt.input!.batch([
  ["counter", 5],
  ["user_name", "Carol"],
  ["last_action", "logout"],
]);

console.log("\n--- Demonstrating output-side pruning ---");
console.log("  Swapping counter_html to a clamped renderer (max 3)...");
(rt.Cels.get("counter_html") as Cel)._fn =
  (({ n }: { n: number }) => `<div>Count: ${Math.min(n, 3)}</div>`) as any;

await rt.input!.set("counter", 3);
console.log(`  counter_html is now: ${rt.input!.get("counter_html")}`);

console.log("\n  Now setting counter=10. Clamp means output is unchanged.");
console.log("  Aggregator reports that counter changed, but the render index stays empty:");
await rt.input!.set("counter", 10);
