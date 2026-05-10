// ============================================================================
// EXAMPLE — plastron-mjml from a terminal.
//
// Hydrates a tiny reactive graph whose lambda cel runs MJML through
// the plastron-mjml compiler. Demonstrates:
//
//   • plastron-mjml's compiler registered at state.fns.get("mjml")
//   • A content cel feeding into an MJML cel via cel.inputMap
//   • {{name}} templating: cel inputs substitute into the source
//     before mjml2html runs
//   • The rendered HTML logged to stdout, then a re-cycle after a
//     content change to show the cascade re-fires
//
// HOW TO RUN:
//   cd examples/mjml-demo && npm install && npm start
// ============================================================================

import type { Fn, Segment } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import { installMjml } from "../../../segments/plastron-mjml/src/index.js";

const state = createInitialState();
installMjml(state);

// MJML source with {{headline}} and {{name}} placeholders. The
// compiler substitutes these from the cel's inputMap before mjml2html
// converts to HTML.
const mjmlSource = `
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">{{headline}}</mj-text>
        <mj-text>Hello {{name}}, welcome to plastron-mjml.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
`.trim();

const segment: Segment = {
  key: "mjml-demo",
  cels: [
    { key: "headline", v: "Reactive emails",         segment: "mjml-demo" },
    { key: "name",     v: "Ada",                     segment: "mjml-demo" },
    {
      key: "rendered",
      segment: "mjml-demo",
      l: "mjml",
      f: mjmlSource,
      inputMap: { headline: "headline", name: "name" },
    },
  ],
};

const hydrate  = state.fns.get("hydrate")  as Fn;
const runCycle = state.fns.get("runCycle") as Fn;
const set      = state.fns.get("set")      as Fn;

hydrate(state, [segment], [new Map()]);
await runCycle(state);

const show = (label: string): void => {
  const html = state.cels.get("rendered")?.v as string | undefined;
  const len = html?.length ?? 0;
  // Show a head + tail snippet so the log stays readable. mjml output
  // is ~3-5KB even for trivial sources because of the boilerplate
  // <head>, inlined CSS resets, etc.
  const head = html?.slice(0, 120) ?? "";
  const tail = html?.slice(-120) ?? "";
  console.log(`\n${label}`);
  console.log(`  headline = ${state.cels.get("headline")?.v}`);
  console.log(`  name     = ${state.cels.get("name")?.v}`);
  console.log(`  html.len = ${len}`);
  console.log(`  html[0..120]   = ${head.replace(/\s+/g, " ")}`);
  console.log(`  html[-120..]   = ${tail.replace(/\s+/g, " ")}`);
};

show("first cycle");

await set(state, "name", "Grace");
show("after set(name=Grace)");

await set(state, "headline", "Cascading templates");
show("after set(headline=Cascading templates)");

console.log("\ndone.");
