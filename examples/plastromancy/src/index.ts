// ============================================================================
// EXAMPLE — plastromancy: the showcase ritual.
//
// HOW TO RUN:
//   cd plastron && npm run build
//   npx tsx examples/plastromancy/src/index.ts
//
// This is the marquee demo. It exercises every plastron architectural
// feature in one running script — and it does so through a 龜卜藏
// facade that lives in this example, not in plastron core. Plastron
// itself is English-named; the plastromancy mask is one possible skin
// you can put on top of the kernel.
//
// FEATURES SHOWN (and the symbols that name them):
//
//   增卷         bundle-shaped hydration with manifest verification
//   體 / augur   custom lambda kind interpreting a JSON rule book
//   紋 / crack   format-tagged value with pattern-equality comparator
//   印 / 卷       signed manifest on a sacred catalog
//   印鑑         deterministic runtime fingerprint
//   觀           hook subscription (audit log of every divination)
//   formula DSL  preface and inscription auto-wire deps via @ refs
//   imports      augur lambda imports the rule-book module cel
//   provenance   authoredBy / generatedAt on charges and ancestors
//   roles        code / schema / documentation / metadata / system
//   defaults     changeIndices and errors auto-installed
//   貞 / 焚 / 增  the augur's hands and the burn rite
//
// THE RITUAL (terminology, after the README's glyph table):
//   卜  the cascade   — a write triggers a crack that propagates
//   辛  the chisel    — the cycle-runner carving omens onto the bone
//   貞  the augur's   — IO surface: 察 (inspect), 刻 (carve), 連刻 (carve many)
//   骨  the bones     — the cels Map
//   甲  the shell     — the substrate
// ============================================================================

import { 龜刻卜 } from "./mask/index.js";
import { fingerprintComponents } from "../../../plastron/src/index.js";
import { sessionBundle } from "./bundles/session.js";
import { rulesBundle } from "./bundles/rules.js";
import { buildAncestorsBundle, trustedSigners } from "./bundles/ancestors.js";
import { chiselFns } from "./lambdas/chisels.js";
import { augurKind } from "./kinds/augur.js";
import { crackTag } from "./tags/crack.js";
import { installAuditLog, type AuditEvent } from "../../../segments/audit-log/src/index.js";

const banner = (s: string) => `\n${s}\n${"─".repeat(s.length)}`;

// ============================================================================
// Build the ancestors bundle. Its content hash is computed and the manifest
// is stamped — the temple has signed the catalog (the 印 on the 卷).
// ============================================================================
const ancestorsBundle = await buildAncestorsBundle();

console.log(banner("龜卜 — Plastromancy showcase"));
console.log("Loading 卷 (bundles):");
console.log(`  session    (role: code, 印: none)`);
console.log(`  rules      (role: schema, 印: none)`);
console.log(`  ancestors  (role: documentation, 印: signed by ${ancestorsBundle.manifest!.signerName})`);

// ============================================================================
// 龜刻卜.卷 — bundle-shaped hydrate. The verifier accepts ancestors based
// on signer identity; an unrecognized seal would refuse the load.
// ============================================================================
const 甲 = await 龜刻卜.卷(
  [sessionBundle, rulesBundle, ancestorsBundle],
  chiselFns,
  {
    kinds: { augur: augurKind },
    tags:  { crack: crackTag },
    verifySegment: (bundle, manifest) => {
      const signer = manifest.signerName ?? "(unsigned)";
      const ok = trustedSigners.has(signer);
      return {
        ok,
        verifier: "plastromancy-demo-verifier",
        reason: ok ? "trusted temple seal" : `unknown signer: ${signer}`,
      };
    },
  },
);

// 觀 — install the audit-log segment. Every divination is recorded.
await installAuditLog(甲.__state);

// 觀 — register an inline observer too. Demonstrates the 觀 method:
// the augur's apprentice keeps a private tally of how many cycles fired.
let cyclesObserved = 0;
甲.觀({
  id: "apprentice-tally",
  afterCycle: (e) => { if (e.allChanges.length > 0) cyclesObserved++; },
});

// Configure change-indices to track every fired cel.
await 甲.貞!.刻("changeIndexConfig", { all: [] });

// ============================================================================
// First reading. carveCrack fires from the seeded heat=6 / thickness=2;
// pattern X; the augur reads "凶".
// ============================================================================
console.log(banner("第一次卜 — first divination"));
console.log(甲.貞!.察("sessionReport"));

// ============================================================================
// 王 poses a graver charge. Provenance is stamped on the cel (authoredBy
// / generatedAt). The cycle re-fires inscription; sessionReport updates.
// ============================================================================
console.log(banner("王 poses a graver charge"));
await 甲.貞!.連刻([
  ["charge", "王往伐羌方，受有祐？ (Shall the king campaign against the Qiāng?)"],
  ["sessionLabel", "After the new charge is carved"],
]);
console.log(甲.貞!.察("sessionReport"));

// ============================================================================
// 連刻 — fresh plastron, firmer brand. heat=8, thickness=2 → ratio 4 → "double-Y".
// One ritual stroke; one cycle.
// ============================================================================
console.log(banner("連刻 — fresh plastron, firmer brand"));
await 甲.貞!.連刻([
  ["heat", 8],
  ["thickness", 2],
  ["sessionLabel", "After 連刻 (geometry shifts)"],
]);
console.log(甲.貞!.察("sessionReport"));

// ============================================================================
// 紋 comparator demo. Heat changes recompute the crack value, but when
// the resulting tagged "crack" has the same pattern, the comparator
// declares the new value equal and downstream cels (omen, inscription,
// sessionReport) don't re-fire.
// ============================================================================
console.log(banner("紋 comparator: same pattern, different intensity"));
const before = 甲.貞!.察("crackGeometry") as { __tag: string; value: { pattern: string; intensity: number } };
console.log(`  current crack: pattern=${before.value.pattern}, intensity=${before.value.intensity.toFixed(2)}`);

const renderEventsBefore = (甲.骨.get("auditEvents")!.v as AuditEvent[])
  .filter((e) => e.kind === "lambda" && (e.data as { key: string }).key === "sessionReport").length;

await 甲.貞!.刻("heat", 9);  // ratio still 4.5 → still double-Y → comparator equal

const after = 甲.貞!.察("crackGeometry") as { __tag: string; value: { pattern: string; intensity: number } };
const renderEventsAfter = (甲.骨.get("auditEvents")!.v as AuditEvent[])
  .filter((e) => e.kind === "lambda" && (e.data as { key: string }).key === "sessionReport").length;

console.log(`  after heat=9:  pattern=${after.value.pattern}, intensity=${after.value.intensity.toFixed(2)}`);
console.log(`  sessionReport re-renders: ${renderEventsAfter - renderEventsBefore} (without 紋 comparator: ≥1)`);

// ============================================================================
// Read the ancestors catalog — separate signed segment, untouched by all of
// the above.
// ============================================================================
console.log(banner("Ancestors catalog (signed segment)"));
console.log(甲.貞!.察("ancestorReport"));

// ============================================================================
// Devtools peek: the audit log. Every divination is recorded.
// ============================================================================
console.log(banner("Audit log — last 5 events"));
const events = (甲.骨.get("auditEvents")!.v ?? []) as AuditEvent[];
const recent = events.slice(-5);
for (const e of recent) {
  const data = JSON.stringify(e.data);
  console.log(`  [${e.kind}] ${data.length > 80 ? data.slice(0, 77) + "…" : data}`);
}

console.log(`\n  apprentice tally (inline 觀): ${cyclesObserved} non-empty cycles fired`);

// ============================================================================
// Devtools peek: the change-indices default segment.
// ============================================================================
console.log(banner("Change-indices snapshot (post-cycle)"));
const ci = 甲.骨.get("changeIndices")!.v;
console.log(JSON.stringify(ci, null, 2));

// ============================================================================
// 印鑑 — the seal of this rite. A deterministic identifier over engine
// version + 體 (kinds) + 觀 (hook subscribers) + segments + 紋 (tags).
// ============================================================================
console.log(banner("印鑑 — the seal of this rite"));
const 印 = await 甲.印鑑();
const components = 甲.印鑑分解();
console.log(`  印鑑:      ${印.slice(0, 32)}…`);
console.log(`  engine:    ${components.engineVersion}`);
console.log(`  體 (kinds):  [${components.kinds.join(", ")}]`);
console.log(`  觀 (hooks):  [${components.hooks.join(", ")}]`);
console.log(`  segments:  [${components.segments.map((s) => `${s.key}(${s.role ?? "?"})`).join(", ")}]`);
console.log(`  紋 (tags):   [${components.tags.join(", ")}]`);

// Sanity check — expose engine identity through the more general API too.
const fpComponents = fingerprintComponents(甲.__state);
console.log(`  via __state.fingerprintComponents: kinds=[${fpComponents.kinds.join(", ")}]`);

// ============================================================================
// 焚 — burn the session plastron's bones; release tagged values via the
// crack tag's release hook. Ancestors and rules survive.
// ============================================================================
console.log(banner("焚 — burn the session plastron"));
甲.焚("session");
const remainingSegments = new Set(
  Array.from(甲.骨.values()).map((c) => c.segment).filter(Boolean),
);
console.log(`  segments still loaded: ${[...remainingSegments].sort().join(", ")}`);

// ============================================================================
// The ancestors scroll still renders.
// ============================================================================
console.log(banner("Ancestors after 焚"));
console.log(甲.貞!.察("ancestorReport"));

console.log("\n龜卜 complete.\n");
