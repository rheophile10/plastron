# plastromancy — divination as a reactive plastron app

A Shang-era bone-cracking divination, modelled as a plastron app. Five
files of TypeScript, one HTML shell, one CSS file — the whole rite is
six cels and a render lambda.

The example exists for two reasons:

1. As a **tour of plastron's load-bearing pieces** in something more
   visual than a unit test: schema-driven change detection, a custom
   "kind" of lambda compiled from JSON-shaped declarative metadata,
   S-expression formulas, vnode rendering through `plastron-dom`, and
   the canonical boot sequence.
2. As **the reference shape for "kind handlers"** — the pattern a
   sibling segment like `plastron-python` will copy when it wants to
   register a non-default lambda compiler. The augur's role here is the
   same role `installEshkol` plays in `plastron-eshkol`.

The Chinese-named glyphs in inline comments are the rite's vocabulary,
not a public API. Comments label which plastron primitive each rite
piece maps to.

```bash
cd examples/plastromancy
npm install
npm run dev          # → http://localhost:5173/
# or
npm run build && npm run preview
```

## File layout

```
examples/plastromancy/
├── index.html        — Vite shell with a single <div id="root"> mount point.
├── src/
│   ├── main.ts       — boot: createInitialState → installShellEnvironment
│   │                   → hydrate(rules + session) → runCycle → installDom
│   │                   → handle.channel.drain() to force a synchronous first paint.
│   ├── schemas.ts    — the `crack` schema (pattern + intensity). The schema's
│   │                   isChanged ignores intensity drift — downstream cels
│   │                   (omen, tree) skip re-firing on noise.
│   ├── kind.ts       — the `augur` compiler. A LambdaMetadata with
│   │                   kind: "augur" + source: <json rule book> is compiled
│   │                   at hydrate into a Fn that reads inputs.crack.pattern
│   │                   and returns the omen text.
│   ├── segments.ts   — two segments: `rules` (the augur's rule book,
│   │                   no cels — just fnMetaData) and `session` (six
│   │                   cels: heat / thickness / charge / ratio / crack /
│   │                   omen / appTree).
│   └── lambdas.ts    — five lambdas: vnodeIsChanged, vnodeDiff,
│                       crackIsChanged, buildCrack, buildTree;
│                       four button dispatchers (hotter / cooler /
│                       thicker / thinner / nextCharge).
└── styles.css        — visual styling for the chiseled-bone look.
```

## What's in the graph

Six session cels plus a global appTree:

| Cel | Role | Notes |
|---|---|---|
| `heat` | value cel | User-writable. Buttons dispatch `session:hotter` / `session:cooler`. |
| `thickness` | value cel | Same shape as heat. |
| `charge` | value cel | The augur's question. `session:nextCharge` rotates through a list. |
| `ratio` | formula cel | `(/ heat thickness)` — the kernel's S-expression compiler. |
| `crack` | lambda cel | `l: "buildCrack"` over `ratio`. Emits `{pattern, intensity}`. `schema: crackSchema` — change-suppressed when only intensity drifts. |
| `omen` | lambda cel | `l: "augur"` — the kind handler reads the rule book. |
| `appTree` | lambda cel | `l: "buildTree"` over everything. `schema: vnodeSchema` — plastron-dom paints from it. |

The diff between `omen` and the tree is intentionally not interesting
to look at — it's a single string interpolated into one `<div>`. The
interesting bit is that the tree only re-fires when something
non-trivial moves: bump heat by one, ratio recomputes, crack might
change pattern or not, omen and tree only re-fire if the pattern moved.
That's `crackIsChanged` doing its job in the cascade.

## Plastron features demonstrated

| Feature | Where to look |
|---|---|
| Canonical boot sequence | `main.ts:45-60` |
| Multi-segment hydrate (rules + session) | `main.ts:51` |
| Custom lambda kind ("augur") | `kind.ts:22-30`, registered at `main.ts:42`, declared at `segments.ts:21-29` |
| S-expression formula compiler | `segments.ts:38` (`f: "(/ heat thickness)"`) |
| Schema-driven `isChanged` suppression | `schemas.ts` + `main.ts:37-41` + `lambdas.ts:80-85` |
| Vnode schema + diff wiring | `main.ts:31-36` registers `vnodeSchema` / `VNODE_DIFF_KEY` from `plastron-dom` |
| Event handlers as dispatchers (host writes inputs, segment owns rendering) | `lambdas.ts:97-114` — every handler is one `update` or `set` call, no value computation in the handler |
| `installDom` with a channel-bound tree cel | `main.ts:54-56` |
| Force synchronous first paint | `main.ts:60` (`handle.channel.drain()`) |

## The kind handler, in detail

A "kind handler" is a Compiler registered in `state.fns` under a name
(here, `"augur"`). At hydrate time, the kernel encounters a lambda whose
`fnMetaData[name].kind === "augur"` and looks up `state.fns.get("augur")`
to compile it. The compiler receives the lambda's `source` string and
returns a runtime `Fn`. From the cascade's perspective, the resulting
Fn is indistinguishable from a hand-written lambda — except the source
of truth was a JSON document, not code.

This is the same pattern `plastron-eshkol` uses to install a Scheme
compiler (`installEshkol` registers `state.fns.set("eshkol", compiler)`),
and the same pattern a future `plastron-python` will use for Pyodide.

```ts
// segments.ts — declarative rule book
{
  augur: {
    key: "augur",
    kind: "augur",
    source: JSON.stringify({
      X: "凶 — calamity, hold the spear",
      Y: "吉 — auspicious, ride at dawn",
    }),
  },
}

// kind.ts — compiler that turns the source into a runtime Fn
export const augurCompiler: Compiler = (source: string) => {
  const rules = JSON.parse(source ?? "{}") as Record<string, string>;
  return (inputs) => rules[inputs.crack?.pattern] ?? "(no omen for ...)";
};
```

No code is shipped; only the rules. Swap the rule book by writing a
new segment with different `fnMetaData[augur].source` — the augur reads
it transparently.

## Why this example matters

Every architectural decision in plastron should compose. The
plastromancy example exercises segments + kind handlers + schemas +
formula + lambda cels + vnode rendering in one running app. If a
future kernel change breaks it, the design test has failed; if it
still renders the same omens, the architecture has held.

The footprint is deliberately small. The interesting structural ideas
(segments-as-flush-units, kind-as-compiler, schema-as-change-policy)
should be reachable from ~300 lines of TypeScript.
