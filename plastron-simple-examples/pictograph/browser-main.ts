// ============================================================================
// browser-main — boot entry for the single-file `index.html` deliverable,
// rebuilt on the plastron view layer.
//
// The DOM is no longer hand-assembled with document.createElement. The whole
// UI is ONE FormulaCel (`view`, parser: "html-template") whose source is an
// HTML template with {{…}} interpolations; it computes a render-spec
// ({ vnode, mount, listeners }) and is wired to the `plastron-dom.paint`
// channel. The painter (raf-channel) diffs the vnode tree to JSON patches
// and applies them to the DOM, attaching the inline event bindings as real
// listeners. Editing an input dispatches an action that `set`s a cel; the
// cascade recomputes the invoice formulas, the `view` cel re-renders, and
// the painter repaints the changed nodes — all declaratively.
//
// Still pure formula-domain (S-expression FormulaCels over `builtins` + the
// view layer's interpolation evaluator, which is interpreter-based — no
// `new Function`), so it boots CSP-safe off `file://` with no heavy runtimes.
// See 4-current/05-runCycle (htm-view-layers / event-registries / raf-channel)
// and 4-current/10-deployment/01-single-file-bundle.md.
// ============================================================================

import {
  createInitialState, precompute, precomputeOptional, resolveFn,
  createPainter, setPainter,
} from "../../plastron-simple/src/index.js";
import type { Fn } from "../../plastron-simple/src/index.js";

// ----- App segment: a reactive invoice, rendered by one view FormulaCel -----

const val = (key: string, v: unknown) => ({
  key, celType: "ValueCel" as const, metadata: { key, segment: "invoice" }, v,
});
const formula = (key: string, f: string) => ({
  key, celType: "FormulaCel" as const, metadata: { key, segment: "invoice", parser: "f" }, f,
});

// The UI as an HTML template. {{symbol}} in a text/attribute slot reads a cel
// value; {{(…)}} in an event slot (onInput/onClick) is captured verbatim as a
// binding the painter compiles lazily. The (dispatch "setNum" "<key>") action
// calls our registered fn with the raw DOM event so it can read target.value.
const TEMPLATE = `
<div>
  <h1>plastron — single-file reactive demo</h1>
  <p class="sub">Edit an input — the formula graph recomputes in-browser, no server.</p>
  <div class="inputs">
    <label>price
      <input type="number" step="any" data-key="price" value={{price}}
             onInput={{(dispatch "setNum" "price")}} /></label>
    <label>qty
      <input type="number" step="any" data-key="qty" value={{qty}}
             onInput={{(dispatch "setNum" "qty")}} /></label>
    <label>tax-rate
      <input type="number" step="any" data-key="tax-rate" value={{tax-rate}}
             onInput={{(dispatch "setNum" "tax-rate")}} /></label>
  </div>
  <table id="computed">
    <thead><tr><th>cel</th><th>value</th></tr></thead>
    <tbody>
      <tr><td>subtotal</td><td class="num">{{subtotal}}</td></tr>
      <tr><td>tax</td><td class="num">{{tax}}</td></tr>
      <tr><td>total</td><td class="num">{{total}}</td></tr>
    </tbody>
  </table>
</div>`;

const segments = [{
  name: "invoice",
  cels: [
    val("price", 3),
    val("qty", 4),
    val("tax-rate", 0.1),
    formula("subtotal", "(* price qty)"),
    formula("tax", "(* subtotal tax-rate)"),
    formula("total", "(+ subtotal tax)"),
    val("view.mount", "#app"),
    {
      key: "view", celType: "FormulaCel" as const,
      metadata: {
        key: "view", segment: "invoice", parser: "html-template",
        schema: "render-spec", channel: ["plastron-dom.paint"],
        // mount is a reserved input the parser reads; the value interpolations
        // (price/qty/tax-rate/subtotal/tax/total) auto-wire from the template.
        inputMap: { mount: "view.mount" },
      },
      f: TEMPLATE,
    },
  ],
}];
const manifests = [{
  name: "invoice", version: "0.2.0",
  description: "single-file bundling demo — a reactive invoice rendered by the view layer",
  dependencies: ["builtins", "html-template-parser", "plastron-dom"], role: "application",
}];

// ----- Boot -----

const state = createInitialState();
const hydrate   = resolveFn(state, "hydrate")   as Fn;
const runCycle  = resolveFn(state, "runCycle")  as Fn;
const register  = resolveFn(state, "registerLambda") as Fn;
const drain     = resolveFn(state, "drain")     as Fn;

// Input → cel write. dispatch hands us (state, key, event); read the field's
// numeric value and `set` it with flush:"all" so the paint channel drains and
// the painter repaints this frame.
await register(state, {
  key: "setNum",
  kind: "custom",
  fn: async (st: typeof state, key: string, event: { target?: { value?: string } }) => {
    const n = Number(event?.target?.value);
    if (!Number.isFinite(n)) return;
    const set = resolveFn(st, "set") as Fn;
    await set(st, key, n, { flush: "all" });
  },
});

await hydrate(state, segments, manifests);
precompute(state);
await precomputeOptional(state);

// Install the painter for this state (the paint channel's drain forwards
// render-specs to it). Host defaults: rAF + document in the browser; a no-op
// off-browser (headless import) where there is no DOM.
const painter = createPainter(state);
setPainter(state, painter);

await runCycle(state);                       // view fires → render-spec onto the paint channel
await drain(state, "plastron-dom.paint");    // channel → painter.enqueue
painter.drain();                             // force the initial paint synchronously

// ----- Test hook (see harness.test.ts) -----

if (typeof window !== "undefined") {
  (window as unknown as { __plastron?: unknown }).__plastron = {
    state,
    resolveFn: (key: string) => resolveFn(state, key),
  };
}

// Exported for a headless smoke check (importable without a DOM).
export { state };
