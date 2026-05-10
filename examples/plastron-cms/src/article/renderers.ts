import type { Fn, LambdaKey, State } from "../../../../plastron/src/index.js";
import {
  el, text, type VNode,
} from "../../../../segments/plastron-dom/src/index.js";

// Render lambdas the article boilerplates reference by key. These are
// fixed in v1 — only the article's content cels are user-editable
// from the sheet. Letting authors mutate the render lambda itself
// requires the sheet to expose `f` editing for cels with `l: "..."`,
// which is a future product step.
//
// Naming convention: render lambdas live in state.fns under the keys
// the article boilerplates reference (renderPage, renderNewsletter).
// Both are registered when the host loads an article state.

const renderPage: Fn = ({ title, subtitle, body }: {
  title: string; subtitle: string; body: string;
}): VNode =>
  el("article", { class: "page-preview" },
    el("h1",   null, text(title)),
    subtitle ? el("p", { class: "subtitle" }, text(subtitle)) : (null as unknown as VNode),
    el("div", { class: "body" }, text(body)),
  );

const renderNewsletter: Fn = ({ subject, preview, body }: {
  subject: string; preview: string; body: string;
}): string => {
  // Naive MJML generation. Hand-written rather than templated to keep
  // the demo self-contained. A future iteration could move this into a
  // user-editable formula cel using the mjml compiler.
  const esc = (s: string) => s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<mjml>
  <mj-head>
    <mj-title>${esc(subject)}</mj-title>
    <mj-preview>${esc(preview)}</mj-preview>
  </mj-head>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text font-size="24px" font-weight="bold">${esc(subject)}</mj-text>
        <mj-text>${esc(body)}</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
};

export const ARTICLE_RENDERER_FNS = new Map<LambdaKey, Fn>([
  ["renderPage",       renderPage],
  ["renderNewsletter", renderNewsletter],
]);

// Article cels' render functions take pre-resolved scalars from
// inputMap; v1 doesn't filter NaN/undefined defensively. Wrap once
// here for any host-side direct invocation.
export const renderInto = (state: State, _viewCelKey: string): unknown => {
  // Convenience accessor — host code reads `view`.v after a cycle.
  const getFn = state.fns.get("get") as Fn;
  return getFn(state, _viewCelKey);
};
