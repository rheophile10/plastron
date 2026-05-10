import { useEffect, useState } from "react";
import type { Fn, State } from "../../../../plastron/src/index.js";

// Newsletter preview: read the article's "view" cel (an MJML source
// string), compile to HTML via the mjml-browser variant, drop into
// an iframe srcDoc so email styles are isolated from the editor chrome.
//
// We compile in the React layer rather than in plastron-mjml because
// the segment package was designed Node-first. A future v2 pass could
// register a "mjml" compiler in the article state itself and have
// plastron-sheet expose the compiled HTML as a downstream cel.
//
// The dependency on mjml-browser is host-side (this example's
// package.json). Falls back to a doc string if mjml-browser isn't
// installed yet.

export const NewsletterPreview = ({ state, viewCel }: {
  state: State;
  viewCel: string;
}): React.ReactElement => {
  const [html, setHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Re-read the source whenever runCycle has plausibly fired. We
  // poll on a microtask interval — coarse but sufficient for v1.
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    let alive = true;
    void tick;
    (async () => {
      const getFn = state.fns.get("get") as Fn;
      const source = getFn(state, viewCel);
      if (typeof source !== "string") {
        if (alive) setHtml("<i>view cel did not produce a string</i>");
        return;
      }
      try {
        // Dynamic import — mjml-browser may not be installed in the
        // host. If absent, surface a clear message instead of crashing.
        const mod = await import(/* @vite-ignore */ "mjml-browser").catch(() => null);
        if (!mod) {
          if (alive) {
            setHtml(
              `<pre style="white-space:pre-wrap">${escapeHtml(source)}</pre>` +
              `<p><i>install <code>mjml-browser</code> to render this preview.</i></p>`,
            );
          }
          return;
        }
        const mjml2html = (mod as { default: (s: string) => { html: string; errors: unknown[] } })
          .default;
        const result = mjml2html(source);
        if (alive) {
          setHtml(result.html);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [state, viewCel, tick]);

  if (error) {
    return <div className="preview-error">MJML error: {error}</div>;
  }

  return (
    <iframe
      title="newsletter-preview"
      sandbox="allow-same-origin"
      srcDoc={html}
      style={{ width: "100%", height: "100%", border: 0 }}
    />
  );
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
