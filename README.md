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
