# `plastron-mjml`

An MJML compiler segment for plastron. Cels declare `cel.l = "mjml"`
and ship MJML source in `cel.f`. The compiler at
`state.fns.get("mjml")` turns the source into a runtime fn that, when
the cel fires, substitutes the cel's resolved inputs into `{{name}}`
placeholders and runs `mjml2html` — yielding the produced HTML string
as the cel's `v`.

## Node-only

`mjml`'s dependency tree (`cheerio`, `juice`, `htmlnano`,
`detect-node`, …) is Node-shaped. This segment is therefore Node-only
in v1; `package.json` declares `"engines": { "node": ">=18" }`. A
browser variant — running `mjml` pre-bundled, or a thinner MJML→HTML
reimplementation — is a follow-up.

## Usage

```ts
import type { Fn, Segment } from "plastron";
import { createInitialState } from "plastron";
import { installMjml } from "plastron-mjml";

const state = createInitialState();
installMjml(state);

const segment: Segment = {
  key: "email",
  cels: [
    { key: "headline", v: "Reactive emails", segment: "email" },
    { key: "name",     v: "Ada",             segment: "email" },
    {
      key: "rendered",
      segment: "email",
      l: "mjml",
      f: `
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
      `,
      // {{name}} → resolved input value (HTML-escaped) at fire time.
      inputMap: { headline: "headline", name: "name" },
    },
  ],
};

const hydrate  = state.fns.get("hydrate")  as Fn;
const runCycle = state.fns.get("runCycle") as Fn;

hydrate(state, [segment], [new Map()]);
await runCycle(state);

const html = state.cels.get("rendered")?.v as string;
```

`runCycle` returns a Promise — `mjml2html` is async, so the `mjml` cel
yields `Promise<string>`. The kernel awaits cels that return Promises,
so this just looks like a slow cel to the host.

## Templating

`{{name}}` tokens (only identifier-shaped: `[A-Za-z_$][\w$]*`) are
substituted from the cel's resolved inputs. Values are coerced
(`String()` for primitives; `JSON.stringify` for richer shapes;
`""` for `null`/`undefined`) and then HTML-escaped before being
spliced into the source. Tokens whose names aren't in the inputs map
are left as-is, so a typo surfaces as a visible `{{whatever}}` in the
rendered email rather than a silent empty string.

## Inputs are explicit

Unlike formula cels, MJML cels don't auto-derive their dependencies —
the segment's compiler doesn't supply `extractDeps`. MJML source
references cels through `{{name}}` tokens, but those are templating
markers resolved at fire time, not declarative cel references the
kernel can analyse at compile time. So you write `inputMap`
explicitly, mapping each `{{name}}` token to the cel key whose value
should fill it.

## Swapping the compiler

`installMjml` registers the compiler at `state.fns.set("mjml", …)`
**unlocked** — matching the formula compiler convention at `"f"`.
Hosts that want a stricter validator, a pre-bundled browser build, or
an MJML-flavored DSL can register a different compiler at the same
key:

```ts
import { createMjmlCompiler } from "plastron-mjml";

// e.g. enable strict-mode validation:
const strictCompiler = createMjmlCompiler({
  mjmlOptions: { validationLevel: "strict" },
});
state.fns.set("mjml", strictCompiler);
```

Or supply a `lambdaKey` to `installMjml` to run multiple MJML
compilers in parallel under different keys (`"mjml-strict"`,
`"mjml-mobile"`, …).

`installMjml` will refuse to overwrite a host-locked entry at the
chosen `lambdaKey` — if some other code has already registered a
compiler at `"mjml"` and marked it `locked: true`, `installMjml`
throws.

## Teardown

```ts
state.fns.get("flush")(state, "plastron-mjml");
```

drops the manifest. The compiler stays in `state.fns` until something
overwrites or deletes it.
