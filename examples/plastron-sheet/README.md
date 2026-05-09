# plastron-sheet

A spreadsheet client built on plastron. Looks and feels like a small
ledger app: column letters, row numbers, click-to-select,
double-click-to-edit, formula bar at the top.

The "spreadsheet" is a thin UI sitting on top of the kernel — every
visible cell is one plastron cel keyed by its address (`A1`, `B7`, …),
and Excel-style formulas plug into the kernel's swappable formula
slot. There's no separate spreadsheet engine.

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

The Excel-style infix parser (`=A1+B1*2`, `=(D7+D8)*0.1`) is in
`src/formula.ts`. It's registered into `state.fns.get("f")` —
plastron's kernel picks any `f:` cel up via this fn at hydrate time,
calls it on the source string, and stores the resulting `Fn` on
`cel._fn`. The default kernel ships an S-expression compiler in this
slot; we replace it with one keystroke in `main.ts`:

```ts
hydrate(state, [], [new Map([["f", infixFormula]])]);
```

That's the whole story for "make plastron speak Excel."

## Selection

- **Click** a cell → anchor + extent collapse to that cell.
- **Drag** across cells (mousedown, hover, mouseup) → rectangular
  range. The anchor is where the drag started; the extent moves with
  the cursor. Releasing the mouse anywhere (in or out of the grid)
  ends the drag.
- **Shift-click** → keeps the anchor, moves the extent.

The name box at the top shows `A1` for a single cell and `A1:C5` for
a range. The formula bar always reflects the anchor cell.

## Keyboard navigation

When a cell is selected (and not in edit mode):

- **Enter** / **↓** — move down. Shift-Enter / **↑** moves up.
- **Tab** / **→** — move right. Shift-Tab / **←** moves left.
- The selection clamps at the grid edge (no wrap).

When the cell is being edited:

- **Enter** commits and advances down (shift-Enter goes up).
- **Tab** commits and advances right (shift-Tab goes left).
- **Escape** cancels the edit without committing.

Both paths flow through `sheet:moveSelection`, registered as a
kernel fn — the same handler is reachable from the document keydown
listener and from the cell editor's keydown.

## Clipboard

- **Cmd/Ctrl-C** → emits TSV (rows by `\n`, cols by `\t`) of the
  selected rectangle. Formula cells emit their *values*, not the
  formula source — Excel's default behavior.
- **Cmd/Ctrl-V** → pastes TSV at the anchor cell. Each entry is
  classified the same way as a typed edit: `=…` becomes a formula,
  numeric strings become numbers, everything else stays as strings.
  Out-of-grid entries are silently dropped. After paste, the
  selection extent grows to cover the pasted block.

The clipboard handlers live on `document` (in `main.ts`) because the
copy/paste events fire there when no input is focused; if a cell is
being edited, the input owns its own clipboard and we skip handling.

## Edit lifecycle

Three ways to edit a cell:

1. **Double-click** → opens the in-cell input seeded with the cell's
   current content (preserves what's there for tweaking).
2. **Type on a selected cell** → opens the in-cell input seeded with
   the keystroke (Excel-style "replace": typing clobbers the cell).
   A document-level keydown listener in `main.ts` watches for
   single-character keys with no modifiers and dispatches
   `sheet:typeIntoSelected`; once the patch has been applied, the
   listener focuses the new input and pins the cursor at the end.
3. **Click the formula bar and type** → the bar is a real `<input>`
   that always shows the active cell's content. Captures the
   currently-selected address on focus, commits to that address on
   Enter or blur (so clicking another cell mid-edit still commits to
   the original target). Escape skips the commit on the upcoming blur
   via a closure flag.

In every case, the commit pipeline is the same:

1. classify `event.target.value` — `"=…"` → formula, parses-as-number
   → number, else string.
2. `hydrate(state, [{ key: "sheet", cels: [newDc] }], [])` —
   overwrites the prior cel completely; recompiles `_fn` if there's a
   new formula; re-runs `precompute` so the dependency graph picks up
   any new refs.
3. `runCycle(state)` — propagates the new value through every
   dependent cell.

`__sheet:editSeed` is the bit of glue that makes type-to-edit work
distinctly from double-click: the render lambda uses it as the
input's initial value if non-empty, falling back to the cell's
existing content otherwise. It's cleared on commit / cancel.

A small change to `plastron-dom`'s `apply.ts` makes the controlled
formula bar behave correctly: writes to the `value` attribute on
`<input>` / `<textarea>` elements also write the IDL property, so
when the active cell changes the formula bar's displayed text
updates even after the user has interacted with the input. (Without
this, `setAttribute("value", …)` doesn't refresh the displayed value
once it's been edited by the user — standard form-element gotcha.)

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
  formula source. We paste literally; a fancy implementation would
  walk the parsed AST and shift refs by the column/row delta.
- **Single → fill paste** — Excel pastes a one-cell clipboard into
  every selected target cell. We only paste at the anchor.
- **Save / load** via plastron-archive — the sheet segment is already
  fully JSON-shape (formulas as text, no closures), so dehydrate +
  archive would round-trip; just isn't wired to a button yet.
- **Keyboard navigation** (arrow keys, Tab) — would ride on the
  existing dispatch handlers with new keydown bindings on the grid
  container.
