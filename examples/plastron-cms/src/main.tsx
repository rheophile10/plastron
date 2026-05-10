import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./shell.js";
import { openCmsDb } from "./db/open.js";
import type { SqliteHandle } from "../../../segments/plastron-sqlite/src/index.js";

// Boot order:
//   1. Open SQLite (OPFS-backed in browser; falls back to in-memory)
//   2. Run migrations (creates articles table on first boot)
//   3. Mount React shell with the db handle
//
// We put DB open inside a useEffect so React strict mode's double-mount
// in dev doesn't fight with WASM loading. The handle resolves once and
// is shared with the rest of the app via prop drill.

const Boot = (): React.ReactElement => {
  const [db, setDb] = useState<SqliteHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let openedDb: SqliteHandle | null = null;
    (async () => {
      try {
        const d = await openCmsDb();
        if (!alive) {
          await d.close();
          return;
        }
        openedDb = d;
        setDb(d);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
      // Strict-mode unmount: close any DB we managed to open before
      // the second mount picks up. The cleanup runs synchronously so
      // we can't await; fire-and-forget is fine for SQLite.
      if (openedDb) void openedDb.close();
    };
  }, []);

  if (error) {
    return (
      <div className="boot-error">
        <h1>plastron-cms failed to start</h1>
        <pre>{error}</pre>
      </div>
    );
  }
  if (!db) {
    return <div className="boot-loading">Loading database…</div>;
  }
  return <Shell db={db} />;
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
