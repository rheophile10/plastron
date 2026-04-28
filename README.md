# plastron 🐢

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
<td align="center" width="170">
<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/%E5%8D%9C-oracle.svg/140px-%E5%8D%9C-oracle.svg.png" width="120" alt="卜 in oracle bone script" />
<br/><b>卜</b> &middot; <i>bǔ</i>
</td>
<td>
<b>The crack itself.</b> A vertical fissure with a branching perpendicular — literally the shape of the heat-induced crack on a fired plastron. The character is sometimes said to echo the <i>kǎ</i> sound of the bone splitting.
<br/><br/>
<b>plastron:</b> the cascade. A write triggers a crack that propagates through the dependency graph; the cycle runner walks it in topological order (Kahn's).
</td>
</tr>
<tr>
<td align="center" width="170">
<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/%E8%BE%9B-oracle.svg/140px-%E8%BE%9B-oracle.svg.png" width="120" alt="辛 in oracle bone script" />
<br/><b>辛</b> &middot; <i>xīn</i>
</td>
<td>
<b>The inscribing knife.</b> An inverted triangular blade with a handle — the tool used for tattooing prisoners, branding slaves, and carving bone. The later "bitter / pungent" reading comes from the sharpness of the cut: the inscriptions were the augur's bitter tongue, knife-spoken into the shell.
<br/><br/>
<b>plastron:</b> the cycle-runner. 辛 is what carves the new omen back onto the bone — the recalculate pass that writes computed values onto cels after the crack has walked them.
</td>
</tr>
<tr>
<td align="center" width="170">
<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/%E8%B2%9E-oracle.svg/140px-%E8%B2%9E-oracle.svg.png" width="120" alt="貞 in oracle bone script" />
<br/><b>貞</b> &middot; <i>zhēn</i>
</td>
<td>
<b>The augur's charge.</b> The 貞人 was the named diviner who posed each question to the ancestors. The character combines 卜 (divine) with 鼎 (ritual tripod), later simplified to 卜 over 貝.
<br/><br/>
<b>plastron:</b> the IO surface. <code>貞.察 / 刻 / 連刻 / 重 / 施</code> — inspect, carve one, carve many, recharge, perform — the augur's hands on the shell.
</td>
</tr>
<tr>
<td align="center" width="170">
<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/7/71/%E5%86%8E-oracle.svg/140px-%E5%86%8E-oracle.svg.png" width="120" alt="冎 (the ancestor of 骨) in oracle bone script" />
<br/><b>骨</b> &middot; <i>gǔ</i>
</td>
<td>
<b>Bone.</b> The oracle form is 冎 — a long bone with a flesh fragment still attached (the 月 below in modern 骨 is the same fragment-pictograph, not the moon).
<br/><br/>
<b>plastron:</b> the cels Map. <code>骨</code> on the facade <i>is</i> the storage — the bones themselves.
</td>
</tr>
<tr>
<td align="center" width="170">
<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/7/77/%E7%94%B2-oracle.svg/140px-%E7%94%B2-oracle.svg.png" width="120" alt="甲 in oracle bone script" />
<br/><b>甲</b> &middot; <i>jiǎ</i>
</td>
<td>
<b>Shell / carapace / armor</b>, and the first of the Ten Heavenly Stems. The plastron substrate itself. <code>甲骨文</code> ("shell-and-bone script") is the modern name for the whole oracle-bone corpus.
<br/><br/>
<b>plastron:</b> state. The flat surface that everything else gets inscribed onto.
</td>
</tr>
<tr>
<td align="center" width="170">
<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/%E9%BE%9C-oracle.svg/140px-%E9%BE%9C-oracle.svg.png" width="120" alt="龜 in oracle bone script" />
<br/><b>龜</b> &middot; <i>guī</i>
</td>
<td>
<b>Turtle.</b> Pictograph of the animal seen from the side, head and feet visible. Two viewing angles co-existed in the script (side and top).
<br/><br/>
<b>plastron:</b> the mascot 🐢, and the source of every plastron the system reads from.
</td>
</tr>
<tr>
<td align="center" width="170">
<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/%E8%97%8F-bronze-warring.svg/140px-%E8%97%8F-bronze-warring.svg.png" width="120" alt="藏 in Warring-States bronze script" />
<br/><b>藏</b> &middot; <i>cáng</i>
</td>
<td>
<b>To store, hide, archive.</b> No oracle-bone form survives — the glyph here is Warring-States bronze, the earliest attested. 艹 (grass) over 臧 (something hidden away). The Daoist 藏 means a treasury of texts; the Tibetan 藏 (Tibet) is named for the same idea.
<br/><br/>
<b>plastron:</b> in the facade name <code>龜卜藏</code> — <i>the archive of turtle divinations</i>. The whole runtime, viewed as a hoard.
</td>
</tr>
<tr>
<td align="center" width="170">
<span style="font-size:48px"><b>坑 / 窖</b></span>
<br/><i>kēng / jiào</i>
</td>
<td>
<b>The dugout.</b> Both are later compounds with no oracle-bone form. <b>坑</b> = 土 (earth) + 亢 (phonetic) — a pit dug into the ground. <b>窖</b> = 穴 (cave) + 告 (phonetic) — an underground cellar or cache. At Yinxu the spent plastrons were stacked into <b>甲骨坑</b> (oracle-bone pits) for archival; pit <b>YH127</b> alone yielded ~17,000 inscribed pieces, more than any other single find in the corpus.
<br/><br/>
<b>plastron:</b> the persistence layer — where hydration draws from and where flushed segments are deposited.
</td>
</tr>
</table>

<sub><i>Ancient-form glyphs from Wiktionary glyph-origin tables on Wikimedia Commons; generally CC BY-SA 3.0.</i></sub>

—

Project: <https://github.com/rheophile10/plastron>

## Quick start

```ts
import { runtime } from "plastron";

const rt = await runtime([{
  price: { segment: "demo", v: 100 },
  qty:   { segment: "demo", v: 3 },
  total: { segment: "demo", f: "*(@price, @qty)" },
}]);

console.log(rt.input!.get("total"));   // 300
await rt.input!.set("qty", 4);
console.log(rt.input!.get("total"));   // 400
```

## Examples

```sh
cd plastron && npm install
npx vite-node ../examples/01_addition_chain/index.ts
```

Each numbered directory under `examples/` is a runnable demo. The headline interactive one is `examples/09_excel_spa/` — a single-page Excel-style sheet running on plastron, with a cascade visualizer that animates each topological layer of recalculation:

```sh
cd examples/09_excel_spa
npm install
npm run dev
```

## License

[MIT](LICENSE).
