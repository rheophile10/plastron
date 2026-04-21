// ============================================================================
// EXAMPLE 04 — input.batch() vs. rapid set() calls.
//
// HOW TO RUN:
//   npx vite-node examples/04_batch_events/index.ts
//
// WHAT THIS DEMONSTRATES:
//   When many events hit the runtime in quick succession, firing
//   input.set() per event runs one recalculation cycle per call.
//   input.batch() takes a list of writes, merges their cascades, and
//   runs a single cycle for all of them. This matters when the
//   downstream graph does real work per cycle.
//
//   We count cycles by wrapping state.cycle with a tracing wrapper.
//   Then we push the same set of events through both paths and compare.
//
//   Afterward we simulate a real "event stream" pattern: an upstream
//   producer pushes events into a JS array at irregular intervals, and
//   a flush step periodically drains the array into one input.batch()
//   call. This is the practical shape of debouncing external events
//   into engine cycles.
// ============================================================================

import { runtime } from "../../plastron/src/index.js";
import type { DehydratedCel, WavedCascade } from "../../plastron/src/state/index.js";

// ============================================================================
// STEP 1 — A small graph: a `reading` variable, a `doubled` lambda,
// and a `report` formula cel. Each write to `reading` propagates to
// both downstream cels.
// ============================================================================

const cels: Record<string, DehydratedCel> = {
  reading: { segment: "demo", v: 0,    children: ["doubled"] },
  doubled: { segment: "demo", l: "add", inputMap: { a: "reading", b: "reading" } },
  report:  { segment: "demo", f: "'doubled=' |> concat(@doubled)" },
};

const rt = await runtime([cels]);

// ============================================================================
// STEP 2 — Wrap state.cycle to count cycles. Each invocation = one cycle.
// ============================================================================

let cycleCount = 0;
const originalCycleRunner = rt.cycle!;
rt.cycle = async (cascade: WavedCascade): Promise<void> => {
  cycleCount++;
  await originalCycleRunner(cascade);
};

const resetCounter = () => { cycleCount = 0; };

// ============================================================================
// STEP 3 — Fire 20 events via individual set() calls.
// ============================================================================

const events = Array.from({ length: 20 }, (_, i) => i + 1);

console.log("--- Firing 20 events via individual input.set() ---");
resetCounter();
for (const e of events) {
  await rt.input!.set("reading", e);
}
console.log(`  cycles run: ${cycleCount}`);
console.log(`  final reading=${rt.input!.get("reading")}, doubled=${rt.input!.get("doubled")}`);

// ============================================================================
// STEP 4 — Fire the same 20 events via a single batch() call.
// ============================================================================

console.log("\n--- Firing 20 events via one input.batch() ---");
resetCounter();
await rt.input!.batch(events.map(e => ["reading", e] as [string, unknown]));
console.log(`  cycles run: ${cycleCount}`);
console.log(`  final reading=${rt.input!.get("reading")}, doubled=${rt.input!.get("doubled")}`);

// ============================================================================
// STEP 5 — Simulate a real event stream: producers push into a JS
// queue at random intervals; a flusher drains the queue into one
// batch() periodically. This is the pattern you'd use wrapping a
// websocket / event bus / requestIdleCallback.
// ============================================================================

console.log("\n--- Simulated event stream ---");

type Write = [string, unknown];
const queue: Write[] = [];

// Producer: fires 50 events over 200ms at irregular intervals.
const producer = new Promise<void>((resolve) => {
  let fired = 0;
  const fire = () => {
    if (fired >= 50) { resolve(); return; }
    queue.push(["reading", Math.floor(Math.random() * 100)]);
    fired++;
    setTimeout(fire, Math.random() * 8);
  };
  fire();
});

// Flusher: every 50ms, take everything in the queue and batch it.
resetCounter();
let flushesFired = 0;
const flusher = setInterval(async () => {
  if (queue.length === 0) return;
  flushesFired++;
  const batch = queue.splice(0);
  await rt.input!.batch(batch);
}, 50);

await producer;
// One more flush to catch leftovers.
await new Promise(r => setTimeout(r, 100));
clearInterval(flusher);
if (queue.length) {
  flushesFired++;
  await rt.input!.batch(queue.splice(0));
}

console.log(`  producer fired 50 events`);
console.log(`  flusher ran ${flushesFired} batches, triggering ${cycleCount} cycles`);
console.log(`  final reading=${rt.input!.get("reading")}, doubled=${rt.input!.get("doubled")}`);

// ============================================================================
// TAKEAWAY
//
// If your app produces many rapid writes — UI drag events, sensor
// streams, websocket bursts — buffer them in a JS queue and flush to
// input.batch() on a debounce/interval. One cycle per flush instead of
// one cycle per event is the difference between responsive and janky.
// ============================================================================
