import type { 甲骨, Cel, DehydratedCel, Fn, Key, State } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { putRaw, readIndex } from "./segment-store.js";
import { deflateCel } from "../kernel/lifecycle/dehydrate/index.js";
import seed from "./opfs-seeding.json" with { type: "json" };

// ============================================================================
// opfs-seeding — chunk C. Populate the segment-store (plastron/ under the
// file-store root) from the in-memory boot segments — the kernel closure —
// so downstream chunks (session-segments, optional-segment-loading,
// cli-segment-export) have a store to read from.
//
// Design: docs/1-design/2-in-evaluation/opfs-seeding.md
//
// DEVIATION FROM THE DESIGN (documented in 4-current): the design has
// createInitialState schedule the seed via queueMicrotask on every boot.
// That would make every one of the ~280 in-memory States the test suite
// creates — and every transient State that never persists — write to
// disk, racing and polluting. So v1 ships `seedStore` as an explicit
// host-called op (like hydrate): the browser/CLI app calls it once after
// boot; tests and throwaway States never touch disk. Auto-fire-on-boot
// can be a thin host wrapper later.
//
// ALSO DEFERRED: "boot reads kernel from OPFS instead of the bundle." v1's
// in-memory boot stays bundle-driven (createInitialState, unchanged); the
// store is the persistence + lookup surface, not the hydrate source for
// the kernel itself. seedStore writes; nothing yet reads the kernel back
// from the store at boot.
// ============================================================================

interface SeedResult { seeded: Key[]; skipped: Key[]; }

const seedStore: Fn = async (stateArg: unknown): Promise<SeedResult> => {
  const state = stateArg as State;

  const backend = state.cels.get("file-store.backend")?.v;
  if (backend === "none" || backend === undefined) {
    throw new Error("opfs-seeding: no file-store backend available — cannot seed.");
  }

  // Group every loaded cel by its segment, deflated to its dehydrated
  // shape. Unlike dehydrate's groupCelsBySegment this does NOT exclude the
  // kernel closure — seeding's whole job is to write it.
  const celsBySegment = new Map<Key, DehydratedCel[]>();
  for (const cel of state.cels.values()) {
    const seg = cel.metadata.segment;
    if (!seg) continue;
    let bucket = celsBySegment.get(seg);
    if (!bucket) { bucket = []; celsBySegment.set(seg, bucket); }
    bucket.push(deflateCel(cel, state));
  }

  const idx = await readIndex();
  const seeded: Key[] = [];
  const skipped: Key[] = [];

  for (const [name, manifest] of state.segments) {
    const version = manifest.version;
    const entry = idx.segments[name];
    if (entry && entry.versions.includes(version)) {
      // Already stored at this exact version — idempotent skip.
      skipped.push(name);
      continue;
    }
    const cels = celsBySegment.get(name) ?? [];
    const 甲骨rec: 甲骨 = { name, cels };
    // putRaw (not put): seeding legitimately writes role:kernel segments.
    await putRaw(name, version, manifest, 甲骨rec);
    seeded.push(name);
  }

  return { seeded, skipped };
};

export const name = "opfs-seeding" as const;

export const cels: Cel[] = bindNativeFns(
  seed as unknown as 甲骨,
  new Map<string, Fn>([["seedStore", seedStore]]),
);
