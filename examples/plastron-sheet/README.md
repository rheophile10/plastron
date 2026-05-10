# plastron-sheet

A spreadsheet client built on plastron. Every visible cell is one
plastron cel keyed by its address (`A1`, `B7`, …); Excel-style infix
formulas plug into the kernel's swappable formula slot. There is no
separate spreadsheet engine — the kernel runs the cascade.

## Run

```sh
cd examples/plastron-sheet
npm install
npm run dev   # http://localhost:5174
```

Or from VS Code: pick **Plastron Sheet (Vite + Chrome)** from the Run
menu.

## How it maps onto plastron

```
Spreadsheet                  Plastron
───────────                  ────────
visible cell at A1           cel { key: "A1", v: <value> }
formula in D2 = "=B2*C2"     cel { key: "D2", f: "B2*C2" }
                             → kernel auto-compiles _fn at hydrate
                             → kernel auto-wires inputMap from refs
recalculate                  state.fns.get("runCycle")(state)
edit a cell                  hydrate state with the new dehydrated cel
                             (overwrites the old; precompute reruns)
selection anchor             "__sheet:selected"      primitive cel
selection extent             "__sheet:selectionEnd"  primitive cel
in-place edit mode           "__sheet:editing"       primitive cel
formula bar text source      "__sheet:sources"       Record<addr,string>
```

The Excel-style infix parser (`=A1+B1*2`, `=(D7+D8)*0.1`) lives in
the [`plastron-sheet` segment](../../segments/plastron-sheet/) at
`src/formula.ts`. `installSheet` registers it into `state.fns.get("f")` —
plastron's kernel picks any `f:` cel up via this fn at hydrate time,
calls it on the source string, and stores the resulting `Fn` on
`cel._fn`. The default kernel ships an S-expression compiler in this
slot; the segment swaps it during install.

This example is now a thin shell: it constructs state, calls
`installSheet(state)` (which hydrates the sheet's cels, lambdas, and
document-level bridges), then mounts the sheet's tree cel via
`installDom`. See `src/main.ts` — the whole bootstrap is under twenty
lines.

## Edit commit pipeline

Every cell commit (typed edit, double-click edit, formula bar, paste)
flows through the same three steps:

1. classify `event.target.value` — `"=…"` → formula, parses-as-number
   → number, else string.
2. `hydrate(state, [{ key: "sheet", cels: [newDc] }], [])` —
   overwrites the prior cel completely; recompiles `_fn` if there's a
   new formula; re-runs `precompute` so the dependency graph picks up
   any new refs.
3. `runCycle(state)` — propagates the new value through every
   dependent cell.

`__sheet:editSeed` is the glue that distinguishes type-to-edit from
double-click: the render lambda uses it as the input's initial value
if non-empty, falling back to the cell's existing content otherwise.
It's cleared on commit / cancel.

The keyboard- and mouse-driven move-selection paths both flow through
one fn, `sheet:moveSelection`, registered in the kernel — same
handler is reachable from the document keydown listener and from the
cell editor.

## Formula bar / name box

The toolbar at the top is fed by three cels:

- `__sheet:selected` (address string) → name box
- `__sheet:sources`  (`{ addr → source }`) → formula bar shows
  `=<source>` for the active cell if it has a formula, otherwise the
  cell's value
- the active cell's value (read by key from inputs) → formula bar
  fallback

Sources are stored without their leading `=`; the formula bar adds it
back at display.

A small change to plastron-dom's `apply.ts` makes the controlled
formula bar behave correctly: writes to the `value` attribute on
`<input>` / `<textarea>` elements also write the IDL property. Without
that mirror, `setAttribute("value", …)` stops refreshing the
displayed value once the user has interacted with the input —
standard form-element gotcha.

## Marquee

The copy-marquee (border around the source range after Cmd-C) is a
single `<div class="copy-marquee">` rendered in the graph with
`data-start` / `data-end` attributes, then sized imperatively in
the segment's `bridges/marquee.ts` from the actual cell
`getBoundingClientRect` values via a `MutationObserver`.
Cell-relative measurement avoids hardcoding
pixel widths that browsers don't honor when `table-layout: fixed`
interacts with surrounding flex constraints.

## Pre-loaded sheet

Loads with a small expense ledger so the demo is immediately
demonstrative:

| | A | B | C | D |
|---|---|---|---|---|
| 1 | Item       | Qty | Price | Total |
| 2 | Bone, ox   | 12  | 4     | `=B2*C2` |
| 3 | Plastron   | 3   | 17    | `=B3*C3` |
| 4 | Charcoal   | 30  | 0.5   | `=B4*C4` |
| 5 | Bronze pin | 8   | 2.25  | `=B5*C5` |
| 7 | Subtotal   |     |       | `=D2+D3+D4+D5` |
| 8 | Tax (10%)  |     |       | `=D7*0.1` |
| 9 | Grand total|     |       | `=D7+D8` |

Edit `B4` to `60` and watch `D4`, `D7`, `D8`, `D9` all update at once
through the cascade.

## Devtools

`window.__plastronState` is exposed for poking:

```js
__plastronState.cels.get("D9").v          // 145.20
__plastronState.cels.get("D9").f          // "D7+D8"
__plastronState.cels.get("D9").inputMap   // { D7: "D7", D8: "D8" }
__plastronState.cels.get("D9")._diff      // last patch the kernel produced
__plastronState.cels.get("__plastronDom:patch:app").v
```

## What's not yet here

- **Functions** like `SUM(A1:A5)`, `IF(...)`, `AVERAGE()` — would be
  additions to the formula parser plus runtime helpers exposed to it.
- **Range references** (`A1:A5`) — same.
- **Relative-reference adjustment on paste** — when a formula is
  pasted at a different position, Excel rewrites cell refs in the
  formula source. We paste literally; a real implementation would
  walk the parsed AST and shift refs by the column/row delta.
- **Save / load** via plastron-archive — the sheet segment is already
  fully JSON-shape (formulas as text, no closures), so dehydrate +
  archive would round-trip; just isn't wired to a button yet.
