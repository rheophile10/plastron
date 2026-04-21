// ============================================================================
// EXAMPLE 05 — Custom segments, custom lambdas, segment flush.
//
// HOW TO RUN:
//   npx vite-node examples/05_custom_segments/index.ts
//
// WHAT THIS DEMONSTRATES:
//   - Two user-defined segments ("catalog" and "cart") hydrated together.
//   - Two user-defined lambdas with full LambdaMetadata: description,
//     input/output schema keys, arity, source string.
//   - Segment flush: `state.flush("cart")` removes the cart segment's
//     cels, leaving the catalog intact. You'd use this pattern to reset
//     per-user state (clear cart, log out) without tearing down the app.
//   - Re-hydrating a fresh "cart" after flush.
// ============================================================================

import { runtime } from "../../plastron/src/index.js";
import type {
  DehydratedCel, LambdaMetadata, FnRegistry,
} from "../../plastron/src/state/index.js";

// ============================================================================
// STEP 1 — Custom lambdas. Each takes a typed input object and returns
// a typed output. The metadata records what the stdlib metadata records
// look like: key, description, inputSchema/outputSchema keys, arity.
// ============================================================================

const sumLineItems = ({ prices, quantities }: { prices: number[]; quantities: number[] }): number => {
  let total = 0;
  for (let i = 0; i < prices.length; i++) total += prices[i] * (quantities[i] ?? 0);
  return total;
};

const formatCurrency = ({ n }: { n: number }): string =>
  `$${n.toFixed(2)}`;

const fnRegistry: FnRegistry = {
  sumLineItems,
  formatCurrency,
};

const lambdaMeta: Record<string, LambdaMetadata> = {
  sumLineItems: {
    key:         "sumLineItems",
    description: "Element-wise dot product of prices[] and quantities[] arrays.",
    inputSchema: "object",   // references the default "object" schema
    outputSchema:"number",
    arity:       2,
    filename:    "examples/05_custom_segments/index.ts",
    source:      sumLineItems.toString(),
  },
  formatCurrency: {
    key:         "formatCurrency",
    description: "Format a number as USD with two decimals.",
    inputSchema: "unopInput",
    outputSchema:"string",
    arity:       1,
    filename:    "examples/05_custom_segments/index.ts",
    source:      formatCurrency.toString(),
  },
};

// ============================================================================
// STEP 2 — "catalog" segment: read-only product prices. This segment
// lives for the whole session; nothing flushes it.
// ============================================================================

const catalog: Record<string, DehydratedCel> = {
  price_apple:  { key: "price_apple",  segment: "catalog", v: 1.25, readOnly: true },
  price_bread:  { key: "price_bread",  segment: "catalog", v: 3.50, readOnly: true },
  price_cheese: { key: "price_cheese", segment: "catalog", v: 5.75, readOnly: true },
};

// ============================================================================
// STEP 3 — "cart" segment: user-mutable quantities + derived totals.
// This segment is flushable — we'll clear it between "customers."
// ============================================================================

const cartSegment = (startingQuantities: [number, number, number]): Record<string, DehydratedCel> => ({
  qty_apple:  { key: "qty_apple",  segment: "cart", v: startingQuantities[0] },
  qty_bread:  { key: "qty_bread",  segment: "cart", v: startingQuantities[1] },
  qty_cheese: { key: "qty_cheese", segment: "cart", v: startingQuantities[2] },

  // Lambda: sum price * qty across all three items. inputMap arrays
  // collect prices/quantities parallel to each other.
  cart_subtotal: {
    key: "cart_subtotal",
    segment: "cart",
    l: "sumLineItems",
    inputMap: {
      prices:     ["price_apple", "price_bread", "price_cheese"],
      quantities: ["qty_apple", "qty_bread", "qty_cheese"],
    },
  },

  // Lambda: format subtotal as currency string.
  cart_display: {
    key: "cart_display",
    segment: "cart",
    l: "formatCurrency",
    inputMap: { n: "cart_subtotal" },
  },
});

// ============================================================================
// STEP 4 — Hydrate catalog + cart together, boot the rt.
// ============================================================================

// runtime() handles hydrate + createRuntime + initial priming in one
// async call. Both segments (catalog + cart) are loaded together.
const rt = await runtime(
  [catalog, cartSegment([2, 1, 1])],   // Alice's starting cart
  [lambdaMeta],
  fnRegistry,
);

const show = (label: string) => {
  console.log(`\n--- ${label} ---`);
  for (const key of ["qty_apple", "qty_bread", "qty_cheese", "cart_subtotal", "cart_display"]) {
    console.log(`  ${key.padEnd(14)} = ${JSON.stringify(rt.input!.get(key))}`);
  }
};

show("Alice's initial cart (2 apples, 1 bread, 1 cheese)");

// ============================================================================
// STEP 5 — Alice adds an apple and some cheese.
// ============================================================================

console.log("\nAlice adds 3 more apples and 1 more cheese...");
await rt.input!.batch([
  ["qty_apple", 5],
  ["qty_cheese", 2],
]);
show("After Alice's updates");

// ============================================================================
// STEP 6 — End of Alice's session. Flush "cart" segment. Catalog
// untouched; cart cels gone.
// ============================================================================

console.log("\n--- Flushing \"cart\" segment ---");
rt.flush("cart");
console.log(`  cart cels remaining: ${
  ["qty_apple", "qty_bread", "qty_cheese", "cart_subtotal", "cart_display"]
    .filter(k => rt.Cels.has(k)).length
}`);
console.log(`  catalog cels remaining: ${
  ["price_apple", "price_bread", "price_cheese"]
    .filter(k => rt.Cels.has(k)).length
} (still there)`);

// ============================================================================
// STEP 7 — Bob's session. Re-hydrate a fresh cart segment with
// different starting quantities into the same rt.
// ============================================================================

console.log("\n--- Bob's session: re-hydrating cart ---");
// rt.hydrate() adds more cels / lambdas to this runtime in place, runs
// precompute, and primes any newly-added null lambda cels. The existing
// catalog segment is untouched; the fresh cart segment slots in.
await rt.hydrate([cartSegment([0, 3, 0])], [lambdaMeta], fnRegistry);

show("Bob's initial cart (3 breads)");

console.log("\nBob adds an apple and a cheese...");
await rt.input!.batch([
  ["qty_apple", 1],
  ["qty_cheese", 1],
]);
show("After Bob's updates");
