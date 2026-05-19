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

**Submitted as [krausest/js-framework-benchmark#2015](https://github.com/krausest/js-framework-benchmark/pull/2015)** on
2026-05-19, pinned against plastron `66575305d030`.

The submission uses the **vanillajs pre-built pattern**, not the
`github:rheophile10/plastron` source-deps shape originally planned.
Reason: plastron and plastron-dom aren't published to npm, and
standard `github:` deps install a whole monorepo as a single
package — there's no clean way to point at the `plastron-dom`
sub-package inside the tarball. The pre-built shape is well-precedented
upstream (vanillajs itself, plus several other framework dirs).

What the submitted framework dirs contain:

```
frameworks/keyed/plastron-dom-v0.0.2/
├── README.md         — pointer to the plastron repo + reviewer notes
├── index.html        — krausest skeleton with <script type="module" src="./main.js">
├── main.js           — the pre-built bundle (vite build of src/main.ts in this repo)
├── package.json      — build-prod is `exit 0`; declares issues: [1139]
├── package-lock.json — empty lockfile (no deps)
└── src/main.ts       — verbatim copy of bench/krausest/keyed/plastron-dom-v0.0.2/src/main.ts
                        for reviewer reference; deep-relative imports remain
                        (not resolvable outside the plastron monorepo, that's the point)
```

Gotchas we hit (notes for the next framework anyone submits):

1. **`dist/` is on krausest's nuke list.** `cli/helpers/rebuild-utils.js:70`
   deletes `["yarn-lock", "dist", "elm-stuff", "bower_components",
   "node_modules", "output"]` during rebuild prep. If your build-prod
   is `exit 0` and you ship a pre-built bundle in `dist/`, the bundle
   gets deleted before the bench runs. Ship the bundle outside
   `dist/` — at the framework root or under `src/` works.
2. **`npm ci` requires `package-lock.json`.** Even with no deps, the
   lockfile must exist. Run `npm install --no-audit --no-fund` once
   to generate it before committing.
3. **vanillajs is the right reference pattern** for "framework that
   doesn't have its dependencies on npm." Solid uses real build +
   npm deps, but solid-js is published; we're not. Don't try to
   emulate solid's shape until plastron-dom ships on npm.

When plastron-dom is published to npm (post-HN), the PR can be
reshaped: real `dependencies` in package.json, real `vite build` as
build-prod, `main.js` regenerated by krausest's CI. The pre-built
shape is an early-stage compromise, not the long-term home.

### How to re-prepare the submission if/when we need to update

```sh
# 1. Rebuild from source in the plastron monorepo
cd ~/projects/plastron/bench/krausest/keyed/plastron-dom-v0.0.2
npm run build-prod                         # produces dist/main.js

# 2. Copy into the fork (assumes fork already cloned at /tmp/js-framework-benchmark)
v=keyed
dst=/tmp/js-framework-benchmark/frameworks/$v/plastron-dom-v0.0.2
mkdir -p $dst/src
cp index.html package.json $dst/
cp src/main.ts $dst/src/
cp dist/main.js $dst/main.js              # NOTE: NOT $dst/dist/main.js

# 3. In the fork, regenerate the lockfile + commit + push
cd $dst
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund --silent

# 4. Same for non-keyed; then in the fork:
cd /tmp/js-framework-benchmark
git add frameworks/keyed/plastron-dom-v0.0.2 frameworks/non-keyed/plastron-dom-v0.0.2
git commit -m "..."
git push
gh pr create ...
```

## Why two directories instead of one with a flag

Krausest's two divisions ("keyed" vs "non-keyed") are graded separately
and submitted as separate framework entries. The directory IS the
submission shape — packing both variants into one dir wouldn't fit the
upstream contract.
