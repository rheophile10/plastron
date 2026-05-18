import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./shell.js";
import { openContentApi } from "./api/pglite-backend.js";
import type { ContentApi } from "./api/content-api.js";

// Boot: open the PGLite-backed content API, then mount the Shell with
// the API as the only persistence handle it sees. The Shell (and every
// component under it, including <PlastronCMS>) talks to this `api`
// object — never to PGLite directly. Swap pglite-backend for fetch()
// and the rest of the app is byte-identical.

const Boot = (): React.ReactElement => {
  const [api, setApi] = useState<ContentApi | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const a = await openContentApi();
        if (alive) setApi(a);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <div className="boot-error">
        <h1>plastron-cms failed to start</h1>
        <pre>{error}</pre>
      </div>
    );
  }
  if (!api) {
    return <div className="boot-loading">Loading database…</div>;
  }
  return <Shell api={api} />;
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
