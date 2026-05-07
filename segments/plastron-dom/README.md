# `plastron-dom`

A reactive-DOM segment for plastron. Three pieces:

1. **`vnodeSchema` + isChanged + diff fns** — registered into
   `state.schemas` / `state.schemaMetadata` / `state.fns` by
   `installDom`. The kernel auto-wires `cel._isChanged` and
   `cel._diffFn` onto every cel declaring this schema, so structurally
   identical re-renders are suppressed at the cel-graph level.
2. **VNode builders** (`el`, `text`) — composed inside user-written
   render lambdas. The lambda's output is a VNode held directly as the
   cel's `v`.
3. **Patch cel + rAF-batched painter** — installDom adds one patch cel
   per root, downstream of the user's tree cel. Its `v` is a JSON-shape
   `Patch` describing what would change; the painter consumes it at
   rAF time and applies via DOM mutations. The diff lives in the graph
   (inspectable, snapshottable) and the apply lives outside it (where
   side effects belong).

```
<user tree cel>  ──→  __plastronDom:patch:<rootKey>  ──→  painter (rAF)
     wave 0                       wave 1
                                  v: Patch
```

## Usage

```ts
import { createInitialState } from "plastron";
import { installDom, el } from "plastron-dom";

const state = createInitialState();
const hydrate = state.fns.get("hydrate")!;
const runCycle = state.fns.get("runCycle")!;

hydrate(state, [{
  key: "app",
  cels: [
    { key: "count",     v: 0 },
    { key: "increment", v: 0, dynamic: true },
    { key: "bump",      l: "incOnEvent", inputMap: { count: "count", trigger: "increment" } },
    { key: "appTree",   l: "renderApp",  inputMap: { count: "count" } },
  ],
}], [new Map([
  ["renderApp",  ({ count }) =>
    el("div", { class: "app", style: { padding: "8px" } },
      el("p", null, `count: ${count}`),
      el("button", { onClick: { set: "increment" } }, "+1"),
    )],
  ["incOnEvent", ({ count, trigger }) => count + (trigger ? 1 : 0)],
])]);

await runCycle(state);

const handle = installDom(state, {
  roots: { app: { selector: "#root", cel: "appTree" } },
});

// Inspect the latest patch about to be applied:
state.cels.get(handle.patchCels.app).v;
//   { kind: "el", children: [{ op: "patch", index: 0, patch: { ... } }] }

// To tear down: state.fns.get("flush")(state, "plastronDom")
// — removes patch cels, fires the painter sentinel cel's _dispose
// (cancels rAF, detaches listeners), re-runs precompute.
```

## VNode shape

```ts
type VNode = VText | VElement;

interface VText { type: "text"; text: string }

interface VElement {
  type: "el";
  tag: string;
  attrs?:    Record<string, AttrValue>;
  style?:    Record<string, AttrValue>;     // diffed per-property
  events?:   Record<string, EventBinding>;
  children?: VNode[];
}
```

JSON-shape end-to-end — VNodes round-trip through hydrate / dehydrate
and `plastron-archive` without a custom serialize hook.

### `el(tag, props?, ...children)`

Props starting with `on` (e.g. `onClick`, `onInput`) become event
bindings. A `style` prop holding an object becomes the inline style
record. Everything else is an attribute.

```ts
el("input", {
  type: "text",
  value: name,
  style: { color: "var(--ink)", "font-family": "monospace" },
  onInput: { set: "name" },
})
```

### Event bindings

```ts
events: { click: { set: "celKey", value?: unknown } }
```

The painter calls `state.fns.get("set")(state, binding.set, value)`. If
`value` is omitted, the painter writes `{ type, value?, checked? }`
carrying the event type and (for form fields) the target's `value` /
`checked`.

## Patch ops

The patch cel's value is one of:

```ts
type Patch =
  | { kind: "noop" }                               // structurally equal
  | { kind: "init"; node: VNode }                  // first paint
  | { kind: "replace"; node: VNode }               // type / tag mismatch
  | { kind: "text"; text: string }                 // text-only update
  | {
      kind: "el";
      attrs?:    { set?: ...; remove?: string[] };
      style?:    { set?: ...; remove?: string[] };
      events?:   { upsert?: ...; remove?: string[] };
      children?: ChildPatch[];
    };

type ChildPatch =
  | { op: "patch"; index: number; patch: Patch }
  | { op: "appendMany"; nodes: VNode[] }
  | { op: "trim"; count: number };
```

The diff is positional, not keyed. If you need keyed list reconciliation
for big dynamic lists, that's a future change to `diff.ts` driven off a
`key?: string` on `VElement`.

The patch fn's closure tracks `lastApplied` — the tree the painter most
recently committed to the DOM. Each cycle's diff is computed from
`lastApplied` to the latest tree, so multiple cycles between rAF ticks
collapse cleanly: the most recent patch supersedes the previous one
rather than queueing.

## CSS

Today:

- `class` and any HTML attribute via `attrs`.
- Inline `style` as a record, diffed per property.
- Stylesheets and design-token cels are not yet implemented but fit
  naturally as future segments — a stylesheet cel with `tag: "stylesheet"`
  whose `v` is raw CSS text could mount a `<style>` element; theme cels
  could write CSS custom properties onto `:root`.

## Why a segment, not in core

Plastron core is environment-agnostic — `document` and
`requestAnimationFrame` only exist in the browser. The painter no-ops
the DOM mutation step off-browser but still advances `lastApplied`, so
patch cels produce meaningful incremental diffs in tests / SSR.
