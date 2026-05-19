# plastron-dom — js-framework-benchmark entries

Two framework-directory submissions for [Stefan Krause's
js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)
("krausest"), one per division:

- `keyed/plastron-dom-v0.0.2/` — `<tr key="row-${id}">` on every row;
  plastron-dom's `diffChildren` routes through keyed reconciliation.
- `non-keyed/plastron-dom-v0.0.2/` — no `key` prop; positional diff.
  Sub-optimal on swap / remove / insert; competitive elsewhere.

The directories sit in this repo (not in a fork of krausest) so the
plastron source code that backs the framework is versioned alongside
the benchmark glue. They get copied into a clone of krausest's repo
when we build, validate, or submit upstream.

## What's in each framework dir

```
{keyed,non-keyed}/plastron-dom-v0.0.2/
├── package.json     ← krausest contract — js-framework-benchmark section + build-prod
├── index.html       ← standard krausest skeleton (buttons, table, glyphicon preload)
├── vite.config.ts   ← `vite build` → dist/ with relative base URLs
└── src/main.ts      ← the implementation (~150 LOC each)
```

The two `main.ts` files are nearly identical — the only difference is
the `key:` prop on the per-row `<tr>` vnode in the keyed variant.

## Implementation shape (plastron-first)

Three cels per State (cookbook §1a — the "one-cel pattern"):

- `krausest:rows: Row[]` — the data
- `krausest:selectedIdx: number | null` — which row is highlighted
- `krausest:tbody` — native-fn cel that emits the `<tbody>` vnode tree
  from rows + selectedIdx

Krausest's six standard buttons (`#run`, `#runlots`, `#add`, `#update`,
`#clear`, `#swaprows`) get `addEventListener("click", …)` handlers in
the host (`main.ts`). Every handler is one `set` call against
`krausest:rows` — no computation in handlers, per DESIGN.md app rubric.

Row-level events (click-to-select, click-to-remove) are declared on
the vnodes themselves via plastron-dom's `EventBinding` mechanism.
plastron-dom attaches the listeners during paint and routes them
through `state.fns.set` / `state.fns.dispatch`.

## Local build

The framework dirs import plastron and plastron-dom via **deep relative
paths** into the monorepo (e.g. `../../../../../plastron/src/index.js`).
This lets us iterate without publishing packages or running `tsc` on
plastron first — Vite compiles TypeScript on the fly.

```sh
cd bench/krausest/keyed/plastron-dom-v0.0.2
npm install        # only vite + typescript
npm run build-prod # → dist/index.html + dist/assets/*
```

Same for `non-keyed/`. The `dist/` directory is what krausest's harness
serves and webdriver-tests against.

## Validate against krausest's harness

Clone krausest locally:

```sh
git clone https://github.com/krausest/js-framework-benchmark ~/projects/js-framework-benchmark
cd ~/projects/js-framework-benchmark
npm install
cd webdriver-ts && npm install && cd ..
```

Copy our framework dirs into theirs:

```sh
cp -r /home/rheophile/projects/plastron/bench/krausest/keyed/plastron-dom-v0.0.2     frameworks/keyed/
cp -r /home/rheophile/projects/plastron/bench/krausest/non-keyed/plastron-dom-v0.0.2 frameworks/non-keyed/
```

Build + validate:

```sh
npm run rebuild-ci -- keyed/plastron-dom-v0.0.2
npm run isKeyed   -- --framework keyed/plastron-dom-v0.0.2

npm run rebuild-ci -- non-keyed/plastron-dom-v0.0.2
npm run isKeyed   -- --framework non-keyed/plastron-dom-v0.0.2
```

The `isKeyed` test is the correctness check: it verifies that the
"keyed" variant actually reuses DOM nodes across reorders (and that the
"non-keyed" variant doesn't). It's the strongest signal that our
`key?` + `diffChildren` work is correct.

## Submitting upstream

For the PR to krausest's repo, the local-iteration shape needs to
change so their CI can install without our monorepo:

1. Change `src/main.ts` imports from deep relative paths to bare
   specifiers (`from "plastron"`, `from "plastron-dom"`).
2. Add to `package.json`:
   ```json
   "dependencies": {
     "plastron":     "github:rheophile10/plastron#<pinned-commit-sha>",
     "plastron-dom": "github:rheophile10/plastron#<pinned-commit-sha>"
   }
   ```
   (Krausest's CI installs from these URLs. The pinned SHA lets the PR
   reference a specific plastron commit; later commits don't change
   what the PR is testing.)
3. Open PR against `krausest/js-framework-benchmark`. Their CI runs the
   harness and the results land in the published table at
   `krausest.github.io/js-framework-benchmark`.

## Why two directories instead of one with a flag

Krausest's two divisions ("keyed" vs "non-keyed") are graded separately
and submitted as separate framework entries. The directory IS the
submission shape — packing both variants into one dir wouldn't fit the
upstream contract.
