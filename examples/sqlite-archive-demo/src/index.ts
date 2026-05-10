// ============================================================================
// sqlite-archive-demo — round-trip a plastron State through SQLite.
//
// Walks the full v1 surface of plastron-sqlite using the better-sqlite3
// backend in Node:
//
//   1. openSqlite (defaults to ":memory:" or SQLITE_FILE if set)
//   2. ensureSchema           — creates plastron_archives table
//   3. runMigrations          — applies a 2-cel migrations segment
//                               (creates an articles table)
//   4. saveArchive            — persist a tiny State as a .甲 blob
//   5. listArchives           — show the row with metadata + timestamps
//   6. loadArchive + hydrate  — verify the segments survived round-trip
//   7. saveArchive again      — history preserved (xit commit chain)
//   8. runMigrations re-run   — verify "applied" → "skipped"
//   9. deleteArchive          — clean up
//
// Run with `:memory:` (default):
//   npm run start
//
// Run against a file (persists across invocations):
//   SQLITE_FILE=/tmp/plastron-demo.sqlite npm run start
// ============================================================================

import {
  createInitialState,
} from "../../../plastron/src/index.js";
import type { Fn, Segment, State } from "../../../plastron/src/index.js";

const PATH = process.env.SQLITE_FILE ?? ":memory:";

// Heavy imports (sqlite + plastron-archive transitive xit-wasm) are
// inside `main` so a doc-only run on an env without those deps still
// shows the API shape without crashing at module load.
const main = async (): Promise<void> => {
  console.log(`[sqlite-archive-demo] opening sqlite at ${PATH}\n`);

  const {
    openSqlite,
    ensureSchema,
    saveArchive,
    loadArchive,
    listArchives,
    deleteArchive,
    runMigrations,
  } = await import("../../../segments/plastron-sqlite/src/index.js");

  // Pre-load better-sqlite3 in the host so the package finds it via
  // the host's node_modules. Required because dynamic imports resolve
  // relative to the importing file — and plastron-sqlite (a peer-dep
  // consumer) doesn't carry better-sqlite3 in its own node_modules.
  const betterSqlite = await import("better-sqlite3");
  const db = await openSqlite({
    path: PATH,
    backend: { kind: "better-sqlite3", module: betterSqlite },
  });

  // ── 2. ensureSchema ───────────────────────────────────────────────────
  await ensureSchema(db);
  console.log("✓ ensureSchema — plastron_archives table ready");

  // ── 3. runMigrations ──────────────────────────────────────────────────
  const migrations: Segment = {
    key: "migrations",
    cels: [
      {
        key: "001_articles",
        v: `CREATE TABLE IF NOT EXISTS articles (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              slug        TEXT UNIQUE NOT NULL,
              title       TEXT NOT NULL,
              created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )`,
        segment: "migrations",
      },
      {
        key: "002_articles_index",
        v: "CREATE INDEX IF NOT EXISTS articles_slug ON articles(slug)",
        segment: "migrations",
      },
    ],
  };

  const migResult = await runMigrations(db, migrations);
  console.log(`✓ runMigrations — applied ${JSON.stringify(migResult.applied)}, ` +
              `skipped ${JSON.stringify(migResult.skipped)}, drift ${migResult.drift.length}`);

  // ── 4. saveArchive ────────────────────────────────────────────────────
  const state = buildDemoState();
  await saveArchive(db, "demo-project", state, { kind: "demo", version: 1 }, {
    message: "initial save",
    author: "demo <demo@example.com>",
  });
  console.log("✓ saveArchive — wrote demo-project");

  // ── 5. listArchives ───────────────────────────────────────────────────
  let listing = await listArchives(db);
  console.log(`✓ listArchives — ${listing.length} row(s):`);
  for (const row of listing) {
    console.log(`    ${row.key} (created ${row.createdAt}; metadata=${JSON.stringify(row.metadata)})`);
  }

  // ── 6. loadArchive + hydrate ─────────────────────────────────────────
  const loaded = await loadArchive(db, "demo-project");
  if (!loaded) throw new Error("expected demo-project to exist");
  const state2 = createInitialState();
  state2.fns.get("hydrate")!(state2, loaded.segments, []);
  await (state2.fns.get("runCycle") as Fn)(state2);
  const total = (state2.fns.get("get") as Fn)(state2, "total");
  console.log(`✓ loadArchive — round-trip ok, get(total) = ${total}`);

  // ── 7. saveArchive again (history-preserving) ────────────────────────
  await (state2.fns.get("set") as Fn)(state2, "qty", 7);
  await saveArchive(db, "demo-project", state2, undefined, {
    message: "qty: 3 → 7",
  });
  console.log(`✓ saveArchive (update) — preserved metadata + xit history`);

  listing = await listArchives(db);
  console.log(`    after update: metadata=${JSON.stringify(listing[0]?.metadata)}  (preserved by COALESCE)`);

  // ── 8. runMigrations re-run ───────────────────────────────────────────
  const migResult2 = await runMigrations(db, migrations);
  console.log(`✓ runMigrations re-run — applied ${migResult2.applied.length}, ` +
              `skipped ${migResult2.skipped.length}, drift ${migResult2.drift.length}`);

  // ── 9. deleteArchive ──────────────────────────────────────────────────
  const removed = await deleteArchive(db, "demo-project");
  console.log(`✓ deleteArchive — removed=${removed}`);

  await db.close();
  console.log("\n[sqlite-archive-demo] done.");
};

const buildDemoState = (): State => {
  const state = createInitialState();
  const seg: Segment = {
    key: "demo",
    cels: [
      { key: "price", v: 100, segment: "demo" },
      { key: "qty",   v: 3,   segment: "demo" },
      {
        key: "total",
        l: "f",
        f: "(* price qty)",
        inputMap: { price: "price", qty: "qty" },
        segment: "demo",
      },
    ],
  };
  state.fns.get("hydrate")!(state, [seg], []);
  return state;
};

main().catch((e: unknown) => {
  console.error("[sqlite-archive-demo] failed:", (e as Error).message);
  process.exitCode = 1;
});
