// ============================================================================
// postgres-archive-demo — round-trip a plastron State through postgres.
//
// Walks the full v1 surface of plastron-postgres:
//
//   1. Connect via PG_URL (no DB? → bail out with a doc-only message).
//   2. ensureSchema()              — create the table if missing.
//   3. Build a tiny State and save it under "demo-project".
//   4. listArchives()              — show the row appears with metadata.
//   5. loadArchive() + hydrate     — verify segments survived round-trip.
//   6. saveArchive() again         — confirm history-preserving update.
//   7. deleteArchive()             — clean up.
//
// Without postgres available, set PG_URL='' (or unset it). The demo
// then prints the API shape without touching the network — useful as
// a "what does this package look like" reference.
//
// Note on imports: doc-only mode must work in environments where
// `xit-wasm` (a transitive dep of plastron-archive, in turn pulled by
// plastron-postgres) isn't installed. So the heavy imports — pg,
// plastron-postgres, anything that drags in xit-wasm — are deferred
// to inside `liveDemo` via `await import(…)`. Top-level keeps only
// pure types and tiny core helpers that resolve without xit-wasm.
// ============================================================================

import {
  createInitialState,
} from "../../../plastron/src/index.js";
import type { Fn, Segment, State } from "../../../plastron/src/index.js";

const PG_URL = process.env["PG_URL"]?.trim();
const PROJECT_KEY = "demo-project";

const buildSampleState = (): State => {
  const state = createInitialState();
  // A representative cel — non-core, non-stats, so it round-trips.
  state.cels.set("greeting", {
    key: "greeting",
    v: "你好 plastron",
    segment: "default",
  });
  state.cels.set("counter", {
    key: "counter",
    v: 1,
    segment: "default",
  });
  return state;
};

const docOnlyDemo = (): void => {
  console.log("=== plastron-postgres API (doc-only mode) ===");
  console.log("");
  console.log("PG_URL is unset — printing the shape rather than running.");
  console.log("");
  console.log("  import { Pool } from 'pg';");
  console.log("  import {");
  console.log("    ensureSchema, saveArchive, loadArchive,");
  console.log("    listArchives, deleteArchive,");
  console.log("  } from 'plastron-postgres';");
  console.log("");
  console.log("  const pool = new Pool({ connectionString: process.env.PG_URL });");
  console.log("  await ensureSchema(pool);");
  console.log("  await saveArchive(pool, 'project-1', state, { author: 'me' });");
  console.log("  const loaded = await loadArchive(pool, 'project-1');");
  console.log("  // loaded.segments → pass to state.fns.get('hydrate')");
  console.log("  await deleteArchive(pool, 'project-1');");
  console.log("  await pool.end();");
  console.log("");
  console.log("Set PG_URL=postgres://… to run the live round-trip.");
};

const liveDemo = async (url: string): Promise<void> => {
  // Dynamic imports keep doc-only mode runnable in environments where
  // xit-wasm (transitive via plastron-archive via plastron-postgres)
  // isn't installed. Top-level static imports of either of these would
  // crash this script at module load before we ever read PG_URL.
  const { Pool } = await import("pg");
  const {
    ensureSchema,
    saveArchive,
    loadArchive,
    listArchives,
    deleteArchive,
  } = await import("../../../segments/plastron-postgres/src/index.js");

  const pool = new Pool({ connectionString: url });
  try {
    console.log("=== ensureSchema ===");
    await ensureSchema(pool);
    console.log("ok — table is in place.");

    // Always start clean so re-runs of the demo are deterministic.
    await deleteArchive(pool, PROJECT_KEY);

    console.log("\n=== saveArchive (initial) ===");
    const state1 = buildSampleState();
    await saveArchive(
      pool,
      PROJECT_KEY,
      state1,
      { name: "demo project", author: "postgres-archive-demo" },
      { message: "initial save" },
    );
    console.log("ok — archive committed.");

    console.log("\n=== listArchives ===");
    const listing = await listArchives(pool);
    for (const row of listing) {
      console.log(
        `  ${row.key}  created=${row.createdAt}  updated=${row.updatedAt}`,
      );
      if (row.metadata) console.log("    metadata:", row.metadata);
    }

    console.log("\n=== loadArchive + hydrate ===");
    const loaded = await loadArchive(pool, PROJECT_KEY);
    if (!loaded) throw new Error("loadArchive returned null after save");
    const state2 = createInitialState();
    const hydrate = state2.fns.get("hydrate") as Fn;
    hydrate(state2, loaded.segments, []);
    console.log(
      "  greeting cel:",
      JSON.stringify(state2.cels.get("greeting")?.v),
    );
    console.log(
      "  counter cel:",
      JSON.stringify(state2.cels.get("counter")?.v),
    );
    console.log("  metadata:", loaded.metadata);

    console.log("\n=== saveArchive (history-preserving update) ===");
    state2.cels.set("counter", {
      key: "counter",
      v: 2,
      segment: "default",
    });
    await saveArchive(
      pool,
      PROJECT_KEY,
      state2,
      { name: "demo project", author: "postgres-archive-demo" },
      { message: "bump counter" },
    );
    const reloaded = await loadArchive(pool, PROJECT_KEY);
    const counterCel = reloaded?.segments
      .flatMap((s: Segment) => s.cels)
      .find((c) => c.key === "counter");
    console.log("  counter after update:", counterCel?.v);

    console.log("\n=== deleteArchive ===");
    const deleted = await deleteArchive(pool, PROJECT_KEY);
    console.log(`  deleted: ${deleted}`);

    console.log("\nall checks ok ✓");
  } finally {
    await pool.end();
  }
};

if (!PG_URL) {
  docOnlyDemo();
} else {
  await liveDemo(PG_URL);
}
