// ============================================================================
// EXAMPLE — plastromancy: divination on a simplified plastron.
//
// HOW TO RUN:
//   cd examples/plastromancy && npm install && npm start
//
// FEATURES SHOWN (and the symbols that name them):
//
//   卷 (segments) bundle-shaped hydration, two segments at once
//   體 (augur)    custom lambda kind that interprets a JSON rule book
//   formula DSL   (/ heat thickness) auto-wires inputs from referenced cels
//   schema-isChanged  crack pattern equality suppresses unrelated propagation
//   schema-diff   vnode tree cel publishes a Patch on cel._diff per cycle
//   .甲 archive   exportArchive / importArchive round-trip the state
//   焚 (flush)    burn the session bones; rules survive
//
// THE RITUAL (terminology, after the README's glyph table):
//   卜  the cascade   — a write triggers a crack that propagates
//   辛  the chisel    — the cycle-runner carving omens onto the bone
//   貞  the augur's   — IO surface: state.fns.get("get"|"set"|"batch")
//   骨  the bones     — the cels Map
//   甲  the shell     — the substrate (now also the archive format)
// ============================================================================

import type { Dehydrate, Fn, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import {
  vnodeSchema, VNODE_SCHEMA_KEY, VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY,
  type Patch,
} from "../../../segments/plastron-dom/src/index.js";
import {
  exportArchive, importArchive,
} from "../../../segments/plastron-archive/src/index.js";
import { rulesSegment, sessionSegment } from "./segments.js";
import { chiselFns } from "./lambdas.js";
import { augurKind } from "./kind.js";
import {
  crackSchema, CRACK_SCHEMA_KEY, CRACK_IS_CHANGED_KEY, type Crack,
} from "./schemas.js";

const banner = (s: string) => `\n${s}\n${"─".repeat(s.length)}`;
const get = (state: State, key: string) => state.cels.get(key)?.v;

// Register schemas + their isChanged/diff metadata up front so hydrate
// can resolve everything at hydrate time (it materializes _isChanged
// and _diffFn on every cel that declares one of these schemas).
const installShellEnvironment = (state: State): void => {
  state.schemas.set(VNODE_SCHEMA_KEY, vnodeSchema);
  state.schemaMetadata.set(VNODE_SCHEMA_KEY, {
    key:       VNODE_SCHEMA_KEY,
    isChanged: VNODE_IS_CHANGED_KEY,
    diff:      VNODE_DIFF_KEY,
  });
  state.schemas.set(CRACK_SCHEMA_KEY, crackSchema);
  state.schemaMetadata.set(CRACK_SCHEMA_KEY, {
    key:       CRACK_SCHEMA_KEY,
    isChanged: CRACK_IS_CHANGED_KEY,
  });
  state.kindRegistry.set("augur", augurKind);
};

// ============================================================================
// Build the kettle.
// ============================================================================
const state = createInitialState();
installShellEnvironment(state);

const hydrate   = state.fns.get("hydrate")   as Fn;
const dehydrate = state.fns.get("dehydrate") as Dehydrate;
const runCycle  = state.fns.get("runCycle")  as Fn;
const set       = state.fns.get("set")       as Fn;
const flush     = state.fns.get("flush")     as Fn;

hydrate(state, [rulesSegment, sessionSegment], [chiselFns]);
await runCycle(state);

const showReading = (label: string): void => {
  const charge = get(state, "charge") as string;
  const crack  = get(state, "crack")  as Crack;
  const omen   = get(state, "omen")   as string;
  console.log(banner(label));
  console.log(`  charge: ${charge}`);
  console.log(`  crack:  ${crack.pattern} (intensity ${crack.intensity.toFixed(2)})`);
  console.log(`  omen:   ${omen}`);
};

// ============================================================================
// 第一次卜 — heat=6, thickness=2 → ratio 3 → pattern Y.
// ============================================================================
showReading("第一次卜 — first divination");
const firstDiff = state.cels.get("tree")?._diff as Patch | undefined;
console.log(`  tree diff: ${firstDiff?.kind ?? "(none)"}`);

// ============================================================================
// 王 poses a graver charge. The cascade fires charge → tree, but not
// crack / omen — their inputs didn't change.
// ============================================================================
await set(state, "charge", "shall we burn the bones for rain?");
showReading("王 poses a graver charge");
const treeDiffAfter = state.cels.get("tree")?._diff as Patch | undefined;
console.log(`  tree diff: ${treeDiffAfter?.kind ?? "(none)"}`);

// ============================================================================
// 連刻 — heat eased. Pattern flips to X; omen and tree re-fire.
// ============================================================================
await set(state, "heat", 4);
showReading("連刻 — heat eased, pattern flips");

// ============================================================================
// crack-isChanged demo: same pattern, different intensity. The schema
// metadata's isChanged callback says "still pattern X, no change," so
// downstream cels (omen, tree) skip re-firing.
// ============================================================================
const crackBefore = get(state, "crack") as Crack;
const omenBefore  = get(state, "omen")  as string;
await set(state, "heat", 5);  // ratio 2.5 — still pattern X
const crackAfter  = get(state, "crack") as Crack;
const omenAfter   = get(state, "omen")  as string;
console.log(banner("schema-isChanged — same pattern, different intensity"));
console.log(`  before: pattern ${crackBefore.pattern}, intensity ${crackBefore.intensity.toFixed(2)}`);
console.log(`  after:  pattern ${crackAfter.pattern}, intensity ${crackAfter.intensity.toFixed(2)}`);
console.log(`  omen ${omenBefore === omenAfter ? "unchanged" : "re-fired"} (isChanged suppressed propagation)`);

// ============================================================================
// .甲 export — write the post-divination state to a zip archive that
// carries its own JSON history. Any host can reload it.
// ============================================================================
console.log(banner(".甲 — archive the rite"));
const segments = dehydrate(state);
console.log(`  segments emitted: ${segments.map((s) => s.key).join(", ")}`);
const bytes = await exportArchive(segments, { message: "plastromancy demo" });
console.log(`  archive size: ${bytes.byteLength} bytes`);

// ============================================================================
// .甲 import — open the archive into a fresh state, verify it reads.
// ============================================================================
const { manifest, segments: imported, archive } = await importArchive(bytes);
await archive.close();
console.log(`  archive segments: [${manifest.segments.join(", ")}]`);

const restored = createInitialState();
installShellEnvironment(restored);
const restoredHydrate  = restored.fns.get("hydrate")  as Fn;
const restoredRunCycle = restored.fns.get("runCycle") as Fn;
restoredHydrate(restored, imported, [chiselFns]);
await restoredRunCycle(restored);
console.log(`  restored omen: ${get(restored, "omen")}`);

// ============================================================================
// 焚 — burn the session bones. flush walks every cel with segment
// "session", fires each cel._dispose, calls tag.release on cel.v, and
// re-precomputes. Rules and the augur-kind metadata survive.
// ============================================================================
flush(state, "session");
const remaining = new Set<string>();
for (const cel of state.cels.values()) {
  if (cel.segment) remaining.add(cel.segment);
}
console.log(banner("焚 — burn the session"));
console.log(`  segments remaining: ${[...remaining].sort().join(", ") || "(none)"}`);

console.log("\n龜卜 complete.\n");
