// ============================================================================
// EXAMPLE 03 — cel.f formulas with @ syntax, defaults auto-loaded.
//
// HOW TO RUN (from /home/ian/projects/plastron):
//   npx vite-node examples/03_formulas/index.ts
//
// WHAT THIS DEMONSTRATES:
//   - `cel.f` is a first-class engine feature. No user lambdas needed —
//     hydrate auto-loads the default operator bundle.
//   - `@key` reads another cel's value, short for K("key").
//   - Dependencies are auto-extracted at hydrate and wired into the
//     topology; you don't hand-write inputMap / children for formula cels.
//   - Strict arity is enforced: "+(1, 2, 3)" errors. Use "[+](1, 2, 3)"
//     for explicit reduce.
// ============================================================================

import { runtime } from "../../plastron/src/index.js";
import type { DehydratedCel } from "../../plastron/src/state/index.js";

const cels: Record<string, DehydratedCel> = {
  price: { key: "price", segment: "demo", v: 100 },
  qty:   { key: "qty",   segment: "demo", v: 3 },
  rate:  { key: "rate",  segment: "demo", v: 0.08 },

  subtotal:  { key: "subtotal",  segment: "demo", f: "*(@price, @qty)" },
  tax:       { key: "tax",       segment: "demo", f: "*(@subtotal, @rate)" },
  total:     { key: "total",     segment: "demo", f: "+(@subtotal, @tax)" },
  sumPrices: { key: "sumPrices", segment: "demo", f: "[+](@price, 50, 25)" },
  rounded:   { key: "rounded",   segment: "demo", f: "🔄(@total)" },
};

// runtime() hydrates + primes + attaches input in one call.
const rt = await runtime([cels]);

const show = (label: string) => {
  console.log(`\n--- ${label} ---`);
  for (const key of ["price", "qty", "rate", "subtotal", "tax", "total", "sumPrices", "rounded"]) {
    console.log(`  ${key.padEnd(10)} = ${rt.input!.get(key)}`);
  }
};

show("After priming (all formulas fired from initial inputs)");
// subtotal = 300, tax = 24, total = 324, sumPrices = 175, rounded = 324

console.log("\nSetting qty=4...");
await rt.input!.set("qty", 4);
show("After qty=4");
// subtotal = 400, tax = 32, total = 432, sumPrices = 175, rounded = 432

console.log("\nSetting price=150...");
await rt.input!.set("price", 150);
show("After price=150");
// subtotal = 600, tax = 48, total = 648, sumPrices = 225, rounded = 648

// ============================================================================
// Strict-arity violation surfaces in the errors cel.
// ============================================================================

const badCels: Record<string, DehydratedCel> = {
  x: { key: "x", segment: "demo", v: 1 },
  y: { key: "y", segment: "demo", f: "+(@x, 2, 3)" },
};
const badRt = await runtime([badCels]);

console.log("\n--- Strict-arity violation surfaces in the errors cel: ---");
const errors = badRt.input!.get("errors") as Record<string, { error: string }>;
console.log("  y.v     =", badRt.input!.get("y"));
console.log("  error   =", errors?.y?.error?.split("\n")[0] ?? "(none)");
