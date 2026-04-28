// ============================================================================
// EXAMPLE 06 — plastromancy: a Shang-era divination ritual with custom
// chisels (lambdas) and multiple plastrons (segments).
//
// HOW TO RUN:
//   npx vite-node examples/06_plastromancy/index.ts
//
// FOLDER LAYOUT:
//   龜/   — "turtles" (segments). One file per plastron.
//   辛/   — "chisels" (lambdas). One file per custom tool plus an
//            index that aggregates fns + metadata.
//
// WHAT THIS DEMONSTRATES:
//   * plastron() accepts three bundles: segment JSON strings, an array
//     of LambdaMetadata records, and an fnRegistry.
//   * Two segments hydrated together: a "session" plastron with
//     writeable charges and an "ancestors" read-only catalog.
//   * Four custom chisels with full LambdaMetadata:
//       crackGeometry   — classify crack from heat + thickness
//       readOmen        — pronounce 吉/凶 from geometry + charge weight
//       omenReport      — compose the session display scroll as a cel
//       ancestorReport  — compose the lineage display scroll as a cel
//   * Display formatting lives in the graph, not in the orchestrator.
//     The TypeScript side just 察's the report cels and prints.
//   * The ritual: 刻 (carve), 連刻 (carve many), 重 (recharge), 焚 (burn).
// ============================================================================

import plastron from "../../plastron/src/index.js";
import { sessionCels }   from "./龜/session.js";
import { ancestorsCels } from "./龜/ancestors.js";
import { 辛Fns, 辛Meta }  from "./辛/index.js";

// plastron() returns a fully-computed 龜卜藏 — it fires one initial
// cycle over every lambda cel after hydration, so 察 hands back real
// values on the first read. No caller-side priming needed.
const 甲 = await plastron([sessionCels, ancestorsCels], [辛Meta], 辛Fns);

// showSession 刻s a new label into `reportLabel`; the `sessionReport`
// lambda cel re-fires and holds the full "— label —" + omen block.
// The orchestrator just reads the cel and prints.
const showSession = async (label: string) => {
  await 甲.貞!.刻("reportLabel", label);
  console.log(甲.貞!.察("sessionReport"));
};

await showSession("Session opens");

// ============================================================================
// King Wu Ding poses a new, weightier charge. 刻 it onto the plastron;
// readOmen will note the charge's weight and sharpen its judgment.
// ============================================================================

console.log("\n王 poses a graver charge:");
console.log("  「王往伐羌方，受有祐？」");
await 甲.貞!.刻("charge", "王往伐羌方，受有祐？ (Shall the king campaign against the Qiāng and receive aid?)");
await showSession("After the new charge is carved");

// ============================================================================
// 連刻: the diviner changes plastron (new thickness) and presses the
// brand harder. One ritual stroke, one cycle.
// ============================================================================

console.log("\n連刻: fresh plastron, firmer brand.");
await 甲.貞!.連刻([
  ["heat", 7],
  ["thickness", 4],
]);
await showSession("After 連刻 (geometry shifts to 雙叉)");

// ============================================================================
// Peek at the ancestor catalog — a separate segment untouched by the
// above rituals. Its display scroll is another lambda cel.
// ============================================================================

console.log("\n— Ancestor catalog —");
console.log(甲.貞!.察("ancestor_report"));

// ============================================================================
// 焚: end of session. Burn the session plastron's bones. The ancestors
// segment survives; its scroll still renders.
// ============================================================================

console.log("\n焚: the session plastron is burned and deposited into 龜坑.");
甲.焚("session");

console.log("\n— Ancestor catalog (after 焚) —");
console.log(甲.貞!.察("ancestor_report"));
