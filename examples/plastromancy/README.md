# plastromancy — the showcase ritual

A Shang-era divination ritual that exercises every plastron architectural feature in one running script. Use it as a tour of the runtime — and as proof that custom facades sit cleanly on top of the kernel. The 龜卜藏 face that drives this example lives in `src/mask/`, not in plastron core.

```bash
cd plastron && npm run build
cd ../examples/plastromancy && npx tsx src/index.ts
```

## What it shows

Each phase of the ritual maps to a plastron feature:

| Ritual phase | Plastromancy symbol | Plastron primitive |
|---|---|---|
| Loading three bundles | 增卷 | `SegmentBundle` + `hydrateBundles` |
| The temple-signed catalog | 印 on a 卷 | `SegmentManifest` + `verifySegment` |
| Carving the bone (heat → crack) | the chisels | Native lambdas + the formula DSL |
| The augur reads the omen | 體 (augur) | Custom `LambdaKindHandler` reading a JSON rule book |
| The crack with a pattern | 紋 (crack) | Format-tagged value with per-tag comparator |
| Pattern-equal cracks suppress re-render | the comparator | `TagProtocol.comparator` returning `true` |
| Provenance on each charge | the augur's hand | `authoredBy` / `generatedAt` on cels |
| Audit log of every divination | 觀 | Hook subscriptions on `afterLambdaInvoke`, `afterCycle`, `afterHydrate` |
| Change-indices snapshot | the watcher's tally | Default segment subscribed to `afterWave` |
| Runtime fingerprint at the close | 印鑑 | `state.fingerprint()` |
| Burning the bones | 焚 | `state.flush()` + tag `release` hooks |
| The Chinese-named API throughout | 龜卜藏 | The local mask (`src/mask/`) wrapping `State` |

## Layout

```
src/
  mask/                  — the 龜卜藏 facade. Lives here, not in plastron core.
    types.ts             — 龜卜藏 / 貞 / 卷 / 印 / 體 / 紋 / 卜
    wrap.ts              — wrap(state) → 龜卜藏
    index.ts             — 龜刻卜 (and 龜刻卜.卷 for bundle-shaped hydration)
  bundles/
    session.ts           — writeable session segment (cels + augur lambda)
    ancestors.ts         — read-only catalog, signed by the temple
    rules.ts             — divination rule book exposed as a module cel
  kinds/
    augur.ts             — custom LambdaKindHandler reading rule books
  tags/
    crack.ts             — TagProtocol with pattern-equality comparator
  lambdas/
    chisels.ts           — native plastron Fns + their LambdaMetadata
  index.ts               — orchestrator
```

## The mask, in detail

`src/mask/` is a self-contained TypeScript module that wraps a plastron `State` as a `龜卜藏`. Methods on the facade:

| Method | Plastron equivalent | Description |
|---|---|---|
| `骨` | `state.Cels` | the cels Map |
| `焚(segmentKey)` | `state.flush` | burn a segment |
| `增(cels, lambdas, fns, options)` | `state.hydrate` | incremental hydrate |
| `增卷(bundles, fns, options)` | `hydrateBundles(bundles, ..., state, ...)` | bundle-shaped hydrate |
| `觀(subscription)` | append to `state._hooks` | register a hook subscriber |
| `印鑑()` | `state.fingerprint()` | runtime fingerprint |
| `印鑑分解()` | `state.fingerprintComponents()` | structured fingerprint inputs |
| `辛(cascade)` | `state.cycle(cascade)` | run one cycle |
| `貞.察(key)` | `state.input.get` | inspect |
| `貞.刻(key, v)` | `state.input.set` | carve |
| `貞.連刻(writes)` | `state.input.batch` | carve many |
| `貞.重(key)` | `state.input.touch` | recharge |
| `貞.施()` | `state.input.consume` | consume buffered writes |
| `__state` | `State` | escape hatch when the facade is too narrow |

Type aliases: `卷 = SegmentBundle`, `印 = SegmentManifest`, `體 = LambdaKindHandler`, `紋 = TagProtocol`, `卜 = WavedCascade`.

## Glyph dictionary (after the README at repo root)

- 卜 — the cascade
- 辛 — the chisel; the cycle-runner
- 貞 — the augur's IO surface (`察 / 刻 / 連刻 / 重 / 施`)
- 骨 — the cels Map
- 甲 — the shell substrate
- 卷 — a scroll (bundle)
- 印 — a seal (manifest)
- 印鑑 — seal-impression (fingerprint)
- 體 — script style (kind handler)
- 紋 — pattern (tag protocol)
- 觀 — the observer (hook subscription)
- 龜卜藏 — the runtime, viewed through plastromantic vocabulary

## Glyph dictionary (after the README at repo root)

- 卜 — the cascade
- 辛 — the chisel; the cycle-runner
- 貞 — the augur's IO surface (`察 / 刻 / 連刻 / 重 / 施`)
- 骨 — the cels Map
- 甲 — the shell substrate
- 龜卜藏 — the runtime, viewed through plastromantic vocabulary

## Why this example

Every architectural decision in plastron is supposed to compose. The plastromancy showcase is a single document that uses every load-bearing feature. If a future change to core breaks the ritual, the design test has failed; if it still runs and prints the same omens, the architecture has held.
