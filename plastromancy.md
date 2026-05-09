# Plastromancy — the project's namesake

> *🎵 [Music to peruse with](https://www.youtube.com/watch?v=1LJedrFV02I)*

Plastron takes its name from Chinese **plastromancy** — Shang-era divination by reading heat-cracks on turtle plastrons. The diviner inscribed a charge onto the bone, applied heat, read the resulting crack, then inscribed the interpretation back onto the same surface. A flat, append-only inscription medium with dependencies and re-readings — closer to a spreadsheet than it first sounds, which is why this library ships a Chinese-named facade (`龜卜藏`) alongside the English one in the showcase example.

<table>
  <tr>
    <td align="center" width="50%">
      <img src="https://upload.wikimedia.org/wikipedia/commons/8/8e/Shang_dynasty_inscribed_tortoise_plastron.jpg" width="380" alt="Inscribed tortoise plastron from the Shang dynasty" />
      <br/><sub><i>Inscribed plastron from the reign of King Wu Ding (~1200 BCE), National Museum of China.<br/>Photo: <a href="https://commons.wikimedia.org/wiki/File:Shang_dynasty_inscribed_tortoise_plastron.jpg">BabelStone</a> · <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a></i></sub>
    </td>
    <td align="center" width="50%">
      <img src="https://upload.wikimedia.org/wikipedia/commons/5/59/Oracle_bones_pit.JPG" width="380" alt="Oracle bones pit YH127 at Yinxu, Anyang" />
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

Note: some entries above (`SegmentManifest`, `LambdaKindHandler`, `HookSubscription`, `state.fingerprint()`) describe primitives planned for the runtime but not yet present in the simplified kernel. The mapping above is the intended target shape; treat it as design vocabulary, not as a current API surface.

## The showcase example

`examples/plastromancy/` is a Shang-era divination performed end-to-end through the plastron primitives that exist today, dressed in the 龜卜藏 facade that ships with the example. It also serves as the proving ground for primitives still on the roadmap.

```sh
cd plastron && npm install && npm run build
cd ../examples/plastromancy && npm install && npm run dev
```
