import type { Segment } from "../../../../plastron/src/index.js";

// Boilerplate for a new "newsletter" article. Same content cels as a
// page, but the "view" cel runs a render lambda producing an MJML
// source string. The host wires this through plastron-mjml's compiler
// (registered under "mjml") so the rendered HTML is what the preview
// pane consumes.
//
// For v1: the article's "view" lambda produces MJML source directly.
// A more honest pipeline would have:
//   view -> mjml-source (lambda)  -> compiled (l: "mjml", f: <source>)
// but that requires a two-cel chain. Inline for simplicity.
export const buildNewNewsletterSegment = (subject = "Untitled newsletter"): Segment => ({
  key: "article",
  cels: [
    { key: "subject",  v: subject,                          segment: "article" },
    { key: "preview",  v: "Short preview text",             segment: "article" },
    { key: "body",     v: "Hello from your newsletter.",    segment: "article" },
    // "view" produces MJML source. The host's renderer for newsletters
    // reads this string, compiles it via mjml at preview time, and
    // pipes the resulting HTML into an iframe srcDoc.
    {
      key: "view",
      l: "renderNewsletter",
      inputMap: { subject: "subject", preview: "preview", body: "body" },
      segment: "article",
    },
  ],
});
