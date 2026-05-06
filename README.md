# plastron 🐢

> *🎵 [Music to peruse with](https://www.youtube.com/watch?v=1LJedrFV02I)*

A reactive computation graph engine for TypeScript. Cels hold values or formulas; writing a cel triggers a cycle that recomputes every downstream cel. Spreadsheet semantics, with swappable formula parsers and arbitrary function composition.

## Thought experiment

> What if Excel, but with greater extensibility?

Excel's reactive recalculation is one of the most successful end-user programming environments ever built — but it's trapped inside one application. plastron lifts the model out: cels are typed JS values, formulas are first-class lambdas, and the formula parser itself is a swappable lambda. You bring the spreadsheet semantics; you decide what counts as a "function."

## Inspiration

Partial inspiration from Chinese **plastromancy** — Shang-era divination by reading heat-cracks on turtle plastrons. The diviner inscribed a charge onto the bone, applied heat, read the resulting crack, then inscribed the interpretation back onto the same surface. A flat, append-only inscription medium with dependencies and re-readings — closer to a spreadsheet than it first sounds, which is why this library ships a Chinese-named facade (`龜卜藏`) alongside the English one.

<table>
  <tr>
    <td align="center" width="50%">
      <img src="https://upload.wikimedia.org/wikipedia/commons/8/8e/Shang_dynasty_inscribed_tortoise_plastron.jpg" width="380" alt="Inscribed tortoise plastron from the Shang dynasty" />
      <br/><sub><i>Inscribed plastron from the reign of King Wu Ding (~1200 BCE), National Museum of China.<br/>Photo: <a href="https://commons.wikimedia.org/wiki/File:Shang_dynasty_inscribed_tortoise_plastron.jpg">BabelStone</a> · <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a></i></sub>
    </td>
    <td align="center" width="50%">
      <img src="https://upload.wikimedia.org/wikipedia/commons/5/59/Oracle_bones_pit.JPG" width="380" alt="Oracle bone storage pit YH127 at Yinxu, Anyang" />
      <br/><sub><i>Pit YH127 at Yinxu (Anyang) — where used plastrons were archived after the rite.<br/>Photo: <a href="https://commons.wikimedia.org/wiki/File:Oracle_bones_pit.JPG">Xuan Che</a> · <a href="https://creativecommons.org/licenses/by/2.0/">CC BY 2.0</a></i></sub>
    </td>
  </tr>
</table>

The project's patron parable is Zhuangzi's tortoise. Asked whether he'd rather be a sacred tortoise honored in a temple after death, or an ordinary one alive dragging its tail in the mud, Zhuangzi chose the mud. We're with him.

— [Zhuangzi, ch. 17 (秋水, "Autumn Floods")](https://en.wikipedia.org/wiki/Zhuangzi_\(book\))

## Glyph notes

The Chinese-named facade (`龜卜藏`) borrows characters whose oldest forms come from the divination kit itself. The metaphor is not decoration — each glyph points at a piece of the runtime. Below: the ancient pictograph (oracle bone script unless noted) on the left, modern reading + the role it plays in plastron on the right.

<table>
<tr>
<td align="center" width="180">

# 卜

<i>bǔ</i>
</td>
<td>
<b>The crack itself.</b> A vertical fissure with a branching perpendicular — literally the shape of the heat-induced crack on a fired plastron. The character is sometimes said to echo the <i>kǎ</i> sound of the bone splitting.
<br/><br/>
<b>plastron:</b> the cascade. A write triggers a crack that propagates through the dependency graph; the cycle runner walks it in topological order (Kahn's).
</td>
</tr>
<tr>
<td align="center" width="180">

# 辛

<i>xīn</i>
</td>
<td>
<b>The inscribing knife.</b> An inverted triangular blade with a handle — the tool used for tattooing prisoners, branding slaves, and carving bone. The later "bitter / pungent" reading comes from the sharpness of the cut: the inscriptions were the augur's bitter tongue, knife-spoken into the shell.
<br/><br/>
<b>plastron:</b> the cycle-runner. 辛 is what carves the new omen back onto the bone — the recalculate pass that writes computed values onto cels after the crack has walked them.
</td>
</tr>
<tr>
<td align="center" width="180">

# 貞

<i>zhēn</i>
</td>
<td>
<b>The augur's charge.</b> The 貞人 was the named diviner who posed each question to the ancestors. The character combines 卜 (divine) with 鼎 (ritual tripod), later simplified to 卜 over 貝.
<br/><br/>
<b>plastron:</b> the IO surface. <code>貞.察 / 刻 / 連刻 / 重 / 施</code> — inspect, carve one, carve many, recharge, perform — the augur's hands on the shell.
</td>
</tr>
<tr>
<td align="center" width="180">

# 骨

<i>gǔ</i>
</td>
<td>
<b>Bone.</b> A long bone with a flesh fragment still attached — the oracle-form ancestor 冎 depicts the same shape; the 月 below in modern 骨 is that fragment-pictograph, not the moon.
<br/><br/>
<b>plastron:</b> the cels Map. <code>骨</code> on the facade <i>is</i> the storage — the bones themselves.
</td>
</tr>
<tr>
<td align="center" width="180">

# 甲

<i>jiǎ</i>
</td>
<td>
<b>Shell / carapace / armor</b>, and the first of the Ten Heavenly Stems. The plastron substrate itself. <code>甲骨文</code> ("shell-and-bone script") is the modern name for the whole oracle-bone corpus.
<br/><br/>
<b>plastron:</b> state. The flat surface that everything else gets inscribed onto.
</td>
</tr>
<tr>
<td align="center" width="180">

# 龜

<i>guī</i>
</td>
<td>
<b>Turtle.</b> Pictograph of the animal seen from the side, head and feet visible. Two viewing angles co-existed in the script (side and top).
<br/><br/>
<b>plastron:</b> the mascot 🐢, and the source of every plastron the system reads from.
</td>
</tr>
<tr>
<td align="center" width="180">

# 藏

<i>cáng</i>
</td>
<td>
<b>To store, hide, archive.</b> No oracle-bone form survives — the earliest attested is Warring-States bronze. 艹 (grass) over 臧 (something hidden away). The Daoist 藏 means a treasury of texts; the Tibetan 藏 (Tibet) is named for the same idea.
<br/><br/>
<b>plastron:</b> in the facade name <code>龜卜藏</code> — <i>the archive of turtle divinations</i>. The whole runtime, viewed as a hoard.
</td>
</tr>
<tr>
<td align="center" width="180">

# 坑 / 窖

<i>kēng / jiào</i>
</td>
<td>
<b>The dugout.</b> Both are later compounds with no oracle-bone form. <b>坑</b> = 土 (earth) + 亢 (phonetic) — a pit dug into the ground. <b>窖</b> = 穴 (cave) + 告 (phonetic) — an underground cellar or cache. At Yinxu the spent plastrons were stacked into <b>甲骨坑</b> (oracle-bone pits) for archival; pit <b>YH127</b> alone yielded ~17,000 inscribed pieces, more than any other single find in the corpus. A minority strand of the scholarship reads the small edge-perforations on certain plastrons as <i>binding holes</i> — evidence the bones were strung into ordered sets the way bamboo slips (<code>簡冊</code>) were bound, an archival format more than a divinatory one.
<br/><br/>
<b>plastron:</b> the persistence layer — where hydration draws from and where flushed segments are deposited.
</td>
</tr>
</table>

—

Project: <https://github.com/rheophile10/plastron>

## The runtime, glyph by glyph

| Glyph | Plastron concept | English name |
|---|---|---|
| 卜 | the cascade | `WavedCascade` — the propagating crack |
| 辛 | the cycle-runner | `state.cycle` — carves new values onto the bone |
| 貞 | the augur's hands | `state.input` — `get / set / batch / touch / consume` |
| 骨 | the cels Map | `state.Cels` — every bone, by key |
| 甲 | the substrate | `State` itself — what the cycle inscribes onto |
| 卷 | a scroll | `SegmentBundle` — bound, signable, transmissible |
| 印 | a seal | `SegmentManifest` — vermillion seal stamped onto a 卷 |
| 印鑑 | seal-impression | `state.fingerprint()` — the runtime's identity |
| 體 | script style | `LambdaKindHandler` — which scribe carves which kind of inscription |
| 紋 | pattern / grain | `TagProtocol` — equality + lifecycle for opaque cel values |
| 觀 | the observer | `HookSubscription` — watches but does not act |
| 龜卜藏 | the archive | the runtime, viewed as a hoard of divinations |
| 坑 / 窖 | the dugout | persistence — where flushed segments are deposited |

Cels hold values or formulas. Writing a cel triggers a crack (the cascade) that the inscribing knife (the cycle-runner) walks in topological order, carving new values onto every downstream bone. The archive (`龜卜藏`) holds the whole rite. When the session ends, the bones are flushed into the dugout — and the augur opens a fresh shell for the next charge.

## Quick start

```ts
import { runtime } from "plastron";

const rt = await runtime([{
  price: { segment: "demo", v: 100 },
  qty:   { segment: "demo", v: 3 },
  total: { segment: "demo", f: "*(@price, @qty)" },
}]);

console.log(rt.input!.get("total"));     // 300
await rt.input!.set("qty", 4);
console.log(rt.input!.get("total"));     // 400
```

Plastron core is English-named. The plastromancy facade (`龜卜藏` with `察 / 刻 / 連刻 / 重 / 施 / 焚 / 增 / 增卷 / 觀 / 印鑑`) is a skin that lives in the showcase example, demonstrating that custom facades sit cleanly on top of the kernel:

```ts
import { 龜刻卜 } from "../examples/plastromancy/src/mask/index.js";

const 甲 = await 龜刻卜([{
  price: { segment: "demo", v: 100 },
  qty:   { segment: "demo", v: 3 },
  total: { segment: "demo", f: "*(@price, @qty)" },
}]);

console.log(甲.貞!.察("total"));     // 300  — read the omen
await 甲.貞!.刻("qty", 4);            // carve a new charge
console.log(甲.貞!.察("total"));     // 400  — the bone has spoken
const 印 = await 甲.印鑑();           // seal-impression of the runtime
```

## The showcase ritual

`examples/plastromancy/` is the marquee example — a Shang-era divination performed end-to-end through every plastron primitive, dressed in the 龜卜藏 facade that ships with the example. Bundle-shaped hydration with a temple-signed manifest (印); a custom **augur** lambda kind (體) that interprets a JSON rule book; **crack** values as format-tagged opaque types (紋) whose pattern-equality comparator suppresses spurious cascades; native chisels carving heat into geometry; the formula DSL composing the inscription; cycle observers (觀) recording every divination into an audit log; the runtime fingerprint (印鑑) printed at the close as the seal of the rite. Open the example to see every architectural choice in one running script.

```sh
cd plastron && npm install && npm run build
cd ../examples/plastromancy && npx tsx src/index.ts
```

## Architecture, lightly

Plastron core is small by design — a kernel that knows about cels, cycles, and a handful of extension points. Everything else lives as a segment or kind:

- **Lambda kinds** — `formula`, `native`, and any opt-in extension (`quickjs`, `python`, `sqlite`, `eshkol`, …) plug in via `LambdaKindHandler`. Source travels with the lambda metadata; core stays language-agnostic.
- **Hooks** — observation-only callbacks (`beforeCycle`, `afterLambdaInvoke`, `afterWave`, `afterCycle`, `afterHydrate`) let segments react to cycle activity without touching the cycle.
- **Format-tagged values** — opaque cel values (`{__tag, value}`) carry a per-tag protocol with comparator, release, and serializer. Numpy arrays, sqlite blobs, Eshkol closures all round-trip through the cycle without core knowing what they are.
- **Bundles + manifests** — segments are versioned, canonically-serialized JSON envelopes that may carry a content hash and Ed25519 signature. The runtime verifies on load via a pluggable `verifySegment` callback.
- **Runtime fingerprint** — sha256 over engine version + kinds + hook subscribers + segments + tag protocols + trust policy. A deterministic identity for "this exact runtime configuration."

Default segments — change-indices, error tracking — are auto-installed by `runtime()` / `plastron()` and replaceable. The `audit-log`, `plastron-schemas`, and `plastron-trust` segments live in `segments/`.

## Anecdotal: what else can it do

The plastromancy framing is the lens; it doesn't bound the use cases. Plastron has been sketched for analyst notebooks, agent harnesses where the agent's working memory is editable cels, news-stream monitoring with windowed transcripts, parliament-archive transcription pipelines, and recursive runtime-as-worker setups where one plastron document dispatches jobs to another. The examples above show exactly the substrate those use — different ritual, same shell.

## Documentation

- [`core-plan.md`](core-plan.md) — what belongs in core, what's been evicted, sequencing.
- [`examples-roadmap.md`](examples-roadmap.md) — target deliverables and the segments each one needs.
- [`pitches.md`](pitches.md) — single-sentence framings of what plastron is.
- [`segments/`](segments/) — ecosystem segments (`audit-log`, `plastron-schemas`, `plastron-trust`).
- [`examples/plastromancy/README.md`](examples/plastromancy/README.md) — the showcase ritual, walked through feature by feature.

## License

[MIT](LICENSE).
